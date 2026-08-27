import type {
  DurableImportLine,
  DurableImportSource,
  FetchLike,
  ImportLine,
  LbbClientOptions,
  LbbRequestEvent,
  LbbResponseEvent,
  LbbRetryEvent,
  ListResponse,
  RawLbbResponse,
  ReadConsistencyOptions,
  RdfImportDocument,
  RdfImportManyResult,
  RdfImportOptions,
  Schemas,
  SearchConsistency,
  SparqlResults,
} from "./types.js";
import { parseSparqlResults } from "./types.js";
import {
  bodyMarksTerminal,
  errorCodeFromBody,
  fullJitterBackoffMs,
  parseLbbError,
  parseResponseJson,
  retryAllowed,
  retryableStatus,
  retryDelayMs,
  sleep,
  type CallOptions,
  type Query,
  type RequestOptions,
} from "./transport.js";
import { LbbCapabilityError } from "./transport.js";
import {
  EntityNamespace,
  GraphNamespace,
  OntologyNamespace,
  QueryNamespace,
  SchemaNamespace,
  SearchNamespace,
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
  SchemaView,
  Snapshot,
} from "./types.js";
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

/**
 * A typed HTTP client for a little big brain graph server. One instance is scoped to a
 * single graph/branch; construct another for a different scope. All methods
 * return the parsed JSON response and throw {@link LbbError} on failure.
 */
export class LbbClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly graphName?: string;
  private readonly branchName?: string;
  private readonly stack?: string;
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
  readonly schema: SchemaNamespace;
  readonly ontology: OntologyNamespace;
  readonly query: QueryNamespace;

  constructor(options: LbbClientOptions) {
    const baseUrl = options.baseUrl?.trim();
    if (!baseUrl) {
      throw new Error(
        "baseUrl is required; copy endpoint_url from the stack's Connect page for hosted use",
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.graphName = options.graph;
    this.branchName = options.branch;
    this.stack = options.stack;
    this.apiVersion = options.apiVersion ?? "2026-07-23";
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
    this.schema = new SchemaNamespace(this);
    this.ontology = new OntologyNamespace(this);
    this.query = new QueryNamespace(this);
  }

  graph(
    name: string,
    opts: { branch?: string; stack?: string } = {},
  ): GraphNamespace {
    return new GraphNamespace(
      this.withScope({
        graph: name,
        branch: opts.branch ?? this.branchName,
        stack: opts.stack ?? this.stack,
      }),
    );
  }

  /**
   * A new client for a different graph/branch on the same server and credential.
   * Each instance is scoped to one graph/branch, so use this to target another
   * scope (e.g. creating a fresh graph) without mutating the current client.
   */
  withScope(scope: {
    graph?: string;
    branch?: string;
    stack?: string;
  }): LbbClient {
    return new LbbClient({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      graph: scope.graph ?? this.graphName,
      branch: scope.branch ?? this.branchName,
      stack: scope.stack ?? this.stack,
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
    if (this.branchName !== undefined) push("branch", this.branchName);
    if (this.stack !== undefined) push("stack", this.stack);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) push(key, value);
    }
    const qs = params.length > 0 ? `?${params.join("&")}` : "";
    return `${this.baseUrl}${path}${qs}`;
  }

  async rawRequest<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<RawLbbResponse<T>> {
    const headers: Record<string, string> = {
      "content-type": opts.contentType ?? "application/json",
      "lbb-version": this.apiVersion,
    };
    if (this.apiKey !== undefined)
      headers["authorization"] = `Bearer ${this.apiKey}`;
    if (opts.idempotencyKey !== undefined)
      headers["idempotency-key"] = opts.idempotencyKey;
    Object.assign(headers, opts.headers ?? {});
    const canRetry = opts.retry ?? retryAllowed(method, opts.idempotencyKey);
    const body =
      opts.rawBody !== undefined
        ? opts.rawBody
        : opts.body !== undefined
          ? JSON.stringify(opts.body)
          : undefined;
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
    const url = this.buildUrl(path, opts.query);
    let attempts = 0;
    let response: Awaited<ReturnType<FetchLike>> | undefined;
    let text = "";
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
        text = await response.text();
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
        if (!callerAborted && canRetry && attempt < maxRetries) {
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
      if (!canRetry) {
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
      throw parseLbbError(response.status, text.trim(), requestId);
    const responseContentType =
      response.headers?.get("content-type")?.toLowerCase() ?? "";
    const isRdfText =
      responseContentType.includes("text/turtle") ||
      responseContentType.includes("application/n-triples") ||
      responseContentType.includes("application/trig") ||
      responseContentType.includes("application/n-quads");
    return {
      data: text
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
    ).then((version) => new Set(version.capabilities));
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

  /** Import several RDF documents with a final fence and server-managed safety compaction. */
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
    opts: { idempotencyKey?: string } = {},
  ): Promise<Schemas["GraphRetractResponse"]> {
    return this.request("POST", "/v1/graph/retract", {
      body,
      idempotencyKey: opts.idempotencyKey ?? this.idempotencyKey("retract"),
    });
  }

  /**
   * Create the scoped graph/branch with an empty ontology. Construct the client
   * with the desired graph/branch first, then call `ontology.define` before
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
   * retry. The response only acknowledges the enqueue — poll the destination
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

  /** Fork the scoped branch from an existing branch in the same graph. */
  createBranch(
    body: Schemas["GraphBranchCreateRequest"],
  ): Promise<Schemas["GraphBranchCreateResponse"]> {
    return this.request("POST", "/v1/graph/branch", { body });
  }

  /**
   * Validate-then-merge: replay `from_branch`'s post-fork commits onto the
   * SCOPED branch (its fork parent) as one new commit. A write — sends an
   * Idempotency-Key so a retry replays instead of re-applying.
   */
  mergeBranch(
    body: Schemas["GraphBranchMergeRequest"],
    opts: { idempotencyKey?: string } = {},
  ): Promise<Schemas["GraphBranchMergeResponse"]> {
    return this.request("POST", "/v1/graph/branch/merge", {
      body,
      idempotencyKey:
        opts.idempotencyKey ?? this.idempotencyKey("branch-merge"),
    });
  }

  /**
   * Observe: store a conversation episode verbatim as EPISODE evidence,
   * anchor + gate extracted facts on an observe branch, and optionally
   * auto-merge when validation is clean. Flag-gated server-side
   * (`--enable-observe`). A write — carries an Idempotency-Key.
   */
  observe(
    body: Schemas["ObserveRequest"],
    opts: { idempotencyKey?: string } = {},
  ): Promise<Schemas["ObserveResponse"]> {
    return this.request("POST", "/v1/memory/observe", {
      body,
      idempotencyKey: opts.idempotencyKey ?? this.idempotencyKey("observe"),
    });
  }

  /** Delete the scoped graph, including every branch, feedback, and active graph-scoped job. */
  deleteGraph(opts: {
    confirm: string;
  }): Promise<Schemas["GraphDeleteResponse"]> {
    return this.request("POST", "/v1/graph/delete", {
      query: { confirm: opts.confirm },
      retry: true,
    });
  }

  /** Delete only the scoped branch. The server refuses to delete a graph's final live branch. */
  deleteBranch(opts: {
    confirm: string;
  }): Promise<Schemas["GraphBranchDeleteResponse"]> {
    return this.request("DELETE", "/v1/graph/branch", {
      query: { confirm: opts.confirm },
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
   * passes. The same tick the `auto_train` cadence fires — always safe to
   * call by hand.
   */
  trainTick(
    body: Schemas["TrainModelRequest"],
  ): Promise<Schemas["TrainModelResponse"]> {
    return this.request("POST", "/v1/models/train-tick", { body });
  }

  /** The graph's automatic-training configuration (default: off). */
  trainingConfig(): Promise<Schemas["ModelTrainingConfig"]> {
    return this.request("GET", "/v1/models/training-config", {});
  }

  /** Set the automatic-training configuration (`auto_train` toggle + kinds). */
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

  /** Planner training examples at or before an optional signal split. */
  plannerDataset(
    opts: { limit?: number; splitSeq?: number } = {},
  ): Promise<Schemas["PlannerDatasetResponse"]> {
    return this.request("GET", "/v1/models/planner-dataset", {
      query: { limit: opts.limit, split_seq: opts.splitSeq },
    });
  }

  /** Planner preference pairs at or before an optional signal split. */
  plannerPreferenceDataset(
    opts: { limit?: number; splitSeq?: number } = {},
  ): Promise<Schemas["PlannerPreferenceDatasetResponse"]> {
    return this.request("GET", "/v1/models/planner-preference-dataset", {
      query: { limit: opts.limit, split_seq: opts.splitSeq },
    });
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

  /**
   * Promote a finished `planner_lora` training run: gated on held-out slot
   * exactness and recorded as a `kind=planner` training run.
   */
  promotePlanner(opts: {
    runId: string;
    allowRegression?: boolean;
  }): Promise<unknown> {
    return this.request("POST", "/v1/models/promote-planner", {
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
   * Ranked incoming/outgoing neighborhood for a graph entity.
   *
   * `edges` caps the edges returned per direction (default 1000, maximum
   * 10000). When a cap cuts a direction the response carries a `truncation`
   * block; an uncut response omits it entirely.
   */
  entityNeighborhood(opts: {
    id?: string;
    type?: string;
    name?: string;
    relations?: string[];
    asOf?: string;
    edges?: number;
  }): Promise<Schemas["EntityNeighborhoodResponse"]> {
    return this.request("GET", "/v1/graph/entity/neighborhood", {
      query: {
        id: opts.id,
        type: opts.type,
        name: opts.name,
        relations: opts.relations?.join(","),
        as_of: opts.asOf,
        edges: opts.edges,
      },
    });
  }

  /** Exact type cardinality plus a bounded deterministic sample from Base. */
  entityTypeSample(
    opts: { type: string; limit?: number } & CallOptions,
  ): Promise<Schemas["EntityTypeSampleResponse"]> {
    const { type, limit, ...request } = opts;
    return this.request("GET", "/v1/graph/entities/sample", {
      ...request,
      query: { type, limit },
    });
  }

  /** Stored entity object-ref status and index-coverage metadata (no
   * attributes — read those from `entityDetail`'s top-level `attributes`). */
  entityMetadata(opts: {
    id?: string;
    type?: string;
    name?: string;
    asOf?: string;
  }): Promise<Schemas["EntityMetadataResponse"]> {
    return this.request("GET", "/v1/graph/entity/metadata", {
      query: {
        id: opts.id,
        type: opts.type,
        name: opts.name,
        as_of: opts.asOf,
      },
    });
  }

  /**
   * Entity detail: metadata, attributes, current state, edge history, and
   * observations. Pass `asOf` / `asOfCommitSeq` to reproduce the node as of a
   * past instant / commit (the state, edges, and history are pinned to it).
   */
  entityDetail(opts: {
    id?: string;
    type?: string;
    name?: string;
    asOf?: string;
    asOfCommitSeq?: number;
  }): Promise<Schemas["EntityDetailResponse"]> {
    return this.request("GET", "/v1/graph/entity", {
      query: {
        id: opts.id,
        type: opts.type,
        name: opts.name,
        as_of: opts.asOf,
        as_of_commit_seq: opts.asOfCommitSeq,
      },
    });
  }

  /**
   * Page through every row of a list endpoint, following `next_cursor` until
   * exhausted. Pass a fetcher that takes a cursor and returns a
   * {@link ListResponse}:
   * The caller supplies a bounded collection endpoint and its cursor.
   */
  async *listAll<T>(
    fetchPage: (cursor?: string) => Promise<ListResponse<T>>,
  ): AsyncGenerator<T, void, unknown> {
    let cursor: string | undefined;
    for (;;) {
      const page = await fetchPage(cursor);
      for (const row of page.data) yield row;
      if (!page.has_more || page.next_cursor == null) return;
      cursor = page.next_cursor;
    }
  }

  // --- temporal / lineage / shapes ---

  /** Current state of an entity's relations, optionally as-of a timestamp. */
  currentState(
    body: Schemas["CurrentStateRequest"],
  ): Promise<Schemas["CurrentStateResponse"]> {
    return this.request("POST", "/v1/query/state", { body });
  }

  /** Full edge-event history for a relationship. */
  history(
    body: Schemas["RelationshipHistoryRequest"],
  ): Promise<Schemas["RelationshipHistoryResponse"]> {
    return this.request("POST", "/v1/query/history", { body });
  }

  /** Ordered state-transition log for an entity's relation, with dwell time. */
  transitions(
    body: Schemas["EntityTransitionsRequest"],
  ): Promise<Schemas["EntityTransitionsResponse"]> {
    return this.request("POST", "/v1/query/transitions", { body });
  }

  /** Lineage and evidence for a single edge. */
  why(body: Schemas["WhyRequest"]): Promise<Schemas["WhyResponse"]> {
    return this.request("POST", "/v1/query/why", { body });
  }

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
      body: this.mergeReadConsistency(body, opts),
    });
  }

  /** SPARQL 1.1 query from text (SELECT/ASK) over the live graph; `results` is SPARQL 1.1 Query Results JSON. The text dialect carries `consistency`/`min_indexed_seq` on the URL. */
  sparqlText(
    body: Schemas["SparqlTextRequest"],
    opts?: ReadConsistencyOptions,
  ): Promise<Schemas["SparqlTextResponse"]> {
    return this.request("POST", "/v1/query/sparql-text", {
      body,
      query: this.readConsistencyQuery(opts),
    });
  }

  /**
   * Run a SPARQL 1.1 text query and return parsed results — the ergonomic
   * complement to {@link sparqlText} (which hands back the raw results string).
   * Returns `{ vars, boolean, bindings, rows }` via {@link parseSparqlResults}:
   * `rows` is the bindings flattened to `{ variable: lexicalValue }`, `boolean`
   * is the ASK answer (or `null` for a SELECT).
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

  /** Suggest ontology additions from the current graph without mutating it. */
  induceOntology(
    body: Schemas["OntologyInduceRequest"],
  ): Promise<Schemas["OntologyInduceResponse"]> {
    return this.request("POST", "/v1/ontology/induce", { body, retry: true });
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

  // --- inspection ---

  /** Server, graph, and persisted-index status. */
  status(): Promise<unknown> {
    return this.request("GET", "/v1/status");
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

  /** Pinned published read root and its query/conformance lag against one coherent head. */
  readSnapshot(): Promise<Schemas["PublishedReadStatusResponse"]> {
    return this.request("GET", "/v1/graph/read-snapshot");
  }

  /** List the graphs (and branches) under the scoped tenant. */
  listGraphs(): Promise<Schemas["GraphListResponse"]> {
    return this.request("GET", "/v1/graphs");
  }
}
