# Changelog

All notable changes to the `@littlebigbrain/client` package are documented here.

## Unreleased

- `FilePage` has `ocr_required` and `FileParse` has `ocr_pages`. A page with
  fewer than 16 characters of text, whose images cover at least 40% of it,
  reads `ocr_required: true` (a scan: OCR is not built). Absent means
  false. The `documents-parse` template flags these pages as the server
  does, adds the `ocr_pages` property to the properties it owns and stores
  its pages under the parser id `poppler-<version>-scan1`. It needs
  `pdfimages` beside `pdftotext` (`LBB_PDFIMAGES`).

- `reason` takes the option `attempt` (1 to 10, type `ReasonOptions`). It says
  which attempt of one reading the call is. A workflow that retries a failed
  answer sends `2` on its retry, under its own `effectId`. The call log names
  it (`attempt` on a `ModelCall` and its row). Send it only on a retry: an
  older server refuses the field. A test value (`WorkflowTestValue`) names
  `attempt` too (`2` for a value of the retry). `settings.repair` shows the
  `repair` setting of a `values.extract` test. The `values-extract` template
  takes `repair: 0 | 1` in its `Settings`.
- `evals.experiments` compares two configurations of a workflow on a
  dataset: `create`, `estimate`, `list`, `all`, `get`, `cancel` and `wait`
  (`isEvalExperimentOpen`). B is the model of one use or a settings
  revision. The report gives the difference with a 95% interval. Guide:
  [Compare two versions of a workflow](https://docs.littlebigbrain.com/guides/experiments/).
- `WorkflowRevision.last_tested` (`WorkflowRevisionTested`: `test`,
  `finished`, `counts`) says whether a workflow test read inputs with a
  revision's settings: an object, `null` when the workflow has tests and no
  test is recorded for them, and `undefined` when the server does not say. An experiment's arm
  adds `experiment` (`id`, `arm`).
- `models.choices.put` takes `experiment` (an `exp_…` id) with `workflow`, and
  `workflows.named.activateRevision` takes `{ experiment }`: the write applies
  that experiment's B. The server answers `409 experiment_outdated` when the
  workflow no longer runs the experiment's A; when it runs B already, nothing
  changes. A choice row names its experiment (`experiment`).
  Use `experiment` only after every node runs the version with experiments: an
  earlier node ignores it on an activation and skips the check of A.

## 0.31.0 (2026-10-26)

- `client.status({ version: "status/1" })` reads the current RDF and class
  diagnostics and checks their shape (`CurrentStatusResponse`). `status()`
  without `version` answers as before. `version: "legacy"` asks for the
  earlier shape and throws `LbbCapabilityError` when the server answers
  another one.
- `client.demoRun({ dataset, version })` runs the fixed RDF fixture checks
  (`POST /v1/demo/run`, dataset `semantic_graph` by default) and checks the
  answer (`DemoCurrentRunResponse`). It sends `version: "demo/1"` by default
  and needs the server capability `rdf_demo_checks_v1`: an older server
  throws `LbbCapabilityError`. `version: "legacy"` returns the earlier
  answer.
- Add `client.entities.retrieve` for versioned `records/1` entity reads: caller IRIs, native ids, activated schema keys, exact RDF terms, independent assertions, explicit snapshot/schema availability and whole-read limits. Existing `entities.detail` is unchanged.

- `client.models.choices`: the model each workflow use runs, for the
  environment or for one workflow (`GET`, `PUT` and `DELETE
  /v1/models/choices`). `list` takes `workflow`, `use`, `limit` and
  `cursor`; `all` pages through it; `put` takes `{use, model, workflow?}`;
  `delete` takes `{use, workflow?}` and returns `{id, object, deleted}`;
  `put` and `delete` send an idempotency key. The uses are `extract` (the reasoning
  model of an AI step) and `decide` (its decision model); `embed` is listed
  and takes no choice. A logged call (`ModelCall`, a call list row) gains
  `choice`: the row in force (`id`, `scope`, `source`) and `fallback`.
  Types: `ModelChoiceListOptions`, `ModelChoicesNamespace`.
  `client.workflows.tests.create` takes `models` (`{extract?, decide?}`):
  the test runs on those models, and the test's `models` names the ones
  it ran.
- `triggeredWorkflow({ onSchedule })` handles the slots of a workflow with
  a schedule trigger (`type: "schedule"`: the slot's time, the slots skipped,
  the commit range since the last run and `changed`), and `onInstances`
  becomes optional. A schedule message without `onSchedule` fails the turn
  for good. `WorkflowScheduleMessage` is exported.
- `triggeredWorkflow({ onEvents })` handles the batches of a workflow with
  a stream trigger (`type: "events"`): the worker reads the batch's blob
  and calls `onEvents(ctx, events, message, state)` with the events in
  order. A batch without `onEvents` fails the turn for good.
  `WorkflowEventsMessage`, `WorkflowEventRecord` and `EVENTS_MESSAGE_TYPE`
  are exported, and a handler's context has `blobJson(key)`, which reads a
  JSON blob of the workflow.
- `client.workflows.named.sendEvents(name, events)` sends 1 to 500 events
  to a workflow with a stream trigger (`POST /v1/workflows/named/events`).
  Each event's `id` is its idempotency key, so a refused send is sent
  again as it is; a `429` waits for its `Retry-After`.

## 0.30.0 (2026-10-22)

- `client.workflows.named` reads the history of a workflow's settings and
  uses earlier settings again: `revisions(name, { cursor, limit })`,
  `allRevisions(name)`, `getRevision(name, id)` and
  `activateRevision(name, id, { expectedRevision })`. A workflow has
  `active_revision`, and a run summary and a test have `revision`.
  `client.workflows.tests.create` takes `revision` (with `name`) to test a
  kept revision without activating it.
- `WorkflowWorker` reports what each run did with each input (the run's
  results) when the claim names `results_max`: `writeOwned` reports each
  subject `written` (or `no_value` when it sets nothing) with its fields and
  out-edges, `review` of an item with a `subject` reports it `review` with
  the item's id, `waitForReview` with what the wait ended with, and
  `requeue` reports each instance `failed`. The completion and the failure
  send them as `results`, at most 512 KiB; a `413` sends them again without
  `results`, and a server that names no `results_max` gets none. A step that
  reported inputs keeps them in its saved output, so a replay reports them
  again; the step's code sees its own value. An earlier version of this
  package does not unwrap that output: when it replays such a step (after a
  rollback, or in a fleet of mixed versions), the workflow's code gets
  `{lbb_step_results, run, results, value}` in place of its value. Roll
  workers forward only. `captureActivities(...).result()`
  gains `results`, the same records. Types: `WorkflowRunInput`,
  `WorkflowRunResultOutcome`, `WorkflowRunResultCounts`,
  `WorkflowRunResultsReport`.
- `client.reviews.list`, `patterns` and `all` take `evalId`: the items
  Evals filed for one record (a calibration session, a model call's
  check, a golden).
- The earlier test routes, `/v1/workflows/triggered/tests*`, answer as
  before until the release after the next one; their `starter` list
  filter is ignored. An unknown workflow name answers `404
  named_workflow_not_found` (before: `triggered_workflow_not_found`,
  the same status).
- A second save of a test keeps the items added to its dataset by hand,
  and a delete takes the dataset off its test (`dataset` is `null`
  again).
- `client.workflows.tests` calls `/v1/workflows/named/tests*`. `create`
  names a workflow of the graph with `name` (in place of
  `workflow: { starter, name }`), and `list({ name, limit, cursor })` takes
  no `starter`.
- A `WorkflowTest` has `dataset`: the id of the Evals dataset saved from its
  answers, `null` until the first save.
- `client.evals.datasets.create({ source: { kind: "test", id } })` keeps one
  dataset per test: a later save of the test brings that dataset up to date
  and returns it with the same id.
- `client.evals.datasets.delete(id)` deletes a dataset and its items
  (`DELETE /v1/evals/datasets`, with an idempotency key) and returns
  `EvalDatasetDeleted` (`{ id, object: "eval_dataset", deleted: true }`). A
  get or an export of it then fails with `404`, and the next save of its
  test makes a new dataset.
- `client.workflows.tests.all({ name })` and `client.evals.datasets.all()`
  read every page of the list.
- `client.workflows.tests.wait(id)` throws an `Error` named `TimeoutError`,
  with the test and its status in the message, when the test is still open
  after `timeoutMs` (default 10 minutes). Before, it returned the open test.
- `client.workflows.tests.dataset(id)` and the type `WorkflowTestDataset`
  are removed. Save the test with `client.evals.datasets.create` and its
  `source`, then read `client.evals.datasets.export(dataset.id)`.
- The client sends `Lbb-Version: 2026-10-21` by default. On this version
  the workflow lists answer in the list envelope,
  `{ object: "list", data, has_more, next_cursor }`, with `limit` and
  `cursor`: `workflows.named.list`, `queue`, `runs` and `documents`, and
  `workflows.triggered.runs` and `documents`. Read `.data` where you read
  `.workflows`, `.items`, `.runs` or `.documents`, and pass `next_cursor`
  as `cursor`. The queue's `next_cursor` is a string. The list methods
  always return the envelope, whatever `apiVersion` says; only a raw
  `client.request(...)` sent with `apiVersion: "2026-07-23"` gets the
  earlier shapes.
- Each list method reads both shapes. A server older than the envelope
  answers the earlier shape, and the method returns it converted, so this
  client works against an older data plane too. A `cursor` that server
  ignored is sent again under its earlier name (`before` or `after`).
- `workflows.named.list({ limit, cursor })` returns one page (`limit` 1 to
  200, default 100), and `all()` iterates every workflow.
  `runs(name, { cursor, limit, outcome })` and `allRuns(name)`,
  `queue(name, { trigger, cursor, limit })`, and the new
  `documents(name, { q, sort, cursor, limit })` and `allDocuments(name)`
  (`GET /v1/workflows/named/documents`). A workflow has `object: "workflow"`
  and `created`.
- `workflows.triggered.{list, get, refresh, pause, runs, run, runStats,
  documents, delete}` are deprecated; each doc comment names its
  `workflows.named` method. They keep working. `starters.use`,
  `triggered.preview` and the calibration routes have no named form and
  stay.
- `listAll` takes any page in the list envelope (`ListPage`, now exported);
  `ListResponse` extends it. The `before` option of `runs` and the `after`
  option of `queue` and `documents` still work and are deprecated in favor
  of `cursor`.
- `reviews.get` reads `GET /v1/reviews/get`, the new name of
  `/v1/reviews/detail`. A data plane without the new route answers its
  catch-all `404`, and the client then reads `/v1/reviews/detail`.
- `reviews.all(options)` iterates every item with the filters of `list`.
- `reviews.answer`, `answerBatch`, `withdraw` and `comment` send an
  `Idempotency-Key`: yours (`idempotencyKey`), else one the call makes. So
  the client's retry of a network failure or a 5xx is safe.

## 0.29.0 (2026-10-21)

- Activity calls name their step (`workflow.step`): `reason`, `decide` and
  `embed` called in a step of a `WorkflowWorker` turn send the step's key, so
  the call log names the step (`scope: live`). The worker records each step's
  effect id when the step starts. A call whose effect id is a step's, or
  starts with it followed by `.` or `:` (such as `${s.effectId}.2`), names
  that step; a call with no such step names none. `captureActivities` sends
  the step the same way. A data plane before this field refuses it, so roll
  the data plane first.
- `WorkflowWorker` stops a turn on `409 turn_lease_lost`, the code a turn
  route now answers when the attempt's token no longer holds its turn. It
  still stops on any other 409 or a 404, as an older server answers a lost
  lease `409 conflict`.
- `lbbActivities(client).waitForReview` names its steps `<key>.ask`,
  `<key>.answer` and `<key>.read`. A step key holds no `:`, so a worker
  refused the old names `<key>:ask`, `<key>:answer` and `<key>:read`. The
  scenarios of `sdk/conformance/workflow-worker` now pin the steps of
  `waitForReview` and of `captureActivities`.
- `captureActivities`: `waitForReview` on a trigger shard (`starter.<name>`)
  is refused with the live call's `WorkflowError`, and keeps nothing. Before,
  it ended unanswered, so a test passed where the live run fails.

- `files.putPages(sha256, parser, upload)` stores what a parser outside the
  server made of one upload of a file (`PUT /v1/files/pages`, with the
  upload's `uploaded_at`). `WorkflowTurnReader` gains the hosted workers'
  grants (`fileRecord`, `fileContent`, `fileContentStream`, `filePages`,
  `putPages`, `commitOwned`); a server issues them to LBB's work token
  only, with `LBB_WORKFLOW_EXECUTION_GRANTS`.

- `client.query.names({ text, min_commit_seq })` waits for the name index to
  hold a write's commit; `commit_seq` in the answer is the newest commit the
  index holds.
- `WorkflowWorker`: a `409` or a `404` on a turn route (a stale lease, or an
  instance that is gone) and a `409 workflow_fence_lost` of a fenced write stop
  the turn. The worker sends no `turns/fail` for it, and `run()` goes on. Before,
  the refusal of that `fail` was thrown out of `run()`. The scenarios of
  `sdk/conformance/workflow-worker` pin these rules for the TypeScript and the
  Python worker.

- Release 2 adds opt-in `WorkflowWorker({ executionReads: true })`, task-bound
  `WorkflowTurnReader`, and optional `WorkflowContext.sparql` for bounded
  SELECT/ASK. Custom contexts remain compatible without the method; feature-check
  it before use. Reads refresh credentials before first use and when the next
  read budget needs it, using monotonic elapsed time and server-issued lifetime.
  The server must return `issued_at_ms`; missing lifetime or elapsed refreshes
  fail retryably without sending a query. No query is automatically replayed.
  Named, acknowledged step outputs remain the workflow's retry-stable input;
  this does not add file/parser/import execution or snapshot retention.

- Environment selectors are trimmed and case-insensitive, including the legacy
  `stack` alias. A selector supplied with an environment API key must match that
  key's environment; a leftover selector for another environment now returns 403
  instead of being ignored. Remove it or select the authenticated environment.

- `environment` is the preferred scope option in `LbbClient`, `withScope`,
  and `graph(name, options)`. The deprecated `stack` option remains compatible;
  conflicting values fail before a request. The wire parameter stays `stack`.
- Optional `catalog` and `access` helpers organize existing graphs and issue or
  revoke scoped read tokens. `sparqlDataset` queries explicitly authorized primary
  and reference graphs with exact decimal-string epochs. These require separately
  enabled server capabilities; they add no delegated writes or automatic capacity.

- Phase 3 of the workflow engine (the server of this release):
  - `writeOwned` sends `workflow_fence` (the step's turn and token,
    `WorkflowStepContext.fence`): the server refuses a new commit of a
    worker whose lease ended (`409 workflow_fence_lost`), and a repeat of
    the effect id is a replay. It fences only a write to the turn's graph
    (`WorkflowStepContext.graph`, the worker client's graph; with a client
    that names none, the graph the write names).
  - A turn that throws `WorkflowWait(retryAtMs)`, or a step that meets
    `429 workflow_budget_exceeded` (`LbbError.retryAtMs`), fails with
    `retry_at_ms`: the turn waits and counts no attempt.
    `WorkflowHandle.wake()` ends such a wait (control action `wake`).
  - `workflows.start(definition, id, { onExhausted })`: `skip` moves a
    turn that failed for good to the history and goes on.
  - `client.workflows.named.requeue(name, { workflow_id, turn, items })`
    and `requeueFailed(client, ctx, stepKey, failed, { graph })` send the
    instances a turn could not do again later, at most 3 times.
  - `client.workflows.blobs.put(data, { workflowId })`, `get(key)`,
    `getText`, `putJson`, `getJson`: blobs of at most 8 MiB, keyed by their
    SHA-256 under the writing identity's workflow.
  - `triggeredWorkflow({ onFanIn })` handles the messages of a workflow's
    fan-in identity (`fan_in` of `named.put`); `fanInIdentity(name, id)`,
    `isFanInIdentity(id)`, `workflowOfIdentity(id)` and
    `WorkflowContext.workflowName` name them.
  - `named.put` takes `budget_usd_per_month`, `on_exhausted` and `fan_in`.
  - `lbbActivities(client).requeue(ctx, stepKey, failed, { graph })`:
    `requeueFailed` bound to the client, for the templates.
  - `lbbActivities(client).listReviews(options)` and `reviewItem(key)`:
    the review items of a workflow, and the one filed under a key with its
    evidence, so a workflow merges new evidence into its items.
- `stableHashHex(parts)`: the data plane's stable hash
  (`lbb_core::stable_hash_hex`, BLAKE3 over the parts, each followed by a
  zero byte, cut to 16 bytes). LBB's own workflows key their review items
  with it; a worker that files the same items uses it too.

## 0.28.0 (2026-10-16)

- A derivation belongs to one upload of its file.
  `client.workflows.derivations.check` names the upload of the live file
  as `content_uploaded_at`. A deleted file has no upload there, and no
  derivation. Send it back in `record`'s `content_uploaded_at`.
  Say the file was deleted since the check, or deleted and uploaded again.
  Then the record writes nothing. It throws `LbbError` 409
  `derivation_upload_changed`, which `isDerivationUploadChanged(error)`
  names. Then the run of the new upload does the work.
- `derive` sends the check's upload with its record. `DeriveResult` has
  `uploadChanged`: `true` when the file was deleted during `work`. Then
  nothing was recorded, `ran` is `false`, `outputs` are `work`'s and
  `derivation` is `null`. `DeriveResult` is now a union on
  `uploadChanged`: test it before you read `derivation`.

## 0.27.0 (2026-10-16)

- `client.files.list({ parseStatus, name })` filters the list: `parseStatus`
  (`parsed`, `unsupported`, `failed`, or `waiting` for a file without one)
  and `name` (a part of the name, in any case). The server reads the
  `Document` facts of the published generation for the page, and
  `FileList.as_of_commit_seq` names the commit it read. `limit` and
  `after` page it as they page the plain list.
- `SuggestionLinkSummary.document_name` names the file of a link review:
  the `Document`'s name for a `document` IRI, the name itself for evidence
  written before typed content.
- An upload without a type (or with `application/octet-stream`) gets the
  type the server detects: PNG, JPEG, GIF, WebP, the Office types of
  `.xlsx`, `.docx` and `.pptx`, and `text/csv`, `text/tab-separated-values`,
  `text/markdown`, `application/json` and `text/plain` for UTF-8 text with
  those names, beside the PDF it detected before.
- The starter workflow catalog (`client.workflows.starters.list()`) lists
  `rows` and `sections`, the templates your worker runs on files.
  `StarterWorkflow.media_types` names the media types of their content
  trigger, and their `watch` is `none`; their `params` are the settings of
  the template's code. Create their workflow with
  `client.workflows.named.put(trigger())`, as the template's
  `npm run setup` does: `client.workflows.starters.use` answers `400
  template_runs_in_worker` for them, and they have no Try on samples.
- `client.files.get(sha256, { deleted: true })` names the facts that cite
  a live file too (`cited_by`, at most 20): what
  `delete(sha256, { purge: true })` would retract.
- A deleted file's bytes, pages and derivations are freed after a grace
  (30 days by default), unless a fact's evidence still names the file.
  `client.files.delete(sha256, { purge: true })` also retracts those facts
  and answers `purged_edges`. `client.files.get(sha256, { deleted: true })`
  answers a deleted file until its content is freed, with `deleted_at` and
  `cited_by` (the facts that cite it, `FileCitation`). An upload of the
  same bytes during the reclaim throws `LbbError` 429
  `file_reclaim_in_progress`; retry it. The package exports
  `FileCitation`, `FileGetOptions` and `FileDeleteOptions`.
- `client.files.list({ limit, after })` reads one page of the graph's
  files, the newest upload first: `limit` is 1 to 1,000 (default 1,000),
  and the answer's `next` (`FileList.next`) is the `after` of the next
  page. A page can hold fewer than `limit` files while `next` is set.
  `client.files.counts()` (`GET /v1/files/counts`) counts the files by
  parse status over the `Document` entities of the published generation,
  with the commit it counted (`FileCounts`). The package exports
  `FileList`, `FileListOptions` and `FileCounts`.
- `client.files.get(sha256)` (`GET /v1/files/record`) reads one file's
  record from one object; a SHA-256 the graph has no file for, or a deleted
  file, answers `404 file_not_found`.
- Files of up to 1 GiB. `client.files.content(sha256, { range })` reads one
  byte range (`{ start, end }` with both bytes included, `{ start }` to the
  end, or `{ suffix }` for the last bytes) and still returns a
  `Uint8Array`. `client.files.contentStream(sha256, { range })` yields the
  bytes in chunks as they arrive, so a large file is never held whole.
  `client.files.head(sha256)` returns `{ bytes, contentType, sha256 }`
  without the bytes. A range with no byte of the file throws `LbbError`
  416 `range_not_satisfiable`; an upload above the server's limit throws
  413 `file_too_large`. `client.requestByteStream(method, path, opts)`
  streams any 2xx body.
- `client.files.upload(data, { name, language, schema })`: an upload can
  state the content's `language` (the natural language of the content, a
  BCP 47 tag such as `en` or `de-CH`, at most 64 characters) and `schema`
  (at most 256), which the file's `Document` stores. `FileRecord` gains
  `language` and `schema`. An upload also writes the file's `Content`
  (`content:<sha256>`) and the edge `HAS_CONTENT`, and the ontology gains
  `REPRESENTS`. `SuggestionLinkSummary.document` is the `Document`'s IRI
  for a link written since, and the file's name for one written before.
- The runs of a workflow: `client.workflows.named.runs(name, { before,
  limit, outcome })`, `getRun(name, runId)` (a run with its model calls)
  and `runStats(name, { hours })` read the run summaries a workflow keeps
  for 30 days (`WorkflowRunList`, `WorkflowRunDetail`, `WorkflowRunStats`).
  `client.workflows.triggered.runs(ref)`, `run(ref, runId)` and
  `runStats(ref)` read the same by starter and name, and
  `documents(ref, { q, sort, after, limit })` pages the documents of
  `documents.link` and `documents.map`.
- A `WorkflowWorker` turn names its run on each model activity call of
  `lbbActivities` (`workflow`: the identity, the turn, the run's id, and
  the `instance` option), and sends the calls' summed `usage` with the
  completion (and with a failure). The worker's code does nothing for it.
  This release needs a server that takes `workflow` and `usage`.
- `client.workflows.named.put` takes a content trigger:
  `{ content: { media_types: ["application/pdf"] } }` sends each upload of
  those media types as it is logged, without a wait for a publication, one
  content per message, routed by its SHA-256. `WorkflowTriggerResolved`
  gains `content`, and its `watch` is absent for a content trigger.
  `WorkflowMessageOrigin` gains `sha256`, `media_type` and
  `uploaded_at_ms` (an origin of kind `content`).
- `client.workflows.derivations.check(key)` and `.record(request)`
  (`/v1/workflows/derivations/*`): what one version of a workflow made of
  one content with one set of settings. `.derive(key, work, { runId })`
  checks, runs `work` when there is no derivation, and records what it
  returns.

## 0.26.0 (2026-10-14)

- `client.workflows.named` reads and writes workflows with triggers
  (`/v1/workflows/named`): `list`, `get`, `put` (your worker's workflow
  type, one `watch` trigger, `shards`, `route_by`, `window`, `batch`,
  `owns`), `run` (run now), `pause`, `delete`, and `queue` (what the
  watch has not sent yet, each item with its shard and origin, and per
  shard its message in flight and its inbox). `client.workflows.triggered`
  stays as the same workflows in their older shape.
- `WorkflowTriggerMessage` gains `origin`: the trigger, and a backfill, a
  commit range with the watched fields that changed and the requests that
  changed the instances, a run now or a schema change.
  `WorkflowMessageOrigin` gains `ontology_version`.

## 0.25.0 (2026-10-13)

- `client.evals.runAnswers({ runner, answers })` checks your own agent's
  answers to the question goldens (`POST /v1/evals/run/answers`): the
  server runs each answer's query and checks it as it checks Ask's answer.
  `client.evals.results({ runner })` reads one agent's runs.
- `SparqlTextRequest` gains `route`: with `request`, the route your app
  took (the `route` of `query.ask` in `mode: "route"`); the eval trace
  keeps it. `EvalLabelRequest` gains `route`, `EvalTrace` and `Golden`
  gain `route`, a verdict gains `route_check` (the router's pick against
  the golden's route), and `EvalResults` gains `runner`, `route_checked`
  and `route_right`. `EvalVia` gains `app`.
- `SearchRequest` gains `shown`, the app's cut (`min_score`,
  `min_relevance`, `limit`) for the eval trace of a search with `request`.
  `EvalTrace` gains `rerank` and `shown`, `Golden` and a verdict gain
  `shown`; a search trace's items hold `relevance` and `shown`.
- The step context of `WorkflowWorker` gains `progress(phase, {done,
  total, unit})`: progress in the convention the console draws as a
  Running line and a bar. It is coalesced (a phase change at once, then at
  most one write per `progressEveryMs`, 3 s by default or half the step's
  `heartbeatTimeoutMs`, and the last value when the step returns). A new
  worker option `progressEveryMs` sets the interval.
- `ctx.origin` names where the turn's message came from. `send` and
  `handle.send` take `origin`. New `workflows.inbox(id)` /
  `handle.inbox()` (`GET /v1/workflows/instances/inbox`) and
  `workflows.inboxByType(type, {version})` (`GET /v1/workflows/inbox`)
  list the messages that wait.
- `WorkflowInstance` and `WorkflowTurn` gain `progress`, and
  `WorkflowTurn` gains `origin`.
- A `writeOwned` write function gets the step's context, so it can report
  progress before the commit. `WorkflowProgressCounts` and `InboxOptions`
  are exported.

## 0.24.0 (2026-10-12)

- The starter workflow Values from text is `values.extract` (formerly
  `infer.llm`; the server still accepts the former id and answers with
  `values.extract`). The README names the project generator
  `npm create @littlebigbrain`.
- `ModelJob` gains `map` (the decisions of `documents.map`) and
  `ModelActivityFeature` gains `workflows`. The pause doc names
  `documents.map`.
- Review items group by instance (`review` workflow): a suggestion's
  `SuggestedFacts` gains `required`, the rows an accept must keep (the type
  of a new instance). `OntologyChangeSuggestionAcceptRequest` gains
  `facts`, the subset of the proposed facts to keep, each exactly as
  proposed. A suggestion gains `proposed_facts` (when a person left facts
  out) and `facts_written` (when the producer has written the facts).

## 0.23.0 (2026-10-11)

- `client.workflows.starters.try({ starter, params })` runs Try on samples
  (`POST /v1/workflows/starters/try`, SaaS mode): a new graph with the
  starter workflow's samples and the workflow on it. It is never retried.
- New `lbbActivities(client)` for the code of a workflow: `reason`,
  `decide` and `embed` call LBB's own models
  (`POST /v1/workflows/activities/*`), and `pages`, `sparql`,
  `writeOwned`, `review`, `evolve` and `ontology` wrap the routes a
  workflow reads and writes. A model call takes the request and
  `{ effectId, label }`: pass the step's `effectId`, and a step that runs
  again gets the first answer (`cached: true`) at no cost. `reason<T>`
  types the answer's `value`. A call with an effect id retries a `5xx` and
  a network failure; one without retries only a `429` the server returns
  before it runs the request. `reason` waits up to 5 minutes per attempt.
  `pages(sha256)` reads to the end of the file, 50 pages per call.
  `review({ workflow, ... })` files a suggestion with the origin
  `{ kind: "agent", id: "starter:<workflow>" }`. New
  `isActivityRefused(error)` (`422 activity_request_refused`) and
  `splitInHalves(items)` for splitting a refused request, and the types
  `LbbActivities`, `ActivityOptions`, `ActivityPagesOptions`,
  `ReasonRequest`, `ReasonResult`, `DecideRequest`, `DecideQuestion`,
  `DecideAnswer`, `DecideResult`, `EmbedRequest`, `EmbedResult` and
  `ReviewRequest`.
- `writeOwned` takes a function that returns the write: it runs inside
  the step, so the write can read inputs the turn does not save (a file's
  pages). A replayed step does not call it.
- New `workflows.starters` and `workflows.triggered` for starter workflows:
  templates a workflow is created from, and the workflows created from them
  (triggered workflows), which run when a published commit changes the
  class they watch. `workflows.starters.list()` reads the catalog
  (`GET /v1/workflows/starters`, each entry with its `group`) and
  `workflows.starters.use(request)` creates a workflow from one, or changes
  one (`PUT /v1/workflows/triggered`). `workflows.triggered.list()`,
  `get({ starter, name })`, `preview(request)`, `refresh({ starter, name })`,
  `pause({ starter, name }, paused)` and `delete({ starter, name })` call
  `/v1/workflows/triggered*`. Embeddings on classes (`search.embed`) and fit
  sources (`ontology.fit`) are triggered workflows too. `use`, `pause` and a
  preview without `propose` retry a failed call; `pause` defaults `paused`
  to `true` (pass `false` to resume); `delete` repeats the name as
  `confirm`. Also on `graph(name).workflows`. New types
  `StarterWorkflowsNamespace`, `TriggeredWorkflowsNamespace` and
  `TriggeredWorkflowRef`. Ontology starters stay `ontology.starters`.
- Developer workflows (`workflow@v1`): a triggered workflow of `workflow`
  sends the new and changed instances of a class to a workflow of your
  worker as trigger messages. `workflows.starters.use` takes its
  `workflow`, `owns` and `batch`.
- New `triggeredWorkflow({ name, version, initialState, onInstances })`
  defines the workflow that receives the messages. It checks each message
  with `parseTriggerMessage` (a message of another shape fails its turn
  without a retry), calls `onInstances(ctx, message, state)` with the typed
  `WorkflowTriggerMessage`, and keeps the state when `onInstances` returns
  none. `message.workflow` names the triggered workflow; a message stored
  with `starter` instead reads the same. The server creates the instance
  `starter.<name>` with the state `{}`, so `state` is `initialState` merged
  under the saved state: a saved key wins, and a null or empty saved state
  gives `initialState`. A handler can add to a number of `initialState`
  (`state.seen + n`) from its first turn.
- New `writeOwned(client, ctx, stepKey, write, options)`: inside the step
  `stepKey`, one `POST /v1/graph/commit` with `replace_owned` replaces the
  owned edges and fields of `write.subjects` with `write.triplets` and
  `write.entity_properties`. The step's effect id is the idempotency key, so
  a turn that runs again never writes twice. `options.graph` names the graph
  (pass `message.graph`); edges default to `skip_unchanged`. New types
  `WorkflowTriggerMessage`, `WorkflowTriggerReason`,
  `TriggeredWorkflowDefinition`, `TriggeredWorkflowTurn`, `OwnedWrite`,
  `OwnedWriteOptions` and `OwnedWriteResult`.
- New `entityRef(iri, type, name?)` and `entityIdFromIri(iri)`: the commit
  reference of an entity you know by its IRI (a trigger message's
  `instances`, a SPARQL answer). Its `key` is `ENTITY_ID_KEY_SENTINEL` and
  the entity's 32-hex id, so a commit or a `replace_owned` subject
  addresses that entity directly, a keyed one included. A namespace other
  than `ENTITY_IRI_NAMESPACE` or a malformed id throws a `RangeError`.
  `name` (default: the id) is the display name a triplet endpoint or a
  field row writes; `replace_owned` reads only the id.
- New `files` for the files of a graph: `upload(data, { name,
  contentType })` sends a `Blob`, `ArrayBuffer` or `Uint8Array` as the raw
  body of `POST /v1/files` (the same bytes again change nothing, so a failed
  call is retried); `list()`, `content(sha256)` (the bytes, a
  `Uint8Array`), `pages(sha256, { from, to })` (the parsed lines and words
  with their boxes) and `delete(sha256)` (repeats the SHA-256 as `confirm`)
  call `/v1/files*`. Also on `graph(name).files`. New types
  `FilesNamespace`, `FileRecord`, `FilePages`, `FileBody`, `BlobLike`,
  `FileUploadOptions` and `FilePagesOptions`.
- `RequestOptions` gains `responseType: "bytes"`, which returns a 2xx body
  as a `Uint8Array`; a `FetchLike` response may carry `arrayBuffer()`.
- `commit` and `graph(name).facts.create` send `replace_owned` and return
  `owned`; `ontology.suggestions.create` sends `facts`, and an accepted
  suggestion returns `facts_commit` (the request types come from the
  contract).
- `query.names` responses carry `index_complete`, `index_classes_read` and
  `index_gaps` (new types `QueryNamesIndexGap` and `QueryNamesGapReason`):
  whether the name index read every class in full, and the classes it did
  not, with the reason. The index reads people and organizations first.

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
