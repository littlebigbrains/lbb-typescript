import { WorkflowNamespace } from "./workflows.js";
import { checkedDemoRunResponse, checkedLegacyDemoRun } from "./demo.js";
import { checkedCurrentStatus } from "./status.js";
import { CdcNamespace } from "./cdc.js";
import { RecordsNamespace } from "./records.js";
import { FilesNamespace } from "./files.js";
import { ReviewsNamespace } from "./reviews.js";
import { AccessNamespace, CatalogNamespace } from "./catalog.js";
import {
  DEFAULT_INTEGRATIONS_URL,
  IntegrationsNamespace,
} from "./integrations.js";
import type {
  DurableImportLine,
  DurableImportSource,
  FetchLike,
  ImportLine,
  LbbClientOptions,
  LbbRequestEvent,
  LbbResponseEvent,
  LbbRetryEvent,
  ListPage,
  RawLbbResponse,
  ReadConsistencyOptions,
  RdfImportDocument,
  RdfImportManyResult,
  RdfImportOptions,
  Schemas,
  SearchConsistency,
  SparqlResults,
} from "./types.js";
import { parseSparqlResults, profileBody } from "./types.js";
import {
  bodyMarksTerminal,
  errorCodeFromBody,
  fullJitterBackoffMs,
  parseLbbError,
  parseNdjson,
  parseResponseJson,
  retriesNetworkFailure,
  retriesStatus,
  retryAllowed,
  retryableStatus,
  retryDelayMs,
  sleep,
  type Query,
  type CallOptions,
  type RequestOptions,
} from "./transport.js";
import { LbbCapabilityError } from "./transport.js";
import {
  bodyChunkReader,
  ServerSentEventParser,
  type BodyChunkReader,
  type ServerSentEvent,
} from "./sse.js";
import {
  EntityNamespace,
  GraphNamespace,
  OntologyNamespace,
  QueryNamespace,
  SchemaNamespace,
  SearchNamespace,
  EvalsNamespace,
  ChecksNamespace,
  ModelsNamespace,
  EmbeddingsNamespace,
} from "./namespaces.js";

export { parseSparqlResults } from "./types.js";
export type {
  AttributeFilter,
  AttributeFilterOp,
  AttributeFilterValue,
  EntityAttributeFilterOptions,
  EntityPropertiesLine,
  DurableImportLine,
  DurableImportSource,
  FetchLike,
  FlatProperties,
  ImportLine,
  LbbClientOptions,
  LbbRequestEvent,
  LbbResponseEvent,
  LbbRetryEvent,
  LbbErrorPayload,
  ListPage,
  ListResponse,
  RawLbbResponse,
  ReadConsistencyOptions,
  RdfImportDocument,
  RdfImportManyResult,
  RdfImportOptions,
  Schemas,
  SearchConsistency,
  SparqlResults,
  SparqlResultsJson,
  SparqlTerm,
  CommitRequest,
  CommitResponse,
  Entity,
  EntitySelector,
  GraphMetadata,
  GraphSummary,
  ModelJob,
  ModelSwitch,
  ModelTrial,
  ModelTrialModel,
  ModelTrialReport,
  SchemaView,
  Snapshot,
} from "./types.js";
export type { ServerSentEvent } from "./sse.js";
export { LbbCapabilityError, LbbError } from "./transport.js";
export type {
  CallOptions,
  Query,
  QueryValue,
  RequestOptions,
} from "./transport.js";
export {
  EntityNamespace,
  FactsNamespace,
  GraphNamespace,
  OntologyNamespace,
  QueryNamespace,
  SchemaNamespace,
  SearchNamespace,
} from "./namespaces.js";

type ImportStreamController = {
  enqueue(chunk: Uint8Array): void;
  close(): void;
  error(reason: unknown): void;
};

type ImportReadableStreamConstructor = new (source: {
  pull(controller: ImportStreamController): Promise<void>;
  cancel(reason?: unknown): Promise<void>;
}) => unknown;

function durableImportBytes(line: DurableImportLine): Uint8Array {
  if (line instanceof Uint8Array) return line;
  const encoded = typeof line === "string" ? line : JSON.stringify(line);
  return new TextEncoder().encode(
    encoded.endsWith("\n") ? encoded : `${encoded}\n`,
  );
}

function durableImportIterator(
  source: DurableImportSource,
): AsyncIterator<DurableImportLine> {
  if (typeof source === "string") {
    return (async function* () {
      yield source;
    })();
  }
  if (Symbol.asyncIterator in Object(source)) {
    return (source as AsyncIterable<DurableImportLine>)[Symbol.asyncIterator]();
  }
  const iterator = (source as Iterable<DurableImportLine>)[Symbol.iterator]();
  return {
    next: async () => iterator.next(),
    return: async () => {
      iterator.return?.();
      return { done: true, value: undefined };
    },
  };
}

async function durableImportBody(
  source: DurableImportSource,
): Promise<unknown> {
  const iterator = durableImportIterator(source);
  const first = await iterator.next();
  if (first.done) {
    await iterator.return?.();
    throw new TypeError(
      "submitImport requires at least one NDJSON record or byte chunk",
    );
  }
  let firstPending = true;
  const next = async (): Promise<IteratorResult<DurableImportLine>> => {
    if (firstPending) {
      firstPending = false;
      return { done: false, value: first.value };
    }
    return iterator.next();
  };
  const Stream = (
    globalThis as { ReadableStream?: ImportReadableStreamConstructor }
  ).ReadableStream;
  if (Stream) {
    return new Stream({
      async pull(controller) {
        try {
          const item = await next();
          if (item.done) {
            controller.close();
          } else {
            controller.enqueue(durableImportBytes(item.value));
          }
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    });
  }
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          const item = await next();
          if (item.done) return;
          yield durableImportBytes(item.value);
        }
      } finally {
        await iterator.return?.();
      }
    },
  };
}

/** A response body as bytes: `arrayBuffer()` when the fetch has it, else
 * `text()` encoded as UTF-8. */
async function responseBytes(
  response: Awaited<ReturnType<FetchLike>>,
): Promise<Uint8Array> {
  if (typeof response.arrayBuffer === "function")
    return new Uint8Array(await response.arrayBuffer());
  return new TextEncoder().encode(await response.text());
}

/**
 * A chunk reader over a response body of bytes: its stream when it has one,
 * else `arrayBuffer()` read whole, else `text()` (test doubles).
 */
function byteChunkReader(
  response: Awaited<ReturnType<FetchLike>>,
): BodyChunkReader {
  const body = response.body as
    | { getReader?: unknown; [Symbol.asyncIterator]?: unknown }
    | null
    | undefined;
  const streams =
    body &&
    (typeof body.getReader === "function" ||
      typeof body[Symbol.asyncIterator] === "function");
  if (streams || typeof response.arrayBuffer !== "function")
    return bodyChunkReader(response);
  let consumed = false;
  return {
    read: async () => {
      if (consumed) return { done: true };
      consumed = true;
      return { done: false, value: await responseBytes(response) };
    },
    cancel: async () => {},
  };
}

/** The body a request sends: `rawBody` as is, else `body` as JSON. */
function requestBody(opts: RequestOptions): unknown {
  return opts.rawBody !== undefined
    ? opts.rawBody
    : opts.body !== undefined
      ? JSON.stringify(opts.body)
      : undefined;
}

function environmentScope(
  options: Pick<LbbClientOptions, "environment" | "stack">,
): string | undefined {
  if (
    options.environment !== undefined &&
    options.stack !== undefined &&
    options.environment !== options.stack
  ) {
    throw new RangeError(
      "environment and stack must name the same environment",
    );
  }
  return options.environment ?? options.stack;
}

/**
 * A typed HTTP client for a little big brain graph server. One instance is scoped to a
 * single graph; construct another for a different scope. All methods
 * return the parsed JSON response and throw {@link LbbError} on failure.
 */
export class LbbClient {
  private readonly baseUrl: string;
  /** The integrations API, `https://api.littlebigbrain.com` by default. */
  readonly integrationsUrl: string;
  private readonly apiKey?: string;
  /** The graph this client is scoped to, when it names one. */
  readonly graphName?: string;
  private readonly expectedGraphEpoch?: string;
  private readonly environment?: string;
  private readonly fetchImpl: FetchLike;
  private readonly apiVersion: string;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly retryBudgetMs: number;
  private readonly timeoutMs: number;
  private readonly onRequest?: (event: LbbRequestEvent) => void;
  private readonly onResponse?: (event: LbbResponseEvent) => void;
  private readonly onRetry?: (event: LbbRetryEvent) => void;
  private capabilities?: Promise<ReadonlySet<string>>;
  /** A5 default read consistency applied when a read omits its own value. */
  readonly defaultConsistency?: SearchConsistency;

  readonly search: SearchNamespace;
  readonly entities: EntityNamespace;
  readonly records: RecordsNamespace;
  readonly schema: SchemaNamespace;
  readonly ontology: OntologyNamespace;
  readonly query: QueryNamespace;
  readonly evals: EvalsNamespace;
  /** Model checks: the call log, the judge's checks, and reviews. */
  readonly checks: ChecksNamespace;
  /** Model trials of other models on the graph's uses, and switches. */
  readonly models: ModelsNamespace;
  readonly embeddings: EmbeddingsNamespace;
  /**
   * Files of the graph: upload a document, list the files, read a file's
   * bytes and its parsed pages (lines and words with their boxes), delete.
   */
  readonly files: FilesNamespace;
  /**
   * Review: questions for a person. File, list and answer review items
   * (values, choices, grades, answers, and ontology changes).
   */
  readonly reviews: ReviewsNamespace;
  readonly catalog: CatalogNamespace;
  readonly access: AccessNamespace;
  readonly workflows: WorkflowNamespace;
  readonly cdc: CdcNamespace;
  /** Hosted integrations for your end customers, at `integrationsUrl`. */
  readonly integrations: IntegrationsNamespace;

  constructor(options: LbbClientOptions) {
    const baseUrl = options.baseUrl?.trim();
    if (!baseUrl) {
      throw new Error(
        "baseUrl is required; copy endpoint_url from the environment's Connect page for hosted use",
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    const integrationsUrl =
      options.integrationsUrl?.trim() || DEFAULT_INTEGRATIONS_URL;
    this.integrationsUrl = integrationsUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.graphName = options.graph;
    this.expectedGraphEpoch = options.expectedGraphEpoch;
    if (
      this.expectedGraphEpoch !== undefined &&
      !/^[0-9]+$/.test(this.expectedGraphEpoch)
    )
      throw new RangeError("expectedGraphEpoch must be a decimal epoch string");
    this.environment = environmentScope(options);
    this.apiVersion = options.apiVersion ?? "2026-10-27";
    this.maxRetries = options.maxRetries ?? 6;
    this.retryDelayMs = options.retryDelayMs ?? 100;
    this.retryBudgetMs = options.retryBudgetMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.onRequest = options.onRequest;
    this.onResponse = options.onResponse;
    this.onRetry = options.onRetry;
    this.defaultConsistency = options.defaultConsistency;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new RangeError("maxRetries must be a non-negative integer");
    }
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new RangeError("retryDelayMs must be a non-negative number");
    }
    if (!Number.isFinite(this.retryBudgetMs) || this.retryBudgetMs < 0) {
      throw new RangeError("retryBudgetMs must be a non-negative number");
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 0) {
      throw new RangeError("timeoutMs must be a non-negative number");
    }
    const fallback = (globalThis as { fetch?: FetchLike }).fetch;
    const chosen =
      options.fetch ?? (fallback ? fallback.bind(globalThis) : undefined);
    if (!chosen) {
      throw new Error("no fetch implementation available; pass options.fetch");
    }
    this.fetchImpl = chosen;
    this.search = new SearchNamespace(this);
    this.entities = new EntityNamespace(this);
    this.records = new RecordsNamespace(this, (capability) =>
      this.requireCapability(capability),
    );
    this.schema = new SchemaNamespace(this);
    this.ontology = new OntologyNamespace(this);
    this.query = new QueryNamespace(this);
    this.evals = new EvalsNamespace(this);
    this.checks = new ChecksNamespace(this);
    this.models = new ModelsNamespace(this);
    this.embeddings = new EmbeddingsNamespace(this);
    this.files = new FilesNamespace(this);
    this.reviews = new ReviewsNamespace(this);
    this.catalog = new CatalogNamespace(this);
    this.access = new AccessNamespace(this);
    this.workflows = new WorkflowNamespace(this);
    this.cdc = new CdcNamespace(this);
    this.integrations = new IntegrationsNamespace(this);
  }

  graph(
    name: string,
    opts: Pick<LbbClientOptions, "environment" | "stack"> = {},
  ): GraphNamespace {
    return new GraphNamespace(
      this.withScope({
        graph: name,
        environment: opts.environment,
        stack: opts.stack,
      }),
    );
  }

  /**
   * A new client for a different graph on the same server and credential.
   * Each instance is scoped to one graph, so use this to target another
   * scope (e.g. creating a fresh graph) without mutating the current client.
   */
  withScope(scope: {
    graph?: string;
    environment?: string;
    /** @deprecated Use `environment`. */
    stack?: string;
    expectedGraphEpoch?: string;
  }): LbbClient {
    return new LbbClient({
      baseUrl: this.baseUrl,
      integrationsUrl: this.integrationsUrl,
      apiKey: this.apiKey,
      graph: scope.graph ?? this.graphName,
      expectedGraphEpoch: scope.expectedGraphEpoch ?? this.expectedGraphEpoch,
      environment: environmentScope(scope) ?? this.environment,
      fetch: this.fetchImpl,
      apiVersion: this.apiVersion,
      maxRetries: this.maxRetries,
      retryDelayMs: this.retryDelayMs,
      retryBudgetMs: this.retryBudgetMs,
      timeoutMs: this.timeoutMs,
      onRequest: this.onRequest,
      onResponse: this.onResponse,
      onRetry: this.onRetry,
      defaultConsistency: this.defaultConsistency,
    });
  }

  /**
   * A5: fold read-consistency options into a request body's own `consistency` /
   * `min_indexed_seq` fields (the shape used by full-text, embedding, and
   * structured-SPARQL bodies). A per-call value wins over the client
   * `defaultConsistency`; an explicit body field wins over both.
   */
  resolveConsistency(
    opts?: ReadConsistencyOptions,
  ): SearchConsistency | undefined {
    return opts?.consistency ?? this.defaultConsistency;
  }

  private mergeReadConsistency<B extends object>(
    body: B,
    opts?: ReadConsistencyOptions,
  ): B {
    const consistency = this.resolveConsistency(opts);
    const merged = { ...body } as Record<string, unknown>;
    if (consistency !== undefined && merged.consistency === undefined) {
      merged.consistency = consistency;
    }
    if (
      opts?.minIndexedSeq !== undefined &&
      merged.min_indexed_seq === undefined
    ) {
      merged.min_indexed_seq = opts.minIndexedSeq;
    }
    return merged as B;
  }

  /** A5: read-consistency options rendered as URL query params, for the routes
   * that carry consistency on the URL (SPARQL-text, graph summary). */
  private readConsistencyQuery(opts?: ReadConsistencyOptions): Query {
    return {
      consistency: this.resolveConsistency(opts),
      min_indexed_seq: opts?.minIndexedSeq,
    };
  }

  private buildUrl(path: string, query?: Query): string {
    const params: string[] = [];
    const push = (key: string, value: string | number | boolean) =>
      params.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
      );
    if (this.graphName !== undefined) push("graph", this.graphName);
    if (this.environment !== undefined) push("stack", this.environment);
    if (this.expectedGraphEpoch !== undefined)
      push("expected_graph_epoch", this.expectedGraphEpoch);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (
        key === "expected_graph_epoch" &&
        this.expectedGraphEpoch !== undefined
      ) {
        if (value !== undefined && value !== this.expectedGraphEpoch)
          throw new RangeError("request cannot change the client graph epoch");
        continue;
      }
      if (value !== undefined) push(key, value);
    }
    const qs = params.length > 0 ? `?${params.join("&")}` : "";
    return `${this.baseUrl}${path}${qs}`;
  }

  /** The integrations API URL of a path: no graph or stack scope is added. */
  private integrationsUrlOf(path: string, query?: Query): string {
    const params = Object.entries(query ?? {})
      .filter(([, value]) => value !== undefined)
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
      );
    const qs = params.length > 0 ? `?${params.join("&")}` : "";
    return `${this.integrationsUrl}${path}${qs}`;
  }

  async rawRequest<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<RawLbbResponse<T>> {
    return this.send<T>(method, this.buildUrl(path, opts.query), opts);
  }

  /**
   * A request to the integrations API at `integrationsUrl`, with the same
   * API key, retries and errors as {@link request}. The client's graph and
   * stack scope are not added: the integrations routes name their graph.
   */
  async integrationsRequest<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const response = await this.send<T>(
      method,
      this.integrationsUrlOf(path, opts.query),
      opts,
    );
    return response.data;
  }

  /** The headers of a request: the SDK defaults, then the caller's. */
  private requestHeaders(
    opts: RequestOptions,
    defaults: Record<string, string> = {},
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": opts.contentType ?? "application/json",
      "lbb-version": this.apiVersion,
      ...defaults,
    };
    if (this.apiKey !== undefined)
      headers["authorization"] = `Bearer ${this.apiKey}`;
    if (opts.idempotencyKey !== undefined)
      headers["idempotency-key"] = opts.idempotencyKey;
    Object.assign(headers, opts.headers ?? {});
    return headers;
  }

  private async send<T>(
    method: string,
    url: string,
    opts: RequestOptions,
  ): Promise<RawLbbResponse<T>> {
    const headers = this.requestHeaders(opts);
    const retry = opts.retry ?? retryAllowed(method, opts.idempotencyKey);
    const body = requestBody(opts);
    const init = {
      method,
      headers,
      body,
      ...(opts.duplex ? { duplex: opts.duplex } : {}),
    };
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const maxRetries = opts.maxRetries ?? this.maxRetries;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError("maxRetries must be a non-negative integer");
    }
    const startedAt = Date.now();
    // Deadline is the binding limit; `maxRetries` is a secondary safety cap.
    const deadline =
      startedAt + Math.max(0, opts.retryBudgetMs ?? this.retryBudgetMs);
    let attempts = 0;
    let response: Awaited<ReturnType<FetchLike>> | undefined;
    let text = "";
    // `responseType: "bytes"`: the 2xx body as bytes; an error body is
    // still read as text for the error and the retry verdict.
    const wantsBytes = opts.responseType === "bytes";
    let bytes: Uint8Array | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (opts.signal?.aborted)
        throw opts.signal.reason ?? new Error("request aborted");
      attempts = attempt + 1;
      const controller =
        (timeoutMs > 0 || opts.signal) && typeof AbortController !== "undefined"
          ? new AbortController()
          : undefined;
      const abortFromCaller = () => controller?.abort(opts.signal?.reason);
      opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
      const timer = controller
        ? timeoutMs > 0
          ? setTimeout(() => controller.abort(), timeoutMs)
          : undefined
        : undefined;
      try {
        this.onRequest?.({
          method: method.toUpperCase(),
          url,
          attempt: attempts,
          maxAttempts: maxRetries + 1,
          idempotencyKey: opts.idempotencyKey,
        });
        const requestInit = {
          ...init,
          signal: controller?.signal ?? opts.signal,
        };
        // Keep FetchLike's long-standing string-body test-double contract while
        // allowing this one endpoint to pass a native streaming body to fetch.
        // Native browser/Node fetch implementations accept the extended shape;
        // custom transports that need durable imports can inspect it at runtime.
        const streamingFetch = this.fetchImpl as unknown as (
          input: string,
          init: typeof requestInit,
        ) => ReturnType<FetchLike>;
        response = await streamingFetch(url, requestInit);
        if (wantsBytes && response.ok) {
          bytes = await responseBytes(response);
          text = "";
        } else {
          text = await response.text();
        }
      } catch (error) {
        const callerAborted = opts.signal?.aborted === true;
        const requestError =
          controller?.signal.aborted && !callerAborted
            ? Object.assign(
                new Error(
                  `Little Big Brain request timed out after ${timeoutMs}ms`,
                  {
                    cause: error,
                  },
                ),
                { name: "TimeoutError" },
              )
            : error;
        if (
          !callerAborted &&
          retriesNetworkFailure(retry) &&
          attempt < maxRetries
        ) {
          const delayMs = fullJitterBackoffMs(this.retryDelayMs, attempt);
          if (Date.now() + delayMs <= deadline) {
            this.onRetry?.({
              method: method.toUpperCase(),
              url,
              attempt: attempts,
              status: undefined,
              delayMs,
              elapsedMs: Math.max(0, Date.now() - startedAt),
            });
            await sleep(delayMs);
            continue;
          }
        }
        throw requestError;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
      }
      if (
        response.ok ||
        !retryableStatus(response.status) ||
        attempt === maxRetries
      ) {
        break;
      }
      if (!retriesStatus(retry, response.status)) {
        break;
      }
      // Honor the server's typed body verdict: a terminal error
      // (`retryable: false`, e.g. an exhausted quota) is surfaced at once
      // rather than retried to the budget.
      if (bodyMarksTerminal(text)) {
        break;
      }
      const delayMs = retryDelayMs(this.retryDelayMs, attempt, {
        retryAfterHeader: response.headers?.get("retry-after"),
        body: text,
      });
      if (Date.now() + delayMs > deadline) {
        break;
      }
      this.onRetry?.({
        method: method.toUpperCase(),
        url,
        attempt: attempts,
        status: response.status,
        errorCode: errorCodeFromBody(text),
        delayMs,
        elapsedMs: Math.max(0, Date.now() - startedAt),
      });
      await sleep(delayMs);
    }
    if (response === undefined)
      throw new Error("request did not produce a response");
    const requestId = response.headers?.get("x-request-id") ?? undefined;
    const version = response.headers?.get("lbb-version") ?? undefined;
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    this.onResponse?.({
      method: method.toUpperCase(),
      url,
      status: response.status,
      requestId,
      attempts,
      retryCount: Math.max(0, attempts - 1),
      elapsedMs,
    });
    if (!response.ok)
      throw parseLbbError(
        response.status,
        text.trim(),
        requestId,
        response.headers?.get("retry-after"),
      );
    const responseContentType =
      response.headers?.get("content-type")?.toLowerCase() ?? "";
    const isRdfText =
      responseContentType.includes("text/turtle") ||
      responseContentType.includes("application/n-triples") ||
      responseContentType.includes("application/trig") ||
      responseContentType.includes("application/n-quads");
    // JSON lines (`application/x-ndjson`) parse to a list of the lines' values.
    const isNdjson = responseContentType.includes("application/x-ndjson");
    return {
      data: wantsBytes
        ? ((bytes ?? new Uint8Array()) as T)
        : isNdjson
          ? (parseNdjson(text, response.status, requestId) as T)
          : text
            ? isRdfText
              ? (text as T)
              : parseResponseJson<T>(text, response.status, requestId)
            : (undefined as T),
      status: response.status,
      requestId,
      version,
      headers: response.headers,
      attempts,
      retryCount: Math.max(0, attempts - 1),
      elapsedMs,
    };
  }

  async request<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const response = await this.rawRequest<T>(method, path, opts);
    return response.data;
  }

  /**
   * Send one request with `Accept: text/event-stream` and yield its
   * server-sent events as they arrive. The request is sent once and never
   * retried. A non-2xx answer throws {@link LbbError}, as {@link request}
   * does. `timeoutMs` bounds the whole stream (0 disables it), and
   * `signal` stops the request and the read. Leaving the loop early closes
   * the response.
   *
   * A 2xx answer that is not an event stream (a server without streams)
   * becomes one event named `jsonEvent`, with the whole body as its data.
   * `onOpen` receives the status and request id when the answer starts.
   */
  async *requestEventStream(
    method: string,
    path: string,
    opts: RequestOptions & {
      jsonEvent?: string;
      onOpen?: (response: { status: number; requestId?: string }) => void;
    } = {},
  ): AsyncGenerator<ServerSentEvent, void, undefined> {
    const signal = opts.signal;
    if (signal?.aborted) throw signal.reason ?? new Error("request aborted");
    const url = this.buildUrl(path, opts.query);
    const upperMethod = method.toUpperCase();
    const headers = this.requestHeaders(opts, { accept: "text/event-stream" });
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const controller =
      typeof AbortController !== "undefined"
        ? new AbortController()
        : undefined;
    let reader: BodyChunkReader | undefined;
    let timedOut = false;
    const stop = (reason?: unknown) => {
      controller?.abort(reason);
      reader?.cancel(reason).catch(() => undefined);
    };
    const abortFromCaller = () => stop(signal?.reason);
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stop();
          }, timeoutMs)
        : undefined;
    // The error to throw once the caller or the timeout stopped the stream.
    const stopped = (cause?: unknown): unknown => {
      if (signal?.aborted)
        return signal.reason ?? cause ?? new Error("request aborted");
      if (timedOut)
        return Object.assign(
          new Error(`Little Big Brain stream timed out after ${timeoutMs}ms`, {
            cause,
          }),
          { name: "TimeoutError" },
        );
      return cause;
    };
    const startedAt = Date.now();
    let finished = false;
    try {
      this.onRequest?.({
        method: upperMethod,
        url,
        attempt: 1,
        maxAttempts: 1,
        idempotencyKey: opts.idempotencyKey,
      });
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        const streamingFetch = this.fetchImpl as unknown as (
          input: string,
          init: Record<string, unknown>,
        ) => ReturnType<FetchLike>;
        response = await streamingFetch(url, {
          method,
          headers,
          body: requestBody(opts),
          signal: controller?.signal ?? signal,
        });
      } catch (error) {
        throw stopped(error);
      }
      const requestId = response.headers?.get("x-request-id") ?? undefined;
      this.onResponse?.({
        method: upperMethod,
        url,
        status: response.status,
        requestId,
        attempts: 1,
        retryCount: 0,
        elapsedMs: Math.max(0, Date.now() - startedAt),
      });
      opts.onOpen?.({ status: response.status, requestId });
      const contentType =
        response.headers?.get("content-type")?.toLowerCase() ?? "";
      if (!response.ok || !contentType.includes("text/event-stream")) {
        let text: string;
        try {
          text = await response.text();
        } catch (error) {
          throw stopped(error);
        }
        if (!response.ok)
          throw parseLbbError(
            response.status,
            text.trim(),
            requestId,
            response.headers?.get("retry-after"),
          );
        finished = true;
        if (opts.jsonEvent !== undefined && text.trim() !== "")
          yield { event: opts.jsonEvent, data: text };
        return;
      }
      reader = bodyChunkReader(response);
      const decoder = new TextDecoder();
      const parser = new ServerSentEventParser();
      for (;;) {
        let chunk: Awaited<ReturnType<BodyChunkReader["read"]>>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw stopped(error);
        }
        if (signal?.aborted || timedOut) throw stopped();
        if (chunk.done) break;
        const text =
          typeof chunk.value === "string"
            ? chunk.value
            : chunk.value
              ? decoder.decode(chunk.value, { stream: true })
              : "";
        for (const event of parser.push(text)) yield event;
      }
      finished = true;
      // An event the body did not end with a blank line is dropped.
      for (const event of parser.push(decoder.decode())) yield event;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
      if (!finished) stop();
    }
  }

  /**
   * Send a request and yield its 2xx body as bytes while they arrive (a
   * file's content), so a large body is never held whole. A `429`, a `5xx`
   * or a network failure before the answer starts is retried as
   * {@link request} retries the method; the body is not retried.
   * `timeoutMs` bounds the wait for the answer, not the body, and `signal`
   * stops the request and the read. A non-2xx answer throws
   * {@link LbbError}. Leaving the loop early closes the response.
   */
  async *requestByteStream(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): AsyncGenerator<Uint8Array, void, undefined> {
    const url = this.buildUrl(path, opts.query);
    const upperMethod = method.toUpperCase();
    const headers = this.requestHeaders(opts);
    const retry = opts.retry ?? retryAllowed(method, opts.idempotencyKey);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const maxRetries = opts.maxRetries ?? this.maxRetries;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError("maxRetries must be a non-negative integer");
    }
    const startedAt = Date.now();
    const deadline =
      startedAt + Math.max(0, opts.retryBudgetMs ?? this.retryBudgetMs);
    const signal = opts.signal;
    const streamingFetch = this.fetchImpl as unknown as (
      input: string,
      init: Record<string, unknown>,
    ) => ReturnType<FetchLike>;
    let response: Awaited<ReturnType<FetchLike>> | undefined;
    let controller: AbortController | undefined;
    const abortFromCaller = () => controller?.abort(signal?.reason);
    let attempts: number;
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? new Error("request aborted");
      attempts = attempt + 1;
      controller =
        typeof AbortController !== "undefined"
          ? new AbortController()
          : undefined;
      signal?.addEventListener("abort", abortFromCaller, { once: true });
      const attemptController = controller;
      const timer =
        timeoutMs > 0 && attemptController
          ? setTimeout(() => attemptController.abort(), timeoutMs)
          : undefined;
      this.onRequest?.({
        method: upperMethod,
        url,
        attempt: attempts,
        maxAttempts: maxRetries + 1,
        idempotencyKey: opts.idempotencyKey,
      });
      try {
        response = await streamingFetch(url, {
          method,
          headers,
          body: requestBody(opts),
          signal: controller?.signal ?? signal,
        });
      } catch (error) {
        signal?.removeEventListener("abort", abortFromCaller);
        const callerAborted = signal?.aborted === true;
        if (
          !callerAborted &&
          retriesNetworkFailure(retry) &&
          attempt < maxRetries
        ) {
          const delayMs = fullJitterBackoffMs(this.retryDelayMs, attempt);
          if (Date.now() + delayMs <= deadline) {
            this.onRetry?.({
              method: upperMethod,
              url,
              attempt: attempts,
              status: undefined,
              delayMs,
              elapsedMs: Math.max(0, Date.now() - startedAt),
            });
            await sleep(delayMs);
            continue;
          }
        }
        throw controller?.signal.aborted && !callerAborted
          ? Object.assign(
              new Error(
                `Little Big Brain request timed out after ${timeoutMs}ms`,
                { cause: error },
              ),
              { name: "TimeoutError" },
            )
          : error;
      } finally {
        // The answer started (or failed): the body has no timeout.
        if (timer !== undefined) clearTimeout(timer);
      }
      if (response.ok) break;
      signal?.removeEventListener("abort", abortFromCaller);
      const text = await response.text();
      if (
        retryableStatus(response.status) &&
        retriesStatus(retry, response.status) &&
        attempt < maxRetries &&
        !bodyMarksTerminal(text)
      ) {
        const delayMs = retryDelayMs(this.retryDelayMs, attempt, {
          retryAfterHeader: response.headers?.get("retry-after"),
          body: text,
        });
        if (Date.now() + delayMs <= deadline) {
          this.onRetry?.({
            method: upperMethod,
            url,
            attempt: attempts,
            status: response.status,
            errorCode: errorCodeFromBody(text),
            delayMs,
            elapsedMs: Math.max(0, Date.now() - startedAt),
          });
          await sleep(delayMs);
          continue;
        }
      }
      const requestId = response.headers?.get("x-request-id") ?? undefined;
      this.onResponse?.({
        method: upperMethod,
        url,
        status: response.status,
        requestId,
        attempts,
        retryCount: Math.max(0, attempts - 1),
        elapsedMs: Math.max(0, Date.now() - startedAt),
      });
      throw parseLbbError(
        response.status,
        text.trim(),
        requestId,
        response.headers?.get("retry-after"),
      );
    }
    this.onResponse?.({
      method: upperMethod,
      url,
      status: response.status,
      requestId: response.headers?.get("x-request-id") ?? undefined,
      attempts,
      retryCount: Math.max(0, attempts - 1),
      elapsedMs: Math.max(0, Date.now() - startedAt),
    });
    const reader = byteChunkReader(response);
    let finished = false;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value === undefined) continue;
        yield typeof chunk.value === "string"
          ? new TextEncoder().encode(chunk.value)
          : chunk.value;
      }
      finished = true;
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
      if (!finished) {
        controller?.abort();
        await reader.cancel().catch(() => undefined);
      }
    }
  }

  private mutationKey(prefix: string): string {
    const random = Math.random().toString(36).slice(2);
    return `${prefix}:${Date.now()}:${random}`;
  }

  idempotencyKey(prefix = "request"): string {
    return this.mutationKey(prefix);
  }

  private async requireCapability(capability: string): Promise<void> {
    this.capabilities ??= this.request<Schemas["VersionResponse"]>(
      "GET",
      "/version",
    ).then(
      (version) =>
        new Set(
          Array.isArray(version?.capabilities) &&
            version.capabilities.every((item) => typeof item === "string")
            ? version.capabilities
            : [],
        ),
    );
    if (!(await this.capabilities).has(capability)) {
      throw new LbbCapabilityError(capability);
    }
  }

  // --- writes ---

  /** Commit triplets and optional entity embeddings. Prefer `client.graph("main").facts.create(...)`. */
  async commit(
    body: Schemas["TripletCommitFile"],
    opts: { idempotencyKey?: string } = {},
  ): Promise<Schemas["GraphCommitResponse"] & { commitSeq: number }> {
    const response = await this.request<Schemas["GraphCommitResponse"]>(
      "POST",
      "/v1/graph/commit",
      {
        body,
        idempotencyKey:
          opts.idempotencyKey ?? this.idempotencyKey("facts.create"),
      },
    );
    // A5: surface the committed sequence as `commitSeq` so the write→floor→read
    // loop reads naturally: `const { commitSeq } = await client.commit(…)`.
    return { ...response, commitSeq: response.commit_seq };
  }

  /**
   * Validate-only preflight: run the same ontology/schema validation a real
   * commit would and report the would-be effect (`op_count`, `written_properties`,
   * `schema_validation`) without writing. A rejected request fails exactly as a
   * real commit would, so this is a safe check before mutating. No idempotency
   * key needed — nothing is persisted.
   */
  commitDryRun(
    body: Schemas["TripletCommitFile"],
  ): Promise<Schemas["GraphCommitDryRunResponse"]> {
    return this.request("POST", "/v1/graph/commit", {
      body,
      query: { dry_run: true },
    });
  }

  /**
   * Bulk-ingest a dataset as NDJSON. Each line is either a triplet or an
   * `{type,name,properties}` entity-properties record; lines are batched into
   * bounded internal commits server-side, so a whole dataset loads in one
   * streamed request without a single oversized commit. Pass `lines` as an array
   * (serialized to NDJSON here) or a pre-built NDJSON string.
   *
   * A successful import durably enqueues one complete published-generation
   * build after the final batch. It does not build index families or wait for
   * visibility; the response's `published_generation` object carries the
   * durable job and due sequence to observe.
   */
  async import(
    lines: ImportLine[] | string,
    opts: {
      batch?: number;
      strict?: boolean;
      observedAt?: string;
      idempotencyKey?: string;
      /** Refuse writes if the graph was deleted and recreated. */
      expectedGraphEpoch?: string;
    } = {},
  ): Promise<Schemas["GraphImportResponse"] & { commitSeq: number | null }> {
    const ndjson =
      typeof lines === "string"
        ? lines
        : lines.map((line) => JSON.stringify(line)).join("\n");
    const response = await this.request<Schemas["GraphImportResponse"]>(
      "POST",
      "/v1/graph/import",
      {
        rawBody: ndjson,
        contentType: "application/x-ndjson",
        query: {
          batch: opts.batch,
          strict: opts.strict,
          observed_at: opts.observedAt,
          expected_graph_epoch: opts.expectedGraphEpoch,
        },
        idempotencyKey: opts.idempotencyKey ?? this.idempotencyKey("import"),
      },
    );
    // A5: surface the last committed sequence (null for an empty import) so the
    // write→floor→read loop reads naturally after a bulk load.
    return { ...response, commitSeq: response.committed_commit_seq ?? null };
  }

  /**
   * Stream NDJSON into immutable storage and enqueue a durable import job.
   *
   * The idempotency key is mandatory and binds the key to the uploaded content.
   * Streaming uploads are attempted once: a one-shot async iterator cannot be
   * replayed safely by an automatic HTTP retry. Call this method again with a
   * fresh iterable and the same key to perform an explicit idempotent replay.
   */
  async submitImport(
    lines: DurableImportSource,
    opts: {
      idempotencyKey: string;
      batch?: number;
      strict?: boolean;
      observedAt?: string;
      signal?: AbortSignal;
    },
  ): Promise<Schemas["GraphImportJobAccepted"]> {
    if (!opts?.idempotencyKey?.trim()) {
      throw new TypeError("submitImport requires a non-empty idempotencyKey");
    }
    await this.requireCapability("durable_import_jobs_v1");
    const rawBody = await durableImportBody(lines);
    return this.request("POST", "/v1/graph/import-jobs", {
      rawBody,
      contentType: "application/x-ndjson",
      duplex: "half",
      query: {
        batch: opts.batch,
        strict: opts.strict,
        observed_at: opts.observedAt,
      },
      idempotencyKey: opts.idempotencyKey,
      maxRetries: 0,
      retry: false,
      signal: opts.signal,
    });
  }

  async getImportJob(jobId: string): Promise<Schemas["GraphImportJobStatus"]> {
    await this.requireCapability("durable_import_jobs_v1");
    return this.request("GET", "/v1/graph/import-jobs", {
      query: { job_id: jobId },
    });
  }

  async cancelImportJob(
    jobId: string,
  ): Promise<Schemas["GraphImportJobCancelResponse"]> {
    await this.requireCapability("durable_import_jobs_v1");
    return this.request("DELETE", "/v1/graph/import-jobs", {
      query: { job_id: jobId },
    });
  }

  async waitForImportJob(
    jobId: string,
    opts: {
      pollIntervalMs?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<Schemas["GraphImportJobStatus"]> {
    const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    const timeoutMs = opts.timeoutMs ?? 0;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
      throw new RangeError("pollIntervalMs must be a non-negative number");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("timeoutMs must be a non-negative number");
    }
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
    for (;;) {
      if (opts.signal?.aborted) {
        throw opts.signal.reason ?? new Error("request aborted");
      }
      const status = await this.getImportJob(jobId);
      if (
        status.state === "succeeded" ||
        status.state === "failed" ||
        status.state === "cancelled"
      ) {
        return status;
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error(`timed out waiting for durable import job ${jobId}`);
      }
      await sleep(pollIntervalMs);
    }
  }

  /**
   * Bulk-ingest N-Triples, Turtle, N-Quads, or TriG without client-side conversion. Resource-object
   * triples become keyed Resource edges; literal-object triples become text
   * properties on the subject Resource.
   */
  importRdf(
    rdf: string,
    opts: RdfImportOptions = {},
  ): Promise<Schemas["GraphRdfImportResponse"]> {
    const format = opts.format ?? "ntriples";
    const contentTypes = {
      ntriples: "application/n-triples",
      turtle: "text/turtle",
      nquads: "application/n-quads",
      trig: "application/trig",
    } as const;
    return this.request("POST", "/v1/graph/import/rdf", {
      rawBody: rdf,
      contentType: contentTypes[format],
      query: {
        batch: opts.batch,
        strict: opts.strict,
        observed_at: opts.observedAt,
        format,
        base_iri: opts.baseIri,
        graph_uri: opts.graphUri,
        blank_node_scope: opts.blankNodeScope,
        resource_type: opts.resourceType,
        edge_idempotency: opts.edgeIdempotency,
        build: opts.build,
      },
      idempotencyKey: opts.idempotencyKey ?? this.idempotencyKey("import-rdf"),
    });
  }

  /** Import several RDF documents as truth-only chunks, then advance one final publication fence. */
  async importRdfMany(
    documents: readonly RdfImportDocument[],
    opts: RdfImportOptions = {},
  ): Promise<RdfImportManyResult> {
    if (documents.length === 0) {
      throw new RangeError("importRdfMany requires at least one document");
    }
    const imports: Schemas["GraphRdfImportResponse"][] = [];
    for (const [index, document] of documents.entries()) {
      const merged = { ...opts, ...document.options };
      const idempotencyKey = merged.idempotencyKey
        ? `${merged.idempotencyKey}:${index + 1}`
        : undefined;
      imports.push(
        await this.importRdf(document.rdf, {
          ...merged,
          idempotencyKey,
          build: index === documents.length - 1,
        }),
      );
    }
    const final = imports[imports.length - 1];
    return {
      imports,
      finalSequence: final?.committed_commit_seq ?? undefined,
      publication: final?.published_generation,
    };
  }

  /**
   * Retract specific edges and/or every edge touching given entities. Appends
   * superseding retract events rather than deleting — history stays visible in an
   * `as_of` read before the retraction, but the edges drop out of current state.
   * The surgical alternative to {@link deleteGraph}.
   */
  retract(
    body: Schemas["GraphRetractRequest"],
    opts: { idempotencyKey?: string; expectedGraphEpoch?: string } = {},
  ): Promise<Schemas["GraphRetractResponse"]> {
    return this.request("POST", "/v1/graph/retract", {
      body,
      query: { expected_graph_epoch: opts.expectedGraphEpoch },
      idempotencyKey: opts.idempotencyKey ?? this.idempotencyKey("retract"),
    });
  }

  /**
   * Create the scoped graph with an empty ontology. Construct the client
   * with the desired graph first, then call `ontology.define` before
   * writing typed data.
   */
  createGraph(): Promise<Schemas["CreateGraphResponse"]> {
    return this.request("POST", "/v1/graph/create");
  }

  /**
   * Fork a whole graph into a brand-new destination graph in the same tenant.
   * The copy runs as a durable background job (`confirm` is fixed to `dst`, which
   * the route requires to authorize the fork); the destination must not already
   * exist, so the create-only CAS on the server side makes the call safe to
   * retry. The id of a deleted graph is refused with 409: fork into a new id. The response only acknowledges the enqueue — poll the destination
   * graph's metadata (see `response.poll`) to observe the fork completing: the
   * destination becomes readable once its head is published.
   */
  forkGraph(opts: {
    src: string;
    dst: string;
  }): Promise<Schemas["GraphForkResponse"]> {
    return this.request("POST", "/v1/graph/fork", {
      query: { src: opts.src, dst: opts.dst, confirm: opts.dst },
      retry: true,
    });
  }

  /**
   * Declarative full-state replace: reconcile the scoped graph so its current
   * state matches exactly the NDJSON payload (same line grammar as
   * {@link import} — triplets or `{type,name,properties}` entity records; pass an
   * array, serialized here, or a pre-built NDJSON string). The whole
   * reconciliation lands as one atomic cutover: payload records are upserted, and
   * entities present at the pre-reload head but absent from the payload leave
   * current state (retraction semantics — history is preserved, so an `as_of`
   * read pinned before the cutover still sees the old state). `confirm` must
   * equal the target graph id (reload is semi-destructive). `dryRun` previews the
   * full delta with zero durable changes. The response carries
   * `prior_commit_seq` / `prior_snapshot_token` as the rollback anchor — read
   * them back with `?as_of_commit_seq=<prior_commit_seq>` to see the pre-reload
   * state. An Idempotency-Key scopes the single cutover commit, so a retry
   * replays rather than re-applying.
   */
  reload(
    lines: ImportLine[] | string,
    opts: {
      confirm: string;
      dryRun?: boolean;
      strict?: boolean;
      observedAt?: string;
      idempotencyKey?: string;
    },
  ): Promise<Schemas["GraphReloadResponse"]> {
    const ndjson =
      typeof lines === "string"
        ? lines
        : lines.map((line) => JSON.stringify(line)).join("\n");
    return this.request("POST", "/v1/graph/reload", {
      rawBody: ndjson,
      contentType: "application/x-ndjson",
      query: {
        confirm: opts.confirm,
        dry_run: opts.dryRun,
        strict: opts.strict,
        observed_at: opts.observedAt,
      },
      idempotencyKey: opts.idempotencyKey ?? this.idempotencyKey("reload"),
    });
  }

  /** Delete the scoped graph, including its feedback and active graph-scoped jobs. */
  deleteGraph(opts: {
    confirm: string;
  }): Promise<Schemas["GraphDeleteResponse"]> {
    return this.request("POST", "/v1/graph/delete", {
      query: { confirm: opts.confirm },
      retry: true,
    });
  }

  // --- models as runs (training-run registry + eval machinery) ---

  /**
   * Captured signals by flush-seq range, oldest first — the model-training
   * feed. The `seq` on each signal is the temporal-split coordinate (train ≤ T,
   * eval > T).
   */
  readSignals(
    opts: { from?: number; to?: number; limit?: number } = {},
  ): Promise<Schemas["SignalReadResponse"]> {
    return this.request("GET", "/v1/signals", {
      query: { from: opts.from, to: opts.to, limit: opts.limit },
    });
  }

  /**
   * Record one immutable model-as-run manifest; runs number sequentially per
   * kind. Trainers MUST train on data ≤ `trained_at_commit_seq` and evaluate
   * past it — `modelSplitAudit` verifies the recorded lineage.
   */
  recordModelRun(body: Schemas["ModelRunManifest"]): Promise<{ run: number }> {
    return this.request("POST", "/v1/models/record", { body }) as Promise<{
      run: number;
    }>;
  }

  /** CAS-promote a recorded run to CURRENT for its kind (replay is a no-op). */
  promoteModelRun(opts: { kind: string; run: number }): Promise<unknown> {
    return this.request("POST", "/v1/models/promote", {
      query: { kind: opts.kind, run: opts.run },
    });
  }

  /** A kind's model runs, newest first, with effective promotion state. */
  modelRegistry(opts: {
    kind: string;
  }): Promise<Schemas["ModelRegistryResponse"]> {
    return this.request("GET", "/v1/models/registry", {
      query: { kind: opts.kind },
    });
  }

  /** GC run prefixes beyond the promoted run + the last `keep`; reports deletions. */
  modelRegistryGc(opts: { kind: string; keep?: number }): Promise<unknown> {
    return this.request("POST", "/v1/models/registry/gc", {
      query: { kind: opts.kind, keep: opts.keep },
    });
  }

  /** Verify a run's temporal-split obligation from its recorded lineage. */
  modelSplitAudit(opts: {
    kind: string;
    run: number;
  }): Promise<Schemas["ModelSplitAudit"]> {
    return this.request("GET", "/v1/models/split-audit", {
      query: { kind: opts.kind, run: opts.run },
    });
  }

  /** Execution-verified QA probes generated from the graph's current edges. */
  syntheticEval(
    opts: { limit?: number } = {},
  ): Promise<Schemas["SyntheticEvalResponse"]> {
    return this.request("GET", "/v1/models/synthetic-eval", {
      query: { limit: opts.limit },
    });
  }

  /**
   * Compare champion and challenger retrieval over one pinned published
   * snapshot. The endpoint returns promotion evidence but never promotes.
   * @deprecated Legacy semantic-search replay; inspect the legacy_model_consumers_deprecation_v1 capability and policy Link.
   * Current managed model trials/Evals are separate. Execution is unchanged.
   */
  shadowEval(
    body: Schemas["ShadowEvalRequest"],
  ): Promise<Schemas["ShadowEvalResponse"]> {
    return this.request("POST", "/v1/models/shadow-eval", { body });
  }

  /** The doubling retrain policy: is a retrain due for this model kind? */
  modelCadence(opts: {
    kind: string;
  }): Promise<Schemas["ModelCadenceResponse"]> {
    return this.request("GET", "/v1/models/cadence", {
      query: { kind: opts.kind },
    });
  }

  /**
   * One deterministic trainer tick: build a probe set (execution-verified
   * synthetic pairs, or bring your own), search a bounded candidate space on
   * the train slice, gate the winner against the champion on the held-out
   * eval slice, record the run either way, and promote only when the gate
   * passes. The same tick the legacy `auto_train` cadence fires.
   * @deprecated Legacy deterministic retrieval trainer, not class-declared search.
   * Execution remains unchanged during the finite notice generation; inspect
   * the linked legacy model-consumer policy before new adoption.
   */
  trainTick(
    body: Schemas["TrainModelRequest"],
  ): Promise<Schemas["TrainModelResponse"]> {
    return this.request("POST", "/v1/models/train-tick", { body });
  }

  /**
   * @deprecated Legacy deterministic trainer selection. Existing job/history
   * reads remain supported; no automatic current-class-search equivalent.
   * Run {@link trainTick} as a durable background job and return its status
   * at once. The idempotency key names the job: submitting again with the
   * same key for the same graph returns the same `job_id`, so a caller that
   * lost the connection submits again instead of starting a second run.
   */
  async trainSubmit(
    body: Schemas["TrainModelRequest"],
    opts: { idempotencyKey: string },
  ): Promise<Schemas["TrainModelJobStatusResponse"]> {
    if (!opts?.idempotencyKey?.trim()) {
      throw new TypeError("trainSubmit requires a non-empty idempotencyKey");
    }
    return this.request("POST", "/v1/models/train-jobs", {
      body,
      idempotencyKey: opts.idempotencyKey,
    });
  }

  /**
   * A trainer job's state: `progress` while it runs, `terminal_error` when it
   * failed, and the complete `result` (the gate evidence and the recorded run)
   * when it succeeded.
   */
  trainJob(jobId: string): Promise<Schemas["TrainModelJobStatusResponse"]> {
    return this.request("GET", "/v1/models/train-jobs", {
      query: { job_id: jobId },
    });
  }

  /** The graph's automatic-training configuration (default: off). */
  trainingConfig(): Promise<Schemas["ModelTrainingConfig"]> {
    return this.request("GET", "/v1/models/training-config", {});
  }

  /**
   * @deprecated Legacy deterministic trainer selection. Execution/config remain
   * unchanged in the notice generation; auto_train=false remains the disable path.
   */
  setTrainingConfig(
    body: Schemas["ModelTrainingConfig"],
  ): Promise<Schemas["ModelTrainingConfig"]> {
    return this.request("POST", "/v1/models/training-config", { body });
  }

  ingestSignals(
    body: Schemas["SignalIngestRequest"],
    opts: { idempotencyKey?: string } = {},
  ): Promise<Schemas["SignalIngestResponse"]> {
    return this.request("POST", "/v1/signals", {
      body,
      idempotencyKey: opts.idempotencyKey ?? this.idempotencyKey("signals"),
    });
  }

  suggestionShown(
    payload: Schemas["SuggestionShownV1"],
    opts: { idempotencyKey?: string } = {},
  ): Promise<Schemas["SignalIngestResponse"]> {
    return this.ingestSignals(
      { signals: [{ kind: "suggestion_shown", payload }] },
      opts,
    );
  }

  suggestionAdopted(
    payload: Schemas["SuggestionAdoptedV1"],
    opts: { idempotencyKey?: string } = {},
  ): Promise<Schemas["SignalIngestResponse"]> {
    return this.ingestSignals(
      { signals: [{ kind: "suggestion_adopted", payload }] },
      opts,
    );
  }

  externalPlannerTrace(
    payload: Schemas["ExternalPlannerTraceV1"],
    opts: { idempotencyKey?: string } = {},
  ): Promise<Schemas["SignalIngestResponse"]> {
    return this.ingestSignals(
      {
        signals: [
          {
            kind: "external_planner_trace",
            request_id: payload.ask_id,
            snapshot_token: payload.snapshot_token,
            payload,
          },
        ],
      },
      opts,
    );
  }

  /** Suggest-ranker examples at or before an optional signal split. */
  suggestDataset(
    opts: { limit?: number; splitSeq?: number } = {},
  ): Promise<Schemas["SuggestDatasetResponse"]> {
    return this.request("GET", "/v1/models/suggest-dataset", {
      query: { limit: opts.limit, split_seq: opts.splitSeq },
    });
  }

  /** Extractor examples at or before an optional signal split. */
  extractorDataset(
    opts: { limit?: number; splitSeq?: number } = {},
  ): Promise<Schemas["ExtractorDatasetResponse"]> {
    return this.request("GET", "/v1/models/extractor-dataset", {
      query: { limit: opts.limit, split_seq: opts.splitSeq },
    });
  }

  /**
   * Promote a finished `extractor_lora` training run: gated on held-out fact
   * F1, recorded as a `kind=extractor` training run whose adapter resident
   * extraction then serves.
   */
  promoteExtractor(opts: {
    runId: string;
    allowRegression?: boolean;
  }): Promise<unknown> {
    return this.request("POST", "/v1/models/promote-extractor", {
      query: { run_id: opts.runId, allow_regression: opts.allowRegression },
    });
  }

  // --- relevance feedback ---

  /**
   * Append relevance labels for a set of ranked results — how little big brain
   * gathers customer-specific qrels. Grade results (3 ideal/good, 1 partial,
   * 0 bad), referencing the ranking's `search_id` so labels tie back to it.
   * Stored apart from customer facts and exported via
   * {@link searchFeedbackExport} as training/eval data for embedding fine-tuning.
   */
  searchFeedback(
    body: Schemas["SearchFeedbackRequest"],
    opts: { idempotencyKey?: string } = {},
  ): Promise<Schemas["SearchFeedbackResponse"]> {
    return this.request("POST", "/v1/search/feedback", {
      body,
      idempotencyKey: opts.idempotencyKey,
    });
  }

  /** Export the stored relevance labels as qrels-style rows for training. */
  searchFeedbackExport(): Promise<Schemas["SearchFeedbackExportResponse"]> {
    return this.request("GET", "/v1/search/feedback/export");
  }

  /**
   * Read projected attributes and current relationships from one RDF snapshot.
   * Each relationship carries its evidence, newest commit first: `evidence`
   * sets how many entries per relationship (default 5, 0 to 20). The
   * response's `evidence` says whether that evidence is `complete` or
   * `partial`. Inspect `unavailable_sections` before interpreting legacy
   * provenance arrays. Use strong consistency for read-after-write, or
   * `asOfCommitSeq` for the record at a retained commit.
   */
  entityDetail(opts: {
    id?: string;
    type?: string;
    name?: string;
    key?: string;
    consistency?: "strong" | "eventual";
    edges?: number;
    evidence?: number;
    asOfCommitSeq?: number;
  }): Promise<Schemas["EntityDetailResponse"]> {
    return this.request("GET", "/v1/graph/entity", {
      query: {
        id: opts.id,
        type: opts.type,
        name: opts.name,
        key: opts.key,
        consistency: opts.consistency,
        edges: opts.edges,
        evidence: opts.evidence,
        as_of_commit_seq: opts.asOfCommitSeq,
      },
    });
  }

  /**
   * Page through every row of a list in the list envelope, following
   * `next_cursor` until `has_more` is false. Pass a fetcher that takes a
   * cursor and returns a page ({@link ListPage}), for example
   * `client.listAll((cursor) => client.reviews.list({ cursor }))`. The
   * workflow lists have their own iterators
   * (`client.workflows.named.all()`, `allRuns`, `allDocuments`).
   */
  async *listAll<T>(
    fetchPage: (cursor?: string) => Promise<ListPage<T>>,
  ): AsyncGenerator<T, void, unknown> {
    let cursor: string | undefined;
    for (;;) {
      const page = await fetchPage(cursor);
      for (const row of page.data) yield row;
      if (!page.has_more || page.next_cursor == null) return;
      cursor = page.next_cursor;
    }
  }

  // --- query ---

  /**
   * SPARQL-subset SELECT/ASK/aggregate query (FILTER, HAVING, ORDER BY, ASK,
   * COUNT/SUM/AVG/MIN/MAX). GROUP BY is not limited to entity identity:
   * `group_by` keys on a variable's entity, and `group_keys` adds typed scalar
   * keys — a `property` value, or a `date_bucket` calendar truncation
   * (`year`/`month`/`week`/`day`/`hour`) of a datetime property — so a
   * per-category breakdown or a time series is one server-side query. Scalar
   * keys come back per group in `groups[].value_keys[<as>]`, entity keys in
   * `groups[].keys`.
   */
  sparql(
    body: Schemas["SparqlSelectRequest"],
    opts?: ReadConsistencyOptions,
  ): Promise<Schemas["SparqlSelectResponse"]> {
    return this.request("POST", "/v1/query/sparql", {
      body: profileBody(this.mergeReadConsistency(body, opts)),
    });
  }

  /** Publish an immutable source selection; it grants no source access. Administrator only. */
  saveDatasetView(
    body: Schemas["SavedDatasetViewDefinition"],
    opts: CallOptions = {},
  ): Promise<Schemas["SavedDatasetView"]> {
    return this.request("POST", "/v1/catalog/views", { ...opts, body });
  }

  /** Read an immutable saved source selection. Administrator only. */
  getDatasetView(
    revision: string,
    opts: CallOptions = {},
  ): Promise<Schemas["SavedDatasetView"]> {
    return this.request("GET", "/v1/catalog/view", {
      ...opts,
      query: { revision },
    });
  }

  /** SELECT/ASK over exact primary and reference epochs; returns the source version vector. */
  sparqlDataset(
    body: Schemas["ReferenceDatasetRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["ReferenceDatasetResponse"]> {
    return this.request("POST", "/v1/query/dataset", {
      ...opts,
      body,
      retry: opts.retry ?? "rate_limited",
    });
  }

  /**
   * SPARQL 1.1 query from text (SELECT/ASK) over the live graph; `results` is
   * SPARQL 1.1 Query Results JSON. The text dialect carries
   * `consistency`/`min_indexed_seq` on the URL; a floor with no explicit
   * consistency implies a strong base-plus-delta read. `as_of_commit_seq` in
   * the body reads the retained published generation of that exact commit.
   *
   * The query is read-only, so a retryable `429` (for example
   * `read_your_writes_pending` while publication catches up to the floor) is
   * retried within the retry budget. A `5xx` is not retried: a query that
   * timed out would run again.
   */
  sparqlText(
    body: Schemas["SparqlTextRequest"],
    opts?: ReadConsistencyOptions,
  ): Promise<Schemas["SparqlTextResponse"]> {
    return this.request("POST", "/v1/query/sparql-text", {
      body: profileBody(body),
      query: this.readConsistencyQuery(opts),
      retry: "rate_limited",
    });
  }

  /**
   * Run a SPARQL 1.1 text query and return parsed results — the ergonomic
   * complement to {@link sparqlText} (which hands back the raw results string).
   * Returns `{ vars, boolean, bindings, rows, snapshot }` via
   * {@link parseSparqlResults}: `rows` is the bindings flattened to
   * `{ variable: lexicalValue }`, `boolean` is the ASK answer (or `null` for a
   * SELECT), and `snapshot.served_at_seq` is the commit an eventual or pinned
   * read answered from (`snapshot` is `null` for a plain strong read).
   */
  async sparqlRows(
    body: Schemas["SparqlTextRequest"],
    opts?: ReadConsistencyOptions,
  ): Promise<SparqlResults> {
    return parseSparqlResults(await this.sparqlText(body, opts));
  }

  // --- ontology ---

  /**
   * The active ontology (entity types and relations) for the scoped graph.
   * Pass `{ counts: true }` to include a per-relation current-edge count
   * (`OntologyRelationView.edge_count`) so a caller can see which declared
   * relations are actually populated — at the cost of a snapshot load.
   */
  ontologyView(
    opts: { counts?: boolean } = {},
  ): Promise<Schemas["OntologyView"]> {
    return this.request("GET", "/v1/ontology", {
      query: opts.counts ? { counts: true } : undefined,
    });
  }

  /**
   * Audit the current snapshot against the ontology's *implied* constraints —
   * capped `cardinality` derived as `sh:maxCount` — returning a SHACL-shaped
   * report. Whole-snapshot and never blocks a write. Unlike
   * The report is referenced by the pinned published read root and carries its
   * own validation watermark and ontology/shapes provenance.
   */
  ontologyConformance(
    opts?: Pick<ReadConsistencyOptions, "consistency">,
  ): Promise<Schemas["SchemaAuditReport"]> {
    return this.request("GET", "/v1/ontology/conformance", {
      query: { consistency: this.resolveConsistency(opts) },
    });
  }

  /** Discover ontology concepts, terms, and relations. */
  ontologySearch(
    body: Schemas["OntologySearchRequest"],
  ): Promise<Schemas["OntologySearchResponse"]> {
    return this.request("POST", "/v1/ontology/search", { body });
  }

  /** Resolve mentions to concepts/entities. */
  ontologyResolve(
    body: Schemas["OntologyResolveRequest"],
  ): Promise<Schemas["OntologyResolveResponse"]> {
    return this.request("POST", "/v1/ontology/resolve", { body });
  }

  /**
   * Put the scoped graph on an imported ontology, creating the graph when it
   * does not exist yet. Safe to repeat: an unchanged ontology answers
   * `changed: false` without writing. An additive difference is applied,
   * including a wider relation domain or range and a new property field, and
   * `changed` reports what was written. A document that narrows or drops what
   * the graph already defines, or states a change no additive operation
   * expresses, is refused with `ontology_restrictive_change`,
   * `ontology_identity_breaking_change`, or `ontology_unsupported_change`, and
   * writes nothing.
   */
  ontologyDefine(
    body: Schemas["OntologyDefineRequest"],
  ): Promise<Schemas["OntologyDefineResponse"]> {
    return this.request("POST", "/v1/ontology/define", { body });
  }

  /**
   * Additively evolve the active ontology of an existing graph: widen relation
   * domains/ranges and declare new entity types (all by name), bumping the
   * ontology version. Additive-only — every existing record stays valid, so no
   * migration is needed — and a request that changes nothing is a no-op.
   */
  evolveOntology(
    body: Schemas["OntologyEvolveRequest"],
  ): Promise<Schemas["OntologyEvolveResponse"]> {
    return this.request("POST", "/v1/ontology/evolve", { body });
  }

  /** Fold the WAL tail into snapshot segments. */
  compact(
    opts: { minTailCommits?: number; maxSegments?: number } = {},
  ): Promise<Schemas["WalCompactResponse"]> {
    return this.request("POST", "/v1/graph/compact", {
      query: {
        min_tail_commits: opts.minTailCommits,
        max_segments: opts.maxSegments,
      },
    });
  }

  /** Run the fixed RDF fixture checks; always sends an explicit response version. */
  demoRun(opts?: {
    dataset?: string;
    version?: "demo/1";
  }): Promise<Schemas["DemoCurrentRunResponse"]>;
  /** Temporary explicit legacy compatibility; no current RDF-check promise. */
  demoRun(opts: { dataset?: string; version: "legacy" }): Promise<unknown>;
  async demoRun(
    opts: { dataset?: string; version?: "demo/1" | "legacy" } = {},
  ): Promise<unknown> {
    const version = opts.version ?? "demo/1";
    const dataset = opts.dataset ?? "semantic_graph";
    if (version !== "demo/1" && version !== "legacy")
      throw new TypeError("demo version must be demo/1 or legacy");
    if (version === "demo/1")
      await this.requireCapability("rdf_demo_checks_v1");
    const response = await this.request<unknown>("POST", "/v1/demo/run", {
      query: { version, dataset },
    });
    return version === "demo/1"
      ? checkedDemoRunResponse(response, dataset)
      : checkedLegacyDemoRun(response);
  }

  // --- inspection ---

  /** Current RDF/class diagnostics, explicitly selected and checked on older servers. */
  status(opts: {
    version: "status/1";
  }): Promise<Schemas["CurrentStatusResponse"]>;
  /** Omitted options follow the server default; pass legacy only for finite compatibility. */
  status(opts?: { version?: "legacy" }): Promise<unknown>;
  async status(
    opts: { version?: "status/1" | "legacy" } = {},
  ): Promise<unknown> {
    if (
      opts.version !== undefined &&
      opts.version !== "status/1" &&
      opts.version !== "legacy"
    ) {
      throw new TypeError("status version must be status/1 or legacy");
    }
    const response = await this.request<unknown>("GET", "/v1/status", {
      query: opts.version ? { version: opts.version } : undefined,
    });
    if (opts.version === "status/1") return checkedCurrentStatus(response);
    if (
      opts.version === "legacy" &&
      (!isStatusObject(response) ||
        !isStatusObject(response.persisted_index) ||
        !isStatusObject(response.graph_status) ||
        response.version === "status/1")
    ) {
      throw new LbbCapabilityError("legacy status response");
    }
    return response;
  }

  /** Graph footprint, WAL tail, and published-index coverage. */
  metadata(
    opts: {
      includeIndexes?: boolean;
    } = {},
  ): Promise<Schemas["GraphMetadataResponse"]> {
    return this.request("GET", "/v1/graph/metadata", {
      query: {
        include_indexes: opts.includeIndexes,
      },
    });
  }

  /** Automatic publication lifecycle, available before the first generation exists. */
  publicationStatus(): Promise<Schemas["PublicationStatusResponse"]> {
    return this.request("GET", "/v1/graph/publication-status");
  }

  /** Background work on the graph: publication, compaction, query
   * statistics, validation, embeddings, and imports, exports, forks and
   * index upgrades. One call reads at most 30 objects, so a status view can
   * poll it every few seconds. Needs the server capability
   * `graph_activity_v1`. */
  activity(): Promise<Schemas["GraphActivityResponse"]> {
    return this.request("GET", "/v1/graph/activity");
  }

  /** The managed models the platform uses per role (embedding, judge,
   * rewriter): the operator's catalog, or the compiled defaults. */
  managedModels(): Promise<Schemas["ManagedModelsResponse"]> {
    return this.request("GET", "/v1/managed-models");
  }

  /** What each managed model did for the stack in one month (`yyyy-mm`,
   * UTC; the current month by default): totals, by day and by graph per
   * feature (`index`, `search`, `fit`, `judge`, `training`) and model, the
   * months with activity, and the model each feature uses now. A stack
   * read: the graph scope is not used. */
  modelActivity(
    opts: { month?: string } = {},
  ): Promise<Schemas["ModelActivityResponse"]> {
    return this.request("GET", "/v1/models/activity", {
      query: { month: opts.month },
    });
  }

  /** Wait until background reconciliation folds `targetSeq` into the RDF base. */
  async waitForPublished(
    targetSeq: number,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<Schemas["PublicationStatusResponse"]> {
    if (!Number.isSafeInteger(targetSeq) || targetSeq < 0) {
      throw new RangeError("targetSeq must be a non-negative safe integer");
    }
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 250;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("timeoutMs must be a non-negative number");
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
      throw new RangeError("pollIntervalMs must be a non-negative number");
    }
    const deadline = Date.now() + timeoutMs;
    let last: Schemas["PublicationStatusResponse"] | undefined;
    while (true) {
      last = await this.publicationStatus();
      if (last.state === "blocked") {
        throw new Error(
          `publication blocked at ${last.current_stage ?? "unknown stage"}: ${last.retry.message}`,
        );
      }
      if (last.state === "current" && last.published_seq >= targetSeq) {
        return last;
      }
      const now = Date.now();
      if (now >= deadline) {
        throw new Error(
          `publication did not reach ${targetSeq} before timeout (state=${last.state}, head=${last.head_seq}, target=${last.target_seq}, published=${last.published_seq}, stage=${last.current_stage ?? "unknown"})`,
        );
      }
      await sleep(
        Math.min(
          Math.max(pollIntervalMs, last.retry.retry_after_ms),
          deadline - now,
        ),
      );
    }
  }

  /** Graph counts and type/relation buckets. Carries `consistency`/`min_indexed_seq` on the URL. */
  summary(
    opts?: ReadConsistencyOptions,
  ): Promise<Schemas["GraphSummaryResponse"]> {
    return this.request("GET", "/v1/graph/summary", {
      query: this.readConsistencyQuery(opts),
    });
  }

  /**
   * The SPARQL planner's statistics for the published generation latest reads
   * use: per-predicate triple and distinct counts (by triple count, paged by
   * `cursor`/`limit`, 200 by default and 500 at most), key-histogram,
   * pair-count and trigram sidecars, and value-order index coverage. Read from
   * the generation's manifest and sidecar metadata; nothing scans the graph.
   * A graph with no published generation answers `served_at_seq: null`.
   */
  plannerStats(
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<Schemas["PlannerStatsResponse"]> {
    return this.request("GET", "/v1/graph/planner-stats", {
      query: { cursor: opts.cursor, limit: opts.limit },
    });
  }

  /** Pinned published read root and its query/conformance lag against one coherent head. */
  readSnapshot(): Promise<Schemas["PublishedReadStatusResponse"]> {
    return this.request("GET", "/v1/graph/read-snapshot");
  }

  /**
   * Compact observed RDF schema attached to the immutable published base:
   * class populations, resource- and literal-valued predicate counts, and
   * bounded OWL/RDFS statements. `literal_predicate_counts` is `null` when
   * the stored summary artifact predates the field; the next full summary
   * rebuild fills it.
   */
  schemaSummary(): Promise<Schemas["RdfSchemaSummaryResponse"]> {
    return this.request("GET", "/v1/graph/schema-summary");
  }

  /** List the graphs under the scoped tenant. */
  listGraphs(): Promise<Schemas["GraphListResponse"]> {
    return this.request("GET", "/v1/graphs");
  }
}

function isStatusObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
