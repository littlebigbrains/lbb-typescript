# @littlebigbrain/client

TypeScript client for the [little big brain](https://littlebigbrain.com) graph + hybrid search HTTP
API. Request and response types are generated from the committed
[`contracts/openapi.json`](https://github.com/littlebigbrains/lbb-typescript/blob/main/contracts/openapi.json) (the single source of
truth, derived from the Rust `lbb-api` types); the client itself is a thin,
dependency-free wrapper over the platform `fetch`.

```sh
npm install @littlebigbrain/client
```

## Usage

```ts
import { LbbClient, LbbError } from "@littlebigbrain/client";

const lbb = new LbbClient({
  baseUrl: "https://db.eu.littlebigbrain.com",
  apiKey: process.env.LBB_API_KEY, // lbb_sk_test_… or lbb_sk_live_…
});

const graph = lbb.graph("main");

await graph.facts.create({
  triplets: [
    {
      source: { type: "SERVICE", name: "auth-service" },
      relation: "WRITES_TO",
      target: { type: "DATABASE", name: "user-db" },
      confidence: 0.93,
      evidence: "auth-service writes identity records to user-db",
    },
  ],
}, {
  idempotencyKey: "import-2026-06-13",
});

await graph.indexes.run({ wait: true });

const results = await graph.search.hybrid("which systems store customer identity data", {
  topK: 5,
  source: "persisted",
  consistency: "strong",
  targets: ["entities", "assertions"],
});
for (const assertion of results.assertions ?? []) {
  console.log(assertion.relation?.name, assertion.score);
}
```

Use `client.graph("name")` to scope graph writes and `client.rawRequest(...)`
when you need response metadata (`requestId`, `version`, headers). Every method
returns parsed JSON and throws `LbbError` with `status`, `type`, `code`,
`message`, `param`, `requestId`, and `docUrl` on a non-2xx response.

Requests have a 120-second per-attempt timeout by default (`timeoutMs: 0`
disables it). Safe reads and idempotency-keyed writes retry `429`/`5xx` and
network failures up to twice, honoring `Retry-After` with a one-minute cap.
Bulk NDJSON and RDF imports receive an idempotency key automatically unless you
provide one explicitly. The preferred namespaced surface accepts the same final
request options everywhere: `timeoutMs`, `maxRetries`, `signal`, `headers`, and
`idempotencyKey` for mutations.

## Preferred surface

Scope once with `client.graph("name", { branch })`; its `facts`, `search`,
`entities`, `indexes`, `schema`, `ontology`, `query`, and `context` namespaces
all carry that graph and branch. The original flat methods remain available for
compatibility.

```ts
const graph = lbb.graph("main", { branch: "review" });

const answer = await graph.context.ask({ question: "what stores identity data?" });
const ontology = await graph.ontology.view({ counts: true });
const rows = await graph.query.sparql({ query: "SELECT ?s WHERE { ?s ?p ?o }" });

for await (const entity of graph.entities.iterate({ fields: ["owner", "status"] })) {
  console.log(entity.name, entity.attributes);
}
```

Use `entities.pages(...)` when page metadata matters, or `entities.iterate(...)`
to yield rows directly. Both follow the server cursor and fail if a cursor
repeats instead of looping forever.

For instrumentation, `onRequest` fires before each attempt and `onResponse`
fires once for the final response; neither event contains bodies or
credentials. `rawRequest(...)` additionally reports `attempts`, `retryCount`,
and `elapsedMs`.

## Methods

| Area | Methods |
| --- | --- |
| Write | `graph("main").facts.create` |
| Search | `search.hybrid`, `search.multi`, `search.fullText`, `search.vector` |
| Context substrate | `context.ask`, `context.suggest`, `context.resolve`, `context.decode`, `context.groundability` |
| Search feedback (training data) | `search.feedback`, `search.feedbackExport` |
| Traversal | `traverse`, `semanticTraverse` |
| Temporal / lineage / shapes | `currentState`, `history`, `why`, `shacl` |
| Query | `query.sparql`, `query.structured`, `query.analytics`, `query.shacl`, `query.infer`, `query.premises` |
| Ontology | `ontology.view`, `ontology.conformance`, `ontology.search`, `ontology.resolve`, `ontology.define`, `ontology.evolve` |
| Index lifecycle | `indexes.run`, `indexes.build`, `indexes.delta`, `indexes.gc`, `compact` |
| Inspection | `entities.list`, `entities.filterByAttributes`, `status`, `metadata`, `summary` |
| Schema activation | `schema.view`, `schema.preview`, `schema.publish`, `schema.audit` |

Common request/response shapes have direct imports such as `SearchRequest`,
`SearchResponse`, `Entity`, `GraphSummary`, `CommitRequest`, `AskResponse`, and
`SchemaView`. Every generated shape remains available as `Schemas["TypeName"]`;
the raw `components`, `paths`, and `operations` are exported too.

## SPARQL

`client.sparqlRows(...)` runs a SPARQL 1.1 text query (SELECT or ASK) and
returns parsed results, so you never have to `JSON.parse` the results string or
zip `head.vars` with binding values yourself:

```ts
const { vars, rows } = await client.sparqlRows({
  query: `SELECT ?service ?db WHERE {
            ?service <https://littlebigbrain.com/r/writes_to> ?db
          } LIMIT 10`,
  reason: true, // optional: fold in rule-derived edges
});
for (const row of rows) console.log(row.service, "->", row.db);

const exists = (await client.sparqlRows({ query: "ASK { ?s ?p ?o }" })).boolean;
```

For app code that already has relation patterns but just needs typed attribute
predicates, `client.entities.filterByAttributes(...)` builds the structured
SPARQL filter body without exposing RDF property IRIs:

```ts
await client.entities.filterByAttributes({
  patterns: [{ subject: { var: "service" }, predicate: "WRITES_TO", object: { var: "db" } }],
  where: [{ field: "slo", op: "ge", value: 0.99 }, { var: "db", field: "tier", value: "prod" }],
  select: ["service"],
});
```

`sparqlRows` returns `{ vars, boolean, bindings, rows }`: `rows` is the bindings
flattened to `{ variable: lexicalValue }`, `bindings` keeps the raw typed term
objects, and `boolean` is the ASK answer (or `null` for a SELECT). `client.sparqlText(...)`
returns the unparsed envelope, and the standalone `parseSparqlResults(response)`
helper (also exported) parses it. For the structured BGP form use
`client.sparql(body)` (`SparqlSelectRequest`).

A standalone stack also serves the **native SPARQL 1.1 Protocol** at `/sparql`
(`GET ?query=`, `POST` form or `application/sparql-query` body,
`Accept`-negotiated JSON/XML/CSV/TSV) for off-the-shelf SPARQL clients (YASGUI,
Protégé); `sparqlRows` returns parsed JSON rows for in-process use.

## Develop

```sh
npm install
npm run generate   # regenerate src/schema.ts from ../../contracts/openapi.json
npm run build      # tsc -> dist/
npm test           # build + node:test (mocked fetch)
npm run test:coverage
npm run pack:check # exact tarball: publint + ATTW
```

`runtime`: any environment with a global `fetch` (Node 18+, browsers, edge
workers), or pass your own via the `fetch` option.
