import type { LbbClient, Schemas } from "./client.js";

/** Read fields only. No eval trace, routing hint, graph or credential override. */
export type WorkflowReadRequest = Pick<
  Schemas["SparqlTextRequest"],
  | "query"
  | "cursor"
  | "as_of_commit_seq"
  | "limit"
  | "offset"
  | "entailment"
  | "profile"
>;
export interface WorkflowReadOptions {
  /** Positive per-call ceiling; also bounded by the issued credential expiry. */
  timeoutMs?: number;
  signal?: AbortSignal;
}
export class WorkflowExecutionError extends Error {}

type Task = Schemas["WorkflowTurnTask"];
type Credential = Schemas["WorkflowExecutionCredential"] & {
  issued_at_ms?: number | null;
};
const refreshMarginMs = 1_000;
type Operation = "sparql_read";
const route = "/v1/workflows/turns/execution-credential";
const fields = new Set([
  "query",
  "cursor",
  "as_of_commit_seq",
  "limit",
  "offset",
  "entailment",
  "profile",
]);
const identityFields = [
  "graph_id",
  "graph_epoch",
  "workflow_id",
  "turn",
  "attempt",
  "run_id",
] as const;
const refuse = (reason: string): never => {
  throw new WorkflowExecutionError(reason);
};
function validateCredential(
  value: Credential | null | undefined,
  operation: Operation = "sparql_read",
): Credential {
  if (!value || typeof value !== "object")
    return refuse(
      "Claim did not return a workflow execution credential; no read was sent",
    );
  if (
    typeof value.token !== "string" ||
    !/^lbb_wke_[A-Za-z0-9._-]+$/.test(value.token) ||
    !Number.isSafeInteger(value.expires_at_ms) ||
    value.expires_at_ms <= 0 ||
    (value.issued_at_ms != null &&
      (!Number.isSafeInteger(value.issued_at_ms) ||
        value.issued_at_ms <= 0 ||
        value.expires_at_ms <= value.issued_at_ms ||
        value.expires_at_ms - value.issued_at_ms > 60_000)) ||
    typeof value.graph_id !== "string" ||
    !value.graph_id ||
    typeof value.graph_epoch !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(value.graph_epoch) ||
    BigInt(value.graph_epoch) > 18446744073709551615n ||
    typeof value.workflow_id !== "string" ||
    !value.workflow_id ||
    !Number.isSafeInteger(value.turn) ||
    value.turn < 1 ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    value.attempt > 4294967295 ||
    typeof value.run_id !== "string" ||
    !value.run_id ||
    !Array.isArray(value.operations) ||
    value.operations.length !== 1 ||
    value.operations[0] !== operation
  )
    return refuse("Invalid workflow execution credential; no read was sent");
  return { ...value, operations: [...value.operations] };
}
function readBody(request: WorkflowReadRequest | string): WorkflowReadRequest {
  const body = typeof request === "string" ? { query: request } : request;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.query !== "string" ||
    !body.query.trim() ||
    Object.keys(body).some((key) => !fields.has(key))
  )
    return refuse(
      "Workflow reads accept only query, cursor, as_of_commit_seq, limit, offset, entailment and profile",
    );
  return { ...body };
}
function optionsChecked(options: WorkflowReadOptions): void {
  if (
    Object.keys(options).some(
      (key) => key !== "timeoutMs" && key !== "signal",
    ) ||
    (options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
  )
    refuse(
      "Workflow read options accept only a positive timeoutMs and an AbortSignal",
    );
}

/**
 * Bounded reads for one claimed attempt. Construct only from a task claimed with
 * include_execution_credential. The control client refreshes the credential;
 * all queries use the separate execution bearer. This class does not renew the
 * workflow lease or checkpoint results. Do that through the control channel.
 */
export class WorkflowTurnReader {
  #control: LbbClient;
  #credential: Credential;
  // A supplied task may have waited before construction. Only a fresh control
  // response establishes a local lifetime; wall-clock offsets are irrelevant.
  #deadline: number | undefined;
  #lease: Schemas["WorkflowTurnLeaseRequest"];
  #signal: AbortSignal | undefined;
  #check: () => void;
  constructor(
    control: LbbClient,
    task: Task,
    signal?: AbortSignal,
    check: () => void = () => {},
  ) {
    const credential = validateCredential(task.execution_credential);
    if (
      !task.turn.run?.id ||
      credential.workflow_id !== task.turn.workflow_id ||
      credential.turn !== task.turn.number ||
      credential.attempt !== task.turn.attempt ||
      credential.run_id !== task.turn.run.id ||
      typeof task.token !== "string" ||
      !task.token
    )
      refuse("Execution credential does not match the claimed turn attempt");
    this.#credential = credential;
    this.#lease = {
      workflow_id: task.turn.workflow_id,
      turn: task.turn.number,
      token: task.token,
    };
    this.#control = control.withScope({
      graph: credential.graph_id,
      expectedGraphEpoch: credential.graph_epoch,
    });
    this.#signal = signal;
    this.#check = check;
  }
  async sparql(
    request: WorkflowReadRequest | string,
    options: WorkflowReadOptions = {},
  ): Promise<Schemas["SparqlTextResponse"]> {
    return this.#execute(
      "sparql_read",
      "/v1/query/sparql-text",
      readBody(request),
      options,
    );
  }
  async #execute<T>(
    operation: Operation,
    path: string,
    body: unknown,
    options: WorkflowReadOptions,
    responseType: "json" | "bytes" = "json",
  ): Promise<T> {
    optionsChecked(options);
    const controller = new AbortController();
    const signals = [this.#signal, options.signal].filter(
      (s): s is AbortSignal => s !== undefined,
    );
    const listeners = signals.map((signal) => {
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      return () => signal.removeEventListener("abort", abort);
    });
    const check = () => {
      this.#check();
      if (controller.signal.aborted)
        throw controller.signal.reason ?? new Error("Workflow read aborted");
    };
    try {
      check();
      const budget = Math.min(options.timeoutMs ?? 30_000, 30_000);
      let credential = this.#credential;
      if (
        this.#deadline === undefined ||
        this.#deadline - performance.now() <= budget + refreshMarginMs
      ) {
        const started = performance.now();
        const refreshed = validateCredential(
          await this.#control.request<Credential>("POST", route, {
            body: this.#lease,
            retry: false,
            maxRetries: 0,
            timeoutMs: budget,
            signal: controller.signal,
          }),
          operation,
        );
        check();
        if (
          identityFields.some((key) => refreshed[key] !== this.#credential[key])
        )
          refuse(
            "Refreshed execution credential changed the claimed graph or turn attempt",
          );
        if (refreshed.issued_at_ms == null)
          throw new Error(
            "Workflow credential lifetime unavailable; upgrade the server before retrying this read",
          );
        // Starting before the request conservatively charges its whole round trip.
        this.#deadline =
          started + (refreshed.expires_at_ms - refreshed.issued_at_ms);
        this.#credential = refreshed;
        credential = refreshed;
      }
      check();
      const remaining = this.#deadline! - performance.now();
      if (remaining <= 0)
        throw new Error(
          "Workflow execution credential lifetime elapsed; retry the read with a live lease",
        );
      const result = await this.#control.request<T>("POST", path, {
        body,
        responseType,
        retry: false,
        maxRetries: 0,
        timeoutMs: Math.min(budget, remaining),
        signal: controller.signal,
        headers: { authorization: `Bearer ${credential.token}` },
      });
      check();
      return result;
    } finally {
      for (const remove of listeners) remove();
    }
  }
}
