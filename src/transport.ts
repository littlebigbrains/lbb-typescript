import type { LbbErrorPayload } from "./types.js";

export interface CallOptions {
  idempotencyKey?: string;
  /** Override the client's per-attempt timeout. Set 0 to disable it. */
  timeoutMs?: number;
  /** Override the client's retry count (secondary cap) for this request. */
  maxRetries?: number;
  /** Override the client's deadline-based retry budget (ms) for this request. */
  retryBudgetMs?: number;
  /** Override retry safety classification. Read-only POST namespaces set this automatically. */
  retry?: boolean;
  /** Abort the request and suppress any further retries. */
  signal?: AbortSignal;
  /** Additional request headers. Values override SDK defaults intentionally. */
  headers?: Record<string, string>;
}

export interface RequestOptions extends CallOptions {
  query?: Query;
  body?: unknown;
  /** Pre-serialized request body (e.g. NDJSON). Takes precedence over `body`. */
  rawBody?: string;
  /** Overrides the default `application/json` content type (used with `rawBody`). */
  contentType?: string;
}

/** Thrown when the server responds with a non-2xx status. */
export class LbbError extends Error {
  readonly type?: string;
  readonly code?: string;
  readonly param?: string | null;
  readonly requestId?: string | null;
  readonly docUrl?: string | null;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
  /** Actionable guidance for composite stack-endpoint routing errors. */
  readonly endpointHint?: string;

  constructor(
    readonly status: number,
    readonly body: string,
    readonly error?: LbbErrorPayload,
  ) {
    super(error?.message ?? `Little Big Brain ${status}: ${body}`);
    this.name = "LbbError";
    this.type = error?.type;
    this.code = error?.code;
    this.param = error?.param;
    this.requestId = error?.request_id;
    this.docUrl = error?.doc_url;
    this.retryable = error?.retryable;
    this.retryAfterSeconds = error?.retry_after_seconds;
    this.endpointHint = endpointMigrationHint(this.code);
  }
}

function endpointMigrationHint(code: string | undefined): string | undefined {
  if (code === "stack_endpoint_required") {
    return "Copy endpoint_url from the stack's Connect page and use it as baseUrl.";
  }
  if (code === "stack_endpoint_mismatch") {
    return "Use the endpoint_url and API key from the same stack.";
  }
  return undefined;
}

export type QueryValue = string | number | boolean | undefined;
export type Query = Record<string, QueryValue>;

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  const timer = (
    globalThis as { setTimeout?: (callback: () => void, ms: number) => unknown }
  ).setTimeout;
  return new Promise((resolve) => {
    if (timer) {
      timer(resolve, ms);
    } else {
      resolve();
    }
  });
}

export function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function retryAllowed(method: string, idempotencyKey?: string): boolean {
  const upper = method.toUpperCase();
  return (
    upper === "GET" ||
    upper === "HEAD" ||
    upper === "OPTIONS" ||
    idempotencyKey !== undefined
  );
}

const MAX_RETRY_AFTER_MS = 60_000;

/** Parse a Retry-After delta-seconds or HTTP-date value, capped at one minute. */
export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.min(Math.max(0, dateMs - nowMs), MAX_RETRY_AFTER_MS);
}

/**
 * Full-jitter exponential backoff: `uniform(0, base * 2**attempt)`, capped at
 * one minute. Replaces linear backoff so many clients recovering from one
 * outage do not retry in lockstep (a thundering herd that re-triggers it).
 */
export function fullJitterBackoffMs(
  baseDelayMs: number,
  attempt: number,
  rng: () => number = Math.random,
): number {
  const ceiling = Math.min(
    Math.max(0, baseDelayMs) * 2 ** attempt,
    MAX_RETRY_AFTER_MS,
  );
  return rng() * ceiling;
}

/**
 * The server's own body hint `error.retry_after_seconds` in ms (capped), or
 * `undefined` when the body is naked (a bare LB 5xx) or carries no hint. Used
 * as the backoff when the `Retry-After` *header* is absent.
 */
export function retryAfterFromBodyMs(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as {
      error?: { retry_after_seconds?: number };
    };
    const seconds = parsed.error?.retry_after_seconds;
    if (
      typeof seconds === "number" &&
      Number.isFinite(seconds) &&
      seconds >= 0
    ) {
      return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
    }
  } catch {
    // Naked LB body (no error envelope) — no hint.
  }
  return undefined;
}

/** The parsed `error.code` from an error body, or `undefined` when absent/naked. */
export function errorCodeFromBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string } };
    const code = parsed.error?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True iff the server explicitly marked this error non-retryable in the body
 * (`error.retryable === false`) — a durable rejection (e.g. an exhausted quota)
 * the client must surface immediately instead of spending its retry budget.
 */
export function bodyMarksTerminal(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: { retryable?: boolean } };
    return parsed.error?.retryable === false;
  } catch {
    return false;
  }
}

/**
 * The backoff (ms) before the next attempt: the `Retry-After` header, else the
 * server's body `retry_after_seconds` hint, else full-jitter exponential
 * backoff.
 */
export function retryDelayMs(
  baseDelayMs: number,
  attempt: number,
  opts: { retryAfterHeader?: string | null; body?: string } = {},
  rng: () => number = Math.random,
): number {
  const header = parseRetryAfterMs(opts.retryAfterHeader);
  if (header !== undefined) return header;
  const bodyHint =
    opts.body !== undefined ? retryAfterFromBodyMs(opts.body) : undefined;
  if (bodyHint !== undefined) return bodyHint;
  return fullJitterBackoffMs(baseDelayMs, attempt, rng);
}

export function parseResponseJson<T>(
  text: string,
  status: number,
  requestId?: string,
): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const request = requestId ? ` (request ${requestId})` : "";
    throw new SyntaxError(
      `Little Big Brain returned invalid JSON with HTTP ${status}${request}`,
      { cause: error },
    );
  }
}

export function parseLbbError(
  status: number,
  body: string,
  fallbackRequestId?: string,
): LbbError {
  try {
    const parsed = JSON.parse(body) as { error?: LbbErrorPayload };
    if (parsed.error) {
      return new LbbError(status, body, {
        ...parsed.error,
        request_id: parsed.error.request_id ?? fallbackRequestId ?? null,
      });
    }
  } catch {
    // Fall through to an unstructured error.
  }
  return new LbbError(status, body, {
    type: "api_error",
    code: "unstructured_error",
    message: body || `Little Big Brain ${status}`,
    request_id: fallbackRequestId ?? null,
  });
}
