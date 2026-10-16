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

// ---- files and derivations ---------------------------------------------------------

/** A file the mock holds: its bytes, name, media type and `Document` IRI. */
export interface MockFile {
  sha256: string;
  name: string;
  mediaType: string;
  document: string;
  bytes: Uint8Array;
}

/**
 * The files and the derivations of a server, for the templates that read
 * files: `files.content` and `workflows.derivations.check` / `record`, the
 * shape of an `LbbClient`. `upload` puts the file's `Document` in `graph`
 * with its name, SHA-256 and media type, as the upload route does.
 *
 * Each upload has its `uploaded_at`, as the server's file record: an upload
 * of a live file keeps it, an upload after `remove` gets a new one. A
 * derivation belongs to the upload of its record. The check names the
 * upload of a live file; a removed file has no upload and no derivation.
 * A record that names another upload than the live one throws `LbbError`
 * 409 `derivation_upload_changed`.
 */
export class MockContent {
  readonly held = new Map<string, MockFile>();
  readonly recorded = new Map<string, Schemas["Derivation"]>();
  /** The upload of each content's file, live or removed. */
  readonly uploads = new Map<string, { uploadedAt: string; live: boolean }>();
  /** The upload each recorded derivation belongs to. */
  private readonly stamps = new Map<string, string | undefined>();
  /** Every derivation record request, in order. */
  readonly records: Schemas["DerivationRecordRequest"][] = [];
  /** Reads of a file's bytes. */
  reads = 0;
  /** Derivation checks. */
  checks = 0;

  constructor(readonly graph: MemoryGraph) {}

  /** Hold a file and write its `Document`. */
  upload(name: string, body: string | Uint8Array, mediaType: string): MockFile {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!this.uploads.get(sha256)?.live) {
      this.newUploads += 1;
      const at = new Date(Date.UTC(2026, 9, 15, 9) + this.newUploads * 1_000);
      this.uploads.set(sha256, { uploadedAt: at.toISOString(), live: true });
    }
    const doc = this.graph.entity({ type: "Document", name, key: `file:${sha256}` });
    doc.name = name;
    Object.assign(doc.properties, {
      name,
      file_sha256: sha256,
      content_type: mediaType,
      file_bytes: bytes.length,
    });
    const file = { sha256, name, mediaType, document: doc.iri, bytes };
    this.held.set(sha256, file);
    return file;
  }

  /** Uploads that gave a content a new `uploaded_at`. */
  private newUploads = 0;

  /** Delete a file, as `DELETE /v1/files`: its bytes are no longer read; its `Document` stays here. */
  remove(sha256: string): void {
    const upload = this.uploads.get(sha256);
    if (!upload?.live) throw new Error(`no live file ${sha256}`);
    this.uploads.set(sha256, { ...upload, live: false });
    this.held.delete(sha256);
  }

  /** The `uploaded_at` of a content's file. */
  uploadedAt(sha256: string): string | undefined {
    return this.uploads.get(sha256)?.uploadedAt;
  }

  /** The byte range of each read, `null` for a whole file, in order. */
  readonly ranges: Array<{ start: number; end: number | null } | null> = [];
  /** The bytes all reads answered. */
  bytesRead = 0;

  /**
   * A file's bytes, or with `range` bytes `start` to `end` (both included),
   * as `GET /v1/files/content` answers: a range past the end ends at the
   * end, and a range from the end on (a file without bytes too) throws
   * `LbbError` 416 `range_not_satisfiable`.
   */
  readonly files = {
    content: async (
      sha256: string,
      options: { range?: { start: number; end?: number } } = {},
    ): Promise<Uint8Array> => {
      this.reads += 1;
      const file = this.held.get(sha256);
      if (!file)
        throw new LbbError(404, "{}", { code: "file_not_found", message: `no file ${sha256}` });
      const range = options.range;
      this.ranges.push(range ? { start: range.start, end: range.end ?? null } : null);
      if (!range) {
        this.bytesRead += file.bytes.length;
        return file.bytes;
      }
      if (range.start >= file.bytes.length)
        throw new LbbError(416, "{}", {
          code: "range_not_satisfiable",
          message: `no byte of the file from ${range.start} on`,
        });
      const end = Math.min(range.end ?? file.bytes.length - 1, file.bytes.length - 1);
      const bytes = file.bytes.slice(range.start, end + 1);
      this.bytesRead += bytes.length;
      return bytes;
    },
  };

  readonly workflows = {
    derivations: {
      check: async (key: Schemas["DerivationKey"]): Promise<Schemas["DerivationCheckResponse"]> => {
        this.checks += 1;
        const file = this.uploads.get(key.sha256);
        const upload = file?.live ? file.uploadedAt : undefined;
        const derivation =
          file && !file.live ? undefined : this.current(derivationName(key), key.sha256);
        return {
          exists: Boolean(derivation),
          ...(derivation ? { derivation } : {}),
          ...(upload ? { content_uploaded_at: upload } : {}),
        };
      },
      record: async (
        request: Schemas["DerivationRecordRequest"],
      ): Promise<Schemas["DerivationRecordResponse"]> => {
        this.records.push(request);
        const named = request.content_uploaded_at;
        const upload = this.uploads.get(request.sha256);
        if (named && !(upload?.live && upload.uploadedAt === named))
          throw new LbbError(409, "{}", {
            code: "derivation_upload_changed",
            message: `the file was deleted since upload ${named}: nothing was recorded`,
            param: "content_uploaded_at",
          });
        const name = derivationName(request);
        const kept = this.current(name, request.sha256);
        if (kept) return { recorded: false, derivation: kept };
        const outputs = JSON.stringify(request.outputs ?? null);
        if (outputs.length > 16 * 1024)
          throw new LbbError(400, "{}", {
            code: "derivation_invalid",
            message: "outputs over 16 KiB",
          });
        const derivation = {
          sha256: request.sha256,
          workflow_type: request.workflow_type,
          version: request.version,
          settings_digest: request.settings_digest,
          run_id: request.run_id ?? null,
          outputs: JSON.parse(outputs) as unknown,
          recorded_at: "2026-10-15T09:00:00Z",
        };
        this.recorded.set(name, derivation);
        this.stamps.set(name, upload?.uploadedAt);
        return { recorded: true, derivation };
      },
    },
  };

  /** The derivation `name` when it belongs to the current upload of its content. */
  private current(name: string, sha256: string): Schemas["Derivation"] | undefined {
    const derivation = this.recorded.get(name);
    const upload = this.uploadedAt(sha256);
    if (!derivation || (upload !== undefined && this.stamps.get(name) !== upload)) return undefined;
    return derivation;
  }
}

const derivationName = (key: Schemas["DerivationKey"]) =>
  `${key.workflow_type}@${key.version}/${key.settings_digest}/${key.sha256}`;

/** The message a content trigger sends for one upload: its `Document`, with origin `content`. */
export function contentMessage(
  workflow: string,
  file: Pick<MockFile, "sha256" | "mediaType" | "document">,
): WorkflowTriggerMessage {
  return {
    type: "instances",
    workflow,
    graph: "samples",
    as_of_commit_seq: 7,
    reason: "changed",
    instances: [file.document],
    removed: [],
    origin: {
      kind: "content",
      trigger: workflow,
      sha256: file.sha256,
      media_type: file.mediaType,
      uploaded_at_ms: 1791967651158,
      requests: [`file-upload:${file.sha256}`],
    },
  };
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
 * A workflow value as JSON, as the SDK's worker writes it: a value JSON
 * cannot hold (undefined, a function, a number that is not finite) fails
 * the turn there, so it fails here too.
 */
function workflowJson(value: unknown, where: string): string {
  return JSON.stringify(value, (key, v: unknown) => {
    const bad =
      v === undefined ||
      typeof v === "function" ||
      typeof v === "symbol" ||
      typeof v === "bigint" ||
      (typeof v === "number" && !Number.isFinite(v));
    if (bad)
      throw new Error(
        `Workflow values must be JSON serializable (use null for no result): ${where}${key ? `.${key}` : ""} is ${typeof v}`,
      );
    return v;
  });
}

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
  options: {
    prefix?: string;
    saved?: Turn;
    crashAfter?: number;
    /** The engine identity that runs the turn (default `starter.test`), and the turn's number. */
    workflowId?: string;
    turn?: number;
  } = {},
): Promise<{ result: TurnResult<S>; turn: Turn }> {
  const prefix = options.prefix ?? mockId(JSON.stringify(message));
  const turn: Turn = { message, keys: [], outputs: [], bytes: 0, progress: [] };
  let busy = false;
  let ran = 0;
  const ctx = {
    signal: new AbortController().signal,
    workflowId: options.workflowId ?? "starter.test",
    messageId: "starter-test-1",
    turn: options.turn ?? 1,
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
        const json = workflowJson(output, `step "${key}"`);
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
  workflowJson(result.state, "state");
  if (result.continuation) workflowJson(result.continuation, "continuation");
  return { result, turn };
}

/**
 * Run a message and every continuation it leads to, from the empty state the
 * server creates the instance with. Returns the final state and the turns.
 * With `workflowId` and `turn`, the turns run as that identity, numbered
 * from `turn` on.
 */
export async function runMessage<S>(
  definition: WorkflowDefinition<S, WorkflowTriggerMessage>,
  message: WorkflowTriggerMessage,
  state: unknown = {},
  options: { workflowId?: string; turn?: number } = {},
) {
  const turns: Turn[] = [];
  let next: WorkflowTriggerMessage | undefined = message;
  while (next) {
    if (turns.length > 100) throw new Error("more than 100 turns");
    const ran: { result: TurnResult<S>; turn: Turn } = await runTurn(definition, state, next, {
      ...(options.workflowId ? { workflowId: options.workflowId } : {}),
      ...(options.turn !== undefined ? { turn: options.turn + turns.length } : {}),
    });
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
