import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LbbClient, LbbError, type FetchLike, type Schemas } from "./client.js";

const DATA_PLANE = "https://0abc1def--production.db.eu.littlebigbrain.com";
const API = "https://api.littlebigbrain.com";
const KEY = "lbb_sk_test_example";
const GRAPH = "c-5f1c9a0e3b7d2c4a8e6f1b0d";

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A fetch that records each call and answers from `replies` in order. */
function fakeFetch(replies: Reply[] = []): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...replies];
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url: new URL(input),
      headers: init?.headers ?? {},
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    });
    const reply = queue.shift() ?? {};
    const status = reply.status ?? 200;
    const headers = new Map(
      Object.entries(reply.headers ?? {}).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      },
      text: async () => JSON.stringify(reply.body ?? { ok: true }),
    };
  };
  return { fetch, calls };
}

function client(fetch: FetchLike, extra: { integrationsUrl?: string } = {}) {
  // A graph and stack scope on the client must not reach the integrations API.
  return new LbbClient({
    baseUrl: DATA_PLANE,
    apiKey: KEY,
    graph: "main",
    stack: "production",
    fetch,
    retryDelayMs: 0,
    ...extra,
  });
}

function only<T>(items: T[]): T {
  assert.equal(items.length, 1);
  return items[0] as T;
}

const status = { kind: "starting", detail: "The first sync starts soon." };

test("the integrations routes use integrationsUrl and the stack key", async () => {
  const { fetch, calls } = fakeFetch([
    {
      body: {
        ok: true,
        id: "hubspot",
        graph: GRAPH,
        kind: "hubspot",
        status,
      },
    },
  ]);
  const lbb = client(fetch);
  assert.equal(lbb.integrationsUrl, API);
  const created = await lbb.integrations.create({
    graph: GRAPH,
    id: "hubspot",
    kind: "hubspot",
    credentials: { HUBSPOT_TOKEN: "pat-eu1-example" },
  });
  assert.equal(created.status.kind, "starting");
  const call = only(calls);
  assert.equal(call.method, "POST");
  assert.equal(call.url.origin, API);
  assert.equal(call.url.pathname, "/v1/integrations/connections");
  assert.equal(call.url.search, "");
  assert.equal(call.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(call.body, {
    graph: GRAPH,
    id: "hubspot",
    kind: "hubspot",
    credentials: { HUBSPOT_TOKEN: "pat-eu1-example" },
  });
});

test("integrationsUrl is configurable and survives withScope", async () => {
  const { fetch, calls } = fakeFetch([{ body: { ok: true, connectors: [] } }]);
  const lbb = client(fetch, { integrationsUrl: "http://127.0.0.1:8787/" });
  assert.equal(lbb.integrationsUrl, "http://127.0.0.1:8787");
  await lbb.withScope({ graph: "other" }).integrations.connectors();
  assert.equal(
    only(calls).url.href,
    "http://127.0.0.1:8787/v1/integrations/connectors",
  );
});

test("create sends every option the caller sets, in the contract's names", async () => {
  const { fetch, calls } = fakeFetch();
  await client(fetch).integrations.create({
    graph: GRAPH,
    id: "linear",
    kind: "linear",
    credentials: { LINEAR_API_KEY: "lin_api_example" },
    config: { teams: ["ENG"] },
    everyMs: null,
    ontologyMode: "review",
    starter: "skip",
    start: false,
  });
  assert.deepEqual(only(calls).body, {
    graph: GRAPH,
    id: "linear",
    kind: "linear",
    credentials: { LINEAR_API_KEY: "lin_api_example" },
    config: { teams: ["ENG"] },
    everyMs: null,
    ontologyMode: "review",
    starter: "skip",
    start: false,
  });
});

test("reads put the graph in the query", async () => {
  const { fetch, calls } = fakeFetch();
  const lbb = client(fetch);
  await lbb.integrations.list({ graph: GRAPH });
  await lbb.integrations.get("hubspot", { graph: GRAPH });
  await lbb.integrations.delete("hubspot", { graph: GRAPH });
  assert.deepEqual(
    calls.map(
      (call) => `${call.method} ${call.url.pathname}${call.url.search}`,
    ),
    [
      `GET /v1/integrations/connections?graph=${GRAPH}`,
      `GET /v1/integrations/connections/hubspot?graph=${GRAPH}`,
      `DELETE /v1/integrations/connections/hubspot?graph=${GRAPH}`,
    ],
  );
  for (const call of calls) assert.equal(call.body, undefined);
});

test("writes put the graph in the body", async () => {
  const { fetch, calls } = fakeFetch();
  const lbb = client(fetch);
  await lbb.integrations.setCredentials("hubspot", {
    graph: GRAPH,
    credentials: { HUBSPOT_TOKEN: "pat-eu1-new" },
  });
  await lbb.integrations.setSettings("hubspot", {
    graph: GRAPH,
    config: { tickets: true },
  });
  await lbb.integrations.pause("hubspot", { graph: GRAPH });
  await lbb.integrations.resume("hubspot", { graph: GRAPH });
  assert.deepEqual(
    calls.map((call) => [call.method, call.url.pathname, call.body]),
    [
      [
        "PUT",
        "/v1/integrations/connections/hubspot/credentials",
        { graph: GRAPH, credentials: { HUBSPOT_TOKEN: "pat-eu1-new" } },
      ],
      [
        "PUT",
        "/v1/integrations/connections/hubspot/settings",
        { graph: GRAPH, config: { tickets: true } },
      ],
      ["POST", "/v1/integrations/connections/hubspot/pause", { graph: GRAPH }],
      ["POST", "/v1/integrations/connections/hubspot/resume", { graph: GRAPH }],
    ],
  );
});

test("sync sends the caller's Idempotency-Key", async () => {
  const turn = {
    number: 3,
    status: "queued",
    message_id: "api-sync-nightly-1",
  };
  const { fetch, calls } = fakeFetch([
    { body: { ok: true, id: "hubspot", graph: GRAPH, turn } },
  ]);
  const answer = await client(fetch).integrations.sync("hubspot", {
    graph: GRAPH,
    full: true,
    idempotencyKey: "nightly-1",
  });
  assert.deepEqual(answer.turn, turn);
  const call = only(calls);
  assert.equal(call.url.pathname, "/v1/integrations/connections/hubspot/sync");
  assert.equal(call.headers["idempotency-key"], "nightly-1");
  assert.deepEqual(call.body, { graph: GRAPH, full: true });
});

test("sync makes one key per call and retries under it", async () => {
  const { fetch, calls } = fakeFetch([
    {
      status: 503,
      headers: { "retry-after": "0" },
      body: { ok: false, error: "briefly busy", code: "data_plane_busy" },
    },
    { body: { ok: true } },
  ]);
  const lbb = client(fetch);
  await lbb.integrations.sync("hubspot", { graph: GRAPH });
  assert.equal(calls.length, 2);
  const [first, second] = calls as [Call, Call];
  const key = first.headers["idempotency-key"] ?? "";
  assert.match(key, /^[A-Za-z0-9_.-]{1,100}$/);
  assert.equal(second.headers["idempotency-key"], key);
  assert.deepEqual(first.body, { graph: GRAPH });
  await lbb.integrations.sync("hubspot", { graph: GRAPH });
  assert.notEqual(calls[2]?.headers["idempotency-key"], key);
});

test("erase names the graph in the path and confirms it", async () => {
  const { fetch, calls } = fakeFetch([
    {
      body: {
        ok: true,
        graph: GRAPH,
        connections_deleted: 1,
        graph_deleted: true,
        reclaims: [],
      },
    },
  ]);
  const erased = await client(fetch).integrations.erase(GRAPH, {
    confirm: GRAPH,
  });
  assert.equal(erased.connections_deleted, 1);
  const call = only(calls);
  assert.equal(call.method, "POST");
  assert.equal(call.url.origin, API);
  assert.equal(call.url.pathname, `/v1/integrations/graphs/${GRAPH}/erase`);
  assert.equal(call.url.search, `?confirm=${GRAPH}`);
  assert.equal(call.body, undefined);
});

test("an integrations error is an LbbError with its code and details", async () => {
  const conflicts = [{ term: "Deal", reason: "class Deal has another parent" }];
  const { fetch } = fakeFetch([
    {
      status: 409,
      body: {
        ok: false,
        error: "the graph holds a starter term differently",
        code: "starter_conflict",
        details: { conflicts },
      },
    },
  ]);
  await assert.rejects(
    client(fetch).integrations.create({
      graph: GRAPH,
      id: "hubspot",
      kind: "hubspot",
      credentials: { HUBSPOT_TOKEN: "pat-eu1-example" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof LbbError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "starter_conflict");
      assert.equal(error.message, "the graph holds a starter term differently");
      assert.deepEqual(error.details, { conflicts });
      return true;
    },
  );
});

test("a 429 carries Retry-After as retryAfterSeconds", async () => {
  const { fetch, calls } = fakeFetch([
    {
      status: 429,
      headers: { "Retry-After": "1800" },
      body: {
        ok: false,
        error: "at most 20 connections are created per stack and hour",
        code: "rate_limited",
      },
    },
  ]);
  await assert.rejects(
    client(fetch).integrations.create({
      graph: GRAPH,
      id: "hubspot",
      kind: "hubspot",
      credentials: { HUBSPOT_TOKEN: "pat-eu1-example" },
      retryBudgetMs: 1_000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof LbbError);
      assert.equal(error.status, 429);
      assert.equal(error.code, "rate_limited");
      assert.equal(error.retryAfterSeconds, 1800);
      return true;
    },
  );
  // A wait past the retry budget is not slept: the error comes at once.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url.origin, API);
});

test("a rate-limited read is retried after Retry-After", async () => {
  const { fetch, calls } = fakeFetch([
    {
      status: 429,
      headers: { "retry-after": "0" },
      body: {
        ok: false,
        error: "too many requests for this stack",
        code: "rate_limited",
      },
    },
    { body: { ok: true, graph: GRAPH, connections: [] } },
  ]);
  const listed = await client(fetch).integrations.list({ graph: GRAPH });
  assert.deepEqual(listed.connections, []);
  assert.equal(calls.length, 2);
});

test("a fault of the service is an LbbError without a code", async () => {
  const { fetch } = fakeFetch([
    { status: 500, body: { ok: false, error: "internal error" } },
  ]);
  await assert.rejects(
    client(fetch).integrations.connectors({ maxRetries: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof LbbError);
      assert.equal(error.status, 500);
      assert.equal(error.code, undefined);
      assert.equal(error.message, "internal error");
      return true;
    },
  );
});

test("suggestions are read from the data plane for one connection", async () => {
  const { fetch, calls } = fakeFetch([
    {
      body: {
        graph: { tenant: "t", graph: GRAPH },
        ontology_version: 4,
        counts: { open: 1, accepted: 0, dismissed: 0, superseded: 0 },
        suggestions: [],
        truncated: false,
      },
    },
  ]);
  await client(fetch).integrations.suggestions("hubspot", {
    graph: GRAPH,
    status: "open",
  });
  const call = only(calls);
  assert.equal(call.method, "GET");
  assert.equal(call.url.origin, DATA_PLANE);
  assert.equal(call.url.pathname, "/v1/ontology/suggestions");
  assert.equal(call.url.searchParams.get("graph"), GRAPH);
  assert.equal(call.url.searchParams.getAll("graph").length, 1);
  assert.equal(call.url.searchParams.get("origin_kind"), "integration");
  assert.equal(call.url.searchParams.get("origin_id"), "hubspot");
  assert.equal(call.url.searchParams.get("status"), "open");
  assert.equal(call.headers.authorization, `Bearer ${KEY}`);
});

function suggestion(overrides: Record<string, unknown> = {}) {
  return {
    suggestion_id: "s-deal",
    graph: { tenant: "t", graph: GRAPH },
    key: "integration:hubspot:deals",
    status: "accepted",
    title: "Add class Deal",
    anchor: "Deal",
    origin: { kind: "integration", id: "hubspot", label: "HubSpot" },
    change: [],
    revision: 2,
    created_at: "2026-10-03T00:00:00Z",
    updated_at: "2026-10-03T00:00:00Z",
    ...overrides,
  };
}

test("accept with sync sends the connection sync-after-<suggestion id>", async () => {
  const turn = { number: 7, status: "queued", message_id: "sync-after-s-deal" };
  const { fetch, calls } = fakeFetch([{ body: suggestion() }, { body: turn }]);
  const change: Schemas["OntologyEvolveOp"][] = [
    { op: "add_entity_type", name: "Deal" },
  ];
  const result = await client(fetch).integrations.accept("s-deal", {
    graph: GRAPH,
    change,
    sync: true,
  });
  assert.equal(result.suggestion.status, "accepted");
  assert.deepEqual(result.sync, turn);
  assert.equal(calls.length, 2);
  const [accept, message] = calls as [Call, Call];
  assert.equal(accept.method, "POST");
  assert.equal(accept.url.origin, DATA_PLANE);
  assert.equal(accept.url.pathname, "/v1/ontology/suggestions/accept");
  assert.equal(accept.url.searchParams.get("graph"), GRAPH);
  assert.equal(accept.url.searchParams.get("suggestion_id"), "s-deal");
  assert.deepEqual(accept.body, { change });
  assert.equal(message.method, "POST");
  assert.equal(message.url.origin, DATA_PLANE);
  assert.equal(message.url.pathname, "/v1/workflows/instances/message");
  assert.equal(message.url.searchParams.get("graph"), GRAPH);
  assert.deepEqual(message.body, {
    workflow_id: "hubspot",
    id: "sync-after-s-deal",
    message: { type: "sync" },
  });
});

test("accept sends no sync without sync: true or for an identity link", async () => {
  const { fetch, calls } = fakeFetch([
    { body: suggestion() },
    {
      body: suggestion({
        proposed_identities: [{ members: ["a", "b"] }],
      }),
    },
    { body: suggestion({ origin: { kind: "person", id: "ada" } }) },
  ]);
  const lbb = client(fetch);
  const plain = await lbb.integrations.accept("s-deal", { graph: GRAPH });
  assert.equal(plain.sync, null);
  const link = await lbb.integrations.accept("s-deal", {
    graph: GRAPH,
    sync: true,
  });
  assert.equal(link.sync, null);
  const person = await lbb.integrations.accept("s-deal", {
    graph: GRAPH,
    sync: true,
  });
  assert.equal(person.sync, null);
  assert.deepEqual(
    calls.map((call) => call.url.pathname),
    [
      "/v1/ontology/suggestions/accept",
      "/v1/ontology/suggestions/accept",
      "/v1/ontology/suggestions/accept",
    ],
  );
});

test("dismiss sends the reason to the data plane", async () => {
  const { fetch, calls } = fakeFetch([
    { body: suggestion({ status: "dismissed" }) },
  ]);
  await client(fetch).integrations.dismiss("s-deal", {
    graph: GRAPH,
    reason: "We track deals elsewhere.",
  });
  const call = only(calls);
  assert.equal(call.url.origin, DATA_PLANE);
  assert.equal(call.url.pathname, "/v1/ontology/suggestions/dismiss");
  assert.equal(call.url.searchParams.get("suggestion_id"), "s-deal");
  assert.deepEqual(call.body, { reason: "We track deals elsewhere." });
});

// Contract drift: every integrations route the client calls is a route of
// contracts/integrations-openapi.json with the contract's query and body
// fields, and every route of the contract has a client method.

interface Operation {
  parameters?: { name: string; in: string }[];
  requestBody?: {
    content: { "application/json": { schema: { $ref: string } } };
  };
}

interface Contract {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, { properties?: Record<string, unknown> }>;
  };
}

function findContract(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, "contracts/integrations-openapi.json");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) {
      throw new Error(
        "contracts/integrations-openapi.json not found in any ancestor",
      );
    }
    dir = parent;
  }
}

test("every integrations route matches contracts/integrations-openapi.json", async () => {
  const contract = JSON.parse(readFileSync(findContract(), "utf8")) as Contract;
  const operations = Object.entries(contract.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      key: `${method.toUpperCase()} ${path}`,
      pattern: new RegExp(`^${path.replace(/\{\w+\}/g, "[^/]+")}$`),
      method: method.toUpperCase(),
      operation,
    })),
  );
  const { fetch, calls } = fakeFetch();
  const api = client(fetch).integrations;
  await api.connectors();
  await api.cdcStatus("postgres", { graph: GRAPH });
  await api.cdcMuteAlerts("postgres", {
    graph: GRAPH,
    expectedRevision: 0,
    muted: true,
  });
  await api.cdcOverview({ graph: GRAPH });
  await api.cdcDiscovery("postgres", { graph: GRAPH });
  await api.cdcDiscover("postgres", {
    graph: GRAPH,
    jobId: "job_1",
    expectedRevision: 0,
    source: {
      hostname: "db.example.test",
      port: 5432,
      database: "source",
      publication: "lbb",
      slot: "lbb",
      tables: [{ schema: "public", table: "items" }],
    },
    credentials: { username: "cdc", password: "fixture" },
  });
  for (const method of ["cdcReviewDiscovery", "cdcApproveDiscovery"] as const)
    await api[method]("postgres", {
      graph: GRAPH,
      jobId: "job_1",
      graphEpoch: 1,
      expectedRevision: 2,
      catalogDigest: "a".repeat(64),
      mapping: {
        tables: {
          pg_42: {
            class_iri: "https://example.test/Item",
            properties: {},
            foreign_keys: [],
          },
        },
      },
      maxCaptureBytes: 1_000_000,
    });
  await api.cdcCancelDiscovery("postgres", {
    graph: GRAPH,
    jobId: "job_1",
    graphEpoch: 1,
    expectedRevision: 2,
  });
  await api.cdcControl("postgres", {
    graph: GRAPH,
    operationId: "retire",
    action: "retire",
    confirm: "postgres",
  });
  await api.create({
    graph: GRAPH,
    id: "hubspot",
    kind: "hubspot",
    credentials: { HUBSPOT_TOKEN: "pat-eu1-example" },
    config: {},
    everyMs: 3_600_000,
    ontologyMode: "auto",
    starter: "apply",
    start: true,
  });
  await api.list({ graph: GRAPH });
  await api.get("hubspot", { graph: GRAPH });
  await api.setCredentials("hubspot", {
    graph: GRAPH,
    credentials: { HUBSPOT_TOKEN: "x" },
  });
  await api.setSettings("hubspot", { graph: GRAPH, config: {} });
  await api.sync("hubspot", { graph: GRAPH, full: false });
  await api.pause("hubspot", { graph: GRAPH });
  await api.resume("hubspot", { graph: GRAPH });
  await api.delete("hubspot", { graph: GRAPH });
  await api.erase(GRAPH, { confirm: GRAPH });

  const called = new Set<string>();
  for (const call of calls) {
    const matched = operations.find(
      (operation) =>
        operation.method === call.method &&
        operation.pattern.test(call.url.pathname),
    );
    assert.ok(
      matched,
      `${call.method} ${call.url.pathname} is not in the contract`,
    );
    called.add(matched.key);
    const queryNames = (matched.operation.parameters ?? [])
      .filter((parameter) => parameter.in === "query")
      .map((parameter) => parameter.name)
      .sort();
    assert.deepEqual(
      [...call.url.searchParams.keys()].sort(),
      queryNames,
      matched.key,
    );
    const ref =
      matched.operation.requestBody?.content["application/json"].schema.$ref;
    if (ref) {
      const schema = contract.components.schemas[ref.split("/").pop() ?? ""];
      const allowed = Object.keys(schema?.properties ?? {}).sort();
      assert.deepEqual(
        Object.keys(call.body as object).sort(),
        allowed,
        matched.key,
      );
    } else {
      assert.equal(call.body, undefined, matched.key);
    }
  }
  assert.deepEqual(
    [...called].sort(),
    operations.map((operation) => operation.key).sort(),
  );
});

test("CDC controls retry one durable operation at the integrations host without inheriting graph scope", async () => {
  const { fetch, calls } = fakeFetch([
    { status: 503 },
    { body: { ok: true, operation: { id: "pause", status: "pending" } } },
  ]);
  const result = await client(fetch).integrations.cdcControl("source/one", {
    graph: GRAPH,
    operationId: "pause",
    action: "pause_capture",
  });
  assert.equal(result.operation.status, "pending");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url.origin, API);
    assert.equal(
      call.url.pathname,
      "/v1/integrations/connections/source%2Fone/cdc/control",
    );
    assert.equal(call.url.search, "");
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(call.body, {
      graph: GRAPH,
      operation_id: "pause",
      action: "pause_capture",
    });
  }
  await client(fetch).integrations.cdcStatus("postgres", { graph: GRAPH });
  assert.equal(
    calls[2].url.href,
    `${API}/v1/integrations/connections/postgres/cdc?graph=${GRAPH}`,
  );
});

test("CDC discovery retries the exact job and credentials, then cancels under its graph epoch", async () => {
  const { fetch, calls } = fakeFetch([
    { status: 503 },
    { body: { ok: true, created: false } },
  ]);
  const source = {
    hostname: "db.example.test",
    port: 5432,
    database: "source",
    publication: "lbb",
    slot: "lbb",
    tables: [{ schema: "public", table: "items" }],
  };
  const credentials = { username: "cdc", password: "fixture" };
  await client(fetch).integrations.cdcDiscover("postgres", {
    graph: GRAPH,
    jobId: "job_1",
    expectedRevision: 0,
    source,
    credentials,
  });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(
      call.url.href,
      `${API}/v1/integrations/connections/postgres/cdc/discovery`,
    );
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(call.body, {
      graph: GRAPH,
      job_id: "job_1",
      expected_revision: 0,
      source,
      credentials,
    });
  }
  await client(fetch).integrations.cdcCancelDiscovery("postgres", {
    graph: GRAPH,
    jobId: "job_1",
    graphEpoch: 4,
    expectedRevision: 2,
  });
  assert.deepEqual(calls[2].body, {
    graph: GRAPH,
    job_id: "job_1",
    graph_epoch: 4,
    expected_revision: 2,
  });
});

test("CDC approval retries the unchanged reviewed body with the stack key at the integrations host", async () => {
  const { fetch, calls } = fakeFetch([{ status: 503 }, { body: { ok: true } }]);
  const input = {
    graph: GRAPH,
    jobId: "job",
    graphEpoch: 3,
    expectedRevision: 4,
    catalogDigest: "a".repeat(64),
    mapping: {
      tables: {
        pg_42: {
          class_iri: "https://example.test/Item",
          properties: {},
          foreign_keys: [],
        },
      },
    },
    maxCaptureBytes: 1_000_000,
  };
  await client(fetch).integrations.cdcApproveDiscovery("postgres", input);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(
      call.url.href,
      `${API}/v1/integrations/connections/postgres/cdc/discovery/approve`,
    );
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(call.body, {
      graph: GRAPH,
      job_id: "job",
      graph_epoch: 3,
      expected_revision: 4,
      catalog_digest: input.catalogDigest,
      mapping: input.mapping,
      max_capture_bytes: 1_000_000,
    });
  }
  await client(fetch).integrations.cdcReviewDiscovery("postgres", input);
  assert.equal(
    calls[2].url.pathname,
    "/v1/integrations/connections/postgres/cdc/discovery/review",
  );
  assert.deepEqual(calls[2].body, calls[0].body);
});
