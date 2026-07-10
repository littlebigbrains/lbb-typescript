import type {
  FetchLike,
  ImportLine,
  LbbAdminSessionResponse,
  LbbAdminStackCreateRequest,
  LbbAdminStackDeleteResponse,
  LbbAdminStackResponse,
  LbbClientOptions,
  LbbRequestEvent,
  LbbResponseEvent,
  LbbStackActivityResponse,
  LbbStackActivityWindow,
  ListResponse,
  RawLbbResponse,
  Schemas,
  SparqlResults,
} from "./types.js";
import { parseSparqlResults } from "./types.js";
import {
  parseLbbError,
  parseResponseJson,
  retryAllowed,
  retryDelayForAttempt,
  retryableStatus,
  sleep,
  type Query,
  type RequestOptions,
} from "./transport.js";
import {
  AdminNamespace,
  ContextNamespace,
  EntityNamespace,
  GraphNamespace,
  IndexNamespace,
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
  FetchLike,
  FlatProperties,
  ImportLine,
  LbbAdminSessionResponse,
  LbbAdminStackCreateRequest,
  LbbAdminStackDeleteResponse,
  LbbAdminStackResponse,
  LbbClientOptions,
  LbbRequestEvent,
  LbbResponseEvent,
  LbbErrorPayload,
  LbbStackActivityResponse,
  LbbStackActivityWindow,
  LbbStackView,
  ListResponse,
  RawLbbResponse,
  Schemas,
  SparqlResults,
  SparqlResultsJson,
  SparqlTerm,
  AskRequest,
  AskResponse,
  CommitRequest,
  CommitResponse,
  Entity,
  EntitySelector,
  GraphMetadata,
  GraphSummary,
  SchemaView,
  SearchRequest,
  SearchResponse,
  SearchResult,
  Snapshot,
} from "./types.js";
export { LbbError } from "./transport.js";
export type {
  CallOptions,
  Query,
  QueryValue,
  RequestOptions,
} from "./transport.js";
export type { EntityListOptions, HybridSearchOptions } from "./namespaces.js";
export {
  AdminNamespace,
  ContextNamespace,
  EntityNamespace,
  FactsNamespace,
  GraphNamespace,
  IndexNamespace,
  OntologyNamespace,
  QueryNamespace,
  SchemaNamespace,
  SearchNamespace,
} from "./namespaces.js";

/**
 * A typed HTTP client for a Little Big Brain graph server. One instance is scoped to a
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
  private readonly timeoutMs: number;
  private readonly onRequest?: (event: LbbRequestEvent) => void;
  private readonly onResponse?: (event: LbbResponseEvent) => void;

  readonly admin: AdminNamespace;
  readonly context: ContextNamespace;
  readonly search: SearchNamespace;
  readonly indexes: IndexNamespace;
  readonly entities: EntityNamespace;
  readonly schema: SchemaNamespace;
  readonly ontology: OntologyNamespace;
  readonly query: QueryNamespace;

  constructor(options: LbbClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.graphName = options.graph;
    this.branchName = options.branch;
    this.stack = options.stack;
    this.apiVersion = options.apiVersion ?? "2026-06-22";
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 100;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.onRequest = options.onRequest;
    this.onResponse = options.onResponse;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new RangeError("maxRetries must be a non-negative integer");
    }
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new RangeError("retryDelayMs must be a non-negative number");
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
    this.admin = new AdminNamespace(this);
    this.context = new ContextNamespace(this);
    this.search = new SearchNamespace(this);
    this.indexes = new IndexNamespace(this);
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
      timeoutMs: this.timeoutMs,
      onRequest: this.onRequest,
      onResponse: this.onResponse,
    });
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
    };
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const maxRetries = opts.maxRetries ?? this.maxRetries;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError("maxRetries must be a non-negative integer");
    }
    const startedAt = Date.now();
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
        response = await this.fetchImpl(url, {
          ...init,
          signal: controller?.signal ?? opts.signal,
        });
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
          await sleep(this.retryDelayMs * (attempt + 1));
          continue;
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
      await sleep(
        retryDelayForAttempt(
          this.retryDelayMs,
          attempt,
          response.headers?.get("retry-after"),
        ),
      );
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
    return {
      data: text
        ? parseResponseJson<T>(text, response.status, requestId)
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

  // --- writes ---

  /** Commit triplets and optional entity embeddings. Prefer `client.graph("main").facts.create(...)`. */
  commit(
    body: Schemas["TripletCommitFile"],
    opts: { idempotencyKey?: string } = {},
  ): Promise<Schemas["GraphCommitResponse"]> {
    return this.request("POST", "/v1/graph/commit", {
      body,
      idempotencyKey:
        opts.idempotencyKey ?? this.idempotencyKey("facts.create"),
    });
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
   * Set `index: true` to run one full index build after the last batch, so the
   * data is served from the persisted runs (not just the ephemeral snapshot
   * fallback) by the time the call returns — the "bulk load, queryable on return"
   * path. Prefer this over indexing per batch (which serializes builds and races
   * the throttle): import the whole dataset, index once. The response's `index`
   * object reports whether the build ran or was skipped.
   */
  import(
    lines: ImportLine[] | string,
    opts: {
      batch?: number;
      strict?: boolean;
      observedAt?: string;
      index?: boolean;
      idempotencyKey?: string;
    } = {},
  ): Promise<Schemas["GraphImportResponse"]> {
    const ndjson =
      typeof lines === "string"
        ? lines
        : lines.map((line) => JSON.stringify(line)).join("\n");
    return this.request("POST", "/v1/graph/import", {
      rawBody: ndjson,
      contentType: "application/x-ndjson",
      query: {
        batch: opts.batch,
        strict: opts.strict,
        observed_at: opts.observedAt,
        index: opts.index,
      },
      idempotencyKey: opts.idempotencyKey ?? this.idempotencyKey("import"),
    });
  }

  /**
   * Bulk-ingest N-Triples without client-side conversion. Resource-object
   * triples become keyed Resource edges; literal-object triples become text
   * properties on the subject Resource.
   */
  importRdf(
    ntriples: string,
    opts: {
      batch?: number;
      strict?: boolean;
      observedAt?: string;
      resourceType?: string;
      edgeIdempotency?: "append" | "skip_unchanged";
      idempotencyKey?: string;
    } = {},
  ): Promise<Schemas["GraphRdfImportResponse"]> {
    return this.request("POST", "/v1/graph/import/rdf", {
      rawBody: ntriples,
      contentType: "application/n-triples",
      query: {
        batch: opts.batch,
        strict: opts.strict,
        observed_at: opts.observedAt,
        format: "ntriples",
        resource_type: opts.resourceType,
        edge_idempotency: opts.edgeIdempotency,
      },
      idempotencyKey: opts.idempotencyKey ?? this.idempotencyKey("import-rdf"),
    });
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

  /** Create the scoped graph/branch. Construct the client with the desired graph/branch first. */
  createGraph(): Promise<Schemas["CreateGraphResponse"]> {
    return this.request("POST", "/v1/graph/create");
  }

  /** Fork the scoped branch from an existing branch in the same graph. */
  createBranch(
    body: Schemas["GraphBranchCreateRequest"],
  ): Promise<Schemas["GraphBranchCreateResponse"]> {
    return this.request("POST", "/v1/graph/branch", { body });
  }

  /**
   * WS16 validate-then-merge: replay `from_branch`'s post-fork commits onto the
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
   * WS15 observe: store a conversation episode verbatim as EPISODE evidence,
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

  /**
   * Delete every object under the scoped graph/branch — a destructive reset.
   * `confirm` must equal the scoped graph id; the next commit re-initializes the
   * graph. Branch-scoped: sibling branches are untouched.
   */
  deleteGraph(opts: { confirm: string }): Promise<unknown> {
    return this.request("POST", "/v1/graph/delete", {
      query: { confirm: opts.confirm },
    });
  }

  // --- models as runs (WS9 registry + eval machinery) ---

  /**
   * The graph's grounding vocabulary as byte-sorted, deduped string sections —
   * the canonical input for a decoder-side automaton (FST/trie) and the
   * vocabulary half of an export bundle.
   */
  vocabExport(
    opts: { sections?: string[]; limit?: number } = {},
  ): Promise<Schemas["VocabExportResponse"]> {
    return this.request("GET", "/v1/search/vocab", {
      query: { sections: opts.sections?.join(","), limit: opts.limit },
    });
  }

  /**
   * Captured signals by flush-seq range, oldest first — the flywheel training
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

  /**
   * Champion vs challenger retrieval over one pinned snapshot. Returns
   * promotion evidence (hit-rate@k, latency, overlap); never promotes.
   */
  shadowEval(
    body: Schemas["ShadowEvalRequest"],
  ): Promise<Schemas["ShadowEvalResponse"]> {
    return this.request("POST", "/v1/models/shadow-eval", { body });
  }

  /**
   * Execution-verified QA probes generated from the graph's current edges —
   * labels are the executed projections, so they are verified by construction.
   * Feeds `shadowEval` directly.
   */
  syntheticEval(
    opts: { limit?: number } = {},
  ): Promise<Schemas["SyntheticEvalResponse"]> {
    return this.request("GET", "/v1/models/synthetic-eval", {
      query: { limit: opts.limit },
    });
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

  /**
   * Verdict on an ask (`accepted` | `rejected` | `corrected` + the right
   * plan), joined to the ask's trace by `ask_id` — the planner fine-tune's
   * explicit feedback capture. `accepted: false` in the response means
   * signal capture is off on this deployment (the contract is identical).
   */
  askFeedback(
    body: Schemas["AskFeedbackRequest"],
  ): Promise<Schemas["AskFeedbackResponse"]> {
    return this.request("POST", "/v1/ask/feedback", { body });
  }

  /**
   * The planner fine-tune's training feed: accepted/corrected feedback
   * joined to its traces (signals ≤ the split pin), topped up with
   * execution-verified synthetic plans.
   */
  plannerDataset(
    opts: { limit?: number; splitSeq?: number } = {},
  ): Promise<Schemas["PlannerDatasetResponse"]> {
    return this.request("GET", "/v1/models/planner-dataset", {
      query: { limit: opts.limit, split_seq: opts.splitSeq },
    });
  }

  /**
   * The DPO pass's training feed: preference pairs from corrected verdicts,
   * paired rejections, and synthetic corrupted-slot pairs.
   */
  plannerPreferenceDataset(
    opts: { limit?: number; splitSeq?: number } = {},
  ): Promise<Schemas["PlannerPreferenceDatasetResponse"]> {
    return this.request("GET", "/v1/models/planner-preference-dataset", {
      query: { limit: opts.limit, split_seq: opts.splitSeq },
    });
  }

  /**
   * The suggest-ranker trainer's probe feed: `suggestion_adopted` signals
   * (typed prefix + adopted text) ≤ the split pin, topped up with
   * execution-verified synthetic vocabulary pairs.
   */
  suggestDataset(
    opts: { limit?: number; splitSeq?: number } = {},
  ): Promise<Schemas["SuggestDatasetResponse"]> {
    return this.request("GET", "/v1/models/suggest-dataset", {
      query: { limit: opts.limit, split_seq: opts.splitSeq },
    });
  }

  /**
   * The extractor fine-tune's training feed: EPISODE transcripts joined to
   * the facts the observe pipeline committed from them.
   */
  extractorDataset(
    opts: { limit?: number; splitSeq?: number } = {},
  ): Promise<Schemas["ExtractorDatasetResponse"]> {
    return this.request("GET", "/v1/models/extractor-dataset", {
      query: { limit: opts.limit, split_seq: opts.splitSeq },
    });
  }

  /**
   * Promote a finished `extractor_lora` training run: gated on held-out fact
   * F1, recorded as a WS9 `kind=extractor` run whose adapter resident
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
   * exactness, recorded as a WS9 `kind=planner` run whose adapter `/v1/ask`
   * then serves.
   */
  promotePlanner(opts: {
    runId: string;
    allowRegression?: boolean;
  }): Promise<unknown> {
    return this.request("POST", "/v1/models/promote-planner", {
      query: { run_id: opts.runId, allow_regression: opts.allowRegression },
    });
  }

  // --- search ---

  /** Full semantic hybrid search from a request body (`POST /v1/graph/search`). */
  graphSearch(
    body: Schemas["SemanticGraphSearchRequest"],
  ): Promise<Schemas["SemanticGraphSearchResponse"]> {
    return this.request("POST", "/v1/graph/search", { body });
  }

  /** Reciprocal-rank-fusion across sub-queries. */
  multiSearch(
    body: Schemas["HybridMultiSearchRequest"],
  ): Promise<Schemas["HybridMultiSearchResponse"]> {
    return this.request("POST", "/v1/search/multi", { body });
  }

  /**
   * Grounded prefix completion from the index vocabulary + ontology. Optionally
   * narrow relation completions by a type-signature `context` (WS10) — a type
   * pair that admits a single relation flags `signature_forced`.
   */
  suggest(
    body: Schemas["SearchSuggestRequest"],
  ): Promise<Schemas["SearchSuggestResponse"]> {
    return this.request("POST", "/v1/search/suggest", { body });
  }

  /**
   * Snap free text to the nearest real vocabulary item (WS11). Embedding cosine
   * on a managed graph, else lexical; never fabricates a term.
   */
  resolveTerm(
    body: Schemas["ResolveTermRequest"],
  ): Promise<Schemas["ResolveTermResponse"]> {
    return this.request("POST", "/v1/search/resolve-term", { body });
  }

  /**
   * Ground a natural-language question to the graph's real vocabulary, retrieve
   * against the pinned snapshot, and answer with citations (WS12, `/v1/ask`).
   */
  ask(body: Schemas["AskRequest"]): Promise<Schemas["AskResponse"]> {
    return this.request("POST", "/v1/ask", { body });
  }

  /**
   * Name the relation between two entities (`/v1/decode`): the DB narrows the
   * candidates to the type pair's admissible relations (WS10), answers alone
   * when the pair forces a single relation, and otherwise decodes it with the
   * graph-native fine-tuned model — the "DB narrows, cheap model decodes" call.
   */
  decode(body: Schemas["DecodeRequest"]): Promise<Schemas["DecodeResponse"]> {
    return this.request("POST", "/v1/decode", { body });
  }

  /**
   * Report which completion mechanisms will carry on this graph (WS13):
   * signature sparsity, name semantics, sampled narrowing recall, and a
   * narrow / narrow+finetune / lexical-first recommendation.
   */
  groundability(
    opts: { sample?: number } = {},
  ): Promise<Schemas["GroundabilityReport"]> {
    return this.request("GET", "/v1/graph/groundability", {
      query: opts.sample != null ? { sample: String(opts.sample) } : undefined,
    });
  }

  /**
   * Append relevance labels for a set of search results — how Little Big Brain
   * gathers customer-specific qrels. Grade results (3 ideal/good, 1 partial,
   * 0 bad), referencing the search response's `search_id` so labels tie back to
   * that ranking. Stored apart from customer facts and exported via
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

  /** BM25 search. */
  fullTextSearch(
    body: Schemas["FullTextSearchRequest"],
  ): Promise<Schemas["FullTextSearchResponse"]> {
    return this.request("POST", "/v1/search/full-text", { body });
  }

  /** ANN/vector search. */
  embeddingSearch(
    body: Schemas["EmbeddingSearchRequest"],
  ): Promise<Schemas["EmbeddingSearchResponse"]> {
    return this.request("POST", "/v1/search/embedding", { body });
  }

  // --- traversal ---

  /** Bounded k-hop graph traversal. */
  traverse(
    body: Schemas["TraverseRequest"],
  ): Promise<Schemas["TraverseResponse"]> {
    return this.request("POST", "/v1/graph/traverse", { body });
  }

  /** Resolve a query to seed entities, then return bounded paths. */
  semanticTraverse(
    body: Schemas["SemanticTraverseRequest"],
  ): Promise<Schemas["SemanticTraverseResponse"]> {
    return this.request("POST", "/v1/graph/semantic-traverse", { body });
  }

  /** Ranked incoming/outgoing neighborhood for a graph entity. */
  entityNeighborhood(opts: {
    id?: string;
    type?: string;
    name?: string;
    relations?: string[];
    asOf?: string;
  }): Promise<Schemas["EntityNeighborhoodResponse"]> {
    return this.request("GET", "/v1/graph/entity/neighborhood", {
      query: {
        id: opts.id,
        type: opts.type,
        name: opts.name,
        relations: opts.relations?.join(","),
        as_of: opts.asOf,
      },
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
   * Paged edge listing. Scope to one node with `id` (or `type`+`name`) and a
   * `direction` (`out`/`in`/`both`) to walk **every** edge of a high-degree node
   * — `entityDetail` returns the full set but is awkward to page; this carries
   * `offset`/`limit` and reports `total_count`. Optional `relation`/`q` filters
   * and an `asOf`/`asOfCommitSeq` snapshot pin. Each row carries `valid_time`, so
   * the page is enough to reconstruct a per-edge timeline.
   */
  graphEdges(
    opts: {
      id?: string;
      type?: string;
      name?: string;
      direction?: "out" | "in" | "both";
      relation?: string;
      q?: string;
      limit?: number;
      /** Opaque cursor from a previous page's `next_cursor`. */
      cursor?: string | number;
      /** @deprecated Legacy alias for `cursor` (still accepted by the server). */
      offset?: number;
      asOf?: string;
      asOfCommitSeq?: number;
    } = {},
  ): Promise<ListResponse<Schemas["GraphEdgeRow"]>> {
    return this.request("GET", "/v1/graph/edges", {
      query: {
        id: opts.id,
        type: opts.type,
        name: opts.name,
        direction: opts.direction,
        relation: opts.relation,
        q: opts.q,
        limit: opts.limit,
        cursor: opts.cursor,
        offset: opts.offset,
        as_of: opts.asOf,
        as_of_commit_seq: opts.asOfCommitSeq,
      },
    });
  }

  /**
   * Page through every row of a list endpoint, following `next_cursor` until
   * exhausted. Pass a fetcher that takes a cursor and returns a
   * {@link ListResponse}:
   * ```ts
   * for await (const e of client.listAll((cursor) =>
   *   client.entities.list({ cursor, fields: "title" }))) { … }
   * ```
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

  /** SHACL-style shape/pattern query. */
  shacl(
    body: Schemas["ShaclQueryRequest"],
  ): Promise<Schemas["ShaclQueryResponse"]> {
    return this.request("POST", "/v1/query/shacl", { body });
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
  ): Promise<Schemas["SparqlSelectResponse"]> {
    return this.request("POST", "/v1/query/sparql", { body });
  }

  /** SPARQL 1.1 query from text (SELECT/ASK) over the live graph; `results` is SPARQL 1.1 Query Results JSON. */
  sparqlText(
    body: Schemas["SparqlTextRequest"],
  ): Promise<Schemas["SparqlTextResponse"]> {
    return this.request("POST", "/v1/query/sparql-text", { body });
  }

  /**
   * Run a SPARQL 1.1 text query and return parsed results — the ergonomic
   * complement to {@link sparqlText} (which hands back the raw results string).
   * Returns `{ vars, boolean, bindings, rows }` via {@link parseSparqlResults}:
   * `rows` is the bindings flattened to `{ variable: lexicalValue }`, `boolean`
   * is the ASK answer (or `null` for a SELECT).
   */
  async sparqlRows(body: Schemas["SparqlTextRequest"]): Promise<SparqlResults> {
    return parseSparqlResults(await this.sparqlText(body));
  }

  /**
   * Basic-graph-pattern query with group-graph-pattern combinators
   * (UNION / OPTIONAL / MINUS / EXISTS / NOT EXISTS) folded over the base
   * patterns. The complement to {@link sparql}: this route carries the
   * combinators (but not FILTER/aggregation), so use it when a query needs an
   * optional/union/negated leg rather than a grouped aggregate.
   */
  analytics(
    body: Schemas["AnalyticQueryRequest"],
  ): Promise<Schemas["AnalyticQueryResponse"]> {
    return this.request("POST", "/v1/query/analytics", { body });
  }

  /**
   * Run inference rules (SHACL-AF `sh:TripleRule` shape) to a bounded fixpoint
   * and return the derived edges as a **preview** — derived facts are never
   * written to the asserted graph. Each rule is a BGP `body`/`where` plus a
   * `head` triple template instantiated per binding.
   */
  infer(
    body: Schemas["InferenceRunRequest"],
  ): Promise<Schemas["InferenceRunResponse"]> {
    return this.request("POST", "/v1/inference/run", { body });
  }

  /**
   * Define (replace) the versioned rule set stored on the scoped graph branch.
   * The stored set is what SHACL `include_derived` and `infer` use when a
   * request carries no inline rules. Returns the new `rules_version`.
   */
  defineRules(
    body: Schemas["RuleSetDefineRequest"],
  ): Promise<Schemas["RuleSetDefineResponse"]> {
    return this.request("POST", "/v1/inference/rules", { body });
  }

  /** The rule set stored on the scoped graph branch (version + rules). */
  graphRules(): Promise<Schemas["RuleSet"]> {
    return this.request("GET", "/v1/inference/rules");
  }

  /**
   * Stage G — derive edges from calibrated retrieval matches (preview): each
   * candidate scored `P >= threshold` becomes a derived edge `(anchor, relation,
   * matched)` with a typed `Retrieval` provenance leaf. Pass either explicit
   * `candidates` or a `query` the server runs as BM25 entity retrieval.
   */
  retrievalPremises(
    body: Schemas["RetrievalPremiseRequest"],
  ): Promise<Schemas["RetrievalPremiseResponse"]> {
    return this.request("POST", "/v1/inference/retrieval-premises", { body });
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
   * {@link SchemaNamespace.audit}, this needs no published shape bundle: the
   * shapes come from the ontology itself. See the `decoration_status` catalog on
   * {@link ontologyView} for which decorations are enforced.
   */
  ontologyConformance(): Promise<Schemas["SchemaAuditReport"]> {
    return this.request("GET", "/v1/ontology/conformance");
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

  /** Define the active ontology before the scoped graph's first commit. */
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

  // --- index lifecycle ---

  /**
   * Build default ANN + BM25 indexes. With `{ background: true }` the build
   * runs detached on the server and the call returns immediately — use it for
   * large corpora whose synchronous build would exceed a fronting gateway's
   * timeout (a 504), then poll `metadata()` for completion.
   */
  indexBuild(opts: { background?: boolean } = {}): Promise<unknown> {
    return this.request("POST", "/v1/index/build", {
      query: { background: opts.background || undefined },
    });
  }

  /**
   * Build BM25, ANN/vector, and adjacency index families. With
   * `{ background: true }` the build runs detached on the server and the call
   * returns immediately — use it for large corpora whose synchronous build would
   * exceed a fronting gateway's timeout, then poll `metadata()` for completion.
   */
  indexRun(opts: { background?: boolean } = {}): Promise<unknown> {
    return this.request("POST", "/v1/index/run", {
      query: { background: opts.background || undefined },
    });
  }

  /** Append a BM25 delta segment for the unindexed WAL tail. */
  indexDelta(): Promise<Schemas["IndexDeltaResponse"]> {
    return this.request("POST", "/v1/index/delta");
  }

  /** Preview or delete superseded persisted index runs. */
  indexGc(
    opts: { keepRuns?: number; dryRun?: boolean } = {},
  ): Promise<Schemas["IndexGcResponse"]> {
    return this.request("POST", "/v1/index/gc", {
      query: { keep_runs: opts.keepRuns, dry_run: opts.dryRun },
    });
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

  /** Graph footprint, WAL tail, and index coverage. */
  metadata(): Promise<Schemas["GraphMetadataResponse"]> {
    return this.request("GET", "/v1/graph/metadata");
  }

  /** Graph counts and type/relation buckets. */
  summary(): Promise<Schemas["GraphSummaryResponse"]> {
    return this.request("GET", "/v1/graph/summary");
  }

  /** List the graphs (and branches) under the scoped tenant. */
  listGraphs(): Promise<Schemas["GraphListResponse"]> {
    return this.request("GET", "/v1/graphs");
  }

  // --- database admin ---

  /** Create a database stack and return its one-time stack API key. */
  adminCreateStack(
    body: LbbAdminStackCreateRequest,
  ): Promise<LbbAdminStackResponse> {
    return this.request("POST", "/api/admin/stacks", { body });
  }

  /** Inspect a database stack without returning secret key material. */
  adminStack(slug: string): Promise<LbbAdminStackResponse> {
    return this.request("GET", "/api/admin/stacks", { query: { stack: slug } });
  }

  /** Rotate a database stack key and return the new one-time API key. */
  adminRotateStackKey(slug: string): Promise<LbbAdminStackResponse> {
    return this.request("POST", "/api/admin/stacks/rotate-key", {
      query: { stack: slug },
    });
  }

  /** Delete a database stack after confirming the slug. */
  adminDeleteStack(slug: string): Promise<LbbAdminStackDeleteResponse> {
    return this.request("DELETE", "/api/admin/stacks", {
      query: { stack: slug, confirm: slug },
    });
  }

  /**
   * Mint a short-lived `lbb_ses_…` session token for an account. A trusted
   * co-located service uses it (with `?stack=<slug>`) to call the data plane on
   * the account's behalf without handling the stack's mode-bearing stack key.
   */
  adminMintSession(
    accountId: string,
    ttlSeconds?: number,
  ): Promise<LbbAdminSessionResponse> {
    const body: Record<string, unknown> = { account_id: accountId };
    if (ttlSeconds !== undefined) body.ttl_seconds = ttlSeconds;
    return this.request("POST", "/api/admin/sessions", { body });
  }

  /** Customer-visible activity for one database stack. */
  adminStackActivity(
    slug: string,
    window: LbbStackActivityWindow = "24h",
  ): Promise<LbbStackActivityResponse> {
    return this.request("GET", "/api/admin/stacks/activity", {
      query: { stack: slug, window },
    });
  }

  /** Activity for the stack selected by the bearer stack key or session. */
  stackActivity(
    window: LbbStackActivityWindow = "24h",
  ): Promise<LbbStackActivityResponse> {
    return this.request("GET", "/v1/stack/activity", { query: { window } });
  }
}
