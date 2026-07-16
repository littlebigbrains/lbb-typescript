# Changelog

All notable changes to the `@littlebigbrain/client` package are documented here.

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
