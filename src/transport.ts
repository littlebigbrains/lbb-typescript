import type { LbbErrorPayload } from "./types.js";

export interface CallOptions {
  idempotencyKey?: string;
  /** Override the client's per-attempt timeout. Set 0 to disable it. */
  timeoutMs?: number;
  /** Override the client's retry count for this request. */
  maxRetries?: number;
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
  }
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

export function retryDelayForAttempt(
  baseDelayMs: number,
  attempt: number,
  retryAfter?: string | null,
): number {
  const fallback = Math.max(0, baseDelayMs) * (attempt + 1);
  return parseRetryAfterMs(retryAfter) ?? fallback;
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
