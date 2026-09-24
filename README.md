# @littlebigbrain/client

TypeScript client for [little big brain](https://littlebigbrain.com), a search
platform for AI applications such as chatbots, search tools, and agents.
Load facts, query their relationships, and keep the data version behind an answer
so you can check it later.

The client has no runtime dependencies and includes generated request and response
types. It uses `fetch` and supports Node.js 18+, browsers, and edge workers.
Keep stack API keys on your server or local machine, outside browser bundles.

[Documentation](https://docs.littlebigbrain.com/sdks/typescript/) ·
[Quickstart](https://docs.littlebigbrain.com/start/quickstart/) ·
[Issues](https://github.com/littlebigbrains/lbb-typescript/issues)

## Install

```sh
npm install @littlebigbrain/client
```

## Load facts and run a query

Create a stack in the [console](https://cloud.littlebigbrain.com) and open
**Connect**. Copy its complete endpoint and a stack API key:

```sh
export LBB_URL="https://<your-complete-stack-host>"
export LBB_API_KEY="<your-stack-api-key>"
```

This example creates a graph named `quickstart` on its first write. It stores
three facts: a service writes to a database, and each has a label. The data uses
Resource Description Framework (RDF), where each line names a subject, a
relationship, and a value or another record. SPARQL is the query language for
those facts.

Save as `quickstart.mts`, then run `npx tsx quickstart.mts`:

```ts
import { LbbClient } from "@littlebigbrain/client";

const lbb = new LbbClient({
  baseUrl: process.env.LBB_URL!,
  apiKey: process.env.LBB_API_KEY!,
  graph: "quickstart",
});

const facts = `
<https://example.org/auth-service> <https://example.org/writesTo> <https://example.org/user-db> .
<https://example.org/auth-service> <http://www.w3.org/2000/01/rdf-schema#label> "Auth Service" .
<https://example.org/user-db> <http://www.w3.org/2000/01/rdf-schema#label> "User Database" .
`;

const imported = await lbb.graph("quickstart").facts.importRdf(facts, {
  format: "ntriples",
  idempotencyKey: "sdk-quickstart-v1",
});
const commitSeq = imported.committed_commit_seq;
if (commitSeq == null) throw new Error("The import did not return a commit sequence.");

const query = `
  SELECT ?service ?database WHERE {
    ?s <https://example.org/writesTo> ?db .
    ?s <http://www.w3.org/2000/01/rdf-schema#label> ?service .
    ?db <http://www.w3.org/2000/01/rdf-schema#label> ?database .
  } ORDER BY ?service ?database LIMIT 10
`;

const { rows } = await lbb.sparqlRows(
  { query },
  { consistency: "strong", minIndexedSeq: commitSeq },
);

for (const row of rows) console.log(`${row.service} -> ${row.database}`);
```

On a fresh graph, this prints:

```text
Auth Service -> User Database
```

The query follows the stored relationship between the service and database.
`consistency: "strong"` makes the new facts available to this read without
waiting for a background index job. Reads default to eventual consistency, so
omit this option only when an earlier version is acceptable.

The idempotency key makes repeating the same import safe. Use a new key if you
change the data.

## Read the same version again

Run the query at the commit returned by the import:

```ts
const replay = await lbb.sparqlRows({
  query,
  as_of_commit_seq: commitSeq,
});
console.log(replay.rows);
```

Save the query, its options, and the commit sequence with any answer you need to
check later. See [history and replay](https://docs.littlebigbrain.com/guides/time-travel-audit/)
for retention and evidence handling.

## Next steps

- [Search by meaning](https://docs.littlebigbrain.com/guides/search-by-meaning/): choose which facts to embed and find records from a text description.
- [Load your own RDF](https://docs.littlebigbrain.com/guides/load-rdf/): import Turtle, N-Triples, N-Quads, or TriG.
- [Work with JSON records](https://docs.littlebigbrain.com/guides/without-rdf/): define a schema and write records without writing RDF.
- [Validate writes](https://docs.littlebigbrain.com/guides/sparql-and-shacl/): define constraints with the Shapes Constraint Language (SHACL).

The RDF and JSON guides use different write workflows. Choose one when creating
a graph; a graph first written through RDF import does not accept
`facts.create` or JSON record imports.

## Errors and retries

Failed HTTP requests throw `LbbError`, with a status, error code, message, and
request ID. Use `rawRequest()` when you also need response headers or timing.

Safe reads and writes with an idempotency key retry rate limits, retryable server
errors, and network failures. Retries respect `Retry-After` and use a 60-second
budget by default. See the [client reference](https://docs.littlebigbrain.com/sdks/typescript/)
for timeout and retry options.

## Development

From a clone of this repository:

```sh
npm ci
npm run typecheck
npm test
```

The request and response types are generated from the API contract. See
[CONTRIBUTING.md](CONTRIBUTING.md) for changes to generated types.

## License

[Apache-2.0](LICENSE).
