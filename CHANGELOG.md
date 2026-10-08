# Changelog

All notable changes to the `@littlebigbrain/client` package are documented here.

## 0.22.0 (2026-10-08)

- The `ModelJob` type gains `ask`: the checked answer of one question
  (model checks and the call log, #1107).
- New `models.trials` and `models.switches`: test another model on a use of
  a model on the graph (`ask`, `route`, `rerank`, `fit`, `label`) against
  the ground truth of its checked calls, then switch the use to it.
  `trials.options`, `create`, `list`, `get`, `call` and `stop` call
  `/v1/models/trials*`; `trials.wait(id, { until, onUpdate, timeoutMs })`
  reads the trial until it compared the checked calls (or ended).
  `switches.create({ trial })`, `list` and `revert(job)` call
  `/v1/models/switches*`. Also on `graph(name).models`. New type aliases
  `ModelTrial`, `ModelTrialReport`, `ModelTrialModel`, `ModelSwitch` and
  `ModelJob`.
- New `ontology.fitSources` for fit from text: `list`, `get`, `declare`,
  `preview`, `refresh` and `delete` call `/v1/ontology/fit-sources*`. A fit
  source names the properties of a class that hold text (transcripts,
  documents); the server reads every instance and files ontology change
  suggestions with verified quotes. `preview({ ..., propose: true })` runs
  the models on up to 3 instances without filing anything. New types
  `FitSource*` and `FitProposal*`.
- `query.ask` returns `chart`: how to draw `rows` (`kind` `bar`, `line`,
  `scatter` or `table`, and the columns `x`, `y` and `series`), or `null`.
  The server checked the hint against the rows. New types
  `QueryAnswerChart` and `QueryAnswerChartKind`; `QueryAnswer` has `chart`,
  and so does the stream's `answer` event.

## 0.21.0 (2026-10-06)

Breaking: the server moved questions to `POST /v1/query/ask` and removed the
one-shot rewrite. `POST /v1/query/rewrite` answers 404. Every question now
runs the server's answer loop.

- Remove `query.rewrite` and `query.rewriteStream`. Use
  `query.ask(question, options)` and `query.askStream(question, options)`.
  Both call `POST /v1/query/ask`.
- `query.ask` answers in plain words by default. The model runs queries in a
  bounded loop, reads their rows, and answers. The result holds `answer` (the
  text, or `null` when the loop stopped first), `citations` (IRIs from the
  rows the loop read) and `steps`. `query` and `rows` are the query whose
  rows hold the answer.
- `mode` takes `"answer"` (the default) or `"route"`. `"route"` returns only
  the kind of question, from the router model. The `"rewrite"` mode is gone.
- Remove the `previous` option of `query.ask`: the loop corrects its own
  queries. The server answers `run`, `previous` and `mode: "rewrite"` with
  `400 invalid_ask_request`, which replaces `invalid_rewrite_request`.
- Rename `QueryAskResult.rewrite` to `QueryAskResult.response`.
- `query.ask` takes `includeGrounding`. The response then holds the graph
  description the models read, in `grounding.text`.
- Add `query.askStream(question, options)` with the options of `ask`. It
  yields `grounding`, `route`, a `step` per tool call, `answer`, and last
  `done` with the whole response. A second `route` comes when the loop chose
  another route. An `error` event throws the same `LbbError` as `ask`. The
  `query`, `run`, `rows` and `repair` events are gone.
- Rename the type `QueryRewriteStreamEvent` to `QueryAskStreamEvent`.
- `QueryRewriteHistory` loses `before` and `after`, and gains `key`,
  `changed` and `totals`. A comparison comes from the loop's `compare` step:
  `added`, `removed` and `changed` hold what differs, and
  `query.as_of_commit_seq` is the later point. `result` is absent for a
  comparison.
- The generated types drop `QueryRewriteStep`, `QueryRewritePoint`,
  `QueryRewriteQueryEvent`, `QueryRewriteRunEvent`, `QueryRewriteRowsEvent`
  and `QueryRewriteRepairEvent`. New types: `QueryAnswer`, `QueryAnswerStep`,
  `QueryAnswerTool`, `QueryAnswerStepEvent`. `QueryRewriteMode` is `answer` or
  `route`. `ModelJob` gains `answer`, the turns of the loop in the model call
  log. A `compare` step's `rows` counts the entries that differ.
- To run your own loop instead, use the four tools below with `query.sparql`.
- Add four tools for an app's own agent, none of which calls a model:
  `query.names({ text, limit })` (`POST /v1/query/names`) finds the entities
  a text names, with the candidates of each name, the one to prefer first;
  `query.describe({ question, classes, properties })`
  (`POST /v1/query/describe`) describes the classes and properties a
  question needs, with how many sampled instances hold each property and the
  values of small classes; `query.commitAt({ date } | { moment })`
  (`GET /v1/graph/commit-at`) finds the commit of a date; and
  `query.compare({ query, before, after, key })` (`POST /v1/query/compare`)
  runs one `SELECT` at two points and pairs the rows into `added`, `removed`
  and `changed`, with `totals` and a `cursor` for the next page.
- Evals ask a question again through the answer loop. The generated
  `EvalAskInput` drops `previous` and gains `timeline`. `EvalTrace` and
  `EvalVerdictDetail` gain `reply`: the loop's answer in words and the IRIs
  it cites (`QueryAnswer`).

## 0.20.0 (2026-10-05)

- The `search` report of a SPARQL query gains `rerank` and
  `timings.relevance_ms`, for a query with `search:rerank true`.
- Add `query.rewriteStream(body, opts)`. It sends `POST /v1/query/rewrite`
  with `Accept: text/event-stream` and yields one event per step: `grounding`,
  `route`, `query`, `run`, `rows` and `repair`. The last event, `done`, holds
  the same response as `query.rewrite`. The type of an event is
  `QueryRewriteStreamEvent`.
- An `error` event throws the same `LbbError` as `query.rewrite`. An error
  before the stream starts throws as `query.rewrite` does. The client never
  retries a stream, and it skips event names it does not know.
- Abort `opts.signal` to stop the request and the server's work. Leaving the
  loop early closes the response too. `timeoutMs` bounds the whole stream.
- A body that ends before `done` or `error` throws an error. A server without
  streams answers with JSON, and the stream then yields only `done`.
- Add `requestEventStream(method, path, opts)`, the low-level call that yields
  the server-sent events of one request. `FetchLike` responses may carry
  `body`, the stream it reads.
- `query.ask(question, { anchor })` sends entity IRIs the user picked, at
  most 10. The server reads each one, and the query uses the IRIs directly
  instead of matching their names.
- `query.ask` returns `linked`: the names of the question the server linked
  to entities (`text`, `iri`, `label`, `class`, `score`, `by`), for a "Did you
  mean …?". It also returns `anchors`, what the server read about each
  anchored IRI, with a `note` when an IRI is not in the graph.
- The generated types add `QueryRewriteRequest.anchor`,
  `QueryRewriteResponse.linked` and `anchors`, `QueryRewriteLink`,
  `QueryRewriteAnchor`, `QueryLinkMethod`, `grounding.names`, and
  `timings.link_ms` and `anchor_ms`.
- Add `query.rewriteProfile()` and `query.setRewriteProfile(body, { dryRun })`
  for the graph's rewrite profile: notes and up to 20 worked examples the
  rewriter reads for every question. Pass the `version` you read as
  `expected_version`; when another write came first, the call throws
  `409 conflict`.
- The `grounding` of a rewrite gains `focus_classes`, `focus_properties` and
  `profile_version`.
- The `search` report of a SPARQL query gains `rerank` and
  `timings.relevance_ms`, for a query with `search:rerank true`.
- `query.ask(question, { timeline })` sends dated points that stand for the
  graph's commits (`{ date, as_of_commit_seq, label? }`, at most 200). A
  history question about a date then reads the commit of the latest point on
  or before it. Without a timeline the server reads the last commit written
  by the end of that day. `query.rewrite` takes `timeline` in its body.
- `query.ask` returns `history`: the date, the commit it resolved to
  (`as_of_commit_seq`) and how (`resolved_by`). A question that asks what
  changed runs at both points: `history.before` and `history.after` hold the
  two runs, and `history.added` and `history.removed` the rows that differ.
- The generated types add `QueryRewriteRequest.timeline`,
  `QueryRewriteTimelinePoint`, the new `QueryRewriteHistory` fields,
  `QueryHistoryResolution`, `QueryRewriteTerm`, and `point` on the `run`
  event (`QueryRewritePoint`).

## 0.19.0 (2026-10-04)

Adds the server features the client did not cover yet, questions in plain
words (the server turns a question into a SPARQL query), and the search
rerank.

- Parsed SPARQL results (`sparqlRows`, `query.sparql`, `parseSparqlResults`)
  gain `search`, `traceId`, `rowPage` and `nextCursor`. `search` reports how a
  `search:similarTo` pattern in the query ran: the plan, the hits asked for and
  bound, `complete` and the lag of the vectors. `traceId` names the eval trace
  of a query sent with `request`. Each field is present only when the server
  sends it.
- Add `query.update(text, opts)` for SPARQL Update on the `/update` endpoint.
  The server accepts `INSERT DATA`. The client sends an idempotency key, so a
  retry replays the write.
- Add `ontology.drafts` with `create()`, `get()`, `validate()`, `promote()`
  and `reject()` for the `/v1/ontology/drafts` routes. `promote()` sends an
  idempotency key.
- Add `trainSubmit(body, { idempotencyKey })` and `trainJob(jobId)` for the
  durable trainer jobs at `/v1/models/train-jobs`.
- Remove the deprecated `asOf` option of `entityDetail` and
  `entities.detail`. The server answers a valid-time `as_of` with 400. Use
  `asOfCommitSeq` to read a record at a past commit.
- `embeddings.search()` takes `rerank`: `true` orders the best hits by the
  managed rerank model (TypeSafe's Jev), and each hit carries its
  `relevance`; `false` keeps the similarity order. Without it the graph's
  search setting decides. The response has a `rerank` report.
- Add `embeddings.searchSettings()` and `setSearchSettings({ rerank })` for
  `GET` and `PUT /v1/search/settings`: rerank every search of the graph, or
  none.
- Add `query.rewrite(body, { consistency })` for `POST /v1/query/rewrite`. A
  router model selects the kind of query, and a rewriter model writes it from
  a description of the graph. With `run: true` the server also runs the query
  and returns the rows in `result`. Each call uses model tokens, so the client
  does not retry a failed call unless `retry` is set.
- Add `query.ask(question, options)`. It calls `rewrite` with `run: true` and
  returns the route, the query, the rationale, the parsed `rows` and `vars`,
  the `boolean` of an `ASK` query, the `snapshot`, the `error`, the eval
  `traceId`, and the whole `rewrite` response. Add the `QueryAskOptions` and
  `QueryAskResult` types.
- Add `checks` (also on `graph(name)`) for the model checks of a graph:
  `calls()` and `call(id)` read the log of the model calls LBB makes for its
  own work, `checkCall(id)` asks the judge to check one call now, `list()`
  reads a month of checks, `review(id, body)` agrees with the judge or
  corrects it, `summary()` sums a month per job and model, and `export()`
  returns a month of checks as parsed JSON lines. `checkCall` spends the
  platform's judge budget, so the client does not retry a failed call unless
  `retry` is set. Add the `ModelCallListOptions`, `ModelCheckListOptions` and
  `ModelCheckExportLine` types.
- A response of type `application/x-ndjson` parses to a list of the lines'
  values.
- `embeddings.setSearchSettings()` documents the merged request of
  `PUT /v1/search/settings`: `rerank`, `rerank_depth`, `blend` and
  `probe_factor`. A field left out keeps its value, and `null` sets it back
  to its default.
- Add `embeddings.searchTuning` with `start()`, `list()`, `get(id)` and
  `apply(id)` for the `/v1/search/tuning` routes. A session runs the graph's
  own searches with other settings and proposes the best. `start()` spends
  the judge budget and is not retried unless `retry` is set; `apply()` sets
  the same settings again on a retry.

## 0.18.0 (2026-10-03)

Adds `client.integrations`: hosted integrations for a developer's end
customers, one graph per customer, with Google Drive among the connectors.

- Add the `integrationsUrl` option, `https://api.littlebigbrain.com` by
  default. The integrations routes take the client's `apiKey`.
- Add `integrations.connectors()`, `create()`, `list()`, `get()`,
  `setCredentials()`, `setSettings()`, `sync()`, `pause()`, `resume()`,
  `delete()` and `erase()` for the `/v1/integrations/*` routes of
  `contracts/integrations-openapi.json`. `sync()` sends an `Idempotency-Key`;
  without `idempotencyKey` it makes one per call, so its retries queue one
  sync.
- Add `integrations.suggestions()`, `accept()` and `dismiss()` for a
  connection's ontology suggestions on the stack endpoint. `accept()` with
  `sync: true` then sends the connection a sync under the message id
  `sync-after-<suggestion id>`.
- `LbbError` reads the integrations API's error body: `code`, the message and
  `details`. `retryAfterSeconds` comes from the `Retry-After` header when the
  body gives no wait.
- Add `googleDrive.authorizeUrl()` and `googleDrive.exchangeCode()`: the
  Google consent URL and the code exchange a developer's server runs before
  it creates a `google_drive` connection. The exchange returns the
  connection's `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
  `GOOGLE_REFRESH_TOKEN`, and fails with a `GoogleOAuthError`.

## 0.17.0 (2026-10-02)

Adds the ontology starters (`crm`, `documents`, `work`).

- Add `ontology.starters` with `list()`, `get(id)`,
  `apply(id, { dryRun, expectedOntologyVersion })` and `update(id)` for the
  `/v1/ontology/starters` routes. A starter is a versioned base ontology
  (`crm`, `documents`, `work`); `list` and `get` answer for a graph that does
  not exist yet. Add the generated `OntologyStarter*` types.
- Add `starters`: the starters' classes, properties, relations and
  competency questions as typed constants with their SPARQL IRIs, for example
  `starters.crm.classes.Organization.iri` and
  `starters.crm.relations.WORKS_AT.inverseIri`.
- A suggestion's `change` holds up to 128 operations (was 64).
- `LbbError.details` holds the per-item reasons of a refusal, for example
  the `conflicts` of `409 starter_conflict`.

## 0.16.0 (2026-10-02)

Breaking removal of `ontology.induce` and `induceOntology`, whose route is
removed from the server.

- A workflow value JSON cannot hold (`undefined`, a function, a symbol, a
  bigint, a non-finite number) still fails the turn for good, and the error
  now says where it is: `state`, `result`, `continuation`, `message`,
  `signal "<name>"` or `step "<key>"`, with the path to the field, such as
  `continuation.message.full is undefined`.
- Add `modelActivity({ month })` for `GET /v1/models/activity`. It reads what
  each managed model did for the stack in one month (`yyyy-mm`, UTC; the
  current month by default). The answer holds totals, rows by day and rows
  by graph per feature and model, the months with activity, and the model
  each feature uses now. Add the generated `ModelActivityResponse` types.
- `WorkflowInstance` gains `history_pruned_through`: turns up to it were
  removed by the server's history retention. Reading one answers 404, and a
  message id whose turn was removed is admitted again as a new message.
- Add `workflows.deleteInstance(id)` for `POST /v1/workflows/instances/delete`.
  It deletes a message workflow instance with its turns and history and
  answers `{ deleted }`.
- Add the `profile` option to `query.sparql` and `query.sparqlRaw` (and the
  `profile` body field on `SparqlTextRequest` and `SparqlSelectRequest`). A
  profiled answer carries `profile`: timings, reads, plan counters and the
  join order with estimates. `SparqlResults.profile` holds it.
- Add `plannerStats({ cursor, limit })` and `graph(name).plannerStats()` for
  `GET /v1/graph/planner-stats`, and the generated `PlannerStatsResponse` and
  `SparqlQueryProfile` types.
- Add `ontology.suggestions` with `list`, `get`, `create`, `validate`,
  `accept`, `dismiss`, `supersede` and `comment` for the
  `/v1/ontology/suggestions` routes. Integrations, agents and people file
  ontology change suggestions; a person accepts or dismisses them.
  `accept` takes `change_sources` with an edited change.
- Remove `ontology.induce` and `induceOntology`, and the generated types
  `OntologyInduceRequest`, `OntologyInduceResponse`, `OntologySuggestion`
  and `OntologySuggestionKind`. The route answered `429` on every graph and
  is removed from the server.

## 0.15.0 (2026-09-26)

Breaking removal of the Base-family reads. Their routes answered
`429 ingest_busy` on every graph. No publication job writes the Base read root
they need. The server now answers 404 and names the replacement.

- Remove `currentState`, `history`, `transitions`, and `why`. Read the graph
  at a past commit with `sparqlText({ query, as_of_commit_seq })`.
- Remove `entityNeighborhood`, `entityMetadata`, and `entities.get`. Use
  `entityDetail` or `entities.detail`. It returns the entity with its
  attributes and relationships.
- Remove `entityTypeSample` and `entities.sample`. Page class members with
  SPARQL.
- Remove the generated types of those routes. Also remove the types of
  `/v1/graph/changes` and `/v1/query/conflicts`, which are gone too.

Added:

- `SparqlResults` has a new `snapshot` field, and `sparqlRows` and
  `parseSparqlResults` fill it. For an eventual or pinned read,
  `snapshot.served_at_seq` is the commit the rows came from. A plain strong
  read returns `snapshot: null`.
- `sparqlText` and `sparqlRows` retry a retryable `429` within the retry
  budget. A read right after a write with `minIndexedSeq` now waits for
  `read_your_writes_pending` to clear. A `5xx` or a network failure is not
  retried, because the query could run twice.
- `CallOptions.retry` accepts `"rate_limited"`, which retries only a retryable
  `429`.
- The type of `entity_properties[].properties` accepts the flat
  `{ field: value }` map as well as the `{ field, value }` list. The server
  always decoded both shapes, but a flat map failed strict type checks. New
  generated types: `PropertiesInput` and `FlatPropertyValue`, a boolean,
  number, string, or array of numbers or strings.
- `SchemaBundleView` has a new `shapes` field: the active SHACL shapes as the
  validator parsed them. New generated types: `SchemaShapeView`,
  `SchemaShapeTarget`, and `SchemaShapeConstraint`.
- `ontology.conformance()` accepts `limit`, the number of result rows to
  return (server default 200, maximum 2,000).

## 0.14.0 (2026-09-25)

Breaking removal of branches, observe, and planner training. Every graph has
one line of history.

- Remove the `branch` option from `LbbClient`, `graph(name, opts)`, and
  `withScope`. A client is scoped by graph only.
- Remove `createBranch`, `mergeBranch`, `deleteBranch`, and `observe`, and the
  `branch()` and `deleteBranch()` methods of the graph namespace.
- Remove `plannerDataset`, `plannerPreferenceDataset`, and `promotePlanner`.
  The server no longer trains the planner.
- Remove the generated planner training types and the `planner` field of
  `ModelServingDefaults`.

Added:

- `sparqlText` accepts a `cursor` and returns `next_cursor` for
  snapshot-bound pagination of an indexed, ordered `LIMIT` query.

## 0.13.2 (2026-09-24)

- Add the `embeddings` namespace to preview and configure embeddings, change
  models, and search by meaning with class and relationship filters.
- Add the `evals` namespace for query traces, result labels, saved evaluation
  queries, and evaluation runs. Expose managed model settings with
  `managedModels()`.
- Refresh generated request and response types, including query trace IDs and
  commit selectors used by the MCP server.
- Rewrite the README with a complete RDF import and relationship query, expected
  output, commit replay, and links to the current guides.

## 0.13.1 (2026-09-18)

- Expose non-mutating schema publication and ontology evolution previews
  through `schema.publish(..., { dryRun: true })` and
  `ontology.evolve(..., { dryRun: true })`.
- Refresh generated schema contracts with publication preview and SHACL write
  enforcement results.

## 0.13.0 (2026-08-31)

Additive release covering the schema-observability surface that landed since
0.12.0.

- New `schemaSummary()`: the compact observed RDF schema attached to the
  immutable published base (`GET /v1/graph/schema-summary`), with class
  populations, resource- and literal-valued predicate counts
  (`resource_predicate_counts` / `literal_predicate_counts`; the literal field
  is `null` until a summary artifact written by a current server exists), and
  bounded OWL/RDFS statements.
- New `publicationStatus()` and `waitForPublished(targetSeq)`: the automatic
  RDF publication lifecycle (`PublicationStatusResponse`), available before
  the first generation exists, and a bounded poll until background
  reconciliation folds a commit into the published base.
- New `importRdfMany()`: multi-document RDF import in one call.
- Ontology and schema views carry each class's frozen `stable_id`, canonical
  query `iri`, and direct `super_types`; the evolve surface gains
  `AddSuperTypesOp`; ontology define accepts `dry_run`.
- Server side, defining Turtle/RDF/JSON-LD ontologies now imports
  `owl:DatatypeProperty` declarations as typed property fields instead of
  relations spanning every class. No client change is needed; `property_defs`
  simply carries the imported fields.

## 0.12.0 (2026-08-24)

Breaking removal of request-time SHACL models that had no supported client or
server operation.

- Remove `ShaclQueryRequest`, `ShaclNodeShape`, `ShaclValidationReport`,
  `ShaclViolation`, and the other retired `Shacl*` generated schema types.
- Publish RDF SHACL shapes with `schemaPublish`, then inspect the durable audit
  with `ontologyConformance`. There is no one-shot `/v1/query/shacl` route.

## 0.11.1 (2026-08-22)

- `createGraph` now creates the scoped graph with an empty ontology. The
  built-in AI-context vocabulary is opt-in through `ontologyDefine` with
  `merge_default: true`.
- `ontologyDefine` is safe to rerun on an existing graph: identical definitions
  are no-ops, additive differences are applied, and its response reports
  `graph_created`, `changed`, and the applied `changes`.
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
