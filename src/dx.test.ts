import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LbbClient,
  type Entity,
  type FetchLike,
  type SearchRequest,
  type SearchResponse,
} from "./index.js";

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
} {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetch: FetchLike = async (url, init) => {
    urls.push(url);
    headers.push(init?.headers ?? {});
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
  return { fetch, urls, headers };
}

test("preferred namespaces make context, ontology, and query operations discoverable", async () => {
  const { fetch, urls } = queuedFetch([
    { body: { answer: "grounded" } },
    { body: { classes: [] } },
    { body: { snapshot: {}, vars: [], solutions: [] } },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  await client.context.ask({ question: "what changed?" });
  await client.ontology.view({ counts: true });
  await client.query.structured({ patterns: [], select: [] });

  assert.deepEqual(urls, [
    "http://h/v1/ask",
    "http://h/v1/ontology?counts=true",
    "http://h/v1/query/sparql",
  ]);
});

test("context namespace covers completion, resolution, decoding, and groundability", async () => {
  const { fetch, urls } = queuedFetch([
    { body: {} },
    { body: {} },
    { body: {} },
    { body: {} },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  await client.context.suggest({ prefix: "wri" });
  await client.context.resolve({ text: "writes" });
  await client.context.decode({
    source: { name: "auth" },
    target: { name: "db" },
  });
  await client.context.groundability({ sample: 25 });

  assert.deepEqual(urls, [
    "http://h/v1/search/suggest",
    "http://h/v1/search/resolve-term",
    "http://h/v1/decode",
    "http://h/v1/graph/groundability?sample=25",
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

test("graph namespace covers managed embedding lifecycle routes", async () => {
  const { fetch, urls } = queuedFetch([
    { body: {} },
    { body: {} },
    { body: { job_id: "job-1", status: "succeeded", result: {} } },
    { body: {} },
  ]);
  const graph = new LbbClient({ baseUrl: "http://h", fetch }).graph("main");

  await graph.embeddingConfig();
  await graph.setEmbeddingConfig({ model_id: "m", dim: 384 });
  await graph.backfillEmbeddings({ batchSize: 64, limit: 1000, full: true });
  await graph.promoteEmbedding({ runId: "run-1", allowRegression: true });

  assert.deepEqual(urls, [
    "http://h/v1/graph/embedding?graph=main",
    "http://h/v1/graph/embedding?graph=main",
    "http://h/v1/graph/embedding/backfill-jobs?graph=main",
    "http://h/v1/graph/embedding/promote?graph=main&run_id=run-1&allow_regression=true",
  ]);
});

test("query namespace covers parsed, raw, analytical, SHACL, and inference reads", async () => {
  const sparqlEnvelope = {
    results: JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }),
  };
  const { fetch, urls } = queuedFetch([
    { body: sparqlEnvelope },
    { body: sparqlEnvelope },
    { body: {} },
    { body: {} },
    { body: {} },
    { body: {} },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  const parsed = await client.query.sparql({
    query: "SELECT * WHERE { ?s ?p ?o }",
  });
  await client.query.sparqlRaw({ query: "ASK { ?s ?p ?o }" });
  await client.query.analytics({} as never);
  await client.query.shacl({} as never);
  await client.query.infer({} as never);
  await client.query.premises({} as never);

  assert.deepEqual(parsed.rows, []);
  assert.deepEqual(urls, [
    "http://h/v1/query/sparql-text",
    "http://h/v1/query/sparql-text",
    "http://h/v1/query/analytics",
    "http://h/v1/query/shacl",
    "http://h/v1/inference/run",
    "http://h/v1/inference/retrieval-premises",
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

  await client.context.suggest({ prefix: "wri" });

  assert.deepEqual(urls, [
    "http://h/v1/search/suggest",
    "http://h/v1/search/suggest",
  ]);
});

test("graph scope carries the preferred namespaces", async () => {
  const { fetch, urls } = queuedFetch([
    { body: { entities: [], assertions: [] } },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  await client
    .graph("support", { branch: "review" })
    .search.hybrid("refund policy");

  assert.equal(
    urls[0],
    "http://h/v1/search?graph=support&branch=review&query=refund%20policy",
  );
});

test("entity iteration follows cursors and yields rows instead of envelopes", async () => {
  const page = (id: string, hasMore: boolean, nextCursor: string | null) => ({
    object: "list",
    data: [{ id, entity_type: "SERVICE", name: id }],
    has_more: hasMore,
    next_cursor: nextCursor,
    snapshot: { commit_seq: 7, indexed_seq: 7 },
    total_count: 2,
  });
  const { fetch, urls } = queuedFetch([
    { body: page("a", true, "cursor-2") },
    { body: page("b", false, null) },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  const names: string[] = [];
  for await (const entity of client.entities.iterate({ limit: 1 }))
    names.push(entity.name);

  assert.deepEqual(names, ["a", "b"]);
  assert.equal(urls[1], "http://h/v1/graph/entities?limit=1&cursor=cursor-2");
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
  const request: SearchRequest = { query: "identity" };
  const response = {
    entities: [],
    assertions: [],
  } as unknown as SearchResponse;
  const entity = { id: "e1", entity_type: "SERVICE", name: "auth" } as Entity;

  assert.equal(request.query, "identity");
  assert.equal(response.entities.length, 0);
  assert.equal(entity.name, "auth");
});
