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
/**
 * One operation of an execution credential: `sparql_read` (SELECT/ASK), and
 * the hosted workers' grants `file_read` and `owned_write`, which a server
 * issues only with `LBB_WORKFLOW_EXECUTION_GRANTS`.
 */
export type WorkflowExecutionOperation = Schemas["WorkflowExecutionOperation"];
type Operation = WorkflowExecutionOperation;
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

/** A call of one execution operation. */
interface Execution {
  method: "GET" | "POST" | "PUT";
  path: string;
  query?: Record<string, string | number>;
  body?: unknown;
  idempotencyKey?: string;
  responseType?: "json" | "bytes" | "stream";
}

/**
 * Bounded reads for one claimed attempt. Construct only from a task claimed with
 * include_execution_credential. The control client refreshes the credential;
 * all queries use the separate execution bearer. This class does not renew the
 * workflow lease or checkpoint results. Do that through the control channel.
 *
 * LBB's hosted workers also use the attempt's grants, one credential per
 * operation: `file_read` ({@link fileRecord}, {@link fileContent},
 * {@link filePages}) and `owned_write` ({@link putPages},
 * {@link commitOwned}). A server without `LBB_WORKFLOW_EXECUTION_GRANTS`
 * refuses them (`403 workflow_execution_disabled`) before any work.
 */
export class WorkflowTurnReader {
  #control: LbbClient;
  #credential: Credential;
  // One credential per operation. A supplied task may have waited before
  // construction. Only a fresh control response establishes a local
  // lifetime; wall-clock offsets are irrelevant.
  #credentials = new Map<Operation, Credential>();
  #deadlines = new Map<Operation, number>();
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
    this.#credentials.set("sparql_read", credential);
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
      {
        method: "POST",
        path: "/v1/query/sparql-text",
        body: readBody(request),
      },
      options,
    );
  }
  /** The record of a file of the claimed graph (`file_read`). */
  async fileRecord(
    sha256: string,
    options: WorkflowReadOptions = {},
  ): Promise<Schemas["FileRecord"]> {
    return this.#execute(
      "file_read",
      { method: "GET", path: "/v1/files/record", query: { sha256 } },
      options,
    );
  }
  /** The bytes of a file of the claimed graph (`file_read`). */
  async fileContent(
    sha256: string,
    options: WorkflowReadOptions = {},
  ): Promise<Uint8Array> {
    return this.#execute(
      "file_read",
      {
        method: "GET",
        path: "/v1/files/content",
        query: { sha256 },
        responseType: "bytes",
      },
      options,
    );
  }
  /**
   * The bytes of a file in chunks as they arrive (`file_read`), so a large
   * file is never held whole. `timeoutMs` bounds the wait for the answer,
   * not the transfer; the turn's and the caller's signals abort it.
   */
  async fileContentStream(
    sha256: string,
    options: WorkflowReadOptions = {},
  ): Promise<AsyncGenerator<Uint8Array, void, undefined>> {
    return this.#execute(
      "file_read",
      {
        method: "GET",
        path: "/v1/files/content",
        query: { sha256 },
        responseType: "stream",
      },
      options,
    );
  }
  /** The stored pages of a file, `from` to `to` (`file_read`). */
  async filePages(
    sha256: string,
    range: { from?: number; to?: number } = {},
    options: WorkflowReadOptions = {},
  ): Promise<Schemas["FilePages"]> {
    return this.#execute(
      "file_read",
      {
        method: "GET",
        path: "/v1/files/pages",
        query: {
          sha256,
          ...(range.from !== undefined ? { from: range.from } : {}),
          ...(range.to !== undefined ? { to: range.to } : {}),
        },
      },
      options,
    );
  }
  /**
   * Store the pages a parser made of one upload of a file (`owned_write`,
   * `PUT /v1/files/pages`); see `client.files.putPages`.
   */
  async putPages(
    sha256: string,
    parser: string,
    upload: Schemas["FilePagesPutRequest"],
    options: WorkflowReadOptions = {},
  ): Promise<Schemas["FilePagesPutResponse"]> {
    return this.#execute(
      "owned_write",
      {
        method: "PUT",
        path: "/v1/files/pages",
        query: { sha256, parser },
        body: upload,
      },
      options,
    );
  }
  /**
   * One commit of the attempt as the workflow it runs (`owned_write`,
   * `POST /v1/graph/commit`): the server writes as the workflow's owner and
   * fences the commit to the credential's graph epoch. Pass the step's
   * `effectId` as `idempotencyKey`, so a retry is a replay.
   */
  async commitOwned(
    body: Schemas["TripletCommitFile"],
    commit: { idempotencyKey: string },
    options: WorkflowReadOptions = {},
  ): Promise<Schemas["GraphCommitResponse"]> {
    if (!commit.idempotencyKey)
      refuse("An owned commit needs its idempotency key; no write was sent");
    return this.#execute(
      "owned_write",
      {
        method: "POST",
        path: "/v1/graph/commit",
        body,
        idempotencyKey: commit.idempotencyKey,
      },
      options,
    );
  }
  async #execute<T>(
    operation: Operation,
    call: Execution,
    options: WorkflowReadOptions,
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
      let credential = this.#credentials.get(operation);
      let deadline = this.#deadlines.get(operation);
      if (
        credential === undefined ||
        deadline === undefined ||
        deadline - performance.now() <= budget + refreshMarginMs
      ) {
        const started = performance.now();
        const refreshed = validateCredential(
          await this.#control.request<Credential>("POST", route, {
            body:
              operation === "sparql_read"
                ? this.#lease
                : { ...this.#lease, operation },
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
        deadline = started + (refreshed.expires_at_ms - refreshed.issued_at_ms);
        this.#deadlines.set(operation, deadline);
        this.#credentials.set(operation, refreshed);
        credential = refreshed;
      }
      check();
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new Error(
          "Workflow execution credential lifetime elapsed; retry the read with a live lease",
        );
      if (call.responseType === "stream") {
        // The transfer outlives this call: it takes the turn's and the
        // caller's signals itself.
        const signals = [this.#signal, options.signal].filter(
          (s): s is AbortSignal => s !== undefined,
        );
        return this.#control.requestByteStream(call.method, call.path, {
          ...(call.query ? { query: call.query } : {}),
          retry: false,
          maxRetries: 0,
          timeoutMs: Math.min(budget, remaining),
          ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
          headers: { authorization: `Bearer ${credential.token}` },
        }) as T;
      }
      const result = await this.#control.request<T>(call.method, call.path, {
        ...(call.query ? { query: call.query } : {}),
        ...(call.body !== undefined ? { body: call.body } : {}),
        ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
        responseType: call.responseType === "bytes" ? "bytes" : "json",
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
