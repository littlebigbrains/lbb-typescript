import type { components } from "./schema.js";

/** Request/response types, generated from the committed OpenAPI spec. */
export type Schemas = components["schemas"];

// Friendly aliases for the types developers reach for most often. The complete
// generated contract remains available through `Schemas` for less common APIs.
export type SearchRequest = Schemas["SemanticGraphSearchRequest"];
export type SearchResponse = Schemas["SemanticGraphSearchResponse"];
export type SearchResult =
  | SearchResponse["entities"][number]
  | SearchResponse["assertions"][number]
  | SearchResponse["concepts"][number]
  | SearchResponse["observations"][number]
  | SearchResponse["paths"][number];
export type Entity = Schemas["EntityExplorerRow"];
export type EntitySelector = Schemas["EntitySelector"];
export type GraphSummary = Schemas["GraphSummaryResponse"];
export type GraphMetadata = Schemas["GraphMetadataResponse"];
export type Snapshot = Schemas["SnapshotView"];
export type CommitRequest = Schemas["TripletCommitFile"];
export type CommitResponse = Schemas["GraphCommitResponse"];
export type AskRequest = Schemas["AskRequest"];
export type AskResponse = Schemas["AskResponse"];
export type SchemaView = Schemas["SchemaBundleView"];

/**
 * The unified list-response envelope returned by every collection read
 * (`/v1/graph/entities`, `/v1/graph/edges`, `/v1/graph/observations`): the rows
 * in `data`, plus `next_cursor` (echo back as `cursor` for the next page) and
 * the pre-page `total_count`. Walk pages with {@link LbbClient.listAll}.
 */
export interface ListResponse<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
  snapshot: Schemas["SnapshotView"];
  total_count: number;
}

/**
 * A flat `{ field: value }` property map. Values are coerced to each field's
 * declared type server-side, so a string like `"2026-06-26"` lands in a
 * `date_time` field and `"52"` in an `i64` field. The verbose
 * `Schemas["PropertyInput"][]` form is also accepted.
 */
export type FlatProperties = Record<string, string | number | boolean>;

/** A single entity-properties record for commit/import, with flat or verbose properties. */
export type EntityPropertiesLine = {
  type: string;
  name: string;
  /** Optional stable external key; identity becomes `(type, key)`. */
  key?: string;
  properties: FlatProperties | Schemas["PropertyInput"][];
};

/** One bulk-import line: a triplet, or an entity-properties record. */
export type ImportLine = Schemas["TripletInput"] | EntityPropertiesLine;

export interface RdfImportOptions {
  format?: "ntriples" | "turtle" | "nquads" | "trig";
  baseIri?: string;
  graphUri?: string;
  /** Stable document scope for blank labels across chunks; omit for legacy stable labels. */
  blankNodeScope?: string;
  batch?: number;
  strict?: boolean;
  observedAt?: string;
  resourceType?: string;
  edgeIdempotency?: "append" | "skip_unchanged";
  idempotencyKey?: string;
}

export interface RdfExportOptions {
  format?: "turtle" | "ntriples" | "trig" | "nquads";
  maxTriples?: number;
  asOfValidTime?: string;
  asOfCommitSeq?: number;
  entailment?: "subclass" | "none";
  reason?: boolean;
}

export type AttributeFilterOp = "eq" | "ne" | "lt" | "le" | "gt" | "ge";

export type AttributeFilterValue =
  | string
  | number
  | boolean
  | { dateTime: string }
  | { entity: Schemas["EntitySelector"] };

export interface AttributeFilter {
  /** Query variable whose typed property should be compared. Defaults to the first bound pattern variable. */
  var?: string;
  /** Ontology property field name, e.g. `status`, `score`, or `committed_at`. */
  field: string;
  /** Comparison operator. Defaults to `eq`. */
  op?: AttributeFilterOp;
  value: AttributeFilterValue;
}

export interface EntityAttributeFilterOptions {
  /** Relation patterns that bind the entity variable(s) before attribute filters run. */
  patterns: Schemas["AnalyticTriplePattern"][];
  /** One or more typed-property comparisons. */
  where: AttributeFilter | AttributeFilter[];
  /** Additional raw structured-SPARQL filters to AND with `where`. */
  filters?: Schemas["SparqlFilter"][];
  select?: string[];
  limit?: number;
  offset?: number;
  asOfValidTime?: string;
  asOfCommitSeq?: number;
  orderBy?: Schemas["SparqlOrderBy"][];
  reason?: boolean;
  maxSolutions?: number;
  maxObjectReads?: number;
  maxFetchedBytes?: number;
}

/**
 * Minimal structural shape of `fetch`, so the client depends on neither the DOM
 * lib nor a specific runtime. Native `fetch` (Node 18+, browsers, workers)
 * satisfies it; tests can pass a fake.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** One term in a SPARQL result binding (the standard results-JSON term object). */
export interface SparqlTerm {
  type: "uri" | "literal" | "bnode" | "typed-literal";
  value: string;
  datatype?: string;
  "xml:lang"?: string;
}

/** The standard SPARQL 1.1 Query Results JSON document. */
export interface SparqlResultsJson {
  head: { vars?: string[]; link?: string[] };
  results?: { bindings: Record<string, SparqlTerm>[] };
  boolean?: boolean;
}

/** Parsed SPARQL results: the head vars, the ASK boolean (or null), the raw
 * typed bindings, and the bindings flattened to `{ variable: lexicalValue }`. */
export interface SparqlResults {
  vars: string[];
  boolean: boolean | null;
  bindings: Record<string, SparqlTerm>[];
  rows: Record<string, string>[];
}

/**
 * Parse a {@link Schemas.SparqlTextResponse} (whose `results` field carries the
 * SPARQL Results document as a JSON *string*) into typed bindings plus flat
 * `{ variable: lexicalValue }` rows — the form most callers want, so they never
 * have to `JSON.parse` and zip `head.vars` with binding values by hand.
 */
export function parseSparqlResults(
  response: Schemas["SparqlTextResponse"],
): SparqlResults {
  const doc = JSON.parse(response.results) as SparqlResultsJson;
  const vars = doc.head?.vars ?? [];
  if (typeof doc.boolean === "boolean") {
    return { vars, boolean: doc.boolean, bindings: [], rows: [] };
  }
  const bindings = doc.results?.bindings ?? [];
  const rows = bindings.map((binding) =>
    Object.fromEntries(
      Object.entries(binding).map(([name, term]) => [name, term.value]),
    ),
  );
  return { vars, boolean: null, bindings, rows };
}

export function firstPatternVariable(
  patterns: Schemas["AnalyticTriplePattern"][],
): string {
  for (const pattern of patterns) {
    if ("var" in pattern.subject) return pattern.subject.var;
    if ("var" in pattern.object) return pattern.object.var;
  }
  return "entity";
}

function attributeFilterValue(
  value: AttributeFilterValue,
): Schemas["SparqlValue"] {
  if (typeof value === "boolean") return { bool: value };
  if (typeof value === "number")
    return Number.isInteger(value) ? { i64: value } : { f64: value };
  if (typeof value === "string") return { str: value };
  if ("dateTime" in value) return { date_time: value.dateTime };
  return { entity: value.entity };
}

export function attributeFilter(
  filter: AttributeFilter,
  defaultVar: string,
): Schemas["SparqlFilter"] {
  return {
    compare: {
      op: filter.op ?? "eq",
      left: {
        property: { var: filter.var ?? defaultVar, field: filter.field },
      },
      right: { value: attributeFilterValue(filter.value) },
    },
  };
}

export interface LbbClientOptions {
  /** Base URL of the little big brain server, e.g. `https://db.eu.littlebigbrain.com`. */
  baseUrl: string;
  /** Stack API key (`lbb_sk_test_…` / `lbb_sk_live_…`) or single-mode token. */
  apiKey?: string;
  /** Graph name (sent as `?graph=`; server default is `main`). */
  graph?: string;
  /** Branch name (sent as `?branch=`; server default is `main`). */
  branch?: string;
  /**
   * Stack slug (sent as `?stack=`). Needed only with a session-token `apiKey`
   * (`lbb_ses_…`), which authorizes an account rather than a single stack; a
   * stack API key (`lbb_sk_test_…` / `lbb_sk_live_…`) already fixes the stack and ignores this.
   */
  stack?: string;
  /** Override the fetch implementation (defaults to the global `fetch`). */
  fetch?: FetchLike;
  /** API version header sent on every request. Defaults to the beta reset contract. */
  apiVersion?: string;
  /** Retry count for 429/5xx responses and network failures. Defaults to 2. */
  maxRetries?: number;
  /** Base delay between retries. Defaults to 100ms. Tests can set 0. */
  retryDelayMs?: number;
  /** Per-attempt timeout, including response-body reads. Defaults to 120 seconds; 0 disables it. */
  timeoutMs?: number;
  /** Called immediately before each network attempt. Bodies and credentials are never included. */
  onRequest?: (event: LbbRequestEvent) => void;
  /** Called once after the final HTTP response. Bodies and credentials are never included. */
  onResponse?: (event: LbbResponseEvent) => void;
}

export interface LbbRequestEvent {
  method: string;
  url: string;
  attempt: number;
  maxAttempts: number;
  idempotencyKey?: string;
}

export interface LbbResponseEvent {
  method: string;
  url: string;
  status: number;
  requestId?: string;
  attempts: number;
  retryCount: number;
  elapsedMs: number;
}

export type LbbStackActivityWindow = "1h" | "4h" | "12h" | "24h";

export interface LbbStackActivityResponse {
  ok: true;
  stack: {
    slug: string;
    name?: string;
  };
  window: {
    range: LbbStackActivityWindow;
    from_micros: number;
    to_micros: number;
    bucket_seconds: number;
    freshness_seconds: number;
  };
  totals: {
    requests: number;
    errors: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
    p99_latency_ms: number;
    storage_read_ops: number;
    storage_read_bytes: number;
    storage_write_ops: number;
    storage_write_bytes: number;
    index_read_ops: number;
    index_read_bytes: number;
  };
  details: {
    total_bucket_count: number;
    active_bucket_count: number;
    error_rate: number;
    storage_total_ops: number;
    storage_total_bytes: number;
    non_index_storage_read_ops: number;
    non_index_storage_read_bytes: number;
    index_read_share: number;
    first_activity_bucket_start_micros?: number;
    last_activity_bucket_start_micros?: number;
  };
  series: Array<{
    bucket_start_micros: number;
    requests: number;
    errors: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
    p99_latency_ms: number;
    storage_read_ops: number;
    storage_read_bytes: number;
    storage_write_ops: number;
    storage_write_bytes: number;
    index_read_ops: number;
    index_read_bytes: number;
  }>;
  routes: Array<{
    family: string;
    requests: number;
    errors: number;
    error_rate: number;
    request_share: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
    p99_latency_ms: number;
  }>;
  storage: Array<{
    family: string;
    read_ops: number;
    read_bytes: number;
    write_ops: number;
    write_bytes: number;
    total_ops: number;
    total_bytes: number;
    op_share: number;
    byte_share: number;
  }>;
  partial: boolean;
}

export interface LbbErrorPayload {
  type?: string;
  code?: string;
  message?: string;
  param?: string | null;
  request_id?: string | null;
  doc_url?: string | null;
}

export interface RawLbbResponse<T> {
  data: T;
  status: number;
  requestId?: string;
  version?: string;
  headers?: { get(name: string): string | null };
  /** Total HTTP attempts, including the successful/final attempt. */
  attempts: number;
  /** Convenience alias for `attempts - 1`. */
  retryCount: number;
  /** Total wall-clock duration across attempts and retry delays. */
  elapsedMs: number;
}
