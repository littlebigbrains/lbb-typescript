# @littlebigbrain/client

Typed TypeScript client for little big brain: ingest, BM25/vector/graph index,
authorized hybrid search, traversal, ontology, feedback, and training jobs.
Runs on Node 18+, browsers, and edge workers using the platform `fetch`.

```sh
npm install @littlebigbrain/client
```

## Five-minute start

```ts
import { LbbClient } from "@littlebigbrain/client";

const lbb = new LbbClient({
  baseUrl: "https://db.eu.littlebigbrain.com",
  apiKey: process.env.LBB_API_KEY,
});
const graph = lbb.graph("main");

await graph.facts.create({
  triplets: [{
    source: { type: "CONCEPT", name: "policy-42" },
    relation: "RELATED_TO",
    target: { type: "CONCEPT", name: "seven-year retention" },
    evidence: "Customer records are retained for seven years.",
  }],
}, { idempotencyKey: "policy-42-v1" });

await graph.indexes.run({ wait: true });

const results = await graph.search.hybrid(
  "How long are customer records retained?",
  { topK: 10, source: "persisted", consistency: "strong" },
);
```

Methods return parsed JSON and throw `LbbError` on non-2xx responses. Safe
reads and idempotency-keyed writes retry transient failures and honor
`Retry-After`. Keep live stack keys on the server, never in browser bundles.

## Enterprise search integrations

Keep the host product's users, connectors, tasks, and cursors in its existing
database. Put searchable documents, passages, facts, embeddings, indexes,
feedback, and model runs in little big brain:

1. Give every document/chunk/passage a stable external key.
2. Bulk-import content, provenance, and native ACL/tag/project sets.
3. Configure managed embeddings; build ANN, BM25, and adjacency once per batch.
4. Filter by ACL inside the search request before ranking and return projected
   fields on the ranked hits.
5. Grade cited results, reconnect to durable trainer jobs, and require a
   held-out quality plus latency gate before promotion.

The [enterprise-search integration guide](https://docs.littlebigbrain.com/guides/enterprise-search/)
contains the graph model, migration sequence, and acceptance tests.

## Main surface

```ts
graph.facts.create(...)
graph.facts.import(...)
graph.search.hybrid(...)
graph.entities.iterate(...)
graph.context.ask(...)
graph.ontology.view(...)
graph.query.sparql(...)
graph.schema.audit(...)
```

Other focused methods cover managed embeddings, full-text/vector search,
multi-query fusion, traversal, temporal state/history, SHACL, ontology
evolution, feedback, indexing, and graph inspection. Request/response types are
generated from `contracts/openapi.json`; common aliases and the complete
`Schemas` map are exported from the package.

Use `rawRequest()` when you need response headers, request ID, retry count, or
elapsed time. `onRequest` and `onResponse` provide body-free instrumentation.

## SPARQL

```ts
const { rows } = await lbb.sparqlRows({
  query: `SELECT ?doc WHERE { ?doc ?p ?o } LIMIT 10`,
});
```

`sparqlRows` parses SELECT/ASK results. The native SPARQL 1.1 Protocol is also
available at `/sparql` for standard RDF clients.

## Develop

```sh
npm install
npm run generate
npm run typecheck
npm test
npm run pack:check
```
