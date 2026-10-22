import type { LbbClient, Schemas } from "./client.js";
import { LbbError, type CallOptions } from "./transport.js";
import {
  WorkflowExecutionError,
  WorkflowTurnReader,
  type WorkflowReadRequest,
  type WorkflowReadOptions,
} from "./workflow-execution.js";
import {
  DerivationsNamespace,
  NamedWorkflowsNamespace,
  StarterWorkflowsNamespace,
  TriggeredWorkflowsNamespace,
} from "./triggered-workflows.js";
import { WorkflowTestsNamespace } from "./workflow-tests.js";
import {
  replayedInputs,
  RunResultsCollector,
  stepOutputResults,
  stepOutputWithResults,
} from "./run-results.js";

type Turn = Schemas["WorkflowTurn"];
type Task = Schemas["WorkflowTurnTask"];
type Instance = Schemas["WorkflowInstance"];
type Origin = Schemas["WorkflowMessageOrigin"];
type Inbox = Schemas["WorkflowInboxResponse"];
/** A page of an inbox: the turns after `after`, at most `limit` (1 to 100, 50 by default). */
export interface InboxOptions {
  after?: number;
  limit?: number;
  /** Include each message's payload. */
  payloads?: boolean;
}
const base = "/v1/workflows";
const notJson = (v: unknown): boolean =>
  v === undefined ||
  typeof v === "function" ||
  typeof v === "symbol" ||
  typeof v === "bigint";
/** Where the first value JSON cannot hold sits, as `where.a.b[2]`. */
const badPath = (
  value: unknown,
  path: string,
  seen = new Set<object>(),
): string | null => {
  if (notJson(value) || (typeof value === "number" && !Number.isFinite(value)))
    return path;
  if (value === null || typeof value !== "object" || seen.has(value))
    return null;
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return null;
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    const found = badPath(
      item,
      Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`,
      seen,
    );
    if (found) return found;
  }
  return null;
};
/**
 * A JSON copy of a workflow value. `where` names the value in the error
 * (`state`, `continuation`, `step "page.3"`), with the path to the field.
 */
const copy = <T>(value: T, where = "value"): T => {
  const at = () => {
    const path = badPath(value, where);
    return path ? `: ${path}` : "";
  };
  const encoded = JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "number" && !Number.isFinite(v))
      throw new WorkflowError(`Values must be finite JSON numbers${at()}`);
    if (notJson(v))
      throw new WorkflowError(
        `Workflow values must be JSON serializable (use null for no result)${at()} is ${typeof v}`,
      );
    return v;
  });
  return JSON.parse(encoded) as T;
};

/** A permanent handler/replay error; ordinary thrown errors retry up to max_attempts. */
export class WorkflowError extends Error {}

/**
 * Throw from a turn to wait for a cause outside it (a dependency that is
 * not there yet, a spent budget) and count no attempt: the worker fails
 * the turn with `retry_at_ms`, and the turn runs again at `retryAtMs`, or
 * at once on a resume or a run now. Its steps are kept. A step that meets
 * `429 workflow_budget_exceeded` waits this way by itself.
 */
export class WorkflowWait extends Error {
  constructor(
    readonly retryAtMs: number,
    message = "the turn waits",
  ) {
    super(message);
    this.name = "WorkflowWait";
  }
}

/**
 * The shortest wait a failure asks for: a wait of now (or of a clock behind
 * the server's) waits a second, so a turn that keeps waiting cannot spin.
 */
const MIN_WAIT_MS = 1_000;

/** The wait of a thrown error: a {@link WorkflowWait}, or a spent budget. */
function waitOf(error: unknown): number | undefined {
  if (error instanceof WorkflowWait) return error.retryAtMs;
  if (
    error instanceof LbbError &&
    error.code === "workflow_budget_exceeded" &&
    typeof error.retryAtMs === "number"
  )
    return error.retryAtMs;
  return undefined;
}

/**
 * The code of a turn route's answer that this attempt's token no longer
 * holds its turn: another attempt holds it, its lease ended, or it finished.
 */
const TURN_LEASE_LOST_CODE = "turn_lease_lost";

/**
 * A turn route's answer that the turn is not this attempt's any more:
 * `409 turn_lease_lost`, another 409 (a server older than the code answers
 * a lost lease `409 conflict`) or a 404 (the instance is gone).
 */
const gone = (error: unknown): boolean =>
  error instanceof LbbError &&
  (error.code === TURN_LEASE_LOST_CODE ||
    error.status === 409 ||
    error.status === 404);

/** The engine identity of a shard: `starter.<name>` or `starter.<name>.<k>`. */
const SHARD = /^starter\.([^.]+)(?:\.([1-9][0-9]*))?$/;
/** The engine identity of a fan-in identity: `starter.<name>.<word>`. */
const FAN_IN = /^starter\.([^.]+)\.([a-z][a-z0-9-]{0,30})$/;

/**
 * The named workflow of an engine identity: a shard's (`starter.<name>`,
 * `starter.<name>.<k>`) or a fan-in identity's (`starter.<name>.<word>`);
 * `undefined` for an identity of no named workflow.
 */
export function workflowOfIdentity(id: string): string | undefined {
  return SHARD.exec(id)?.[1] ?? FAN_IN.exec(id)?.[1];
}

/**
 * The engine identity of the fan-in identity `fanIn` of the workflow
 * `name` (`fan_in` of `PUT /v1/workflows/named`): `starter.<name>.<fanIn>`.
 * Send to it with a deterministic message id, so a repeat is admitted once.
 */
export function fanInIdentity(name: string, fanIn: string): string {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(fanIn))
    throw new RangeError("a fan-in id matches [a-z][a-z0-9-]{0,30}");
  return `starter.${name}.${fanIn}`;
}

/** Whether `id` is a fan-in identity (`starter.<name>.<word>`). */
export function isFanInIdentity(id: string): boolean {
  return FAN_IN.test(id);
}
export interface WorkflowResult<S, R = unknown, M = unknown> {
  state: S;
  result?: R;
  continuation?: { message: M };
}
export interface WorkflowStepOptions {
  kind?: "step" | "model" | "tool";
  /** Per-attempt execution limit, independent of worker lease renewal (default 5 minutes). */
  timeoutMs?: number;
  /** Require explicit progress from the operation, independent of worker liveness. */
  heartbeatTimeoutMs?: number;
}
/** What a step's progress counts (see {@link WorkflowStepContext.progress}). */
export interface WorkflowProgressCounts {
  /** A whole number, at least 0. */
  done: number;
  /** A whole number; leave it out when the step does not know it. */
  total?: number;
  /**
   * What `done` and `total` count: `documents`, `pages`, `mentions`,
   * `links`, `proposals`, `instances`, `questions`, `messages`, `items`,
   * or another short word.
   */
  unit?: string;
}
export interface WorkflowStepContext {
  effectId: string;
  /**
   * The turn this step runs in, as `workflow_fence` of a commit names it:
   * the server refuses a new commit once the token no longer holds the
   * turn (`409 workflow_fence_lost`). `writeOwned` sends it with a write to
   * the turn's graph (`graph`). A `WorkflowWorker` always sets it; a test's
   * own context may leave it out.
   */
  fence?: Schemas["WorkflowFence"];
  /**
   * The graph of the turn: the graph the worker's client names. Undefined
   * when that client names none (the server's default graph); `writeOwned`
   * then takes the graph a write names for the turn's graph.
   */
  graph?: string;
  signal: AbortSignal;
  /** Last progress checkpoint from a previous attempt, or null. */
  checkpoint: unknown;
  heartbeat(
    details: unknown,
    options?: { checkpoint?: unknown },
  ): Promise<void>;
  /**
   * Report what the step does now in the progress convention
   * (`{phase, done, total, unit}`), which the console draws as a Running
   * line and a bar. Coalesced: a phase change is sent at once, other calls
   * at most once per `progressEveryMs` of the worker (3 s by default, or
   * half the step's `heartbeatTimeoutMs` when that is shorter), the last
   * value wins, and the last value is sent when the step returns. Keeps
   * the resume checkpoint of the last `heartbeat`. Does not wait for the
   * write; a failed write fails the step when it returns.
   */
  progress(phase: string, counts: WorkflowProgressCounts): void;
}
export type WorkflowSignalResult<T> =
  { received: true; value: T } | { received: false; value: null };
export interface WorkflowContext {
  readonly signal: AbortSignal;
  readonly workflowId: string;
  readonly messageId: string;
  readonly turn: number;
  /** SELECT/ASK for this live attempt, using its execution credential. Requires
   * the worker's executionReads opt-in. Optional for compatibility with custom
   * contexts; feature-check before calling inside ctx.step to checkpoint it. */
  sparql?(
    request: WorkflowReadRequest | string,
    options?: WorkflowReadOptions,
  ): Promise<Schemas["SparqlTextResponse"]>;
  /**
   * The attempt's execution reader: SELECT/ASK, and for LBB's hosted workers
   * the file reads and owned writes of their grants. Requires the worker's
   * executionReads opt-in. Optional for compatibility with custom contexts.
   */
  execution?(): WorkflowTurnReader;
  /** Where the message came from, when its sender named it. */
  readonly origin?: Schemas["WorkflowMessageOrigin"] | null;
  /** The named workflow of this identity (a shard's or a fan-in identity's), if any. */
  readonly workflowName?: string;
  /** Sequential named effects only. Pass effectId to the external service as its idempotency key. */
  step<T>(
    key: string,
    effect: (context: WorkflowStepContext) => Promise<T>,
    options?: WorkflowStepOptions,
  ): Promise<T>;
  /** Wait without holding a worker; signals can arrive before registration. */
  waitForSignal<T = unknown>(
    key: string,
    options: { name: string; timeoutMs: number },
  ): Promise<WorkflowSignalResult<T>>;
  /** Checkpoint and release the worker until the timer is due. */
  sleep(key: string, milliseconds: number): Promise<void>;
  /** Commit state and append a new message at the inbox tail in one transaction. */
  continue<S, M>(state: S, message: M): WorkflowResult<S, never, M>;
}
interface RegisteredWorkflow {
  name: string;
  version: string;
  initialState: unknown;
  execute(
    ctx: WorkflowContext,
    state: unknown,
    message: unknown,
  ): Promise<WorkflowResult<unknown>>;
}
export interface WorkflowDefinition<S, M> extends RegisteredWorkflow {
  initialState: S;
  start(
    client: LbbClient,
    id: string,
    options?: WorkflowStartOptions,
  ): Promise<WorkflowHandle<M>>;
}
/** Define a version-pinned message handler. Put I/O, clock reads and randomness inside ctx.step. */
export function workflow<S, M, R = unknown>(definition: {
  name: string;
  version: string;
  initialState: S;
  onMessage(
    ctx: WorkflowContext,
    state: S,
    message: M,
  ): Promise<WorkflowResult<S, R, M>>;
}): WorkflowDefinition<S, M> {
  const registered: WorkflowDefinition<S, M> = {
    name: definition.name,
    version: definition.version,
    initialState: copy(definition.initialState, "initialState"),
    execute: (ctx, state, message) =>
      definition.onMessage(ctx, state as S, message as M),
    start: (client, id, options) =>
      client.workflows.start(registered, id, options),
  };
  return registered;
}

/** How `start` creates an instance. */
export interface WorkflowStartOptions {
  leaseMs?: number;
  maxAttempts?: number;
  /**
   * What a turn that failed for good does: `block` (the default) holds the
   * inbox until a person retries or skips it; `skip` keeps the failed turn
   * in the history and goes on with the next message.
   */
  onExhausted?: Schemas["WorkflowOnExhausted"];
}

export class WorkflowHandle<M = unknown> {
  constructor(
    private readonly api: WorkflowNamespace,
    readonly id: string,
  ) {}
  status(options?: CallOptions): Promise<Instance> {
    return this.api.get(this.id, options);
  }
  /**
   * Reuse id when retrying the same message, including after a client
   * restart. `origin` says where the message came from; it is stored with
   * the turn and shown in the inbox.
   */
  send(
    message: M,
    options: { id: string; origin?: Origin } & CallOptions,
  ): Promise<Turn> {
    return this.api.send(this.id, message, options);
  }
  /** The messages that wait in this workflow's inbox, oldest first. */
  inbox(options?: InboxOptions & CallOptions): Promise<Inbox> {
    return this.api.inbox(this.id, options);
  }
  /** Deliver an approval, callback or other event to a specific run, including while it waits. */
  signal(
    name: string,
    value: unknown,
    options: { turn: number; id: string } & CallOptions,
  ): Promise<Turn> {
    return this.api.signal(this.id, name, value, options);
  }
  history(options?: { after?: number; limit?: number } & CallOptions) {
    return this.api.history(this.id, options);
  }
  pause(options?: CallOptions) {
    return this.api.control(this.id, "pause", undefined, options);
  }
  resume(options?: CallOptions) {
    return this.api.control(this.id, "resume", undefined, options);
  }
  retry(turn: number, options?: CallOptions) {
    return this.api.control(this.id, "retry", turn, options);
  }
  cancelTurn(turn: number, options?: CallOptions) {
    return this.api.control(this.id, "cancel_turn", turn, options);
  }
  /** End a wait of the current turn that counts no attempt (`retry_at_ms`): a run now. */
  wake(options?: CallOptions) {
    return this.api.control(this.id, "wake", undefined, options);
  }
}

/** Blobs of the workflow engine: large step outputs and shared reads. */
export class WorkflowBlobsNamespace {
  constructor(private readonly client: LbbClient) {}
  /**
   * Store `data` (at most 8 MiB) as a blob of the identity `workflowId`'s
   * workflow (`POST /v1/workflows/blobs`) and answer its key,
   * `<workflow>/<sha256>`. Name the key in a step's output, the state or a
   * message: a blob stays while a live identity names it, and at least a
   * day after its last write. The same bytes again answer the same key,
   * so a failed call is retried.
   */
  async put(
    data: ArrayBuffer | Uint8Array | string,
    options: { workflowId: string } & CallOptions,
  ): Promise<Schemas["WorkflowBlob"]> {
    const { workflowId, ...call } = options;
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (bytes.byteLength > 8 * 1024 * 1024)
      throw new RangeError("a blob holds at most 8 MiB");
    return this.client.request("POST", `${base}/blobs`, {
      ...call,
      retry: call.retry ?? true,
      query: { workflow_id: workflowId },
      rawBody: bytes,
      contentType: "application/octet-stream",
    });
  }
  /** The bytes of blob `key` (`GET /v1/workflows/blobs`). */
  get(key: string, options: CallOptions = {}): Promise<Uint8Array> {
    return this.client.request("GET", `${base}/blobs`, {
      ...options,
      query: { key },
      responseType: "bytes",
    });
  }
  /** The text of blob `key`, decoded as UTF-8. */
  async getText(key: string, options: CallOptions = {}): Promise<string> {
    return new TextDecoder().decode(await this.get(key, options));
  }
  /** Store a JSON value as a blob: {@link put} of its text. */
  putJson(
    value: unknown,
    options: { workflowId: string } & CallOptions,
  ): Promise<Schemas["WorkflowBlob"]> {
    return this.put(JSON.stringify(value), options);
  }
  /** The JSON value of blob `key`. */
  async getJson<T = unknown>(
    key: string,
    options: CallOptions = {},
  ): Promise<T> {
    return JSON.parse(await this.getText(key, options)) as T;
  }
}
export class WorkflowNamespace {
  /**
   * The starter workflows this server offers (templates), and creating a
   * workflow from one with `use`.
   */
  readonly starters: StarterWorkflowsNamespace;
  /**
   * The workflows created from a starter workflow on this graph, by
   * starter and name: each one runs when a published commit changes the
   * class it watches. `named` reads and changes the same workflows by
   * name; `preview` and the calibration of a gate stay here.
   */
  readonly triggered: TriggeredWorkflowsNamespace;
  /**
   * The workflows of the graph by name: a target workflow type, shards,
   * settings and a watch or content trigger; the queue of what each
   * trigger has not sent yet, the runs, and the documents of a document
   * workflow. The lists answer in the list envelope and have iterators
   * (`all`, `allRuns`, `allDocuments`).
   */
  readonly named: NamedWorkflowsNamespace;
  /**
   * Derivations: what one version of a workflow made of one content with
   * one set of settings, checked before the work and recorded after.
   */
  readonly derivations: DerivationsNamespace;
  /**
   * Tests: a workflow runs on chosen inputs and writes nothing; a person
   * answers each value, and the answers save as the test's dataset
   * (`client.evals.datasets`).
   */
  readonly tests: WorkflowTestsNamespace;
  /** Blobs: large step outputs and shared reads, keyed by their SHA-256. */
  readonly blobs: WorkflowBlobsNamespace;

  constructor(private readonly client: LbbClient) {
    this.starters = new StarterWorkflowsNamespace(client);
    this.triggered = new TriggeredWorkflowsNamespace(client);
    this.named = new NamedWorkflowsNamespace(client);
    this.derivations = new DerivationsNamespace(client);
    this.tests = new WorkflowTestsNamespace(client);
    this.blobs = new WorkflowBlobsNamespace(client);
  }
  handle<M = unknown>(id: string): WorkflowHandle<M> {
    return new WorkflowHandle<M>(this, id);
  }
  async start<S, M>(
    definition: WorkflowDefinition<S, M>,
    id: string,
    options: WorkflowStartOptions = {},
  ): Promise<WorkflowHandle<M>> {
    await this.create({
      id,
      workflow_type: definition.name,
      version: definition.version,
      state: definition.initialState,
      lease_ms: options.leaseMs ?? 60_000,
      max_attempts: options.maxAttempts ?? 3,
      ...(options.onExhausted ? { on_exhausted: options.onExhausted } : {}),
    });
    return this.handle<M>(id);
  }
  create(
    request: Schemas["WorkflowInstanceCreateRequest"],
    options?: CallOptions,
  ): Promise<Instance> {
    return this.client.request("POST", `${base}/instances`, {
      ...options,
      body: request,
      retry: true,
    });
  }
  get(id: string, options?: CallOptions): Promise<Instance> {
    return this.client.request("GET", `${base}/instances/get`, {
      ...options,
      query: { id },
    });
  }
  list(
    options: { after?: string; limit?: number } & CallOptions = {},
  ): Promise<Schemas["WorkflowInstanceListResponse"]> {
    const { after, limit, ...call } = options;
    return this.client.request("GET", `${base}/instances`, {
      ...call,
      query: { after, limit },
    });
  }
  send(
    workflowId: string,
    message: unknown,
    options: { id: string; origin?: Origin } & CallOptions,
  ): Promise<Turn> {
    const { id, origin, ...call } = options;
    return this.client.request("POST", `${base}/instances/message`, {
      ...call,
      retry: true,
      body: {
        workflow_id: workflowId,
        id,
        message: copy(message, "message"),
        origin,
      },
    });
  }
  /**
   * The unfinished turns of one workflow, oldest first: each message's
   * status, ready time, attempt, size and origin, and the running turn's
   * progress. Payloads only with `payloads: true`.
   */
  inbox(id: string, options: InboxOptions & CallOptions = {}): Promise<Inbox> {
    const { after, limit, payloads, ...call } = options;
    return this.client.request("GET", "/v1/workflows/instances/inbox", {
      ...call,
      query: { id, after, limit, payloads },
    });
  }
  /**
   * The workflows of one type (one `version`, or every version) whose
   * inbox holds messages, by id: each one's count, its oldest message and
   * its inbox head.
   */
  inboxByType(
    workflowType: string,
    options: {
      version?: string;
      after?: string;
      limit?: number;
    } & CallOptions = {},
  ): Promise<Schemas["WorkflowTypeInboxResponse"]> {
    const { version, after, limit, ...call } = options;
    return this.client.request("GET", "/v1/workflows/inbox", {
      ...call,
      query: { workflow_type: workflowType, version, after, limit },
    });
  }
  signal(
    workflowId: string,
    name: string,
    value: unknown,
    options: { turn: number; id: string } & CallOptions,
  ): Promise<Turn> {
    const { turn, id, ...call } = options;
    return this.client.request("POST", `${base}/turns/signal`, {
      ...call,
      retry: true,
      body: {
        workflow_id: workflowId,
        turn,
        id,
        name,
        value: copy(value, `signal "${name}"`),
      },
    });
  }
  history(
    id: string,
    options: { after?: number; limit?: number } & CallOptions = {},
  ): Promise<Schemas["WorkflowTurnHistoryResponse"]> {
    const { after, limit, ...call } = options;
    return this.client.request("GET", `${base}/instances/history`, {
      ...call,
      query: { id, after, limit },
    });
  }
  control(
    id: string,
    action: Schemas["WorkflowInstanceAction"],
    turn?: number,
    options?: CallOptions,
  ): Promise<Instance> {
    // Explicit turn number prevents a repeated operator command acting on its successor.
    return this.client.request("POST", `${base}/instances/control`, {
      ...options,
      retry: false,
      body: { workflow_id: id, action, turn },
    });
  }
  /**
   * Delete an instance with its turns and history. `deleted` is false when
   * no instance had the id, or when a retry finished an earlier delete.
   * The id can be created again once this returns.
   */
  deleteInstance(
    id: string,
    options?: CallOptions,
  ): Promise<Schemas["WorkflowInstanceDeleteResponse"]> {
    return this.client.request("POST", `${base}/instances/delete`, {
      ...options,
      retry: true,
      body: { workflow_id: id },
    });
  }
}
const suspended = Symbol("workflow sleep");

/**
 * The run of a turn this process runs: the `workflow` its activity calls
 * name, what those calls used, added up for the completion, and the steps
 * whose function ran in this attempt.
 * @internal
 */
export interface ActivityTurn {
  workflow: Schemas["ActivityWorkflow"];
  usage: Schemas["WorkflowRunUsage"];
  /**
   * What the turn did with each input (`writeOwned`, `review`,
   * `requeue`), for the completion's `results`; absent when the claim
   * named no `results_max`.
   */
  results?: RunResultsCollector;
  /** The instances of the turn's trigger message. */
  instances?: ReadonlySet<string>;
  /**
   * Each step whose function ran in this attempt: its effect id and its
   * key. At most 64 (the steps of a turn), cleared when the turn ends.
   */
  steps: Map<string, string>;
}

/** The run of the turn a context belongs to. @internal */
export const TURN_RUN: unique symbol = Symbol("lbb.workflow.turnRun");

/** The run of the turn `ctx` belongs to, when a worker made it. @internal */
export function turnRunOf(ctx: WorkflowContext): ActivityTurn | undefined {
  return (ctx as { [TURN_RUN]?: ActivityTurn })[TURN_RUN];
}

/** The instances a trigger message (or a continuation's message) names. */
function messageInstances(message: unknown): string[] {
  const instances =
    message && typeof message === "object"
      ? (message as { instances?: unknown }).instances
      : undefined;
  return Array.isArray(instances)
    ? instances.filter((iri): iri is string => typeof iri === "string")
    : [];
}

/**
 * The results a turn reports: what its calls reported, and, at a
 * completion, the instances of its trigger message that it named nowhere
 * and that its continuation does not carry (`no_value`). Nothing when the
 * claim named no `results_max`, or when no call reported an input.
 */
function reportedResults(
  turn: ActivityTurn,
  message: unknown,
  continuation?: { message: unknown } | null,
) {
  const results = turn.results;
  if (!results?.size) return {};
  if (message !== undefined) {
    const carried = new Set(messageInstances(continuation?.message));
    for (const iri of messageInstances(message))
      if (!results.has(iri) && !carried.has(iri))
        results.add({ iri, label: "", outcome: "no_value", values: [] });
  }
  const report = results.report();
  return report ? { results: report } : {};
}

/**
 * The running turn whose trigger message names `iri`: a review item about
 * an input belongs to the turn that reads it. `undefined` when none or
 * more than one does.
 * @internal
 */
export function turnOfInstance(iri: string): ActivityTurn | undefined {
  let found: ActivityTurn | undefined;
  for (const turn of runningTurns.values()) {
    if (!turn.instances?.has(iri)) continue;
    if (found) return undefined;
    found = turn;
  }
  return found;
}

/** A request the server refused as too large (`413`). */
const tooLarge = (error: unknown) =>
  error instanceof LbbError && error.status === 413;

/** The turns this process runs now, by their effect prefix. */
const runningTurns = new Map<string, ActivityTurn>();

/**
 * The turn an activity call belongs to: the turn whose effect prefix starts
 * `effectId` (a step's `effectId`, or one made from it such as
 * `${s.effectId}.2`); else, when this process runs one turn only, that
 * turn. `undefined` outside a turn.
 * @internal
 */
export function activityTurn(
  effectId: string | undefined,
): ActivityTurn | undefined {
  if (effectId !== undefined) {
    const slash = effectId.indexOf("/");
    const turn =
      slash > 0 ? runningTurns.get(effectId.slice(0, slash)) : undefined;
    if (turn) return turn;
  }
  if (runningTurns.size !== 1) return undefined;
  return runningTurns.values().next().value;
}

/**
 * The key of the step of `turn` that makes an activity call: the step whose
 * effect id is `effectId`, else the step with the longest effect id that
 * `effectId` starts with followed by `.` or `:` (an id made from it, such as
 * `${s.effectId}.2`). `undefined` when no step of the turn matches. The
 * lookup reads the step runner's record and parses no step from the id.
 * @internal
 */
export function activityStep(
  turn: ActivityTurn,
  effectId: string | undefined,
): string | undefined {
  if (effectId === undefined) return undefined;
  const exact = turn.steps.get(effectId);
  if (exact !== undefined) return exact;
  let found: { id: string; key: string } | undefined;
  for (const [id, key] of turn.steps) {
    const next = effectId[id.length];
    if (
      (next === "." || next === ":") &&
      effectId.startsWith(id) &&
      (!found || id.length > found.id.length)
    )
      found = { id, key };
  }
  return found?.key;
}

/** Add one activity call's usage to its turn. @internal */
export function addTurnUsage(
  turn: ActivityTurn,
  used: Partial<Schemas["WorkflowRunUsage"]>,
): void {
  for (const key of [
    "calls",
    "errors",
    "tokens_in",
    "tokens_out",
    "cost_micro_usd",
  ] as const) {
    turn.usage[key] = (turn.usage[key] ?? 0) + (used[key] ?? 0);
  }
}

/** The usage a turn reports, or nothing when it made no activity call. */
const reportedUsage = (turn: ActivityTurn) =>
  (turn.usage.calls ?? 0) > 0 || (turn.usage.errors ?? 0) > 0
    ? { usage: { ...turn.usage } }
    : {};

/** Progress writes of one step at most this often, by default. */
const PROGRESS_EVERY_MS = 3_000;
const UNIT = /^[\p{L}\p{N} _-]{1,32}$/u;
/** Progress details in the convention the console draws, checked as the server checks them. */
function progressDetails(
  phase: string,
  counts: WorkflowProgressCounts,
): { phase: string; done: number; total?: number; unit?: string } {
  const text = typeof phase === "string" ? phase.trim() : "";
  const whole = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  if (!text || [...text].length > 80 || /\p{Cc}/u.test(text))
    throw new WorkflowError(
      "Progress phase must be text of 1 to 80 characters",
    );
  if (!whole(counts?.done))
    throw new WorkflowError(
      "Progress done must be a whole number of at least 0",
    );
  if (counts.total !== undefined && !whole(counts.total))
    throw new WorkflowError(
      "Progress total must be a whole number of at least 0",
    );
  const unit = counts.unit?.trim();
  if (counts.unit !== undefined && !(unit && UNIT.test(unit)))
    throw new WorkflowError(
      "Progress unit must be a short word of 1 to 32 characters",
    );
  return {
    phase: text,
    done: counts.done,
    ...(counts.total !== undefined ? { total: counts.total } : {}),
    ...(unit ? { unit } : {}),
  };
}

/** One turn at a time per worker; run additional worker processes for concurrency. */
export class WorkflowWorker {
  constructor(
    private readonly client: LbbClient,
    private readonly definitions: readonly RegisteredWorkflow[],
    private readonly options: {
      worker: string;
      /** Opt into turn-scoped SELECT/ASK. Disabled servers refuse before claim. */
      executionReads?: boolean;
      /** A step's `progress` writes at most this often (default 3000 ms). */
      progressEveryMs?: number;
    },
  ) {
    const keys = definitions.map((d) => `${d.name}/${d.version}`);
    if (!keys.length || new Set(keys).size !== keys.length)
      throw new WorkflowError("Register distinct workflow name/version pairs");
  }
  async run(options: { signal: AbortSignal }): Promise<void> {
    while (!options.signal.aborted) {
      try {
        await this.runOnce({ signal: options.signal, waitMs: 10_000 });
      } catch (error) {
        if (options.signal.aborted) return;
        throw error;
      }
    }
  }
  async runOnce(
    options: { signal?: AbortSignal; waitMs?: number } = {},
  ): Promise<boolean> {
    const claimed = await this.client.request<
      Schemas["WorkflowTurnClaimResponse"]
    >("POST", `${base}/turns/claim`, {
      signal: options.signal,
      retry: false,
      body: {
        worker: this.options.worker,
        ...(this.options.executionReads
          ? { include_execution_credential: true }
          : {}),
        workflows: this.definitions.map((d) => ({
          workflow_type: d.name,
          version: d.version,
        })),
        wait_ms: options.waitMs ?? 0,
      },
    });
    if (!claimed.task) return false;
    await this.execute(claimed.task, options.signal);
    return true;
  }
  private async execute(task: Task, signal?: AbortSignal): Promise<void> {
    const definition = this.definitions.find(
      (d) => d.name === task.workflow_type && d.version === task.turn.version,
    );
    if (!definition)
      throw new WorkflowError(
        "Server returned an unregistered workflow version",
      );
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const lease = {
      workflow_id: task.turn.workflow_id,
      turn: task.turn.number,
      token: task.token,
    };
    const turnGraph = this.client.graphName;
    // The run of this attempt: the activity calls of its steps name it,
    // and their usage goes with the completion.
    const turnRun: ActivityTurn = {
      workflow: {
        identity: task.turn.workflow_id,
        turn: task.turn.number,
        ...(task.turn.run?.id ? { run_id: task.turn.run.id } : {}),
      },
      usage: {
        calls: 0,
        errors: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost_micro_usd: 0,
      },
      // A server that writes results names how many a run keeps whole.
      ...(task.results_max
        ? { results: new RunResultsCollector(task.results_max) }
        : {}),
      instances: new Set(messageInstances(task.turn.message)),
      steps: new Map(),
    };
    runningTurns.set(task.effect_prefix, turnRun);
    let alive = true,
      busy = false,
      position = 0,
      stopped = false;
    let invalid: WorkflowError | undefined;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (stopped) throw suspended;
      if (!alive || controller.signal.aborted)
        throw (
          controller.signal.reason ??
          new WorkflowError("Turn no longer owns its lease")
        );
      if (invalid) throw invalid;
    };
    const renew = async () => {
      try {
        await this.client.request("POST", `${base}/turns/heartbeat`, {
          body: lease,
          retry: false,
          signal: controller.signal,
          timeoutMs: Math.max(50, Math.floor(task.lease_ms / 3)),
        });
        if (alive && !stopped)
          heartbeat = setTimeout(
            () => {
              void renew();
            },
            Math.max(20, task.lease_ms / 3),
          );
      } catch (error) {
        if (alive && !stopped) controller.abort(error);
      }
    };
    heartbeat = setTimeout(
      () => {
        void renew();
      },
      Math.max(20, task.lease_ms / 3),
    );
    const stopHeartbeat = () => {
      stopped = true;
      clearTimeout(heartbeat);
    };
    // A request of a turn route. A 409 (`turn_lease_lost`, or another
    // conflict) or a 404 (the instance is gone) ends the attempt here:
    // nothing more is sent for it.
    const turnRequest = async <T>(
      route: string,
      body: Record<string, unknown>,
    ): Promise<T> => {
      try {
        return await this.client.request<T>("POST", `${base}/turns/${route}`, {
          signal: controller.signal,
          retry: true,
          body,
        });
      } catch (error) {
        if (gone(error)) controller.abort(error);
        throw error;
      }
    };
    const checkpoint = async (
      key: string,
      kind: "step" | "sleep" | "signal",
      effect?: (context: WorkflowStepContext) => Promise<unknown>,
      delay?: number,
      signalName?: string,
      stepOptions: WorkflowStepOptions = {},
    ): Promise<unknown> => {
      check();
      if (busy || !/^[A-Za-z0-9_.-]{1,128}$/.test(key) || position >= 64) {
        invalid = new WorkflowError(
          "Await sequential steps with distinct valid keys; at 64 steps return ctx.continue(state, cursor)",
        );
        throw invalid;
      }
      busy = true;
      try {
        const index = position++;
        const old = task.turn.steps[index];
        if (old) {
          if (
            old.key !== key ||
            old.kind !== kind ||
            (old.delay_ms ?? undefined) !== delay ||
            (old.signal_name ?? undefined) !== signalName
          ) {
            invalid = new WorkflowError(
              "Step order changed: keep code for existing workflow versions",
            );
            throw invalid;
          }
          // A step that reported inputs saved them: report them again, as
          // they were in this run (a resume), or as an earlier attempt's.
          const saved = stepOutputResults(old.output);
          for (const input of saved.run === turnRun.workflow.run_id
            ? saved.results
            : replayedInputs(saved.results))
            turnRun.results?.add(input);
          return copy(saved.value);
        }
        if (task.turn.steps.some((s) => s.key === key)) {
          invalid = new WorkflowError("Step keys must be unique within a turn");
          throw invalid;
        }
        let output: unknown = null;
        // What the step reported, kept in its saved output.
        let reported: ReturnType<RunResultsCollector["endStep"]> = [];
        if (kind === "step") {
          const timeout = stepOptions.timeoutMs ?? 300_000;
          const progressTimeout = stepOptions.heartbeatTimeoutMs;
          if (
            !Number.isSafeInteger(timeout) ||
            timeout < 100 ||
            timeout > 86_400_000 ||
            (progressTimeout !== undefined &&
              (!Number.isSafeInteger(progressTimeout) ||
                progressTimeout < 100 ||
                progressTimeout > timeout))
          )
            throw new WorkflowError("Invalid operation/progress timeout");
          const begun = await turnRequest<Turn>("operation", {
            ...lease,
            key,
            position: index,
            kind: stepOptions.kind ?? "step",
            timeout_ms: timeout,
            heartbeat_timeout_ms: progressTimeout,
          });
          check(); // A late begin response cannot authorize I/O after lease loss.
          let sequence = 0,
            active = true;
          let cursor: unknown = begun.operation?.checkpoint ?? null;
          let pending: Promise<void> = Promise.resolve();
          /** One progress write, in order behind the earlier ones. */
          const report = (details: unknown, savedCursor?: unknown) => {
            pending = pending.then(async () => {
              check();
              if (savedCursor !== undefined) cursor = savedCursor;
              await turnRequest("progress", {
                ...lease,
                key,
                sequence: ++sequence,
                details,
                checkpoint: cursor,
              });
              check();
              watchProgress();
            });
            // The worker also observes this promise if the handler forgets to await it.
            void pending.catch(() => {});
            return pending;
          };
          // Coalesced `progress`: a phase change goes out at once, other
          // values at most once per interval, the last value wins.
          const progressEvery = Math.min(
            this.options.progressEveryMs ?? PROGRESS_EVERY_MS,
            progressTimeout !== undefined
              ? Math.max(50, Math.floor(progressTimeout / 2))
              : Infinity,
          );
          let lastPhase: string | undefined;
          let lastSentAt = -Infinity;
          let held: ReturnType<typeof progressDetails> | undefined;
          let flushTimer: ReturnType<typeof setTimeout> | undefined;
          const flush = () => {
            clearTimeout(flushTimer);
            flushTimer = undefined;
            if (held === undefined) return;
            const details = held;
            held = undefined;
            lastPhase = details.phase;
            lastSentAt = Date.now();
            void report(details);
          };
          const deadline = setTimeout(
            () => controller.abort(new Error(`Operation ${key} timed out`)),
            timeout,
          );
          let progressTimer: ReturnType<typeof setTimeout> | undefined;
          const watchProgress = () => {
            clearTimeout(progressTimer);
            if (progressTimeout !== undefined)
              progressTimer = setTimeout(
                () =>
                  controller.abort(
                    new Error(`Operation ${key} stopped reporting progress`),
                  ),
                progressTimeout,
              );
          };
          watchProgress();
          const clearOperationTimers = () => {
            clearTimeout(deadline);
            clearTimeout(progressTimer);
            clearTimeout(flushTimer);
          };
          controller.signal.addEventListener("abort", clearOperationTimers, {
            once: true,
          });
          const effectId = `${task.effect_prefix}/${key}`;
          // An activity call with this id, or one made from it, names the step.
          turnRun.steps.set(effectId, key);
          turnRun.results?.beginStep();
          try {
            output = copy(
              await effect!({
                effectId,
                fence: { ...lease },
                graph: turnGraph,
                signal: controller.signal,
                checkpoint: copy(cursor),
                heartbeat: (details, options) => {
                  check();
                  if (!active)
                    throw new WorkflowError("Operation has already finished");
                  const savedDetails = copy(details, `step "${key}" progress`);
                  const savedCursor =
                    options && "checkpoint" in options
                      ? copy(options.checkpoint, `step "${key}" checkpoint`)
                      : undefined;
                  // An explicit heartbeat is newer than a held progress value.
                  held = undefined;
                  clearTimeout(flushTimer);
                  flushTimer = undefined;
                  return report(savedDetails, savedCursor);
                },
                progress: (phase, counts) => {
                  check();
                  if (!active)
                    throw new WorkflowError("Operation has already finished");
                  held = progressDetails(phase, counts);
                  const wait = lastSentAt + progressEvery - Date.now();
                  if (held.phase !== lastPhase || wait <= 0) flush();
                  else flushTimer ??= setTimeout(flush, wait);
                },
              }),
              `step "${key}"`,
            );
            // The last progress value goes out before the step's checkpoint.
            flush();
            active = false;
            await pending;
          } finally {
            reported = turnRun.results?.endStep() ?? [];
            active = false;
            clearOperationTimers();
            controller.signal.removeEventListener(
              "abort",
              clearOperationTimers,
            );
          }
        }
        check();
        if (kind !== "step") stopHeartbeat();
        const savedOutput = stepOutputWithResults(
          output,
          turnRun.workflow.run_id ?? "",
          reported,
        );
        const saved = await turnRequest<Turn>(
          kind === "signal" ? "wait-signal" : "checkpoint",
          kind === "signal"
            ? {
                ...lease,
                position: index,
                key,
                name: signalName,
                timeout_ms: delay,
              }
            : {
                ...lease,
                position: index,
                key,
                kind,
                output: savedOutput,
                delay_ms: delay,
              },
        );
        if (kind === "signal") {
          const entry = saved.steps[index];
          task.turn.steps.push(entry);
          if (saved.status === "waiting") throw suspended;
          stopped = false;
          heartbeat = setTimeout(
            () => {
              void renew();
            },
            Math.max(20, task.lease_ms / 3),
          );
          return copy(entry.output);
        }
        task.turn.steps.push({
          key,
          kind,
          output: savedOutput,
          delay_ms: delay ?? null,
          at_ms: 0,
          wake_at_ms: null,
          signal_name: null,
        });
        if (kind === "sleep") throw suspended;
        return copy(output);
      } finally {
        busy = false;
      }
    };
    let executionReader: WorkflowTurnReader | undefined;
    const ctx: WorkflowContext = {
      signal: controller.signal,
      workflowId: lease.workflow_id,
      messageId: task.turn.message_id,
      turn: lease.turn,
      sparql: async (request, options) => {
        check();
        if (!executionReader)
          throw new WorkflowExecutionError(
            "Enable executionReads on this worker; no query was sent",
          );
        return executionReader.sparql(request, options);
      },
      execution: () => {
        check();
        if (!executionReader)
          throw new WorkflowExecutionError(
            "Enable executionReads on this worker; nothing was sent",
          );
        return executionReader;
      },
      origin: task.turn.origin ?? null,
      workflowName: workflowOfIdentity(lease.workflow_id),
      step: async <T>(
        key: string,
        fn: (context: WorkflowStepContext) => Promise<T>,
        options?: WorkflowStepOptions,
      ) =>
        (await checkpoint(key, "step", fn, undefined, undefined, options)) as T,
      waitForSignal: async <T>(
        key: string,
        options: { name: string; timeoutMs: number },
      ) => {
        if (
          !/^[A-Za-z0-9_.-]{1,128}$/.test(options.name) ||
          !Number.isSafeInteger(options.timeoutMs) ||
          options.timeoutMs < 1 ||
          options.timeoutMs > 365 * 86_400_000
        )
          throw new WorkflowError("Invalid signal name/timeout");
        return (await checkpoint(
          key,
          "signal",
          undefined,
          options.timeoutMs,
          options.name,
        )) as WorkflowSignalResult<T>;
      },
      sleep: async (key, delay) => {
        if (
          !Number.isSafeInteger(delay) ||
          delay < 0 ||
          delay > 365 * 86_400_000
        )
          throw new WorkflowError("Invalid sleep duration");
        await checkpoint(key, "sleep", undefined, delay);
      },
      continue: (state, message) => ({ state, continuation: { message } }),
    };
    // `writeOwned` and `requeue` report their inputs to the turn's run.
    Object.defineProperty(ctx, TURN_RUN, { value: turnRun });
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(controller.signal.reason ?? new Error("Workflow interrupted"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    // Race cancellation even when a provider ignores AbortSignal. Late managed writes are fenced.
    try {
      check();
      if (this.options.executionReads)
        executionReader = new WorkflowTurnReader(
          this.client,
          task,
          controller.signal,
          check,
        );
      const result = await Promise.race([
        definition.execute(ctx, copy(task.state), copy(task.turn.message)),
        aborted,
      ]);
      check();
      if (busy || position !== task.turn.steps.length)
        throw new WorkflowError(
          "Handler left unawaited steps or omitted saved steps",
        );
      if (stopped) throw suspended; // A handler must not swallow a sleep suspension and commit.
      const body = {
        ...lease,
        state: copy(result.state, "state"),
        result: copy(result.result ?? null, "result"),
        continuation: result.continuation
          ? copy(result.continuation, "continuation")
          : null,
        ...reportedUsage(turnRun),
      };
      const results = reportedResults(
        turnRun,
        task.turn.message,
        result.continuation,
      );
      // Serialize completion retries exactly; a lost response must not rerun effects.
      stopHeartbeat();
      try {
        await turnRequest("complete", { ...body, ...results });
      } catch (error) {
        // Results never cost a completion: a body too large for the server
        // goes again without them.
        if (!(tooLarge(error) && "results" in results)) throw error;
        await turnRequest("complete", body);
      }
    } catch (error) {
      if (error === suspended) return;
      if (controller.signal.aborted) {
        if (signal?.aborted) throw signal.reason ?? error;
        return; // The coordinator expires/fences this attempt and schedules its retry.
      }
      // A fenced write found the lease gone: the turn's next holder writes.
      if (error instanceof LbbError && error.code === "workflow_fence_lost")
        return;
      stopHeartbeat();
      // A wait for a cause outside the turn counts no attempt.
      const retryAt = waitOf(error);
      const failBody = {
        ...lease,
        error: String(error).slice(0, 1000),
        non_retryable:
          retryAt === undefined &&
          (error instanceof WorkflowError ||
            error instanceof WorkflowExecutionError),
        ...(retryAt !== undefined
          ? { retry_at_ms: Math.max(retryAt, Date.now() + MIN_WAIT_MS) }
          : {}),
        ...reportedUsage(turnRun),
      };
      const failResults = reportedResults(turnRun, undefined);
      const sendFail = (body: object) =>
        this.client.request("POST", `${base}/turns/fail`, {
          body,
          retry: false,
          signal: controller.signal,
        });
      try {
        try {
          await sendFail({ ...failBody, ...failResults });
        } catch (refused) {
          // Results never cost a failure either.
          if (!(tooLarge(refused) && "results" in failResults)) throw refused;
          await sendFail(failBody);
        }
      } catch (refused) {
        // The turn is no longer this worker's: nothing to fail.
        if (!gone(refused)) throw refused;
      }
    } finally {
      if (runningTurns.get(task.effect_prefix) === turnRun)
        runningTurns.delete(task.effect_prefix);
      turnRun.steps.clear();
      controller.signal.removeEventListener("abort", onAbort);
      alive = false;
      stopHeartbeat();
      controller.abort();
      signal?.removeEventListener("abort", abort);
    }
  }
}
