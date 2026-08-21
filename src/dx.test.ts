import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, type Entity, type FetchLike } from "./index.js";

function queuedFetch(
  payloads: Array<{
    status?: number;
    body: unknown;
    headers?: Record<string, string>;
  }>,
): {
  fetch: FetchLike;
  urls: string[];
  headers: Array<Record<string, string>>;
  bodies: Array<string | undefined>;
} {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const bodies: Array<string | undefined> = [];
  const fetch: FetchLike = async (url, init) => {
    urls.push(url);
    headers.push(init?.headers ?? {});
    bodies.push(typeof init?.body === "string" ? init.body : undefined);
    const next = payloads.shift() ?? { body: {} };
    const responseHeaders = new Map(
      Object.entries(next.headers ?? {}).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name) => responseHeaders.get(name.toLowerCase()) ?? null,
      },
      text: async () => JSON.stringify(next.body),
    };
  };
  return { fetch, urls, headers, bodies };
}

test("preferred namespaces make entity, ontology, and query operations discoverable", async () => {
  const { fetch, urls } = queuedFetch([
    { body: { snapshot: {} } },
    { body: { classes: [] } },
    { body: { snapshot: {}, vars: [], solutions: [] } },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  await client.entities.get({ type: "SERVICE", name: "auth" });
  await client.ontology.view({ counts: true });
  await client.query.structured({ patterns: [], select: [] });

  assert.deepEqual(urls, [
    "http://h/v1/graph/entity/metadata?type=SERVICE&name=auth",
    "http://h/v1/ontology?counts=true",
    "http://h/v1/query/sparql",
  ]);
});

test("ontology namespace covers its complete read and lifecycle family", async () => {
  const { fetch, urls } = queuedFetch(
    Array.from({ length: 7 }, () => ({ body: {} })),
  );
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  await client.ontology.view();
  await client.ontology.conformance();
  await client.ontology.search({} as never);
  await client.ontology.resolve({} as never);
  await client.ontology.define({} as never);
  await client.ontology.evolve({} as never);
  await client.ontology.induce({} as never);

  assert.deepEqual(urls, [
    "http://h/v1/ontology",
    "http://h/v1/ontology/conformance",
    "http://h/v1/ontology/search",
    "http://h/v1/ontology/resolve",
    "http://h/v1/ontology/define",
    "http://h/v1/ontology/evolve",
    "http://h/v1/ontology/induce",
  ]);
});

test("query namespace covers the parsed and raw SPARQL reads", async () => {
  const sparqlEnvelope = {
    results: JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }),
  };
  const { fetch, urls } = queuedFetch([
    { body: sparqlEnvelope },
    { body: sparqlEnvelope },
    { body: { snapshot: {}, vars: [], solutions: [] } },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  const parsed = await client.query.sparql({
    query: "SELECT * WHERE { ?s ?p ?o }",
  });
  await client.query.sparqlRaw({ query: "ASK { ?s ?p ?o }" });
  await client.query.structured({ patterns: [], select: [] });

  assert.deepEqual(parsed.rows, []);
  assert.deepEqual(urls, [
    "http://h/v1/query/sparql-text",
    "http://h/v1/query/sparql-text",
    "http://h/v1/query/sparql",
  ]);
});

test("read-only POST namespaces retry safely without an idempotency key", async () => {
  const { fetch, urls } = queuedFetch([
    { status: 503, body: { error: { message: "retry" } } },
    { body: {} },
  ]);
  const client = new LbbClient({
    baseUrl: "http://h",
    fetch,
    maxRetries: 1,
    retryDelayMs: 0,
  });

  await client.ontology.search({} as never);

  assert.deepEqual(urls, [
    "http://h/v1/ontology/search",
    "http://h/v1/ontology/search",
  ]);
});

test("graph scope carries the preferred namespaces", async () => {
  const { fetch, urls } = queuedFetch([
    { body: { snapshot: {}, vars: [], solutions: [] } },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  await client
    .graph("support", { branch: "review" })
    .query.structured({ patterns: [], select: [] });

  assert.equal(urls[0], "http://h/v1/query/sparql?graph=support&branch=review");
});

test("request hooks and raw metadata expose retries without exposing bodies", async () => {
  const events: string[] = [];
  const { fetch, headers } = queuedFetch([
    { status: 503, body: { error: { message: "retry" } } },
    { body: { ok: true }, headers: { "x-request-id": "req_dx" } },
  ]);
  const client = new LbbClient({
    baseUrl: "http://h",
    fetch,
    retryDelayMs: 0,
    onRequest: (event) => events.push(`request:${event.attempt}`),
    onResponse: (event) =>
      events.push(`response:${event.status}:${event.attempts}`),
  });

  const response = await client.rawRequest<{ ok: boolean }>("GET", "/health", {
    maxRetries: 1,
    headers: { "x-client-trace": "trace-1" },
  });

  assert.equal(response.data.ok, true);
  assert.equal(response.requestId, "req_dx");
  assert.equal(response.attempts, 2);
  assert.equal(response.retryCount, 1);
  assert.ok(response.elapsedMs >= 0);
  assert.equal(headers[0]["x-client-trace"], "trace-1");
  assert.deepEqual(events, ["request:1", "request:2", "response:200:2"]);
});

test("friendly named aliases describe the common generated types", () => {
  const entity = { id: "e1", entity_type: "SERVICE", name: "auth" } as Entity;

  assert.equal(entity.name, "auth");
});

test("A5: the read-your-writes loop — commitSeq surfaces and minIndexedSeq threads", async () => {
  const { fetch, urls, bodies } = queuedFetch([
    { body: { commit_seq: 128, snapshot_token: "t", op_count: 1 } },
    { body: { snapshot: {}, vars: [], solutions: [] } },
    { body: { snapshot: {} } },
  ]);
  const lbb = new LbbClient({
    baseUrl: "https://s--p.db.eu.littlebigbrain.com",
    fetch,
  });

  // commit surfaces the committed sequence as `commitSeq`.
  const { commitSeq } = await lbb.commit({ triplets: [] });
  assert.equal(commitSeq, 128);

  // The floor threads onto the structured-SPARQL body as `min_indexed_seq`.
  await lbb.sparql({ patterns: [] }, { minIndexedSeq: commitSeq });
  const sparqlBody = JSON.parse(bodies[1] ?? "{}");
  assert.equal(sparqlBody.min_indexed_seq, 128);

  // On the summary (URL) route the floor rides the query string.
  await lbb.summary({ minIndexedSeq: commitSeq });
  assert.ok(
    urls[2].includes("min_indexed_seq=128"),
    `summary URL should carry the floor: ${urls[2]}`,
  );
});

test("A5: defaultConsistency applies when a call omits it, and a per-call value wins", async () => {
  const { fetch, urls, bodies } = queuedFetch([
    { body: { snapshot: {}, vars: [], solutions: [] } },
    { body: { snapshot: {}, vars: [], solutions: [] } },
    { body: { snapshot: {} } },
    { body: { conforms: true, result_count: 0 } },
  ]);
  const lbb = new LbbClient({
    baseUrl: "https://s--p.db.eu.littlebigbrain.com",
    fetch,
    defaultConsistency: "strong",
  });

  // The structured-SPARQL body inherits the client default.
  await lbb.sparql({ patterns: [] });
  assert.equal(JSON.parse(bodies[0] ?? "{}").consistency, "strong");

  // A per-call consistency wins over the client default.
  await lbb.sparql({ patterns: [] }, { consistency: "eventual" });
  assert.equal(JSON.parse(bodies[1] ?? "{}").consistency, "eventual");

  // The default also reaches artifact-backed URL routes.
  await lbb.summary();
  assert.ok(
    urls[2].includes("consistency=strong"),
    `summary URL should carry the default: ${urls[2]}`,
  );
  await lbb.ontologyConformance();
  assert.ok(
    urls[3].includes("consistency=strong"),
    `conformance URL should carry the default: ${urls[3]}`,
  );
});
