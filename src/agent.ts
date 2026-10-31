// The agent step: a bounded tool loop inside a workflow turn
// (`docs/architecture/agent-step.md`). A handler calls `lbb.agent(ctx, key,
// spec)`. The model returns one action at a time; LBB-written tools run each
// action; the loop ends with `finish`. Every decision and every tool call is
// a checkpointed `ctx.step`, so a crash costs at most the step that ran. The
// model never writes: `propose_write` records a proposal and the server's
// `ground` activity judges its quote against the file; the commit phase
// writes the grounded proposals once, as one owned commit, and files a Review
// item for each value that needs a person.
//
// Replay: a turn that runs again replays the handler from the top. A saved
// step returns its saved output, so everything here that is not inside a step
// is a pure function of the saved steps: no clock read, no random number, no
// network call. The pin (`agent-protocol.ts`) stops a resume that runs other
// code against old decisions.
import {
  AGENT_RULES,
  AGENT_TOOLS,
  DECISION_MAX_TOKENS,
  DECISION_TIMEOUT_MS,
  FILE_READ_RETURN_BYTES,
  FILE_READ_SCAN_BYTES,
  GRAPH_READ_CALL_MS,
  GRAPH_READ_ROWS,
  INVALID_IN_A_ROW,
  RESULT_MAX_BYTES,
  SAVED_BYTES_FACTOR,
  SAVED_BYTES_GUARD,
  TOOL_TIMEOUT_MS,
  TRACE_LINES,
  TRACE_NOTE_BYTES,
  actionSchema,
  agentPin,
  supportQuestion,
  canonicalJson,
  cutBytes,
  decisionPrompt,
  jsonSize,
  parseAction,
  utf8,
  type AgentToolName,
  type Observation,
  type PromptState,
} from "./agent-protocol.js";
import { stableHashHex } from "./hash.js";
import { nextPlace, placeCount, placeOf, readPlace } from "./locators.js";
import { LbbError, type CallOptions } from "./transport.js";
import type { Schemas, SparqlResults } from "./types.js";
import {
  turnRunOf,
  WorkflowError,
  WorkflowWait,
  type WorkflowContext,
  type WorkflowStepContext,
} from "./workflows.js";
import type {
  ActivityOptions,
  DecideRequest,
  DecideResult,
  ReasonOptions,
  ReasonRequest,
  ReasonResult,
} from "./activities.js";
import type { WorkflowRunInput } from "./run-results.js";

export {
  AGENT_INTERPRETER,
  AGENT_TOOLS,
  type AgentToolName,
} from "./agent-protocol.js";

// ---- the spec -------------------------------------------------------------

/** What the run reads: a file, and the instances it is about. */
export interface AgentInput {
  /** A file's SHA-256 or its `Document` IRI: in the run's pinned set from the start. */
  file?: string;
  /** Entity IRIs the message names: subjects the run may propose values for. */
  instances?: readonly string[];
}

/** The spec of an agent step (`docs/architecture/agent-step.md` 1.2). */
export interface AgentSpec {
  /** The task in words. Part of the pin. 1 to 8,000 bytes. */
  instructions: string;
  /** The tools the model may call. `finish` is always there. Default: all three. */
  tools?: readonly AgentToolName[];
  /** Model decisions at most: 1 to 12. Default 8. */
  maxIterations?: number;
  /** The run's model cost at most, in micro-USD: 1 to 2,000,000. Default 200,000. */
  maxCostMicroUsd?: number;
  /** The run's time at most: 10,000 to 1,800,000 ms. Default 600,000. */
  maxWallMs?: number;
  /** The time of all `graph.read` calls: 1,000 to 120,000 ms. Default 60,000. */
  maxReadMs?: number;
  /** The support score a proposal needs to be written. Absent: no support check. */
  gate?: number;
  /** Proposals the run may record: 1 to 64. Default 64. */
  maxProposals?: number;
  /** Review items the run may file: 0 to 50. Default 10. */
  maxReviewItems?: number;
  /** How long a pin mismatch defers the turn: 60,000 to 3,600,000 ms. Default 900,000. */
  pinWaitMs?: number;
  /** The properties the step may set. Required. */
  owns: { properties: readonly string[] };
  /** What the run reads. */
  input: AgentInput;
  /**
   * The trigger message, for the bytes the turn record holds. Leave it out
   * for a message of a few lines.
   */
  message?: unknown;
  /** The workflow's name: the Review keys and the work key. Default: `ctx.workflowName`. */
  workflow?: string;
}

/** The options of one call that are not part of the spec. */
export interface AgentOptions {
  /**
   * A scripted plan in place of the model: the actions of the loop in order.
   * The run asks no model for its decisions, and a plan that ends finishes the
   * loop. A test or a local run without a model uses it.
   */
  plan?: readonly AgentPlanAction[];
  /**
   * Run under a hosted execution credential: the server builds the key and the
   * origin of a Review item and stamps the workflow, so the body carries
   * neither.
   */
  hosted?: boolean;
  /**
   * The support the decision model gives, in place of a `decide` call: a
   * number for every proposal, or a number by `property`. For a run with a
   * `plan`.
   */
  planSupport?: number | Record<string, number>;
}

/** One action of a scripted plan. */
export interface AgentPlanAction {
  tool: AgentToolName | "finish";
  arguments: Record<string, unknown>;
  summary?: string;
}

// ---- the result -----------------------------------------------------------

/** The first failing check of a proposal, or `grounded`. */
export type AgentVerdictCode =
  | "grounded"
  | "upload_changed"
  | "source_generated"
  | "locator_invalid"
  | "quote_not_found"
  | "quote_too_short"
  | "unknown_property"
  | "invalid_value"
  | "unit_unconfirmed"
  | "scan_budget"
  | "not_owned"
  | "source_not_pinned"
  | "subject_not_read"
  | "proposal_limit"
  | "weak_support"
  | "source_changed"
  /** The graph refused the write as invalid: the value waits for a person. */
  | "commit_refused"
  /** A person answered on other evidence or another value: the agent asks again. */
  | "new_evidence";

/** What the validator said of one proposal. */
export interface AgentVerdict {
  code: AgentVerdictCode;
  /** In words, at most 200 bytes. */
  message?: string;
  /** The value in the property's unit, as the server typed it. */
  typed?: Schemas["PropertyValueInput"];
  /** The value as the text states it (`600 mm`). */
  stated?: string;
  /** The IRI of the file's `Document`, from the evidence of a verified quote. */
  document?: string;
}

/** What became of a proposal. */
export type AgentDisposition =
  "written" | "review" | "failed" | "dropped" | "answered" | "rejected";

/** One value the model proposed, with its verdict and what became of it. */
export interface AgentProposal {
  subject: string;
  /** The property as a name (`width_cm`). */
  property: string;
  value: string;
  unit?: string;
  sha256: string;
  locator: string;
  quote: string;
  verdict: AgentVerdict;
  /** `undefined` while the commit phase has not decided it. */
  disposition?: AgentDisposition;
  /** The support the decision model gave, when the spec has a gate. */
  support?: number;
}

/** A line of the trace: what one iteration did. Plain text, at most 160 bytes. */
export interface AgentTraceLine {
  n: number;
  tool: string;
  ok: boolean;
  note: string;
}

export type AgentOutcome = "finished" | "limit" | "failed";
export type AgentLimit = "iterations" | "cost" | "wall" | "bytes";
export type AgentFailure =
  | "agent_limit"
  | "agent_invalid_action"
  | "agent_pin_changed"
  | "agent_effect_uncertain"
  | "agent_input_invalid";

/** What an agent step did. The run's results and the console read it. */
export interface AgentResult {
  outcome: AgentOutcome;
  /** For `limit`, which cap. */
  limit?: AgentLimit;
  /** For `failed`, the run-level code. */
  code?: AgentFailure;
  /** The model's summary at `finish`, or the words of the failure or the cap. */
  summary: string;
  iterations: number;
  maxIterations: number;
  tools: Record<string, number>;
  costMicroUsd: number;
  model?: string;
  pin: string;
  workKey: string;
  proposals: AgentProposal[];
  counts: { written: number; review: number; failed: number; dropped: number };
  trace: AgentTraceLine[];
}

// ---- the host -----------------------------------------------------------

/** A file's record, as the tools read it. */
export interface AgentFileRecord {
  sha256: string;
  uploadedAt: string;
  contentType: string;
  /** The `Document` IRI. */
  document?: string;
  /** A generated output: never evidence. */
  generated: boolean;
}

/**
 * What the interpreter needs from the world: the models, the graph, the
 * files, the commit and the Review inbox. {@link lbbAgentHost} makes one
 * from a client; a test hands the interpreter a scripted one.
 */
export interface AgentHost {
  reason<T>(
    request: ReasonRequest,
    options: ReasonOptions,
  ): Promise<ReasonResult<T>>;
  decide(
    request: DecideRequest,
    options: ActivityOptions,
  ): Promise<DecideResult>;
  /** `POST /v1/workflows/activities/ground`. */
  ground(
    items: Schemas["GroundItem"][],
    options?: CallOptions,
  ): Promise<Schemas["GroundResult"][]>;
  /** The head commit and the graph epoch, now. */
  head(
    signal?: AbortSignal,
  ): Promise<{ commitSeq: number | null; graphEpoch?: string }>;
  /** A SELECT or ASK at a commit. */
  sparql(
    query: string,
    asOfCommitSeq: number | undefined,
    signal?: AbortSignal,
  ): Promise<SparqlResults>;
  /** The SHA-256 of the file a `Document` IRI names, if any. */
  documentSha(iri: string, signal?: AbortSignal): Promise<string | undefined>;
  fileRecord(sha256: string, signal?: AbortSignal): Promise<AgentFileRecord>;
  /** The bytes `start` to `end` (excluded) of a file. */
  fileBytes(
    sha256: string,
    range: { start: number; end: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  /** The parsed text of the pages `from` to `to` (0-based, `to` excluded). */
  filePages(
    sha256: string,
    from: number,
    to: number,
    signal?: AbortSignal,
  ): Promise<{ pageCount: number; pages: { text: string }[] }>;
  /** The class (as an ontology name) and the display name of entities. */
  describe(
    iris: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, { type: string; name: string }>>;
  /** Called with each input the run writes, files or fails (a capture keeps them). */
  report?(input: WorkflowRunInput): void;
  /** The Review items filed under `keys`, of every status. */
  reviewItems(
    keys: string[],
    signal?: AbortSignal,
  ): Promise<Schemas["ReviewItem"][]>;
  /** File a Review item of kind `value`. */
  review(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ id?: string; status?: string }>;
  /**
   * The owned commit, under the step's effect id as the idempotency key. A
   * capture keeps the body and checks it with the dry run instead.
   */
  commit(
    body: Schemas["TripletCommitFile"],
    options: {
      idempotencyKey: string;
      fence?: Schemas["WorkflowFence"];
      graph?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ commitSeq: number | null; replayed: boolean }>;
}

// ---- saved step outputs ---------------------------------------------------

/** What `<key>.start` saves. */
interface StartRecord {
  pin: string;
  startedAtMs: number;
  commitSeq: number | null;
  graphEpoch?: string;
  /** The input file's stamp: in the pinned set from the start. */
  file?: { sha256: string; uploadedAt: string };
  instances: string[];
  /** Why the input cannot be read, when it cannot. */
  invalid?: string;
}

/** What a decision step saves: the validated action, never the raw reply. */
interface DecisionRecord {
  action?: {
    tool: AgentToolName | "finish";
    arguments: Record<string, unknown>;
    summary: string;
  };
  invalid?: string;
  stop?: "wall";
  model?: string;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
}

/** What a tool step saves: a bounded result. */
interface ToolRecord {
  ok: boolean;
  /** One line for the trace and the prompt. */
  note: string;
  result: Record<string, unknown>;
  /** The time a `graph.read` took. */
  elapsedMs?: number;
}

/** One verdict a `propose_write` result holds. */
interface SavedVerdict {
  i: number;
  property: string;
  code: AgentVerdictCode;
  message?: string;
  typed?: Schemas["PropertyValueInput"];
  stated?: string;
  document?: string;
}

interface SupportRecord {
  support: Record<string, number>;
  model?: string;
  costMicroUsd: number;
}

/** What an answered Review item says, kept small. */
interface AnswerRecord {
  decision: "accept" | "correct" | "reject";
  /** The value a person gave. */
  value?: string;
  /** The value the item asked about. */
  asked?: string;
  /** The mark of the evidence the item was asked on. */
  hash?: string;
  /** The graph refused to write the answer. */
  refused?: true;
}

interface RecheckRecord {
  /** Pairs whose evidence no longer holds. */
  changed: string[];
  /** Pairs whose file the server could not scan again in time. */
  unchecked: string[];
  /** The answer of a person on the item of a pair, by pair. */
  answered: Record<string, AnswerRecord>;
  /** Pairs whose item was asked again on new evidence: it holds the value. */
  held: string[];
  epochChanged: boolean;
}

interface WriteRecord {
  commitSeq: number | null;
  replayed: boolean;
  /** The commit was refused in a way that moves the pairs to Review. */
  refused?: string;
  /** What the graph said, at most 200 bytes. */
  message?: string;
  /** An effect that may have landed and cannot be settled. */
  uncertain?: string;
}

interface ReviewRecord {
  filed: { pair: string; id?: string; status?: string }[];
}

// ---- the loop's view of what is saved ----------------------------------------

const ENTITY_IRI = /^https:\/\/littlebigbrain\.com\/e\/[0-9a-fA-F]{32}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;
const PROPERTY_NAMESPACE = "https://littlebigbrain.com/p/";
const CLAMP = { support: 1 };

const pad = (n: number) => String(n).padStart(2, "0");

/** A label of a model call is at most 64 characters: cut with a hash of the whole. */
function label(text: string): string {
  return text.length <= 64
    ? text
    : `${text.slice(0, 55)}~${stableHashHex([text]).slice(0, 8)}`;
}
const lower = (text: string) => text.toLowerCase();

/** A property as a name: the last part of its IRI, else as given. */
export function propertyName(property: string): string {
  return property.startsWith(PROPERTY_NAMESPACE)
    ? property.slice(PROPERTY_NAMESPACE.length)
    : property;
}

/** The pair a proposal is recorded under: a subject and a property. */
const pairOf = (subject: string, property: string) =>
  `${subject}|${lower(propertyName(property))}`;

/** The key of the Review item of a value: the same for a rerun and for the server. */
export function agentValueKey(
  workflow: string,
  subject: string,
  property: string,
): string {
  const hash = stableHashHex(["agent_value_v1", subject, property]);
  return `agent:${workflow}:value:${hash.slice(0, 24)}`;
}

/** The `wk_` id of one item of work: the same on every attempt of one message. */
export function agentWorkKey(
  workflow: string,
  identity: string,
  messageId: string,
): string {
  return `wk_${stableHashHex([workflow, identity, messageId]).slice(0, 16)}`;
}

interface Resolved {
  instructions: string;
  tools: AgentToolName[];
  maxIterations: number;
  maxCostMicroUsd: number;
  maxWallMs: number;
  maxReadMs: number;
  gate?: number;
  maxProposals: number;
  maxReviewItems: number;
  pinWaitMs: number;
  owns: string[];
}

function whole(
  name: string,
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || v < min || v > max)
    throw new WorkflowError(`${name} is a whole number from ${min} to ${max}`);
  return v;
}

/** The spec with its defaults, or a {@link WorkflowError} for a spec the bounds refuse. */
export function resolveSpec(spec: AgentSpec): Resolved {
  if (
    typeof spec.instructions !== "string" ||
    !spec.instructions.trim() ||
    utf8(spec.instructions) > 8_000
  )
    throw new WorkflowError("instructions are 1 to 8,000 bytes of text");
  const tools = [...(spec.tools ?? AGENT_TOOLS)];
  if (
    new Set(tools).size !== tools.length ||
    tools.some((tool) => !AGENT_TOOLS.includes(tool))
  )
    throw new WorkflowError(
      `tools is a set of ${AGENT_TOOLS.join(", ")} (finish is always there)`,
    );
  if (
    spec.gate !== undefined &&
    !(typeof spec.gate === "number" && spec.gate >= 0 && spec.gate <= 1)
  )
    throw new WorkflowError("gate is a number from 0 to 1");
  const owns = [...(spec.owns?.properties ?? [])];
  if (!owns.length)
    throw new WorkflowError(
      "owns.properties names the properties the step may set",
    );
  return {
    instructions: spec.instructions,
    tools,
    maxIterations: whole("maxIterations", spec.maxIterations, 8, 1, 12),
    maxCostMicroUsd: whole(
      "maxCostMicroUsd",
      spec.maxCostMicroUsd,
      200_000,
      1,
      2_000_000,
    ),
    maxWallMs: whole("maxWallMs", spec.maxWallMs, 600_000, 10_000, 1_800_000),
    maxReadMs: whole("maxReadMs", spec.maxReadMs, 60_000, 1_000, 120_000),
    ...(spec.gate !== undefined ? { gate: spec.gate } : {}),
    maxProposals: whole("maxProposals", spec.maxProposals, 64, 1, 64),
    maxReviewItems: whole("maxReviewItems", spec.maxReviewItems, 10, 0, 50),
    pinWaitMs: whole("pinWaitMs", spec.pinWaitMs, 900_000, 60_000, 3_600_000),
    owns,
  };
}

/** The pin of a spec: what a resume checks. */
export function specPin(spec: AgentSpec): string {
  const cfg = resolveSpec(spec);
  return agentPin({
    tools: cfg.tools,
    instructions: cfg.instructions,
    maxIterations: cfg.maxIterations,
    maxCostMicroUsd: cfg.maxCostMicroUsd,
    maxWallMs: cfg.maxWallMs,
    maxReadMs: cfg.maxReadMs,
    maxProposals: cfg.maxProposals,
    maxReviewItems: cfg.maxReviewItems,
    owns: cfg.owns.map(propertyName),
    ...(cfg.gate !== undefined ? { gate: cfg.gate } : {}),
  });
}

/** The proposal of a decision, as the model gave it. */
interface RawProposal {
  subject: string;
  property: string;
  value: string;
  unit?: string;
  file: { sha256: string; uploaded_at?: string };
  locator: string;
  quote: string;
}

/**
 * Everything the loop knows, built from saved steps only. A replay builds it
 * again from the same steps and reaches the same state.
 */
class Run {
  readonly decisions: DecisionRecord[] = [];
  readonly observations: Observation[] = [];
  readonly trace: AgentTraceLine[] = [];
  readonly toolCounts: Record<string, number> = {};
  /** Files the run read: sha -> upload stamp. */
  readonly pinned = new Map<string, string>();
  readonly subjects = new Set<string>();
  readonly proposals = new Map<string, AgentProposal>();
  costMicroUsd = 0;
  model: string | undefined;
  readMs = 0;
  savedBytes: number;
  iterations = 0;
  invalidInARow = 0;
  snapshotGone = false;

  constructor(
    readonly cfg: Resolved,
    readonly start: StartRecord,
    baseBytes: number,
  ) {
    this.savedBytes = baseBytes + jsonSize(start);
    if (start.file) this.pinned.set(start.file.sha256, start.file.uploadedAt);
    for (const iri of start.instances) this.subjects.add(iri);
  }

  /** The bytes the turn record would hold, with the factor. */
  projectedBytes(): number {
    return Math.ceil(this.savedBytes * SAVED_BYTES_FACTOR);
  }

  addDecision(n: number, record: DecisionRecord): void {
    this.savedBytes += jsonSize(record);
    this.decisions.push(record);
    this.iterations = n;
    this.costMicroUsd += record.costMicroUsd;
    this.model = record.model ?? this.model;
    if (record.invalid !== undefined) {
      this.invalidInARow += 1;
      this.observations.push({
        n,
        tool: "invalid_action",
        asked: "",
        summary: `invalid action: ${record.invalid}`,
        result: JSON.stringify({
          error: "invalid_action",
          message: record.invalid,
        }),
      });
      this.trace.push({
        n,
        tool: "invalid_action",
        ok: false,
        note: noteOf(record.invalid),
      });
    } else {
      this.invalidInARow = 0;
    }
  }

  addTool(
    n: number,
    action: NonNullable<DecisionRecord["action"]>,
    record: ToolRecord,
  ): void {
    this.savedBytes += jsonSize(record);
    this.toolCounts[action.tool] = (this.toolCounts[action.tool] ?? 0) + 1;
    this.observations.push({
      n,
      tool: action.tool,
      asked: askedOf(action),
      summary: record.note,
      result: JSON.stringify(record.result),
    });
    this.trace.push({
      n,
      tool: action.tool,
      ok: record.ok,
      note: noteOf(action.summary || record.note),
    });
    if (action.tool === "graph.read") {
      this.readMs += record.elapsedMs ?? 0;
      if (record.result.error === "snapshot_unavailable")
        this.snapshotGone = true;
      for (const iri of iris(record.result)) this.subjects.add(iri);
    }
    if (action.tool === "files.read" && record.ok) {
      const sha = record.result.sha256;
      const at = record.result.uploaded_at;
      if (typeof sha === "string" && typeof at === "string")
        this.pinned.set(sha, at);
    }
    if (action.tool === "propose_write") this.recordProposals(action, record);
  }

  private recordProposals(
    action: NonNullable<DecisionRecord["action"]>,
    record: ToolRecord,
  ): void {
    const raw = (action.arguments.proposals ?? []) as RawProposal[];
    const verdicts = (record.result.verdicts ?? []) as SavedVerdict[];
    for (const verdict of verdicts) {
      const p = raw[verdict.i];
      if (!p) continue;
      const property = propertyName(p.property);
      this.proposals.set(pairOf(p.subject, property), {
        subject: p.subject,
        property,
        value: p.value,
        ...(p.unit ? { unit: p.unit } : {}),
        sha256: lower(p.file.sha256),
        locator: p.locator,
        quote: p.quote,
        verdict: {
          code: verdict.code,
          ...(verdict.message ? { message: verdict.message } : {}),
          ...(verdict.typed ? { typed: verdict.typed } : {}),
          ...(verdict.stated ? { stated: verdict.stated } : {}),
          ...(verdict.document ? { document: verdict.document } : {}),
        },
      });
    }
  }

  addExtra(output: unknown, costMicroUsd = 0): void {
    this.savedBytes += jsonSize(output);
    this.costMicroUsd += costMicroUsd;
  }

  promptState(n: number, input: unknown): PromptState {
    return {
      iteration: n,
      maxIterations: this.cfg.maxIterations,
      files: [...this.pinned].map(([sha256, uploadedAt]) => ({
        sha256,
        uploadedAt,
      })),
      subjects: [...this.subjects].slice(0, 100),
      owns: this.cfg.owns,
      proposals: [...this.proposals.values()].map(
        (p) => `${p.property} of ${p.subject}: ${p.verdict.code}`,
      ),
      input,
    };
  }
}

/** A line of the model's own words, cut to a trace note. */
const noteOf = (text: string) =>
  cutBytes(text.replace(/\s+/g, " ").trim(), TRACE_NOTE_BYTES);

/** What the model asked, in a short line. */
function askedOf(action: NonNullable<DecisionRecord["action"]>): string {
  const args = action.arguments;
  const text =
    action.tool === "graph.read"
      ? String(args.query ?? "")
      : action.tool === "files.read"
        ? `${String(args.file ?? "")} ${String(args.locator ?? "")}`
        : action.tool === "propose_write"
          ? `${Array.isArray(args.proposals) ? args.proposals.length : 0} proposals`
          : "";
  return cutBytes(text.replace(/\s+/g, " ").trim(), 120);
}

/** The entity IRIs in the rows of a graph.read result. */
function iris(result: Record<string, unknown>): string[] {
  const found: string[] = [];
  const rows = result.rows;
  if (!Array.isArray(rows)) return found;
  for (const row of rows)
    if (row && typeof row === "object")
      for (const value of Object.values(row as Record<string, unknown>))
        if (typeof value === "string" && ENTITY_IRI.test(value))
          found.push(value);
  return found;
}

/** A tool result cut to the bound, with `truncated` and `original_bytes`. */
function boundedResult(
  result: Record<string, unknown>,
): Record<string, unknown> {
  const size = jsonSize(result);
  if (size <= RESULT_MAX_BYTES) return result;
  const out: Record<string, unknown> = { ...result };
  const rows = Array.isArray(result.rows)
    ? [...(result.rows as unknown[])]
    : null;
  if (rows) {
    while (
      rows.length &&
      jsonSize({ ...out, rows, truncated: true, original_bytes: size }) >
        RESULT_MAX_BYTES
    )
      rows.pop();
    return { ...out, rows, truncated: true, original_bytes: size };
  }
  const text = typeof result.text === "string" ? result.text : undefined;
  if (text !== undefined) {
    let keep = Math.max(0, utf8(text) - (size - RESULT_MAX_BYTES) - 64);
    let cut = cutBytes(text, keep);
    while (
      jsonSize({ ...out, text: cut, truncated: true, original_bytes: size }) >
        RESULT_MAX_BYTES &&
      keep > 0
    ) {
      keep = Math.floor(keep * 0.9);
      cut = cutBytes(text, keep);
    }
    return { ...out, text: cut, truncated: true, original_bytes: size };
  }
  return { truncated: true, original_bytes: size };
}

// ---- reading a query --------------------------------------------------------

/** An IRI reference: no space and none of the characters an IRI leaves out. */
const IRI_REFERENCE = /<[^<>"{}|^`\\\s]*>/y;

/**
 * The query with its comments and strings taken out, and its IRIs taken out
 * too unless `keepIris`. It reads the text once, left to right, so a `#` in an
 * IRI (`<http://e/ns#>`) or in a string starts no comment, and a quote in a
 * comment starts no string. A string has one of the four forms of the grammar:
 * short with double or single quotes, or long with three of either. A short
 * string that is not closed ends at its line, a long one at the end of the
 * query; the server refuses such a query.
 */
function maskQuery(query: string, keepIris: boolean): string {
  let out = "";
  let i = 0;
  while (i < query.length) {
    const c = query[i]!;
    if (c === "#") {
      while (i < query.length && query[i] !== "\n" && query[i] !== "\r") i++;
      out += " ";
    } else if (c === '"' || c === "'") {
      const quote = query.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      i += quote.length;
      while (i < query.length) {
        if (query[i] === "\\") i += 2;
        else if (query.startsWith(quote, i)) {
          i += quote.length;
          break;
        } else if (quote.length === 1 && /[\n\r]/.test(query[i]!)) break;
        else i++;
      }
      out += '""';
    } else if (c === "<") {
      IRI_REFERENCE.lastIndex = i;
      const found = IRI_REFERENCE.exec(query);
      if (found) {
        out += keepIris ? found[0] : "<>";
        i += found[0].length;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Why a query is refused, or `null`: SELECT and ASK only, no SERVICE, no similarity. */
export function refuseQuery(query: string): string | null {
  const masked = maskQuery(query, false);
  const body = masked.replace(
    /^\s*(?:(?:BASE\s*<>|PREFIX\s+[^\s:]*:\s*<>)\s*)*/i,
    "",
  );
  const form = /^\s*(SELECT|ASK)\b/i.exec(body);
  if (!form) return "only a SELECT or an ASK runs";
  if (/\bSERVICE\b/i.test(masked)) return "SERVICE is not allowed";
  // The predicate may be an IRI or a prefixed name: read the IRIs too.
  if (/similarTo/i.test(maskQuery(query, true)))
    return "a similarity pattern is not allowed";
  return null;
}

// ---- the interpreter ---------------------------------------------------------

/**
 * Run an agent step. `key` names the steps (`<key>.start`, `<key>.i01.decide`,
 * …): letters, digits, `_` and `-`, 1 to 64 characters.
 */
export async function runAgent(
  host: AgentHost,
  ctx: WorkflowContext,
  key: string,
  spec: AgentSpec,
  options: AgentOptions = {},
): Promise<AgentResult> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key))
    throw new WorkflowError(
      "an agent step key is 1 to 64 letters, digits, _ or -",
    );
  const cfg = resolveSpec(spec);
  const workflow = spec.workflow ?? ctx.workflowName ?? "agent";
  const pin = specPin(spec);
  const workKey = agentWorkKey(workflow, ctx.workflowId, ctx.messageId);
  // The guard counts the message when the spec carries it. A trigger message
  // is at most 32 KiB, and the guard stops the saved steps at 128 KiB of raw
  // bytes, so a message the spec leaves out still fits the 256 KiB record with
  // its envelopes (the largest record is tested in `lbb-workflows`).
  const baseBytes = jsonSize(spec.message ?? null);
  const turnResults = turnRunOf(ctx)?.results;
  const report = (input: WorkflowRunInput): void => {
    turnResults?.add(input);
    host.report?.(input);
  };
  const owned = new Set(cfg.owns.map((name) => lower(propertyName(name))));

  // ---- the start step: the pin, the snapshot, the input ----
  const start = await ctx.step<StartRecord>(
    `${key}.start`,
    async (s) => startStep(host, s, pin, spec),
    { kind: "step" },
  );
  const finish = (
    partial: Pick<AgentResult, "outcome"> &
      Partial<AgentResult> & { summary: string },
    run?: Run,
  ): AgentResult => {
    const proposals = run ? [...run.proposals.values()] : [];
    const counts = { written: 0, review: 0, failed: 0, dropped: 0 };
    for (const p of proposals) {
      if (p.disposition === "written") counts.written += 1;
      else if (p.disposition === "review") counts.review += 1;
      else if (p.disposition === "dropped") counts.dropped += 1;
      else if (p.disposition === "failed") counts.failed += 1;
    }
    return {
      iterations: run?.iterations ?? 0,
      maxIterations: cfg.maxIterations,
      tools: run?.toolCounts ?? {},
      costMicroUsd: run?.costMicroUsd ?? 0,
      ...(run?.model ? { model: run.model } : {}),
      pin,
      workKey,
      proposals,
      counts,
      trace: (run?.trace ?? []).slice(0, TRACE_LINES),
      ...partial,
    };
  };

  // The pin comes first: a different one runs no tool and calls no model.
  if (start.pin !== pin) {
    const elapsed = Date.now() - start.startedAtMs;
    if (elapsed >= cfg.pinWaitMs)
      return finish({
        outcome: "failed",
        code: "agent_pin_changed",
        summary: "The agent's code or tools changed during the run.",
      });
    const wait = Math.min(300_000, Math.max(30_000, Math.floor(elapsed / 4)));
    throw new WorkflowWait(
      Date.now() + wait,
      "the agent's code or tools changed since the run began",
    );
  }
  if (start.invalid !== undefined)
    return finish({
      outcome: "failed",
      code: "agent_input_invalid",
      summary: start.invalid,
    });

  const run = new Run(cfg, start, baseBytes);
  const input = { file: start.file?.sha256, instances: start.instances };
  const plan = options.plan;

  // ---- the loop ----
  let end:
    | { outcome: "finished"; summary: string }
    | { outcome: "limit"; limit: AgentLimit }
    | { outcome: "failed"; code: AgentFailure; summary: string }
    | undefined;
  for (let n = 1; n <= cfg.maxIterations && !end; n++) {
    if (run.costMicroUsd >= cfg.maxCostMicroUsd) {
      end = { outcome: "limit", limit: "cost" };
      break;
    }
    if (run.projectedBytes() >= SAVED_BYTES_GUARD) {
      end = { outcome: "limit", limit: "bytes" };
      break;
    }
    const decision = await ctx.step<DecisionRecord>(
      `${key}.i${pad(n)}.decide`,
      async (s) => decideStep(host, s, run, cfg, key, n, input, start, plan),
      { kind: "model", timeoutMs: DECISION_TIMEOUT_MS },
    );
    run.addDecision(n, decision);
    if (decision.stop) {
      end = { outcome: "limit", limit: decision.stop };
      break;
    }
    if (decision.invalid !== undefined) {
      if (run.invalidInARow >= INVALID_IN_A_ROW)
        end = {
          outcome: "failed",
          code: "agent_invalid_action",
          summary: `Two invalid actions in a row: ${decision.invalid}`,
        };
      continue;
    }
    const action = decision.action!;
    if (action.tool === "finish") {
      end = {
        outcome: "finished",
        summary: String(action.arguments.summary ?? ""),
      };
      break;
    }
    if (run.projectedBytes() >= SAVED_BYTES_GUARD) {
      end = { outcome: "limit", limit: "bytes" };
      break;
    }
    const tool = await ctx.step<ToolRecord>(
      `${key}.i${pad(n)}.tool`,
      async (s) => toolStep(host, s, run, cfg, action, n, start, owned),
      { kind: "tool", timeoutMs: TOOL_TIMEOUT_MS },
    );
    run.addTool(n, action, tool);
  }
  end ??= { outcome: "limit", limit: "iterations" };

  const finished = end.outcome === "finished";

  // ---- the commit phase ----
  const phase = await commitPhase({
    host,
    ctx,
    key,
    cfg,
    run,
    start,
    workflow,
    finished,
    options,
    report,
  });
  if (phase.uncertain !== undefined)
    return finish(
      {
        outcome: "failed",
        code: "agent_effect_uncertain",
        summary: `The commit may or may not have landed (${phase.uncertain}). Inspect the graph and the Review items, then run the input again.`,
      },
      run,
    );
  if (end.outcome === "finished")
    return finish({ outcome: "finished", summary: end.summary }, run);
  if (end.outcome === "failed")
    return finish(
      { outcome: "failed", code: end.code, summary: end.summary },
      run,
    );
  return finish(
    {
      outcome: "limit",
      code: "agent_limit",
      limit: end.limit,
      summary: `The loop reached its ${end.limit} cap. Raise the cap or narrow the task.`,
    },
    run,
  );
}

// ---- steps ------------------------------------------------------------------

async function startStep(
  host: AgentHost,
  s: WorkflowStepContext,
  pin: string,
  spec: AgentSpec,
): Promise<StartRecord> {
  const head = await host.head(s.signal);
  const record: StartRecord = {
    pin,
    startedAtMs: Date.now(),
    commitSeq: head.commitSeq,
    ...(head.graphEpoch !== undefined ? { graphEpoch: head.graphEpoch } : {}),
    instances: [...(spec.input.instances ?? [])].filter((iri) =>
      ENTITY_IRI.test(iri),
    ),
  };
  const file = spec.input.file;
  if (file !== undefined) {
    try {
      const sha = SHA256.test(file)
        ? lower(file)
        : await host.documentSha(file, s.signal);
      if (!sha)
        return { ...record, invalid: "The input file is not in the graph." };
      const info = await host.fileRecord(sha, s.signal);
      if (info.generated)
        return {
          ...record,
          invalid: "The input file is a generated output, not a source.",
        };
      record.file = { sha256: info.sha256, uploadedAt: info.uploadedAt };
    } catch (error) {
      if (
        error instanceof LbbError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429
      )
        return { ...record, invalid: "The input file cannot be read." };
      throw error;
    }
  }
  return record;
}

async function decideStep(
  host: AgentHost,
  s: WorkflowStepContext,
  run: Run,
  cfg: Resolved,
  key: string,
  n: number,
  input: unknown,
  start: StartRecord,
  plan: readonly AgentPlanAction[] | undefined,
): Promise<DecisionRecord> {
  // The wall cap is read from the clock inside the step, so the answer is
  // saved with the step and a replay does not ask the clock again.
  if (Date.now() - start.startedAtMs >= cfg.maxWallMs)
    return { stop: "wall", tokensIn: 0, tokensOut: 0, costMicroUsd: 0 };
  s.progress(`iteration ${n} of ${cfg.maxIterations}`, {
    done: n - 1,
    total: cfg.maxIterations,
    unit: "iterations",
  });
  let reply: unknown;
  let model: string | undefined;
  let usage = { tokensIn: 0, tokensOut: 0, costMicroUsd: 0 };
  if (plan) {
    const step = plan[n - 1] ?? {
      tool: "finish" as const,
      arguments: { summary: "The plan ended." },
    };
    reply = {
      tool: step.tool,
      arguments_json: JSON.stringify(step.arguments),
      summary: step.summary ?? "",
    };
  } else {
    const prompt = decisionPrompt(
      cfg.instructions,
      cfg.tools,
      run.promptState(n, input),
      run.observations,
    );
    try {
      const answer = await host.reason<unknown>(
        {
          prompt,
          system: AGENT_RULES,
          schema: actionSchema(cfg.tools) as unknown as Record<string, unknown>,
          max_tokens: DECISION_MAX_TOKENS,
        },
        { effectId: s.effectId, label: label(`${key} i${pad(n)} decide`) },
      );
      reply = answer.value;
      model = answer.model;
      usage = {
        tokensIn: answer.tokens_in ?? 0,
        tokensOut: answer.tokens_out ?? 0,
        costMicroUsd: answer.cost_micro_usd ?? 0,
      };
    } catch (error) {
      // A model that cannot return the schema is refused (422); the call
      // cost its tokens and counts as an invalid action.
      if (
        error instanceof LbbError &&
        error.code === "activity_request_refused"
      )
        return {
          invalid: "the model gave no usable action",
          tokensIn: 0,
          tokensOut: 0,
          costMicroUsd: 0,
        };
      throw error;
    }
  }
  const parsed = parseAction(reply, cfg.tools);
  if (!parsed.ok)
    return {
      invalid: parsed.reason,
      ...(model ? { model } : {}),
      ...usage,
    };
  return {
    action: {
      tool: parsed.tool,
      arguments: parsed.arguments,
      summary: parsed.summary,
    },
    ...(model ? { model } : {}),
    ...usage,
  };
}

/** A signal that ends after `ms`, or when `signal` does. */
function timed(
  signal: AbortSignal,
  ms: number,
): { signal: AbortSignal; done(): void; timedOut(): boolean } {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  signal.addEventListener("abort", abort, { once: true });
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort(new Error("timed out"));
  }, ms);
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    },
    // Our own time cap ended the call, not the lease or the worker.
    timedOut: () => fired && !signal.aborted,
  };
}

const refused = (
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
): ToolRecord => ({
  ok: false,
  note: `${error}: ${message}`.slice(0, 120),
  result: { error, message, ...extra },
});

async function toolStep(
  host: AgentHost,
  s: WorkflowStepContext,
  run: Run,
  cfg: Resolved,
  action: NonNullable<DecisionRecord["action"]>,
  n: number,
  start: StartRecord,
  owned: ReadonlySet<string>,
): Promise<ToolRecord> {
  s.progress(`iteration ${n} of ${cfg.maxIterations}`, {
    done: n,
    total: cfg.maxIterations,
    unit: "iterations",
  });
  const timer = timed(s.signal, TOOL_TIMEOUT_MS - 5_000);
  try {
    if (action.tool === "graph.read")
      return await graphRead(
        host,
        run,
        cfg,
        action.arguments,
        start,
        timer.signal,
      );
    if (action.tool === "files.read")
      return await filesRead(host, action.arguments, timer.signal);
    if (action.tool === "propose_write")
      return await proposeWrite(
        host,
        run,
        cfg,
        action.arguments,
        owned,
        timer.signal,
      );
    return refused("unknown_tool", action.tool);
  } catch (error) {
    // The time cap of the call ended it. The model gets that as the result of
    // the tool: a step that threw would run the same call again, and again.
    if (timer.timedOut())
      return refused(
        "tool_timeout",
        `the ${action.tool} call took longer than ${(TOOL_TIMEOUT_MS - 5_000) / 1_000} seconds`,
      );
    throw error;
  } finally {
    timer.done();
  }
}

async function graphRead(
  host: AgentHost,
  run: Run,
  cfg: Resolved,
  args: Record<string, unknown>,
  start: StartRecord,
  signal: AbortSignal,
): Promise<ToolRecord> {
  if (run.snapshotGone)
    return refused(
      "snapshot_unavailable",
      "the graph cannot be read at this run's commit any more",
    );
  if (run.readMs >= cfg.maxReadMs)
    return refused(
      "read_budget",
      "the time for graph reads of this run is spent",
    );
  const query = String(args.query);
  const why = refuseQuery(query);
  if (why) return refused("query_refused", why);
  const began = Date.now();
  const limit = timed(signal, GRAPH_READ_CALL_MS);
  try {
    const answer = await host.sparql(
      query,
      start.commitSeq ?? undefined,
      limit.signal,
    );
    const elapsedMs = Date.now() - began;
    if (answer.boolean !== null)
      return {
        ok: true,
        note: `ASK: ${answer.boolean}`,
        result: { boolean: answer.boolean },
        elapsedMs,
      };
    const truncated = answer.rows.length > GRAPH_READ_ROWS;
    const rows = answer.rows.slice(0, GRAPH_READ_ROWS);
    const result = boundedResult({
      vars: answer.vars,
      rows,
      ...(truncated ? { truncated: true } : {}),
    });
    return {
      ok: true,
      note: `${rows.length} row${rows.length === 1 ? "" : "s"}${truncated || result.truncated ? " (cut)" : ""}`,
      result,
      elapsedMs,
    };
  } catch (error) {
    const elapsedMs = Date.now() - began;
    // A call past its time answers as the budget does, and the whole time of
    // the call counts against the run's budget.
    if (limit.timedOut())
      return {
        ...refused(
          "read_budget",
          `the read took longer than ${GRAPH_READ_CALL_MS / 1_000} seconds`,
        ),
        elapsedMs: Math.max(elapsedMs, GRAPH_READ_CALL_MS),
      };
    if (
      error instanceof LbbError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 429
    ) {
      const gone = /snapshot|as_of|retained|generation/i.test(
        `${error.code} ${error.message}`,
      );
      return {
        ...refused(
          gone ? "snapshot_unavailable" : "query_refused",
          cutBytes(error.message, 200),
        ),
        elapsedMs,
      };
    }
    throw error;
  } finally {
    limit.done();
  }
}

const decoder = new TextDecoder("utf-8");

async function filesRead(
  host: AgentHost,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ToolRecord> {
  const file = String(args.file);
  const locator = String(args.locator);
  let sha: string | undefined;
  try {
    sha = SHA256.test(file)
      ? lower(file)
      : await host.documentSha(file, signal);
    if (!sha)
      return refused(
        "file_not_found",
        "no file has that SHA-256 or Document IRI",
      );
    const info = await host.fileRecord(sha, signal);
    if (info.generated)
      return refused(
        "source_generated",
        "the file is a generated output, not a source",
      );
    const checked = placeOf(info.contentType, locator);
    if (!checked.ok)
      return refused(
        "locator_invalid",
        checked.error,
        checked.error === "unsupported_media_type"
          ? { media_type: info.contentType }
          : {},
      );
    const place = checked.place;
    let text: string;
    let next: string | undefined;
    if (place.kind === "page") {
      const read = await host.filePages(
        sha,
        place.page - 1,
        place.page,
        signal,
      );
      if (place.page > read.pageCount)
        return refused("locator_invalid", "out_of_range");
      text = read.pages.map((page) => page.text).join("\n");
      next = nextPlace(place, read.pageCount);
    } else {
      const bytes = await host.fileBytes(
        sha,
        { start: 0, end: FILE_READ_SCAN_BYTES },
        signal,
      );
      const body = decoder.decode(bytes);
      const read = readPlace(info.contentType, locator, body);
      if (!read.ok) return refused("locator_invalid", read.error);
      text = read.text;
      next = nextPlace(place, placeCount(info.contentType, place.kind, body));
    }
    const cut = utf8(text) > FILE_READ_RETURN_BYTES;
    const shown = cut ? cutBytes(text, FILE_READ_RETURN_BYTES) : text;
    return {
      ok: true,
      note: `${locator} of ${sha.slice(0, 8)}`,
      result: boundedResult({
        sha256: sha,
        uploaded_at: info.uploadedAt,
        media_type: info.contentType,
        locator,
        text: shown,
        ...(cut ? { truncated: true, original_bytes: utf8(text) } : {}),
        ...(next ? { next } : {}),
      }),
    };
  } catch (error) {
    if (error instanceof LbbError && error.status === 404)
      return refused(
        error.code === "file_not_parsed" ? "file_not_parsed" : "file_not_found",
        cutBytes(error.message, 120),
      );
    if (
      error instanceof LbbError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 429
    )
      return refused("file_unreadable", cutBytes(error.message, 120));
    throw error;
  }
}

async function proposeWrite(
  host: AgentHost,
  run: Run,
  cfg: Resolved,
  args: Record<string, unknown>,
  owned: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<ToolRecord> {
  const proposals = args.proposals as RawProposal[];
  const verdicts: SavedVerdict[] = new Array(proposals.length);
  const fresh = new Set<string>();
  const items: { i: number; item: Schemas["GroundItem"] }[] = [];
  for (const [i, p] of proposals.entries()) {
    const name = propertyName(p.property);
    const verdict = (
      code: AgentVerdictCode,
      message: string,
    ): SavedVerdict => ({
      i,
      property: name,
      code,
      message: cutBytes(message, 200),
    });
    const pair = pairOf(p.subject, name);
    const stamp = run.pinned.get(lower(p.file.sha256));
    if (!ENTITY_IRI.test(p.subject) || !run.subjects.has(p.subject)) {
      verdicts[i] = verdict(
        "subject_not_read",
        "propose values only for a subject named under SUBJECTS or one that graph.read returned",
      );
    } else if (!owned.has(lower(name))) {
      verdicts[i] = verdict("not_owned", `the step does not own ${name}`);
    } else if (stamp === undefined) {
      verdicts[i] = verdict(
        "source_not_pinned",
        "read the file with files.read before you cite it",
      );
    } else if (
      !run.proposals.has(pair) &&
      !fresh.has(pair) &&
      run.proposals.size + fresh.size >= cfg.maxProposals
    ) {
      verdicts[i] = verdict(
        "proposal_limit",
        `the run records at most ${cfg.maxProposals} proposals`,
      );
    } else {
      fresh.add(pair);
      items.push({
        i,
        item: {
          subject: p.subject,
          property: p.property.startsWith("http")
            ? p.property
            : `${PROPERTY_NAMESPACE}${p.property}`,
          value: p.value,
          ...(p.unit ? { unit: p.unit } : {}),
          file: { sha256: lower(p.file.sha256), uploaded_at: stamp },
          locator: p.locator,
          quote: p.quote,
        },
      });
    }
  }
  if (items.length) {
    const results = await host.ground(
      items.map((entry) => entry.item),
      { signal },
    );
    for (const [at, entry] of items.entries()) {
      const result = results[at];
      const name = propertyName(proposals[entry.i]!.property);
      if (!result) {
        verdicts[entry.i] = {
          i: entry.i,
          property: name,
          code: "scan_budget",
          message: "the server gave no verdict",
        };
        continue;
      }
      verdicts[entry.i] = {
        i: entry.i,
        property: name,
        code: result.ok
          ? "grounded"
          : ((result.code ?? "quote_not_found") as AgentVerdictCode),
        ...(result.message ? { message: cutBytes(result.message, 200) } : {}),
        ...(result.value ? { typed: result.value } : {}),
        ...(result.stated ? { stated: cutBytes(result.stated, 128) } : {}),
        ...(result.evidence?.source_id
          ? { document: result.evidence.source_id.split("#")[0]! }
          : {}),
      };
    }
  }
  const grounded = verdicts.filter((v) => v.code === "grounded").length;
  return {
    ok: true,
    note: `${grounded} of ${proposals.length} grounded`,
    // The saved result of `propose_write` is the input of the commit: it is
    // exempt from the cut, and its own bounds keep it under 6 KiB.
    result: { verdicts },
  };
}

// ---- the commit phase ---------------------------------------------------------

interface PhaseInput {
  host: AgentHost;
  ctx: WorkflowContext;
  key: string;
  cfg: Resolved;
  run: Run;
  start: StartRecord;
  workflow: string;
  finished: boolean;
  options: AgentOptions;
  /** Report an input to the run's results (and to a capture). */
  report: (input: WorkflowRunInput) => void;
}

/** The result input of a proposal that was not written or filed. */
function failedInput(p: AgentProposal): WorkflowRunInput {
  return {
    iri: p.subject,
    label: "",
    outcome: "failed",
    values: [
      {
        property: p.property,
        value: p.value,
        // The model's words are not evidence: a failed value shows no quote.
        quote: "",
        outcome: p.verdict.code,
      },
    ],
    error: p.verdict.message ?? p.verdict.code,
  } as WorkflowRunInput;
}

const GROUND_CHUNK_ITEMS = 16;
const GROUND_CHUNK_FILES = 8;

/** The ground items of some proposals, in chunks the activity accepts. */
function groundChunks(
  proposals: readonly AgentProposal[],
  stamps: ReadonlyMap<string, string>,
): { proposal: AgentProposal; item: Schemas["GroundItem"] }[][] {
  const chunks: { proposal: AgentProposal; item: Schemas["GroundItem"] }[][] =
    [];
  let current: { proposal: AgentProposal; item: Schemas["GroundItem"] }[] = [];
  let files = new Set<string>();
  for (const proposal of proposals) {
    const item: Schemas["GroundItem"] = {
      subject: proposal.subject,
      property: `${PROPERTY_NAMESPACE}${proposal.property}`,
      value: proposal.value,
      ...(proposal.unit ? { unit: proposal.unit } : {}),
      file: {
        sha256: proposal.sha256,
        uploaded_at: stamps.get(proposal.sha256) ?? "",
      },
      locator: proposal.locator,
      quote: proposal.quote,
    };
    if (
      current.length >= GROUND_CHUNK_ITEMS ||
      (!files.has(proposal.sha256) && files.size >= GROUND_CHUNK_FILES)
    ) {
      chunks.push(current);
      current = [];
      files = new Set();
    }
    current.push({ proposal, item });
    files.add(proposal.sha256);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function commitPhase(input: PhaseInput): Promise<{ uncertain?: string }> {
  const {
    host,
    ctx,
    key,
    cfg,
    run,
    start,
    workflow,
    finished,
    options,
    report,
  } = input;
  const proposals = [...run.proposals.values()];
  if (!proposals.length) return {};

  // Which proposals the table of section 3.3 sends where, before the steps.
  const stamps = run.pinned;
  const grounded = proposals.filter((p) => p.verdict.code === "grounded");
  const reviewCodes = new Set<AgentVerdictCode>([
    "unit_unconfirmed",
    "quote_not_found",
    "quote_too_short",
    "locator_invalid",
    "upload_changed",
    "source_changed",
  ]);

  // The support gate: one `decide` for all grounded proposals.
  if (finished && cfg.gate !== undefined && grounded.length) {
    const support = await ctx.step<SupportRecord>(
      `${key}.commit.support`,
      async (s) => supportStep(host, s, cfg, grounded, workflow, options),
      { kind: "model", timeoutMs: DECISION_TIMEOUT_MS },
    );
    run.addExtra(support, support.costMicroUsd);
    for (const p of grounded) {
      const value = support.support[pairOf(p.subject, p.property)];
      if (value !== undefined) p.support = value;
      if (value === undefined || value < cfg.gate)
        p.verdict = { ...p.verdict, code: "weak_support" };
    }
  }

  // Written candidates: grounded, finished, past the gate.
  const candidates = finished
    ? proposals.filter((p) => p.verdict.code === "grounded")
    : [];
  const toReview = proposals.filter(
    (p) =>
      p.verdict.code === "weak_support" ||
      reviewCodes.has(p.verdict.code) ||
      (!finished && p.verdict.code === "grounded"),
  );
  for (const p of proposals)
    if (!candidates.includes(p) && !toReview.includes(p))
      p.disposition = "failed";

  // The re-check at commit time: the files, the epoch, the answers in force.
  const pairsToCheck = [...candidates, ...toReview];
  let recheck: RecheckRecord = {
    changed: [],
    unchecked: [],
    answered: {},
    held: [],
    epochChanged: false,
  };
  if (pairsToCheck.length) {
    recheck = await ctx.step<RecheckRecord>(
      `${key}.commit.recheck`,
      async (s) =>
        recheckStep(host, s, start, candidates, pairsToCheck, workflow, stamps),
      { kind: "tool", timeoutMs: TOOL_TIMEOUT_MS },
    );
    run.addExtra(recheck);
  }
  // A person's answer holds for the value and the evidence it was given on
  // (as in `values.extract`): the same value, or the same evidence, is not
  // asked again; new evidence with another value is asked again, and the
  // value waits for the person.
  const asking = new Set(recheck.held);
  for (const p of proposals) {
    const pair = pairOf(p.subject, p.property);
    const answer = recheck.answered[pair];
    if (!answer) continue;
    const judged = judgeAnswer(p, answer, evidenceHash(p, stamps));
    if (judged === "answered") p.disposition = "answered";
    else if (judged === "rejected") p.disposition = "rejected";
    else if (judged === "refused") p.disposition = "review";
    else if (judged === "ask") asking.add(pair);
  }
  const changed = new Set(recheck.changed);
  const unchecked = new Set(recheck.unchecked);
  const writing: AgentProposal[] = [];
  const filing: AgentProposal[] = [];
  for (const p of proposals) {
    if (p.disposition) continue;
    const pair = pairOf(p.subject, p.property);
    if (asking.has(pair) && !changed.has(pair) && !unchecked.has(pair)) {
      if (p.verdict.code === "grounded")
        p.verdict = { ...p.verdict, code: "new_evidence" };
      filing.push(p);
    } else if (
      candidates.includes(p) &&
      !changed.has(pair) &&
      !unchecked.has(pair)
    )
      writing.push(p);
    else if (candidates.includes(p)) {
      // A file that changed is not one the server could not read in time.
      p.verdict = unchecked.has(pair)
        ? {
            ...p.verdict,
            code: "scan_budget",
            message: "The file could not be checked again in time.",
          }
        : { ...p.verdict, code: "source_changed" };
      filing.push(p);
    } else if (toReview.includes(p)) filing.push(p);
  }

  // The write: one owned commit of the proposals that passed.
  let refusedWrite: string | undefined;
  if (writing.length) {
    const written = await ctx.step<WriteRecord>(
      `${key}.commit.write`,
      async (s) => writeStep(host, s, writing, report),
      { kind: "tool", timeoutMs: TOOL_TIMEOUT_MS },
    );
    run.addExtra(written);
    if (written.uncertain !== undefined)
      return { uncertain: written.uncertain };
    if (written.refused !== undefined) refusedWrite = written.refused;
    for (const p of writing) {
      if (refusedWrite) {
        // A file or a graph that changed is `source_changed`; any other
        // refusal is the graph's own, and its words go to the person.
        p.verdict =
          refusedWrite === "graph_epoch_changed" ||
          refusedWrite === "evidence_not_verified"
            ? { ...p.verdict, code: "source_changed", message: refusedWrite }
            : {
                ...p.verdict,
                code: "commit_refused",
                message: written.message ?? refusedWrite,
              };
        filing.push(p);
      } else {
        p.disposition = "written";
      }
    }
  }

  // Review: one `value` item for each proposal that needs a person.
  const filed = filing.slice(0, cfg.maxReviewItems);
  for (const p of filing.slice(cfg.maxReviewItems)) p.disposition = "dropped";
  if (filed.length) {
    const record = await ctx.step<ReviewRecord>(
      `${key}.commit.review`,
      async (s) =>
        reviewStep(host, s, filed, workflow, options, stamps, report),
      { kind: "tool", timeoutMs: TOOL_TIMEOUT_MS },
    );
    run.addExtra(record);
    for (const p of filed) p.disposition = "review";
  }
  for (const p of proposals)
    if (p.disposition === "failed") report(failedInput(p));
  return {};
}

/** Bytes of one source text a support question carries, and of all of them. */
const SUPPORT_SOURCE_EACH = 2_048;
const SUPPORT_SOURCE_ALL = 32 * 1_024;

/** The text of a place of a file, or `undefined` when it cannot be read now. */
async function placeTextOf(
  host: AgentHost,
  sha256: string,
  locator: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const info = await host.fileRecord(sha256, signal);
    const checked = placeOf(info.contentType, locator);
    if (!checked.ok) return undefined;
    const place = checked.place;
    if (place.kind === "page") {
      const read = await host.filePages(
        sha256,
        place.page - 1,
        place.page,
        signal,
      );
      return place.page > read.pageCount
        ? undefined
        : read.pages.map((page) => page.text).join("\n");
    }
    const bytes = await host.fileBytes(
      sha256,
      { start: 0, end: FILE_READ_SCAN_BYTES },
      signal,
    );
    const read = readPlace(info.contentType, locator, decoder.decode(bytes));
    return read.ok ? read.text : undefined;
  } catch (error) {
    if (
      error instanceof LbbError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 429
    )
      return undefined;
    throw error;
  }
}

/** At most `max` bytes of `text`, around the first words of `quote` when they are in it. */
function windowAround(text: string, quote: string, max: number): string {
  if (utf8(text) <= max) return text;
  const at = text.indexOf(quote.slice(0, 60));
  return cutBytes(text.slice(at < 0 ? 0 : Math.max(0, at - 200)), max);
}

async function supportStep(
  host: AgentHost,
  s: WorkflowStepContext,
  cfg: Resolved,
  grounded: readonly AgentProposal[],
  workflow: string,
  options: AgentOptions,
): Promise<SupportRecord> {
  if (options.plan) {
    const given = options.planSupport ?? 1;
    const support: Record<string, number> = {};
    for (const p of grounded)
      support[pairOf(p.subject, p.property)] =
        typeof given === "number" ? given : (given[p.property] ?? 1);
    return { support, costMicroUsd: 0 };
  }
  s.progress("asking the decision model", {
    done: 0,
    total: grounded.length,
    unit: "proposals",
  });
  // The decision model judges a quote for an item, so it gets the item's name
  // and the text the quote came from, as `values.extract` sends the record's.
  const described = await host.describe(
    [...new Set(grounded.map((p) => p.subject))],
    s.signal,
  );
  const sources: Record<string, string> = {};
  let room = SUPPORT_SOURCE_ALL;
  const questions: Record<string, ReturnType<typeof supportQuestion>> = {};
  for (const [n, p] of grounded.entries()) {
    const source = `${p.sha256.slice(0, 8)}#${p.locator}`;
    if (!(source in sources)) {
      const text = await placeTextOf(host, p.sha256, p.locator, s.signal);
      const shown =
        text === undefined
          ? ""
          : windowAround(text, p.quote, Math.min(room, SUPPORT_SOURCE_EACH));
      sources[source] = shown;
      room -= utf8(shown);
    }
    const found = described.get(p.subject);
    questions[`v${n}`] = supportQuestion({
      label: found?.name ?? p.subject,
      type: found?.type ?? "item",
      property: p.property,
      value: p.verdict.stated ?? p.value,
      source,
      quote: p.quote,
    });
  }
  const answered = await host.decide(
    { state: { task: cfg.instructions, workflow, sources }, questions },
    { effectId: s.effectId, label: label(`${workflow} support`) },
  );
  const support: Record<string, number> = {};
  for (const [n, p] of grounded.entries()) {
    const a = answered.answers[`v${n}`];
    const value =
      a?.probabilities?.supported ??
      (a?.choice == null
        ? undefined
        : a.choice === "supported"
          ? (a.confidence ?? 1)
          : 0);
    support[pairOf(p.subject, p.property)] = Math.min(
      CLAMP.support,
      Math.max(0, value ?? 0),
    );
  }
  return {
    support,
    ...(answered.model ? { model: answered.model } : {}),
    costMicroUsd: answered.cost_micro_usd ?? 0,
  };
}

/** The mark of the evidence a value is asked on: the file's upload, the place, the quote. */
function evidenceHash(
  p: AgentProposal,
  stamps: ReadonlyMap<string, string>,
): string {
  return stableHashHex([
    "agent_evidence_v1",
    p.sha256,
    stamps.get(p.sha256) ?? "",
    p.locator,
    p.quote.replace(/\s+/g, " ").trim().toLowerCase(),
    p.unit ?? "",
  ]).slice(0, 32);
}

/** Two values a person and the agent state, as numbers when both are numbers. */
function sameValue(a: string | undefined, b: unknown): boolean {
  if (a === undefined || b === undefined || b === null) return false;
  const x = a.trim();
  const y = String(b).trim();
  return x === y || (x !== "" && y !== "" && Number(x) === Number(y));
}

/**
 * What an answered Review item says of a value the run proposes again, as
 * `values.extract` reads it. `answered`: the person's value holds (the same
 * value, or the same evidence). `rejected`: the same value was rejected.
 * `refused`: the graph refused to write that value, and the item waits for the
 * person. `ask`: new evidence with another value, so the person is asked
 * again. `undefined`: the answer says nothing of this value.
 */
function judgeAnswer(
  p: AgentProposal,
  answer: AnswerRecord,
  hash: string,
): "answered" | "rejected" | "refused" | "ask" | undefined {
  const mine = p.verdict.typed ? valueOf(p.verdict.typed) : p.value;
  const given =
    answer.decision === "correct"
      ? answer.value
      : (answer.value ?? answer.asked);
  if (answer.refused) return sameValue(given, mine) ? "refused" : undefined;
  if (answer.decision === "reject")
    return sameValue(answer.asked, mine) ? "rejected" : undefined;
  const same =
    !answer.hash ||
    answer.hash === hash ||
    sameValue(given, mine) ||
    sameValue(answer.asked, mine);
  return same ? "answered" : "ask";
}

async function recheckStep(
  host: AgentHost,
  s: WorkflowStepContext,
  start: StartRecord,
  candidates: readonly AgentProposal[],
  all: readonly AgentProposal[],
  workflow: string,
  stamps: ReadonlyMap<string, string>,
): Promise<RecheckRecord> {
  const record: RecheckRecord = {
    changed: [],
    unchecked: [],
    answered: {},
    held: [],
    epochChanged: false,
  };
  if (candidates.length) {
    const head = await host.head(s.signal);
    record.epochChanged =
      start.graphEpoch !== undefined &&
      head.graphEpoch !== undefined &&
      head.graphEpoch !== start.graphEpoch;
    if (record.epochChanged) {
      record.changed = candidates.map((p) => pairOf(p.subject, p.property));
    } else {
      for (const chunk of groundChunks(candidates, stamps)) {
        const answers = await host.ground(
          chunk.map((entry) => entry.item),
          { signal: s.signal },
        );
        for (const [i, entry] of chunk.entries()) {
          const answer = answers[i];
          if (answer?.ok) continue;
          const pair = pairOf(entry.proposal.subject, entry.proposal.property);
          // A file the server had no time to scan is not a file that changed.
          if (answer?.code === "scan_budget") record.unchecked.push(pair);
          else record.changed.push(pair);
        }
      }
    }
  }
  if (all.length) {
    const keys = all.map((p) => agentValueKey(workflow, p.subject, p.property));
    const items = await host.reviewItems(keys, s.signal);
    for (const item of items) {
      const p = all.find(
        (p) => agentValueKey(workflow, p.subject, p.property) === item.key,
      );
      if (!p) continue;
      const pair = pairOf(p.subject, p.property);
      // An item asked again on new evidence holds the value for a person.
      if (item.status === "open") {
        if (item.previous_answer) record.held.push(pair);
        continue;
      }
      const answer = item.answer;
      const decision = answer?.decision;
      if (
        decision !== "accept" &&
        decision !== "correct" &&
        decision !== "reject"
      )
        continue;
      const text = (value: unknown) =>
        value === undefined || value === null ? undefined : String(value);
      record.answered[pair] = {
        decision,
        ...(text(answer?.value) !== undefined
          ? { value: text(answer?.value)! }
          : {}),
        ...(text(item.question?.value) !== undefined
          ? { asked: text(item.question?.value)! }
          : {}),
        ...(item.evidence_hash ? { hash: item.evidence_hash } : {}),
        ...(item.effects?.commit_error ? { refused: true as const } : {}),
      };
    }
  }
  return record;
}

async function writeStep(
  host: AgentHost,
  s: WorkflowStepContext,
  writing: readonly AgentProposal[],
  report: PhaseInput["report"],
): Promise<WriteRecord> {
  const subjects = [...new Set(writing.map((p) => p.subject))];
  const described = await host.describe(subjects, s.signal);
  // A subject the graph does not describe has no class to write it under.
  if (subjects.some((iri) => !described.has(iri)))
    return {
      commitSeq: null,
      replayed: false,
      refused: "subject_not_found",
      message: "The graph does not describe the subject.",
    };
  const body = commitBody(writing, described);
  // The intent goes out before the effect. A later attempt of this step
  // reads it from the checkpoint: an intent with no saved output means that
  // an earlier attempt began, and a retry sends the same key.
  const requestHash = stableHashHex([canonicalJson(body)]);
  const earlier = s.checkpoint as {
    intent?: string;
    request_hash?: string;
  } | null;
  if (earlier?.intent === "commit" && earlier.request_hash !== requestHash)
    return {
      commitSeq: null,
      replayed: false,
      uncertain: "the request changed between attempts",
    };
  await s.heartbeat(
    { phase: "commit", proposals: writing.length },
    { checkpoint: { intent: "commit", request_hash: requestHash } },
  );
  try {
    const done = await host.commit(body, {
      idempotencyKey: s.effectId,
      ...(s.fence ? { fence: s.fence } : {}),
      ...(s.graph !== undefined ? { graph: s.graph } : {}),
      signal: s.signal,
    });
    for (const input of writtenInputs(writing, described)) report(input);
    return { commitSeq: done.commitSeq, replayed: done.replayed };
  } catch (error) {
    if (error instanceof LbbError) {
      // The commit's own refusals: a fence lost or an ownership refusal stop
      // the turn (the worker handles them); a file or a graph that changed
      // moves the values to Review; anything else is not settled.
      if (
        error.code === "workflow_fence_lost" ||
        error.code === "write_outside_owns"
      )
        throw error;
      if (
        error.code === "graph_epoch_changed" ||
        error.code === "evidence_not_verified"
      )
        return { commitSeq: null, replayed: false, refused: error.code };
      // A request the graph found invalid wrote nothing (a shape that rejects
      // the value, a class it does not know): the values wait for a person,
      // with the graph's words. Any other 4xx, an idempotency conflict for
      // one, may or may not have landed: the run says so.
      if ([400, 403, 404, 413, 422].includes(error.status))
        return {
          commitSeq: null,
          replayed: false,
          refused: error.code ?? `http_${error.status}`,
          message: cutBytes(error.message, 200),
        };
      if (error.status >= 400 && error.status < 500 && error.status !== 429)
        return {
          commitSeq: null,
          replayed: false,
          uncertain: error.code ?? `http_${error.status}`,
        };
    }
    throw error;
  }
}

/** The result inputs of the proposals one commit wrote. */
function writtenInputs(
  writing: readonly AgentProposal[],
  described: Map<string, { type: string; name: string }>,
): WorkflowRunInput[] {
  const bySubject = new Map<string, AgentProposal[]>();
  for (const p of writing)
    bySubject.set(p.subject, [...(bySubject.get(p.subject) ?? []), p]);
  return [...bySubject].map(([subject, list]) => ({
    iri: subject,
    label: described.get(subject)?.name ?? "",
    outcome: "written",
    values: list.map((p) => ({
      property: p.property,
      value: p.verdict.stated ?? p.value,
      quote: p.quote,
      outcome: "written",
      ...(p.support !== undefined ? { support: p.support } : {}),
    })),
  })) as WorkflowRunInput[];
}

/** `ValueSource` rows and edges for the proposals one commit writes. */
export function commitBody(
  writing: readonly AgentProposal[],
  described: ReadonlyMap<string, { type: string; name: string }>,
): Schemas["TripletCommitFile"] {
  const sentinel = "\u0000lbb-eid:";
  const idOf = (iri: string) =>
    iri.slice("https://littlebigbrain.com/e/".length).toLowerCase();
  const subjects = [...new Set(writing.map((p) => p.subject))];
  const ref = (iri: string): Schemas["NamedEntityInput"] => {
    const found = described.get(iri);
    return {
      type: found?.type ?? "Entity",
      name: found?.name?.trim() ? found.name : idOf(iri),
      key: `${sentinel}${idOf(iri)}`,
    };
  };
  const rows: Schemas["EntityPropertiesInput"][] = [];
  const edges: Schemas["TripletInput"][] = [];
  const owned: Schemas["SubjectPropertiesInput"][] = [];
  for (const subject of subjects) {
    const mine = writing.filter((p) => p.subject === subject);
    rows.push({
      ...ref(subject),
      properties: mine.map((p) => ({
        field: p.property,
        value: p.verdict.typed as Schemas["PropertyValueInput"],
      })),
    } as Schemas["EntityPropertiesInput"]);
    owned.push({
      subject: ref(subject),
      properties: mine.map((p) => p.property),
    });
    for (const p of mine) {
      const stated = p.verdict.stated ?? p.value;
      const source: Schemas["NamedEntityInput"] = {
        type: "ValueSource",
        name: [...`${p.property} = ${stated}`].slice(0, 200).join(""),
        key: `value:${idOf(subject)}:${p.property}`,
      };
      const support = p.support ?? 1;
      rows.push({
        ...source,
        properties: [
          { field: "property", value: { keyword: p.property } },
          { field: "value", value: { text: stated } },
          { field: "support", value: { f64: support } },
        ],
      } as Schemas["EntityPropertiesInput"]);
      edges.push({
        source: ref(subject),
        relation: "HAS_VALUE_SOURCE",
        target: source,
        confidence: support,
        evidence: {
          text: p.quote,
          source_id: `${p.verdict.document ?? ""}#${p.locator}`,
          source_sha256: p.sha256,
        },
      } as Schemas["TripletInput"]);
    }
  }
  return {
    entity_properties: rows,
    triplets: edges,
    edge_idempotency: "append",
    replace_owned: {
      subjects: subjects.map(ref),
      subject_properties: owned,
    },
  } as Schemas["TripletCommitFile"];
}

async function reviewStep(
  host: AgentHost,
  s: WorkflowStepContext,
  filing: readonly AgentProposal[],
  workflow: string,
  options: AgentOptions,
  stamps: ReadonlyMap<string, string>,
  report: PhaseInput["report"],
): Promise<ReviewRecord> {
  const described = await host.describe(
    [...new Set(filing.map((p) => p.subject))],
    s.signal,
  );
  const filed: ReviewRecord["filed"] = [];
  for (const p of filing) {
    const body = reviewBody(p, workflow, s, options, stamps, described);
    const item = await host.review(body, s.signal);
    filed.push({
      pair: pairOf(p.subject, p.property),
      ...(item.id ? { id: item.id } : {}),
      ...(item.status ? { status: item.status } : {}),
    });
    {
      const subject = body.subject as Schemas["ReviewSubject"];
      report({
        iri: subject.iri ?? p.subject,
        label: subject.name ?? "",
        outcome: "review",
        values: [
          {
            property: p.property,
            value: p.verdict.stated ?? p.value,
            quote: "",
            outcome: "review",
            ...(item.id ? { review_item: item.id } : {}),
          },
        ],
      } as WorkflowRunInput);
    }
  }
  return { filed };
}

/** The body of the `value` item of a proposal that needs a person. */
function reviewBody(
  p: AgentProposal,
  workflow: string,
  s: WorkflowStepContext,
  options: AgentOptions,
  stamps: ReadonlyMap<string, string>,
  described: ReadonlyMap<string, { type: string; name: string }>,
): Record<string, unknown> {
  const found = described.get(p.subject);
  // A value with a verified quote shows it; any other value shows no quote:
  // the model's words are never evidence.
  const verified =
    p.verdict.code === "weak_support" ||
    p.verdict.code === "unit_unconfirmed" ||
    p.verdict.code === "commit_refused" ||
    p.verdict.code === "new_evidence";
  const evidence =
    verified && p.verdict.document
      ? [
          {
            quote: p.quote,
            source_id: `${p.verdict.document}#${p.locator}`,
            uploaded_at: stamps.get(p.sha256) ?? "",
            source_sha256: p.sha256,
          },
        ]
      : [];
  const why: Record<string, string> = {
    weak_support:
      "The quote does not clearly state this value for the subject.",
    unit_unconfirmed: "The unit of the value is not confirmed by the quote.",
    quote_not_found:
      "The quote is not in the file at the place the agent named.",
    quote_too_short: "The quote is too short to state the value.",
    locator_invalid: "The place the agent named is not in the file.",
    upload_changed: "The file changed after the agent read it.",
    source_changed: "The file or the graph changed after the agent read it.",
    scan_budget: "The file could not be checked again in time.",
    commit_refused: `The graph refused to write the value: ${p.verdict.message ?? "no reason given"}`,
    new_evidence:
      "A person answered this on other evidence or for another value. The agent read it again.",
    grounded: "The run did not finish, so its values wait for a person.",
  };
  return {
    kind: "value",
    title: `${p.property} of ${found?.name ?? p.subject}`,
    rationale: why[p.verdict.code] ?? p.verdict.message ?? p.verdict.code,
    subject: {
      iri: p.subject,
      ...(found?.type ? { type: found.type } : {}),
      ...(found?.name ? { name: found.name } : {}),
    },
    question: {
      property: p.property,
      value: p.verdict.typed ? valueOf(p.verdict.typed) : p.value,
      // The value is in the property's unit once the server typed it.
      ...(p.unit && !p.verdict.typed ? { unit: p.unit } : {}),
    },
    evidence,
    // An answer holds for this mark: other evidence with another value asks again.
    evidence_hash: evidenceHash(p, stamps),
    // Under a credential the server names the workflow, the run and the turn;
    // the body may carry the step only.
    workflow: options.hosted
      ? { step: s.effectId.split("/").pop() }
      : { name: workflow, step: s.effectId.split("/").pop() },
    ...(options.hosted
      ? {}
      : {
          key: agentValueKey(workflow, p.subject, p.property),
          origin: { kind: "agent", id: `starter:${workflow}` },
          scope: "live",
        }),
  };
}

/** The plain value of a typed value (`{f64: 60}` is 60). */
function valueOf(typed: Schemas["PropertyValueInput"]): unknown {
  const entries = Object.values(typed as Record<string, unknown>);
  return entries.length === 1 ? entries[0] : typed;
}
