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

## Ask a question in plain words

`query.ask` answers a question about the graph in plain words. A router model
picks the kind of question. A reasoning model then runs queries in a loop,
reads their rows, and answers. The loop is bounded: a question takes about
8 s.

```ts
const result = await lbb.query.ask(
  "Which services write to the user database?",
  { context: "Services and databases of the platform team." },
);

console.log(result.answer);
console.log(result.citations); // the IRIs the answer names
for (const row of result.rows) console.log(row);
```

`citations` holds the IRIs the answer names; each one is in the rows the loop
read. `steps` lists the tool calls of the loop. `query` is the query whose rows
hold the answer, and `rows` hold its rows. `traceId` names the eval
trace of those rows, so you can label them. When the loop runs out of time,
`answer` is `null`, `error` says why, and `rows` hold the best rows it read.

`chart` says how to draw `rows`, or is `null`: `kind` is `bar`, `line`,
`scatter` or `table`, and `x`, `y` and `series` name columns of the rows. The
server checked the hint: the columns exist, and `y` holds numbers for `bar`
and `line` (`x` and `y` for `scatter`).

```ts
if (result.chart?.kind === "bar") {
  const { x, y } = result.chart;
  drawBars(result.rows.map((row) => [row[x!], Number(row[y!])]));
}
```

`{ mode: "route" }` returns only the kind of question, in about 0.25 s. No
query runs. Each call uses model tokens, so the client does not retry a failed
call.

The graph can keep notes and worked examples that the model reads for every
question. Store them with `query.setRewriteProfile({ notes, examples,
expected_version })` and read them with `query.rewriteProfile()`. A call's
`context` still adds notes for that call.

The server finds the names in the question ("Quelmann", "TU Dresden") in the
graph, and the queries use the IRIs it found. `result.linked` lists them, so
you can show "Did you mean …?". When the user has a record open, pass its IRI
in `anchor` (`{ anchor: [iri] }`, at most 10).

A question about a date ("Which findings were open on 18 June?") reads the
last commit written by the end of that day. `result.history` names the commit
and how the server found it. When your commits stand for other dates (a
demo's milestones, an import of old records), pass `timeline`:
`{ timeline: [{ date: "2026-06-18", as_of_commit_seq: 5, label: "Addendum" }] }`.
A question that asks what changed compares two points.
`result.history.added`, `removed` and `changed` hold what differs, and
`result.history.totals` counts each list. `query` is then the compared query,
read at the later point.

### Show progress

`query.askStream` takes the same arguments and yields an event for each stage.
The last event, `done`, holds the whole response.

```ts
const controller = new AbortController();
for await (const event of lbb.query.askStream(
  "Which services write to the user database?",
  { signal: controller.signal },
)) {
  if (event.event === "route") console.log("route", event.data.kind);
  if (event.event === "step") console.log(event.data.tool, event.data.rows);
  if (event.event === "done") console.log(event.data.answer?.text);
}
```

The events are `grounding`, `route`, a `step` per tool call, `answer` and
`done`. An error event throws the same `LbbError` as `query.ask`. Abort the
signal to stop the server's work. The client skips event names it does not
know.

### Tools for your own agent

When your app runs its own agent loop, four calls give it what only the
server knows. None calls a model.

```ts
// The IRI of a name, the person before a document with the name.
const { candidates } = await lbb.query.names({ text: "Summarize David Korn's deals" });
// The classes and properties a question needs: how many instances hold each
// property, and the values of small classes such as stages.
const { text } = await lbb.query.describe({ question: "Which deals moved stage?" });
// The commit of a date.
const { as_of_commit_seq } = await lbb.query.commitAt({ date: "2026-06-18" });
// What changed between two points, paired by entity.
const diff = await lbb.query.compare({
  query: "SELECT ?deal ?stage WHERE { ?deal <https://x.test/p/stage> ?stage }",
  before: { date: "2026-06-01" },
  key: ["deal"],
});
console.log(diff.totals, diff.changed, diff.next_cursor);
```

`compare` reads up to 20,000 rows per point and pages each list: pass
`next_cursor` back as `cursor` with the same request.

## Next steps

- [Search by meaning](https://docs.littlebigbrain.com/guides/search-by-meaning/): choose which facts to embed, find records from a text description, and search inside a SPARQL query with `search:similarTo`.
- [Load your own RDF](https://docs.littlebigbrain.com/guides/load-rdf/): import Turtle, N-Triples, N-Quads, or TriG.
- [Work with JSON records](https://docs.littlebigbrain.com/guides/without-rdf/): define a schema and write records without writing RDF.
- [Validate writes](https://docs.littlebigbrain.com/guides/sparql-and-shacl/): define constraints with the Shapes Constraint Language (SHACL).

The RDF and JSON guides use different write workflows. Choose one when creating
a graph; a graph first written through RDF import does not accept
`facts.create` or JSON record imports.

## Integrations for your customers

`client.integrations` connects each of your customers' HubSpot, Linear,
SharePoint or Google Drive to a graph of their own. Its routes are on the
integrations API, `https://api.littlebigbrain.com` by default
(`integrationsUrl`). They take the
same stack API key. An operator turns on developer access per stack; ask us
first.

```ts
const graph = "c-5f1c9a0e3b7d2c4a8e6f1b0d"; // one opaque graph per customer

await lbb.integrations.create({
  graph,
  id: "hubspot",
  kind: "hubspot",
  credentials: { HUBSPOT_TOKEN: token },
});
const { connections } = await lbb.integrations.list({ graph });
const open = await lbb.integrations.suggestions("hubspot", { graph, status: "open" });
await lbb.integrations.accept(open.suggestions[0].suggestion_id, { graph, sync: true });
await lbb.integrations.erase(graph, { confirm: graph });
```

Google Drive connects through your own Google app. `googleDrive` builds the
consent URL and turns the callback's code into the connection's credentials:

```ts
import { googleDrive } from "@littlebigbrain/client";

const url = googleDrive.authorizeUrl({ clientId, redirectUri, state });
// On the callback, after `state` matches:
const { credentials } = await googleDrive.exchangeCode({
  clientId,
  clientSecret,
  redirectUri,
  code,
});
await lbb.integrations.create({ graph, id: "google-drive", kind: "google_drive", credentials });
```

See [Integrations for your customers](https://docs.littlebigbrain.com/guides/integrations-for-your-customers/).

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
