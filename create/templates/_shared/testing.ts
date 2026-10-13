// Run a template's workflow on its samples without a server: a workflow
// context that saves each step as the workflow engine does, a graph in
// memory that applies owned writes, and a mock of the LBB activities whose
// model answers come from deterministic rules. Each template's
// workflow.test.ts gives the rules.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENTITY_ID_KEY_SENTINEL,
  ENTITY_IRI_NAMESPACE,
  LbbError,
  type ActivityOptions,
  type DecideRequest,
  type DecideResult,
  type EmbedRequest,
  type EmbedResult,
  type FilePages,
  type LbbActivities,
  type OwnedWrite,
  type ReasonRequest,
  type ReasonResult,
  type ReviewRequest,
  type Schemas,
  type SparqlResults,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowProgressCounts,
  type WorkflowStepContext,
  type WorkflowTriggerMessage,
} from "@littlebigbrain/client";

/** The `samples/` folder of a template, from its test file: `samplesDir(import.meta.url, "documents-link")`. */
export function samplesDir(testFile: string, template: string): string {
  let dir = dirname(fileURLToPath(testFile));
  for (let up = 0; up < 6; up++, dir = dirname(dir))
    for (const candidate of [join(dir, "samples"), join(dir, template, "samples")])
      if (
        existsSync(join(candidate, "..", "workflow.ts")) ||
        existsSync(join(candidate, "..", "README.md"))
      )
        if (existsSync(candidate)) return candidate;
  throw new Error(`no samples folder for ${template} above ${testFile}`);
}

export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/** The 32-hex id a mock entity gets from its class and key. */
export const mockId = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 32);

// ---- a graph in memory ---------------------------------------------------------

export interface MemoryEntity {
  iri: string;
  type: string;
  name: string;
  properties: Record<string, unknown>;
}
export interface MemoryEdge {
  source: string;
  relation: string;
  target: string;
  confidence?: number | null;
  evidence?: unknown;
}

/** Entities and edges, written by owned writes with the semantics of `replace_owned`. */
export class MemoryGraph {
  readonly entities = new Map<string, MemoryEntity>();
  edges: MemoryEdge[] = [];
  commits = 0;

  /** The IRI an entity reference names: by id with the sentinel key, else by class and key (or name). */
  iriOf(ref: Schemas["NamedEntityInput"] | Schemas["EntityPropertiesInput"]): string {
    const type = "type" in ref ? ref.type : "";
    if (ref.key?.startsWith(ENTITY_ID_KEY_SENTINEL))
      return ENTITY_IRI_NAMESPACE + ref.key.slice(ENTITY_ID_KEY_SENTINEL.length);
    return ENTITY_IRI_NAMESPACE + mockId(`${type}\u0000${ref.key ?? `name:${ref.name}`}`);
  }

  entity(ref: Schemas["NamedEntityInput"]): MemoryEntity {
    const iri = this.iriOf(ref);
    let entity = this.entities.get(iri);
    if (!entity)
      this.entities.set(iri, (entity = { iri, type: ref.type, name: ref.name, properties: {} }));
    return entity;
  }

  /** Apply one owned write, as `POST /v1/graph/commit` with `replace_owned` does. */
  apply(write: OwnedWrite): void {
    this.commits += 1;
    const relations = new Set(write.relations ?? []);
    for (const subject of write.subjects) {
      const iri = this.iriOf(subject);
      this.edges = this.edges.filter((e) => !(e.source === iri && relations.has(e.relation)));
      const entity = this.entities.get(iri);
      if (entity) for (const p of write.properties ?? []) delete entity.properties[p];
    }
    for (const gone of write.retract_entities ?? []) {
      const iri = this.iriOf(gone);
      this.entities.delete(iri);
      this.edges = this.edges.filter((e) => e.source !== iri && e.target !== iri);
    }
    for (const row of write.entity_properties ?? []) {
      const entity = this.entity({ type: row.type, name: row.name, key: row.key });
      const properties = Array.isArray(row.properties)
        ? Object.fromEntries(row.properties.map((p) => [p.field, Object.values(p.value)[0]]))
        : (row.properties ?? {});
      Object.assign(entity.properties, properties);
    }
    for (const t of write.triplets ?? []) {
      const [source, target] = [this.entity(t.source).iri, this.entity(t.target).iri];
      const same = (e: MemoryEdge) =>
        e.source === source && e.relation === t.relation && e.target === target;
      this.edges = [
        ...this.edges.filter((e) => !same(e)),
        { source, relation: t.relation, target, confidence: t.confidence, evidence: t.evidence },
      ];
    }
  }

  ofType(type: string): MemoryEntity[] {
    return [...this.entities.values()].filter((e) => e.type === type);
  }

  edgesOf(relation: string): MemoryEdge[] {
    return this.edges.filter((e) => e.relation === relation);
  }
}

// ---- the activities, mocked ------------------------------------------------------

/** The rules a test gives the mock. A rule left out throws when the workflow calls it. */
export interface MockRules {
  reason?: (request: ReasonRequest) => unknown;
  decide?: (request: DecideRequest) => DecideResult["answers"];
  embed?: (texts: string[]) => number[][];
  sparql?: (
    query: string,
    graph: MemoryGraph,
    request: Schemas["SparqlTextRequest"],
  ) => Record<string, string>[];
  /** Whether a model call is refused (`422 activity_request_refused`). */
  refuses?: (kind: "reason" | "decide" | "embed", request: unknown) => boolean;
  /** The status a review item gets (default `open`). */
  reviewStatus?: (request: ReviewRequest) => Schemas["OntologyChangeSuggestionStatus"];
  pages?: FilePages[];
  ontology?: Schemas["OntologyView"];
  /** What a dry-run evolve answers (default: a change that is not a no-op). */
  evolve?: (ops: Schemas["OntologyEvolveOp"][]) => Partial<Schemas["OntologyEvolveResponse"]>;
}

export interface MockCall {
  kind: "reason" | "decide" | "embed";
  effectId?: string;
  label?: string;
  cached: boolean;
  refused: boolean;
}

/**
 * The LBB activities on a {@link MemoryGraph}, with the effect cache of the
 * server: a repeat of a request under its effect id returns the kept answer
 * (`cached: true`), and another request under the same effect id fails with
 * `409 activity_effect_conflict`.
 */
export class MockActivities implements LbbActivities {
  readonly graph = new MemoryGraph();
  readonly calls: MockCall[] = [];
  readonly reviews = new Map<string, ReviewRequest & { status: string }>();
  readonly evolved: Schemas["OntologyEvolveOp"][][] = [];
  private readonly kept = new Map<string, { request: string; answer: unknown }>();
  private readonly written = new Set<string>();

  constructor(readonly rules: MockRules = {}) {}

  private model<T>(
    kind: MockCall["kind"],
    request: object,
    options: ActivityOptions,
    answer: () => T,
  ): T {
    const body = JSON.stringify(request);
    const cacheKey = `${kind}\u0000${options.effectId}`;
    const kept = options.effectId ? this.kept.get(cacheKey) : undefined;
    if (kept) {
      if (kept.request !== body)
        throw new LbbError(409, "{}", {
          code: "activity_effect_conflict",
          message: `${options.effectId} keeps another request`,
        });
      this.calls.push({
        kind,
        effectId: options.effectId,
        label: options.label,
        cached: true,
        refused: false,
      });
      return { ...(kept.answer as object), cached: true, tokens_in: 0, cost_micro_usd: 0 } as T;
    }
    const refused = this.rules.refuses?.(kind, request) ?? false;
    this.calls.push({
      kind,
      effectId: options.effectId,
      label: options.label,
      cached: false,
      refused,
    });
    if (refused)
      throw new LbbError(422, "{}", { code: "activity_request_refused", message: "too large" });
    const result = answer();
    if (options.effectId) this.kept.set(cacheKey, { request: body, answer: result });
    return result;
  }

  async reason<T = unknown>(
    request: ReasonRequest,
    options: ActivityOptions = {},
  ): Promise<ReasonResult<T>> {
    const rule = this.rules.reason ?? (() => assertNever("reason"));
    return this.model("reason", request, options, () => ({
      value: JSON.parse(JSON.stringify(rule(request))) as T,
      model: "mock-reasoning",
      tokens_in: Math.ceil(request.prompt.length / 4),
      tokens_out: 0,
      cost_micro_usd: 1_000,
      cached: false,
    }));
  }

  async decide(request: DecideRequest, options: ActivityOptions = {}): Promise<DecideResult> {
    const rule = this.rules.decide ?? (() => assertNever("decide"));
    if (Object.keys(request.questions).length > 64)
      throw new LbbError(400, "{}", {
        code: "invalid_request",
        param: "questions",
        message: "more than 64 questions",
      });
    return this.model("decide", request, options, () => ({
      answers: rule(request),
      model: "mock-decision",
      tokens_in: 200,
      tokens_out: 0,
      cost_micro_usd: 0,
      cached: false,
    }));
  }

  async embed(request: EmbedRequest, options: ActivityOptions = {}): Promise<EmbedResult> {
    const rule = this.rules.embed;
    if (!rule)
      throw new LbbError(503, "{}", {
        code: "activity_model_unavailable",
        message: "no embedding model",
        retryable: false,
      });
    if (request.texts.length > 256)
      throw new LbbError(400, "{}", {
        code: "invalid_request",
        param: "texts",
        message: "more than 256 texts",
      });
    return this.model("embed", request, options, () => {
      const vectors = rule(request.texts);
      return {
        vectors,
        model: "mock-embedding",
        dim: vectors[0]?.length ?? 0,
        tokens_in: 1,
        cost_micro_usd: 0,
        cached: false,
      };
    });
  }

  async pages(sha256: string, options: { from?: number; to?: number } = {}): Promise<FilePages> {
    const file = this.rules.pages?.find((f) => f.sha256 === sha256);
    if (!file)
      throw new LbbError(404, "{}", { code: "file_not_parsed", message: `no pages for ${sha256}` });
    const from = options.from ?? 0;
    const to = Math.min(options.to ?? file.page_count, file.page_count);
    return { ...file, from, to, pages: file.pages.slice(from, to) };
  }

  async sparql(request: string | Schemas["SparqlTextRequest"]): Promise<SparqlResults> {
    const body = typeof request === "string" ? { query: request } : request;
    const rows = (this.rules.sparql ?? (() => assertNever("sparql")))(body.query, this.graph, body);
    return { vars: Object.keys(rows[0] ?? {}), boolean: null, bindings: [], rows, snapshot: null };
  }

  writeOwned(
    ctx: WorkflowContext,
    stepKey: string,
    write: OwnedWrite | ((step: WorkflowStepContext) => OwnedWrite | Promise<OwnedWrite>),
  ) {
    return ctx.step(stepKey, async (step) => {
      const { effectId } = step;
      const replayed = this.written.has(effectId);
      if (!replayed) {
        this.graph.apply(typeof write === "function" ? await write(step) : write);
        this.written.add(effectId);
      }
      return {
        commit_seq: this.graph.commits,
        idempotency_key: effectId,
        replayed,
        owned: null,
        entities_written: 0,
        edges_written: 0,
      };
    });
  }

  async review(request: ReviewRequest): Promise<Schemas["OntologyChangeSuggestion"]> {
    const key = request.key ?? `review-${this.reviews.size}`;
    const status = this.reviews.get(key)?.status ?? this.rules.reviewStatus?.(request) ?? "open";
    this.reviews.set(key, { ...request, status });
    return {
      suggestion_id: key,
      status,
      facts: request.facts ?? null,
    } as unknown as Schemas["OntologyChangeSuggestion"];
  }

  async evolve(ops: Schemas["OntologyEvolveOp"][], options: { dryRun?: boolean } = {}) {
    if (!options.dryRun) this.evolved.push(ops);
    const answer = this.rules.evolve?.(ops) ?? {};
    return {
      dry_run: Boolean(options.dryRun),
      no_op: false,
      publishable: true,
      messages: [],
      applied: [],
      ...answer,
    } as Schemas["OntologyEvolveResponse"];
  }

  async ontology(): Promise<Schemas["OntologyView"]> {
    return this.rules.ontology ?? assertNever("ontology");
  }
}

function assertNever(what: string): never {
  throw new Error(`the test gives the mock no ${what} rule`);
}

// ---- turns -------------------------------------------------------------------------

/** One progress report of a step (`s.progress`), as the worker would send it. */
export interface ProgressCall extends WorkflowProgressCounts {
  step: string;
  phase: string;
}

/** One turn: its step keys, their saved outputs, and the progress its steps reported. */
export interface Turn {
  message: WorkflowTriggerMessage;
  keys: string[];
  outputs: unknown[];
  bytes: number;
  progress: ProgressCall[];
}

const UNIT = /^[\p{L}\p{N} _-]{1,32}$/u;
const whole = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;

/** A progress report checked as the worker checks it: the progress convention. */
function progressCall(step: string, phase: string, counts: WorkflowProgressCounts): ProgressCall {
  const text = phase.trim();
  if (!text || [...text].length > 80) throw new Error(`step ${step}: progress phase "${phase}"`);
  if (!whole(counts.done) || (counts.total !== undefined && !whole(counts.total)))
    throw new Error(`step ${step}: progress counts ${JSON.stringify(counts)}`);
  if (counts.unit !== undefined && !UNIT.test(counts.unit))
    throw new Error(`step ${step}: progress unit "${counts.unit}"`);
  return { step, phase: text, ...counts };
}

/** What a turn returns: its state, and a continuation when the work goes on in another turn. */
export interface TurnResult<S> {
  state: S;
  continuation?: { message: WorkflowTriggerMessage };
}

/** Thrown by {@link runTurn} to stop a turn after a number of steps, as a crash would. `turn` holds the steps saved before it. */
export class Crash extends Error {
  constructor(
    message: string,
    readonly turn: Turn,
  ) {
    super(message);
  }
}

const STEP_KEY = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Run one turn of `definition` as the workflow engine does: each step runs
 * once and its output is saved; with `saved`, the saved steps replay without
 * running. The engine's limits hold: 64 steps, 64 KiB per step output and
 * 256 KiB per turn. `crashAfter` stops the turn after that many new steps.
 */
export async function runTurn<S>(
  definition: WorkflowDefinition<S, WorkflowTriggerMessage>,
  state: unknown,
  message: WorkflowTriggerMessage,
  options: { prefix?: string; saved?: Turn; crashAfter?: number } = {},
): Promise<{ result: TurnResult<S>; turn: Turn }> {
  const prefix = options.prefix ?? mockId(JSON.stringify(message));
  const turn: Turn = { message, keys: [], outputs: [], bytes: 0, progress: [] };
  let busy = false;
  let ran = 0;
  const ctx = {
    signal: new AbortController().signal,
    workflowId: "starter.test",
    messageId: "starter-test-1",
    turn: 1,
    async step<T>(
      key: string,
      effect: (s: {
        effectId: string;
        signal: AbortSignal;
        checkpoint: unknown;
        heartbeat(): Promise<void>;
        progress(phase: string, counts: WorkflowProgressCounts): void;
      }) => Promise<T>,
    ) {
      if (busy) throw new Error("steps run one at a time: await each step");
      if (!STEP_KEY.test(key) || turn.keys.includes(key))
        throw new Error(`step key ${key} is not valid or not unique`);
      if (turn.keys.length >= 64) throw new Error("a turn holds at most 64 steps");
      const index = turn.keys.length;
      turn.keys.push(key);
      const saved = options.saved?.keys[index];
      if (saved !== undefined) {
        if (saved !== key)
          throw new Error(`step ${index} was ${saved}, now ${key}: the step order changed`);
        turn.outputs.push(options.saved!.outputs[index]);
        return JSON.parse(JSON.stringify(options.saved!.outputs[index])) as T;
      }
      if (options.crashAfter !== undefined && ran >= options.crashAfter)
        throw new Crash(`crash before ${key}`, { ...turn, keys: turn.keys.slice(0, -1) });
      busy = true;
      try {
        const output = await effect({
          effectId: `${prefix}/${key}`,
          signal: new AbortController().signal,
          checkpoint: null,
          heartbeat: async () => {},
          progress: (phase, counts) => turn.progress.push(progressCall(key, phase, counts)),
        });
        const json = JSON.stringify(output ?? null);
        if (json.length > 64 * 1024)
          throw new Error(`step ${key} saves ${json.length} bytes, more than 64 KiB`);
        turn.bytes += json.length;
        if (turn.bytes > 256 * 1024) throw new Error("a turn saves at most 256 KiB");
        turn.outputs.push(JSON.parse(json));
        ran += 1;
        return JSON.parse(json) as T;
      } finally {
        busy = false;
      }
    },
    async waitForSignal(): Promise<never> {
      throw new Error("not in the templates");
    },
    async sleep(): Promise<never> {
      throw new Error("not in the templates");
    },
    continue: <T, M>(next: T, nextMessage: M) => ({
      state: next,
      continuation: { message: nextMessage },
    }),
  } as unknown as WorkflowContext;
  const result = (await definition.execute(ctx, state, message)) as TurnResult<S>;
  return { result, turn };
}

/**
 * Run a message and every continuation it leads to, from the empty state the
 * server creates the instance with. Returns the final state and the turns.
 */
export async function runMessage<S>(
  definition: WorkflowDefinition<S, WorkflowTriggerMessage>,
  message: WorkflowTriggerMessage,
  state: unknown = {},
) {
  const turns: Turn[] = [];
  let next: WorkflowTriggerMessage | undefined = message;
  while (next) {
    if (turns.length > 100) throw new Error("more than 100 turns");
    const ran: { result: TurnResult<S>; turn: Turn } = await runTurn(definition, state, next);
    turns.push(ran.turn);
    state = ran.result.state;
    next = ran.result.continuation?.message;
  }
  return { state: state as S, turns };
}

/** The phases the steps of `turns` reported, each once, in the order they first came. */
export function phases(turns: Turn[]): string[] {
  return [...new Set(turns.flatMap((t) => t.progress.map((p) => p.phase)))];
}

/** A trigger message of the triggered workflow `workflow`. */
export function triggerMessage(
  workflow: string,
  instances: string[],
  removed: string[] = [],
): WorkflowTriggerMessage {
  return {
    type: "instances",
    workflow,
    graph: "samples",
    as_of_commit_seq: 7,
    reason: "backfill",
    instances,
    removed,
  };
}
