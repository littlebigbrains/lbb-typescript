# @littlebigbrain/client

The typed TypeScript client for [Little Big Brain](https://littlebigbrain.com) — write graph facts, build indexes, and run hybrid search over one snapshot. Request and response types are generated from the API contract, so every call is fully typed. Runs anywhere there's a global `fetch`: Node 18+, browsers, and edge workers.

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

// 2. Build persisted BM25 + vector + adjacency indexes and wait.
await graph.indexes.run({ wait: true });

// 3. Hybrid search over the snapshot.
const results = await graph.search.hybrid(
  "How long are customer records retained?",
  { topK: 10, source: "persisted", consistency: "strong" },
);
```

For hosted use, `baseUrl` is required and must be the exact `endpoint_url`
shown on the stack's Connect page. Graph and branch remain client scope
parameters; they are not encoded in the hostname.

## Examples

**Search with filters.** Pass the request body to filter before ranking — here, only facts an ACL principal may see:

```ts
const results = await graph.search.hybrid({
  query: "incident response runbook",
  targets: ["entities"],
  search: {
    filters: {
      op: "overlaps",
      field: "acl",
      values: ["user:rino@example.com", "group:engineering"],
    },
  },
  top_k: 20,
});
```

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

**Time-travel read.** Pin any search to a past instant — results reflect the graph as it was then:

```ts
const asOf = await graph.search.hybrid("retention policy", { asOf: "2026-01-01T00:00:00Z" });
```

**SPARQL.** `sparqlRows` runs a SPARQL 1.1 SELECT/ASK and returns parsed rows:

```ts
const { rows } = await lbb.sparqlRows({
  query: `SELECT ?doc WHERE { ?doc ?p ?o } LIMIT 10`,
});
```

## Errors & retries

Methods return parsed JSON and throw `LbbError` (with `status`, `code`, `message`, `param`, `requestId`, `docUrl`) on any non-2xx response. Safe reads and idempotency-keyed writes retry `429`/`5xx` and network failures with full-jitter backoff, bounded by a retry budget (`retryBudgetMs`, default 60s) rather than a fixed count, and honor `Retry-After` — a terminal error the server marks non-retryable surfaces immediately. Use `rawRequest()` for response headers, request id, and retry/timing metadata.

## More

The `graph(...)` scope exposes `facts`, `search`, `entities`, `indexes`, `ontology`, `query`, `schema`, and `context` namespaces — covering managed embeddings, multi-query fusion, traversal, temporal state and history, SHACL, ontology evolution, and durable index jobs. Every generated shape is available as `Schemas["TypeName"]`.

Full reference and guides: [docs.littlebigbrain.com/sdks/typescript](https://docs.littlebigbrain.com/sdks/typescript/).

## Develop

```sh
npm install
npm run generate    # regenerate types from contracts/openapi.json
npm run typecheck
npm test
```
