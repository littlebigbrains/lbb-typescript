# Changelog

All notable changes to the `@littlebigbrain/client` package are documented here.

## 0.11.1 (2026-08-22)

- Treat an absent first published generation as normal asynchronous build
  progress instead of retrying the metadata request until the generic retry
  budget is exhausted.
- Give publication waiters their own explicit deadline and continue through
  retryable metadata responses, including `429`, without multiplying nested
  retry loops.
- Determine readiness from the published generation and served RDF watermark,
  so RDF-only production deployments do not wait for removed search families.

## 0.11.0 (2026-08-21)

Breaking removal of every non-SPARQL query surface. The server now serves
SPARQL as its only query surface, so the client keeps only the SPARQL methods.

- Remove the search family: `search.hybrid`, `search.multi`, `search.fullText`,
  `search.vector`, `graphSearch`, `multiSearch`, `fullTextSearch`,
  `embeddingSearch`, `suggest`, `resolveTerm`, and `vocabExport`.
- Remove the managed embedding family from both `LbbClient` and
  `graph(...)`: `embeddingConfig`, `embeddingModels`, `setEmbeddingModel`,
  `setEmbeddingConfig`, `submitEmbeddingBackfill`, `embeddingBackfillJob`,
  `cancelEmbeddingBackfill`, `backfillEmbeddings`, and `promoteEmbedding`.
- Remove `decode`, `groundability`, `analytics`, and `query.analytics`.
- Remove the whole `context` namespace (`suggest`, `resolve`, `decode`,
  `groundability`) and the exported `ContextNamespace` class.
- Remove the `HybridSearchOptions` option type and the `SearchRequest`,
  `SearchResponse`, and `SearchResult` type aliases.
- Keep `query.structured`, `query.sparql`, `query.sparqlRaw`, `sparql`,
  `sparqlText`, and `sparqlRows`. Keep the temporal reads (`currentState`,
  `history`, `transitions`, `why`), the entity reads, relevance feedback, and
  every write, ontology, schema, branch, and operations surface.

## 0.10.0 (2026-08-21)

Breaking removal of the standalone graph-traversal surface.

- Remove `traverse`, `semanticTraverse`, and their request/response models.
- Entity neighborhoods and class samples now read the published Base family.
- Use SPARQL 1.1 property paths for exact multi-hop graph queries; semantic
  search continues to expose bounded graph-path evidence internally.

RDF import.

- `importRdf`'s server-side `batch` default changed from 1,000 statements to the
  1,000,000 cap — one internal commit per fully-buffered request. Pass an
  explicit `batch` to opt back into smaller internal commits.
- `importRdf` accepts `build`; pass `build: false` on every chunk except the
  last of a chunked bulk stream to defer the published-generation enqueue so the
  derived families build once at the final head.
- Drop the phantom `publish` query param from the generated import operations —
  the server never read it.

## 0.9.1

- `submitImport` now rejects an empty iterable before issuing the import POST,
  so a producer bug cannot create an opaque empty-upload server failure.
- The one-record preflight preserves streaming and one-shot iterator semantics.

## 0.9.0

Durable, asynchronous NDJSON imports.

- `submitImport` streams sync or async iterable input without constructing one
  complete body and requires an explicit idempotency key.
- `getImportJob`, `cancelImportJob`, and `waitForImportJob` expose durable
  grouped-commit progress and terminal state.
- Durable methods require the server's `durable_import_jobs_v1` capability and
  never silently fall back to the synchronous import route.

## 0.8.1

Adjacency-backed Explorer reads now report the coherent adjacency coverage
watermark instead of failing while a published run trails graph head. The
generated `SnapshotView` contract documents `stale_reason:
"adjacency_coverage"` and the append-safe WAL-prefix semantics.

## 0.8.0

Eventual-by-default read consistency and the read-your-writes floor.

### ⚠️ Behavior change — default read consistency is now `eventual`

The server's default read consistency flipped from `strong` to `eventual`
(server-side change; this SDK forwards `consistency` unchanged). A read that
does not specify `consistency` now serves the last **published** index/dataset
state at its watermark (surfaced on `snapshot.served_at_seq` with
`stale_reason: "eventual_consistency"`) rather than folding the un-indexed WAL
tail up to head. **Code that relied on the implicit `strong` default for
read-after-write must either pass `strong` explicitly or — preferably — use the
new `minIndexedSeq` floor below.**

### Read-your-writes floor (`minIndexedSeq`)

- Read methods on the `search`, `query`, and summary surfaces accept
  `consistency` and `minIndexedSeq` options (camelCase; forwarded as
  `consistency` / `min_indexed_seq`). Take the committed sequence a write
  returned and read with `minIndexedSeq` set to it:

  ```ts
  const { commitSeq } = await client.commit(triplets);
  const rows = await client.query.sparql(
    { query: "SELECT ?s ?p ?o WHERE { ?s ?p ?o }" },
    { minIndexedSeq: commitSeq },
  );
  ```

  Under the eventual default, a floor not yet covered by published state throws
  a retryable `read_your_writes_pending` `429` (with `Retry-After`) so a sync
  pipeline can poll for its own write instead of reading a stale answer.
- **Committed-sequence surfacing.** `commit`, `commitDryRun`, `import`, and
  `importRdf` results now carry a convenience `commitSeq` alongside the raw
  response fields, so the write→floor→read loop reads naturally.
- **Client-level default.** `new LbbClient({ …, defaultConsistency: "strong" })`
  sets the consistency used when a call omits it (and is carried across
  `withScope`); a per-call `consistency` still wins.

## 0.6.1

Composite stack endpoints: hosted stacks are addressed by their own
`endpoint_url`, and a misroute is surfaced with actionable guidance instead of
being retried away.

### Endpoints

- **`baseUrl` is required.** For hosted use it must be the exact `endpoint_url`
  shown on the stack's Connect page
  (`https://<tenant-short-id>--<stack-slug>.db.eu.littlebigbrain.com`). Graph and
  branch stay client scope parameters; they are not encoded in the hostname. An
  empty `baseUrl` now throws at construction instead of silently defaulting.
- **Actionable routing hints.** `LbbError.endpointHint` carries copy-paste
  guidance for the composite-endpoint error codes `stack_endpoint_required`
  (HTTP `421`) and `stack_endpoint_mismatch` (HTTP `403`).

### Retry behavior

- **`421`/`403` are terminal.** Misdirection (`421`) and authorization (`403`)
  failures surface immediately — they were never retryable by status (only
  `429`/`5xx` are), and a test now pins that so the actionable `endpointHint` is
  never masked by retries.

## 0.6.0

Honest, deadline-bounded retries — so server-side backpressure stays invisible
to your code under sustained overload, not just a single blip.

### Server contract

- **Pressure ⇒ 429.** The server now returns `429` for every retryable
  pressure/throttle class, including the graph-scoped `ingest_busy` code (WAL
  backpressure, commit contention, busy full build) that previously came back as
  `503`. `storage_degraded` (a genuine storage-dependency outage) stays `503`.
  The client already retried both `429` and `5xx`, so this is **not
  wire-breaking** — existing retry behavior is unchanged.

### Retry behavior

- **Honors the server's typed body verdict.** A terminal error marked
  `retryable: false` in the body (e.g. an exhausted quota) is now surfaced
  immediately instead of being retried, and the body's `retry_after_seconds`
  hint is used for the backoff when no `Retry-After` header is present.
- **Full-jitter exponential backoff** (`fullJitterBackoffMs`) replaces the old
  linear delay, so many clients recovering from one outage no longer retry in
  lockstep.
- **Deadline-based retry budget.** New `retryBudgetMs` (default `60_000`, also a
  per-request `CallOptions` override) is the binding limit: idempotent requests
  keep retrying until the budget elapses, so a multi-second advertised
  `Retry-After` window is honored. `maxRetries` remains a secondary cap and its
  default is raised `2 → 6`.
- **Naked load-balancer `5xx`** (a bare `502/503/504` with an HTML body and no
  error envelope) is explicitly treated as a transient, retryable
  server-busy-equivalent with backoff.
- **Absorbed retries are observable.** New optional `onRetry` client callback
  receives an `LbbRetryEvent` (`attempt`, `status`, `errorCode`, `delayMs`,
  `elapsedMs`) before each backoff sleep; `onResponse` and `RawLbbResponse`
  continue to report final `attempts` / `retryCount` / `elapsedMs`.

All additions are backward-compatible: new optional options (`retryBudgetMs`,
`onRetry`) and a new exported `LbbRetryEvent` type. `retryDelayForAttempt` (an
internal helper, never part of the documented surface) is replaced by
`retryDelayMs` + `fullJitterBackoffMs`.
