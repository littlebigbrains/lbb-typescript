import type { LbbClient, Schemas } from "./client.js";
import { LbbError, type CallOptions } from "./transport.js";

export interface RecordCommitOptions extends CallOptions {
  /** Retain this exact key and body when retrying an unknown outcome. */
  idempotencyKey: string;
  expectedGraphEpoch?: string;
}

/** The POST may have committed, but its response did not prove acceptance. */
export class LbbRecordCommitOutcomeError extends Error {
  readonly outcome = "unknown";
  constructor(
    readonly idempotencyKey: string,
    options?: ErrorOptions,
  ) {
    super(
      `Record commit outcome is unknown; the request may have committed. Retry the original body with the same idempotency key (${idempotencyKey}) to recover its receipt.`,
      options,
    );
    this.name = "LbbRecordCommitOutcomeError";
  }
}

const CAPABILITY = "records_commit_v1";
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function counter(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function ids(value: unknown): boolean {
  return Array.isArray(value) && value.every(text);
}
function checkedResult(
  value: unknown,
  key: string,
): Schemas["RecordCommitResult"] {
  const failure = () => new LbbRecordCommitOutcomeError(key);
  if (
    !object(value) ||
    value.object !== "record_commit" ||
    value.version !== "records/1" ||
    typeof value.idempotent_replay !== "boolean" ||
    !object(value.receipt)
  )
    throw failure();
  const receipt = value.receipt;
  if (
    !text(receipt.epoch) ||
    receipt.epoch.length > 20 ||
    !/^(0|[1-9][0-9]*)$/.test(receipt.epoch) ||
    BigInt(receipt.epoch) > 18_446_744_073_709_551_615n ||
    !counter(receipt.commit_seq) ||
    !text(receipt.visibility_token) ||
    !text(receipt.schema_revision) ||
    typeof receipt.no_op !== "boolean" ||
    !object(receipt.scope) ||
    !text(receipt.scope.owner) ||
    !text(receipt.scope.scope) ||
    !object(receipt.resolved_ids) ||
    !ids(receipt.resolved_ids.entities) ||
    !ids(receipt.resolved_ids.relationships) ||
    !object(receipt.projection) ||
    !counter(receipt.projection.added) ||
    !counter(receipt.projection.removed) ||
    (receipt.no_op &&
      (receipt.projection.added !== 0 || receipt.projection.removed !== 0))
  ) {
    throw failure();
  }
  return value as unknown as Schemas["RecordCommitResult"];
}

/** Exact records on the existing commit resource. This never activates a graph. */
export class RecordsNamespace {
  constructor(
    private readonly client: LbbClient,
    private readonly requireCapability: (capability: string) => Promise<void>,
  ) {}

  /**
   * Commit to an existing support-enabled graph. An unsupported graph stays a
   * typed server refusal. Acceptance and publication/search readiness differ.
   * On an unknown outcome retry this original body and key, never a new key.
   */
  async commit(
    body: Schemas["RecordCommitRequest"],
    options: RecordCommitOptions,
  ): Promise<Schemas["RecordCommitResult"]> {
    if (!object(body) || body.version !== "records/1") {
      throw new TypeError("records.commit requires explicit version records/1");
    }
    const captured = { ...options, headers: { ...options?.headers } };
    const key = captured.idempotencyKey;
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new TypeError("records.commit requires an explicit idempotencyKey");
    }
    if (
      Object.keys(captured.headers).some(
        (name) => name.trim().toLowerCase() === "idempotency-key",
      )
    ) {
      throw new TypeError(
        "use idempotencyKey, not an Idempotency-Key header override",
      );
    }
    if (
      captured.maxRetries !== undefined &&
      (!Number.isInteger(captured.maxRetries) || captured.maxRetries < 0)
    ) {
      throw new RangeError("maxRetries must be a non-negative integer");
    }
    if (captured.signal?.aborted)
      throw captured.signal.reason ?? new Error("request aborted");
    const epoch = captured.expectedGraphEpoch;
    if (
      epoch !== undefined &&
      (typeof epoch !== "string" ||
        epoch.length > 20 ||
        !/^(0|[1-9][0-9]*)$/.test(epoch) ||
        BigInt(epoch) > 18_446_744_073_709_551_615n)
    ) {
      throw new TypeError("expectedGraphEpoch must be a decimal u64 string");
    }
    // Snapshot before the first await. Validate the encoded selector too: a
    // getter/toJSON supplied through a cast cannot turn this into legacy POST.
    const rawBody = JSON.stringify(body);
    const encoded: unknown = JSON.parse(rawBody);
    if (!object(encoded) || encoded.version !== "records/1") {
      throw new TypeError(
        "encoded records.commit body must retain version records/1",
      );
    }
    await this.requireCapability(CAPABILITY);
    if (captured.signal?.aborted)
      throw captured.signal.reason ?? new Error("request aborted");
    try {
      const result = await this.client.request<unknown>(
        "POST",
        "/v1/graph/commit",
        {
          ...captured,
          idempotencyKey: key,
          rawBody,
          contentType: "application/json",
          query: { expected_graph_epoch: epoch },
        },
      );
      return checkedResult(result, key);
    } catch (error) {
      // Once POST is entered, a transport failure cannot establish that the
      // mutation was refused. Typed server replies retain their own contract.
      if (
        error instanceof LbbError ||
        error instanceof LbbRecordCommitOutcomeError
      )
        throw error;
      throw new LbbRecordCommitOutcomeError(key, { cause: error });
    }
  }
}
