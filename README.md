# @littlebigbrain/client

The typed TypeScript client for [Little Big Brain](https://littlebigbrain.com) — write graph facts and query one immutable published snapshot. Request and response types are generated from the API contract, so every call is fully typed. Runs anywhere there's a global `fetch`: Node 18+, browsers, and edge workers.

```sh
npm install @littlebigbrain/client
```

## Quickstart

```ts
import { LbbClient } from "@littlebigbrain/client";

const lbb = new LbbClient({
  baseUrl: "https://0abc1def--production.db.eu.littlebigbrain.com",
  apiKey: process.env.LBB_API_KEY, // lbb_sk_live_… — keep it server-side
});
const graph = lbb.graph("main");

// 1. Write a fact.
await graph.facts.create(
  {
    triplets: [
      {
        source: { type: "CONCEPT", name: "policy-42" },
        relation: "RELATED_TO",
        target: { type: "CONCEPT", name: "seven-year retention" },
        evidence: "Customer records are retained for seven years.",
      },
    ],
  },
  { idempotencyKey: "policy-42-v1" },
);

// 2. Publication is automatic. Inspect one coherent watermark when needed.
const published = await lbb.readSnapshot();
console.log(published.snapshot.served_at_seq, published.query_lag_commits);

// 3. Query the snapshot with SPARQL.
const rows = await lbb.sparqlRows({
  query: "SELECT ?s ?o WHERE { ?s <policy:retention> ?o } LIMIT 10",
});
```

For hosted use, `baseUrl` is required and must be the exact `endpoint_url`
shown on the stack's Connect page. Graph and branch remain client scope
parameters; they are not encoded in the hostname.

## Examples

**Bulk import.** Load an array of records (or an NDJSON string) in one call:

```ts
await graph.facts.import(
  [
    { source: { type: "DOC", name: "handbook", key: "doc:42" }, relation: "HAS_PASSAGE", target: { type: "PASSAGE", name: "leave-policy", key: "p:42:1" } },
    // …one record per line
  ],
  { idempotencyKey: "handbook-batch-1" },
);
```

For large or long-running loads, stream records to a durable job instead:

```ts
const accepted = await lbb.submitImport(records(), {
  idempotencyKey: "hubspot:portal-42:run-2026-07-29",
});
const completed = await lbb.waitForImportJob(accepted.job_id);
console.log(completed.state, completed.committed_commit_seq);
if (completed.committed_commit_seq != null) {
  await lbb.waitForIndexLineage(completed.committed_commit_seq);
}
```

`records()` may be an iterable or async iterable. Success means every grouped
commit is durable and final publication was enqueued; it does not mean indexes
have already reached `committed_commit_seq`. Wait once after the final commit,
not after each source row or chunk. The lineage waiter polls normal
`index_caught_up=false` metadata until its own deadline, including on an
RDF-only deployment. An empty iterable is rejected locally before an import
POST is sent.

**Time-travel read.** Pin a SPARQL read to a past instant — results reflect the graph as it was then:

```ts
const asOf = await lbb.sparqlRows({
  query: "SELECT ?s ?o WHERE { ?s <policy:retention> ?o }",
  as_of_valid_time: "2026-01-01T00:00:00Z",
});
```

**SPARQL.** `sparqlRows` runs a SPARQL 1.1 SELECT/ASK and returns parsed rows:

```ts
const { rows } = await lbb.sparqlRows({
  query: `SELECT ?doc WHERE { ?doc ?p ?o } LIMIT 10`,
});
```

## Errors & retries

Methods return parsed JSON and throw `LbbError` (with `status`, `code`, `message`, `param`, `requestId`, `docUrl`) on any non-2xx response. Safe reads and idempotency-keyed writes retry `429`/`5xx` and network failures with full-jitter backoff, bounded by a retry budget (`retryBudgetMs`, default 60s) rather than a fixed count, and honor `Retry-After` — a terminal error the server marks non-retryable surfaces immediately. Use `rawRequest()` for response headers, request id, and retry/timing metadata.
`waitForIndexLineage(...)` is a separate deadline-bounded poller, so the generic
request retry-count cap cannot end publication waiting early.

## More

The `graph(...)` scope exposes `facts`, `entities`, `ontology`, `query`,
`search` (feedback surfaces), and `schema` namespaces. `query` runs SPARQL,
the one query language on the API; `schema`
reads or atomically publishes the active ontology/shapes bundle. Writes enqueue
published-generation maintenance automatically. Every generated shape is
available as `Schemas["TypeName"]`. Retired request-time JSON SHACL DTOs are
intentionally absent: publish RDF shapes with `schema.publish`, then read
`ontology.conformance`.

Full reference and guides: [docs.littlebigbrain.com/sdks/typescript](https://docs.littlebigbrain.com/sdks/typescript/).

## Develop

```sh
npm install
npm run generate    # regenerate types from contracts/openapi.json
npm run typecheck
npm test
```
