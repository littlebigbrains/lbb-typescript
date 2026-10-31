// The fake engine and the fake world of the agent step's tests (no tests of
// its own). The engine saves the output of each step by key, as the turn
// record does, and can end an attempt at any step boundary: after a step's
// output is saved, or after its effect ran and before the output was saved.
// The world answers the host's reads and keeps what the host writes: commits
// by idempotency key, Review items by key, model calls by effect id.
// `sdk/conformance/agent-step` describes the same world in JSON.
import { LbbError } from "./transport.js";
import { agentValueKey, type AgentHost } from "./agent.js";
import { placeKind, readPlace } from "./locators.js";
import type { Schemas } from "./types.js";
import type {
  WorkflowContext,
  WorkflowStepContext,
  WorkflowStepOptions,
} from "./workflows.js";

/** The attempt was ended by the engine, as a lost worker ends it. */
export class Killed extends Error {
  constructor(
    readonly boundary: number,
    readonly phase: KillPhase,
  ) {
    super(`killed at step ${boundary} (${phase})`);
  }
}

export type KillPhase = "after_save" | "before_save";

export interface FileDef {
  uploaded_at: string;
  content_type: string;
  document?: string;
  generated?: boolean;
  text?: string;
  pages?: string[];
}

export interface WorldDef {
  commit_seq?: number;
  epoch?: string;
  files?: Record<string, FileDef>;
  entities?: Record<string, { type: string; name: string }>;
  /** A read answers with the first entry whose `match` the query contains. */
  reads?: { match: string; vars?: string[]; rows: Record<string, string>[] }[];
  /** A quote one of these names gets its verdict; any other is read from the file. */
  ground?: { quote: string; verdict: Record<string, unknown> }[];
  /** The support the decision model gives: by property name, or `default`. */
  support?: Record<string, number>;
  /** Answers in force, by `<subject IRI>|<property name>`. */
  answers?: Record<string, Decision | AnswerDef>;
  /** The commit is refused with this error. */
  commit_error?: { status: number; code: string };
  /** A read past this many calls takes `read_ms` each. */
  read_ms?: number;
}

export type Decision = "accept" | "correct" | "reject";

/** A person's answer in force on an item, as the Review inbox shows it. */
export interface AnswerDef {
  decision: Decision;
  /** The value a person gave (a correction). */
  value?: string | number;
  /** The value the item asked about. */
  asked?: string | number;
  /** The mark of the evidence the item was asked on. */
  evidence_hash?: string;
  /** The graph refused to write the answer. */
  commit_error?: string;
  /** The item is open again: asked on new evidence, the answer stays as the previous one. */
  reopened?: boolean;
}

export interface ModelReply {
  tool: string;
  arguments: Record<string, unknown>;
  summary?: string;
  cost_micro_usd?: number;
  /** A reply that is not valid JSON for the action schema. */
  raw?: unknown;
}

export interface Counters {
  head: number;
  sparql: number;
  files: number;
  ground: number;
  reason: number;
  decide: number;
  describe: number;
  reviewItems: number;
  review: number;
  commit: number;
}

const FILE_NOT_FOUND = () =>
  new LbbError(404, "{}", {
    type: "not_found",
    code: "file_not_found",
    message: "no such file",
  });

const fold = (text: string) => text.replace(/\s+/g, " ").trim();

/** The world a host answers from. */
export class FakeWorld {
  commitSeq: number;
  epoch: string;
  files: Map<string, FileDef>;
  readonly counters: Counters = {
    head: 0,
    sparql: 0,
    files: 0,
    ground: 0,
    reason: 0,
    decide: 0,
    describe: 0,
    reviewItems: 0,
    review: 0,
    commit: 0,
  };
  /** Model effect ids with the cost the first call was billed. */
  readonly billed = new Map<string, number>();
  readonly modelCalls = new Map<string, number>();
  /** Commits by idempotency key. */
  readonly commits = new Map<
    string,
    { seq: number; body: Schemas["TripletCommitFile"] }
  >();
  /** Times a commit body was applied (a replay is not). */
  applied = 0;
  /** The fields the commits set: `subject|property` to the value. */
  readonly facts = new Map<string, unknown>();
  /** Review items by key. */
  readonly reviews = new Map<string, Record<string, unknown>>();
  readonly reviewCalls = new Map<string, number>();
  /** The `as_of_commit_seq` of each graph read. */
  readonly readAt: (number | undefined)[] = [];
  /** The labels of model calls, in call order. */
  readonly labels: (string | undefined)[] = [];
  /** The requests of the decision model, in call order. */
  readonly decideRequests: Record<string, unknown>[] = [];
  readonly readQueries: string[] = [];

  constructor(
    readonly def: WorldDef,
    readonly script: ModelReply[] = [],
    readonly workflow = "doors",
  ) {
    this.commitSeq = def.commit_seq ?? 41;
    this.epoch = def.epoch ?? "epoch-1";
    this.files = new Map(Object.entries(def.files ?? {}));
  }

  /** Total of the cost the models billed, each effect id once. */
  billedTotal(): number {
    let total = 0;
    for (const cost of this.billed.values()) total += cost;
    return total;
  }

  /** What the world holds that a test compares: no counters. */
  summary() {
    return {
      commits: this.commits.size,
      applied: this.applied,
      facts: Object.fromEntries(
        [...this.facts].sort(([a], [b]) => a.localeCompare(b)),
      ),
      reviews: [...this.reviews.keys()].sort(),
      billed: this.billedTotal(),
    };
  }

  host(): AgentHost {
    return makeHost(this);
  }
}

/** One engine's saved steps and checkpoints, kept across attempts. */
export class FakeEngine {
  readonly saved = new Map<string, unknown>();
  readonly kinds = new Map<string, string>();
  readonly checkpoints = new Map<string, unknown>();
  /** The effect of a step ran this many times. */
  readonly runs = new Map<string, number>();
  /** Step keys in the order their first output was saved. */
  readonly order: string[] = [];
  kill?: { at: number; phase: KillPhase };
  /** Run after a step's output is first saved. */
  onSaved?: (key: string) => void;
  /** Run after a durable heartbeat, including one whose reply is lost. */
  onHeartbeat?: (key: string) => void;

  constructor(
    readonly identity = "wf-1",
    readonly messageId = "msg-1",
    readonly workflowName = "doors",
  ) {}

  /** The effect id of step `key`: what a model call under it is billed to. */
  effectId(key: string): string {
    return `${this.identity}/${this.messageId}/${key}`;
  }

  /** A context for one attempt. */
  context(): WorkflowContext {
    return makeContext(this);
  }

  /** Bytes of everything saved, as the turn record would hold it. */
  savedBytes(): number {
    let total = 0;
    for (const [key, value] of this.saved)
      total += new TextEncoder().encode(JSON.stringify({ key, value })).length;
    for (const [key, checkpoint] of this.checkpoints)
      total += new TextEncoder().encode(
        JSON.stringify({ key, checkpoint }),
      ).length;
    return total;
  }
}

/** The text of a place in a file, for a test that builds its own world. */
export function placeText(file: FileDef, locator: string): string | undefined {
  if (file.pages) {
    const page = /^page=(\d+)$/.exec(locator);
    return page ? file.pages[Number(page[1]) - 1] : undefined;
  }
  if (placeKind(file.content_type) === null) return undefined;
  const read = readPlace(file.content_type, locator, file.text ?? "");
  return read.ok ? read.text : undefined;
}

/** The host of a world. */
function makeHost(world: FakeWorld): AgentHost {
  const def = world.def;
  const supportOf = (property: string) =>
    def.support?.[property] ?? def.support?.default ?? 1;
  return {
    async reason(request, options) {
      world.counters.reason += 1;
      world.labels.push(options.label);
      const effect = options.effectId ?? "";
      world.modelCalls.set(effect, (world.modelCalls.get(effect) ?? 0) + 1);
      const n = Number(/\.i(\d+)\.decide$/.exec(effect)?.[1] ?? 0);
      const scripted = world.script[n - 1] ?? {
        tool: "finish",
        arguments: { summary: "The script ended." },
      };
      const cost = scripted.cost_micro_usd ?? 0;
      const cached = world.billed.has(effect);
      if (!cached) world.billed.set(effect, cost);
      void request;
      return {
        value:
          scripted.raw !== undefined
            ? scripted.raw
            : {
                tool: scripted.tool,
                arguments_json: JSON.stringify(scripted.arguments),
                summary: scripted.summary ?? "",
              },
        model: "fake-model",
        tokens_in: 100,
        tokens_out: 20,
        cost_micro_usd: world.billed.get(effect)!,
        cached,
      } as never;
    },
    async decide(request, options) {
      world.counters.decide += 1;
      world.labels.push(options.label);
      world.decideRequests.push(request as unknown as Record<string, unknown>);
      const effect = options.effectId ?? "";
      world.modelCalls.set(effect, (world.modelCalls.get(effect) ?? 0) + 1);
      if (!world.billed.has(effect)) world.billed.set(effect, 0);
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        const text = (question as { instructions: string }).instructions;
        const property = /Property: (\S+)/.exec(text)?.[1] ?? "";
        const name = property.slice(property.lastIndexOf("/") + 1);
        const support = supportOf(name);
        answers[id] = {
          choice: support >= 0.5 ? "supported" : "weak",
          confidence: support,
          probabilities: { supported: support },
        };
      }
      return { answers, model: "fake-model", cost_micro_usd: 0 } as never;
    },
    async ground(items) {
      world.counters.ground += 1;
      return items.map((item) => {
        const rule = def.ground?.find((r) => item.quote.includes(r.quote));
        if (rule) return rule.verdict as never;
        const sha = item.file.sha256;
        const file = world.files.get(sha);
        if (!file || file.uploaded_at !== item.file.uploaded_at)
          return { ok: false, code: "upload_changed" } as never;
        let text: string | undefined;
        if (file.pages) {
          const page = /^page=(\d+)$/.exec(item.locator);
          text = page ? file.pages[Number(page[1]) - 1] : undefined;
        } else {
          const read = readPlace(
            file.content_type,
            item.locator,
            file.text ?? "",
          );
          if (!read.ok)
            return {
              ok: false,
              code: "locator_invalid",
              reason: read.error,
            } as never;
          text = read.text;
        }
        if (text === undefined || !fold(text).includes(fold(item.quote)))
          return { ok: false, code: "quote_not_found" } as never;
        return {
          ok: true,
          value: { f64: Number.parseFloat(item.value) },
          stated: item.value,
          evidence: {
            quote: fold(item.quote),
            source_id: `${file.document ?? ""}#${item.locator}`,
            source_sha256: sha,
            uploaded_at: file.uploaded_at,
          },
        } as never;
      });
    },
    async head() {
      world.counters.head += 1;
      return { commitSeq: world.commitSeq, graphEpoch: world.epoch };
    },
    async sparql(query, asOfCommitSeq) {
      world.counters.sparql += 1;
      world.readAt.push(asOfCommitSeq);
      world.readQueries.push(query);
      const found = def.reads?.find((r) => query.includes(r.match));
      return {
        vars: found?.vars ?? [],
        rows: found?.rows ?? [],
        boolean: null,
      } as never;
    },
    async documentSha(iri) {
      world.counters.files += 1;
      for (const [sha, file] of world.files)
        if (file.document === iri) return sha;
      return undefined;
    },
    async fileRecord(sha256) {
      world.counters.files += 1;
      const file = world.files.get(sha256);
      if (!file) throw FILE_NOT_FOUND();
      return {
        sha256,
        uploadedAt: file.uploaded_at,
        contentType: file.content_type,
        ...(file.document ? { document: file.document } : {}),
        generated: file.generated === true,
      };
    },
    async fileBytes(sha256, range) {
      world.counters.files += 1;
      const file = world.files.get(sha256);
      if (!file) throw FILE_NOT_FOUND();
      return new TextEncoder()
        .encode(file.text ?? "")
        .slice(range.start, range.end);
    },
    async filePages(sha256, from, to) {
      world.counters.files += 1;
      const file = world.files.get(sha256);
      if (!file) throw FILE_NOT_FOUND();
      const pages = file.pages ?? [];
      return {
        pageCount: pages.length,
        pages: pages.slice(from, to).map((text) => ({ text })),
      };
    },
    async describe(iris) {
      world.counters.describe += 1;
      const found = new Map<string, { type: string; name: string }>();
      for (const iri of iris) {
        const entity = def.entities?.[iri];
        if (entity) found.set(iri, entity);
      }
      return found;
    },
    async reviewItems(keys) {
      world.counters.reviewItems += 1;
      const decided = new Map<string, AnswerDef>();
      for (const [pair, answer] of Object.entries(def.answers ?? {})) {
        const [subject, property] = pair.split("|") as [string, string];
        decided.set(
          agentValueKey(world.workflow, subject, property),
          typeof answer === "string" ? { decision: answer } : answer,
        );
      }
      return keys.flatMap((key) => {
        const answer = decided.get(key);
        if (answer)
          return [
            {
              id: `item-${key}`,
              key,
              status: answer.reopened ? "open" : "answered",
              answer: {
                decision: answer.decision,
                ...(answer.value !== undefined ? { value: answer.value } : {}),
              },
              ...(answer.reopened
                ? { previous_answer: { decision: answer.decision } }
                : {}),
              ...(answer.asked !== undefined
                ? { question: { value: answer.asked } }
                : {}),
              ...(answer.evidence_hash
                ? { evidence_hash: answer.evidence_hash }
                : {}),
              ...(answer.commit_error
                ? { effects: { commit_error: answer.commit_error } }
                : {}),
            } as never,
          ];
        return world.reviews.has(key)
          ? [{ id: `item-${key}`, key, status: "open" } as never]
          : [];
      });
    },
    async review(body) {
      world.counters.review += 1;
      const key = String(
        body.key ??
          JSON.stringify(body.subject) + JSON.stringify(body.question),
      );
      world.reviewCalls.set(key, (world.reviewCalls.get(key) ?? 0) + 1);
      world.reviews.set(key, body);
      return { id: `item-${key}`, status: "open" };
    },
    async commit(body, options) {
      world.counters.commit += 1;
      if (def.commit_error)
        throw new LbbError(def.commit_error.status, "{}", {
          type: "error",
          code: def.commit_error.code,
          message: def.commit_error.code,
        });
      const earlier = world.commits.get(options.idempotencyKey);
      if (earlier) return { commitSeq: earlier.seq, replayed: true };
      world.commitSeq += 1;
      world.commits.set(options.idempotencyKey, {
        seq: world.commitSeq,
        body,
      });
      world.applied += 1;
      for (const row of body.entity_properties ?? []) {
        const properties = Array.isArray(row.properties) ? row.properties : [];
        for (const property of properties as {
          field: string;
          value: unknown;
        }[])
          world.facts.set(
            `${row.key ?? row.name}|${property.field}`,
            property.value,
          );
      }
      return { commitSeq: world.commitSeq, replayed: false };
    },
  };
}

/** One attempt's context on an engine. */
function makeContext(engine: FakeEngine): WorkflowContext {
  let began = 0;
  const ctx: WorkflowContext = {
    signal: new AbortController().signal,
    workflowId: engine.identity,
    messageId: engine.messageId,
    turn: 1,
    workflowName: engine.workflowName,
    async step<T>(
      key: string,
      effect: (context: WorkflowStepContext) => Promise<T>,
      options?: WorkflowStepOptions,
    ): Promise<T> {
      if (engine.saved.has(key)) {
        if (engine.kinds.get(key) !== (options?.kind ?? "step"))
          throw new Error(`step ${key} replays with another kind`);
        return structuredClone(engine.saved.get(key)) as T;
      }
      began += 1;
      const index = began;
      engine.runs.set(key, (engine.runs.get(key) ?? 0) + 1);
      const step: WorkflowStepContext = {
        effectId: engine.effectId(key),
        signal: new AbortController().signal,
        checkpoint: structuredClone(engine.checkpoints.get(key) ?? null),
        async heartbeat(_details, heartbeat) {
          if (heartbeat && "checkpoint" in heartbeat)
            engine.checkpoints.set(key, structuredClone(heartbeat.checkpoint));
          engine.onHeartbeat?.(key);
        },
        progress() {},
      };
      const output = await effect(step);
      if (engine.kill?.at === index && engine.kill.phase === "before_save")
        throw new Killed(index, "before_save");
      // The output is kept as JSON, as the turn record keeps it.
      engine.saved.set(key, JSON.parse(JSON.stringify(output ?? null)));
      engine.checkpoints.delete(key);
      engine.kinds.set(key, options?.kind ?? "step");
      engine.order.push(key);
      engine.onSaved?.(key);
      if (engine.kill?.at === index && engine.kill.phase === "after_save")
        throw new Killed(index, "after_save");
      return output;
    },
    async waitForSignal() {
      throw new Error("the agent step waits for no signal");
    },
    async sleep() {
      throw new Error("the agent step does not sleep");
    },
    continue() {
      throw new Error("the agent step does not continue");
    },
  };
  return ctx;
}

// ---- a sample world ------------------------------------------------------------

export const BASE = "https://littlebigbrain.com/e/";
export const D1 = `${BASE}00000000000000000000000000000d01`;
export const D2 = `${BASE}00000000000000000000000000000d02`;
export const DOC = `${BASE}00000000000000000000000000000f01`;
export const SHA = "a".repeat(64);
export const STAMP = "2026-10-01T10:00:00Z";
export const TEXT = "Door D-1\nWidth: 600 mm\nHeight: 2100 mm\nWeight: 40 kg\n";

/** A world with one text file and two entities. */
export function sampleWorld(extra: Partial<WorldDef> = {}): WorldDef {
  return {
    files: {
      [SHA]: {
        uploaded_at: STAMP,
        content_type: "text/plain",
        document: DOC,
        text: TEXT,
      },
    },
    entities: {
      [D1]: { type: "Door", name: "D-1" },
      [D2]: { type: "Door", name: "D-2" },
    },
    ...extra,
  };
}

/** A proposal of the width of the first entity, as the model states it. */
export const sampleWidth = {
  subject: D1,
  property: "width_cm",
  value: "600",
  unit: "mm",
  file: { sha256: SHA },
  locator: "line=0,4",
  quote: "Width: 600 mm",
};

/** A scripted decision. */
export const sampleReply = (
  tool: string,
  args: Record<string, unknown>,
  cost = 1000,
): ModelReply => ({ tool, arguments: args, summary: "", cost_micro_usd: cost });
