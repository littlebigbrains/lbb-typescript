import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, type FetchLike } from "./client.js";

test("optional catalog helpers preserve graph scope, cursors and idempotency", async () => {
  const seen: {
    url: URL;
    method?: string;
    body: unknown;
    headers?: Record<string, string>;
  }[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({
      url: new URL(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: init?.headers,
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () =>
        JSON.stringify({ items: [], next_cursor: "opaque+/=", scanned: 0 }),
    };
  };
  const client = new LbbClient({
    baseUrl: "https://example.test",
    graph: "project",
    environment: "prod",
    fetch,
  });
  await client.catalog.createNamespace(
    { name: "customer" },
    { idempotencyKey: "create-customer" },
  );
  await client.catalog.adoptGraph(
    { expected_graph_epoch: "3", owner_id: "ns_stable" },
    { idempotencyKey: "adopt-project" },
  );
  const first = await client.catalog.graphs({ limit: 1 });
  assert.equal(first.items.length, 0);
  await client.catalog.graphs({
    cursor: first.next_cursor ?? undefined,
    limit: 1,
  });
  await client.catalog.resolve("customer/projects");
  assert.equal(seen[0].headers?.["idempotency-key"], "create-customer");
  assert.deepEqual(seen[1].body, {
    expected_graph_epoch: "3",
    owner_id: "ns_stable",
  });
  assert.equal(seen[1].headers?.["idempotency-key"], "adopt-project");
  assert.equal(seen[3].url.searchParams.get("cursor"), "opaque+/=");
  assert.equal(seen[4].url.searchParams.get("path"), "customer/projects");
  for (const request of seen) {
    assert.equal(request.url.searchParams.get("graph"), "project");
    assert.equal(request.url.searchParams.get("stack"), "prod");
  }
});

test("read credential helpers carry only requested selectors and revocation identity", async () => {
  const bodies: unknown[] = [];
  const paths: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    paths.push(new URL(url).pathname);
    bodies.push(JSON.parse(String(init?.body)));
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => "{}",
    };
  };
  const client = new LbbClient({ baseUrl: "https://example.test", fetch });
  await client.access.createReadToken({
    grants: [
      { kind: "graph", graph_id: "project" },
      { kind: "namespace", namespace_id: "ns_stable" },
    ],
    ttl_seconds: 60,
  });
  await client.access.revokeToken("cred_stable");
  assert.deepEqual(paths, ["/v1/access/tokens", "/v1/access/tokens/revoke"]);
  assert.deepEqual(bodies, [
    {
      grants: [
        { kind: "graph", graph_id: "project" },
        { kind: "namespace", namespace_id: "ns_stable" },
      ],
      ttl_seconds: 60,
    },
    { credential_id: "cred_stable" },
  ]);
});

test("catalog recovery keeps owner selection, bounded cursor and exact operation identity", async () => {
  const seen: { url: URL; body: unknown }[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({
      url: new URL(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => "{}",
    };
  };
  const client = new LbbClient({ baseUrl: "https://example.test", fetch });
  await client.catalog.graphs({
    ownerId: "ns_customer",
    includeDescendants: true,
    cursor: "opaque+/=",
    limit: 1,
  });
  await client.catalog.namespaces({ parentId: "ns_customer", limit: 1 });
  await client.catalog.pendingOperations({ cursor: "opaque+/=", limit: 2 });
  await client.catalog.repairOperation("op_exact");
  await client.catalog.repairIndexes({
    kind: "graphs",
    cursor: "opaque+/=",
    limit: 2,
  });
  assert.equal(seen[0].url.searchParams.get("include_descendants"), "true");
  assert.equal(seen[0].url.searchParams.get("owner_id"), "ns_customer");
  assert.equal(seen[0].url.searchParams.get("cursor"), "opaque+/=");
  assert.equal(seen[1].url.searchParams.get("parent_id"), "ns_customer");
  assert.equal(seen[2].url.searchParams.get("limit"), "2");
  assert.deepEqual(seen[3].body, { operation_id: "op_exact" });
  assert.deepEqual(seen[4].body, {
    kind: "graphs",
    cursor: "opaque+/=",
    limit: 2,
  });
});

test("reference datasets preserve per-source epochs and the source version vector", async () => {
  const body = {
    query: "SELECT ?s WHERE { ?s ?p ?o }",
    expected_graph_epoch: "18446744073709551615",
    references: [
      {
        name: "urn:standards",
        graph_id: "standards",
        expected_graph_epoch: "9007199254740993",
      },
    ],
  };
  const reply = {
    results: '{"head":{"vars":[]},"results":{"bindings":[]}}',
    sources: [
      {
        name: null,
        graph_id: "project",
        graph_epoch: "18446744073709551615",
        commit_seq: 5,
        generation: 1,
        snapshot_token: "snapshot",
      },
    ],
    charged_read_bytes: 128,
  };
  const fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/v1/query/dataset");
    assert.equal(parsed.searchParams.get("graph"), "project");
    assert.equal(
      parsed.searchParams.get("expected_graph_epoch"),
      "18446744073709551615",
    );
    assert.deepEqual(JSON.parse(String(init?.body)), body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(reply),
    };
  };
  const client = new LbbClient({
    baseUrl: "https://example.test",
    graph: "project",
    expectedGraphEpoch: "18446744073709551615",
    fetch,
  });
  assert.deepEqual(await client.sparqlDataset(body), reply);
});

test("catalog/access/dataset helpers respect retry false on retryable responses", async () => {
  const operations: ((client: LbbClient) => Promise<unknown>)[] = [
    (client) => client.catalog.repairOperation("op_exact", { retry: false }),
    (client) =>
      client.catalog.repairIndexes({ kind: "graphs" }, { retry: false }),
    (client) => client.access.revokeToken("credential", { retry: false }),
    (client) =>
      client.sparqlDataset(
        { query: "ASK {}", expected_graph_epoch: "0", references: [] },
        { retry: false },
      ),
  ];
  for (const operation of operations) {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            error: { code: "server_busy", message: "retry later" },
          }),
      };
    };
    const client = new LbbClient({ baseUrl: "https://example.test", fetch });
    await assert.rejects(operation(client));
    assert.equal(calls, 1);
  }
});

test("saved dataset views preserve immutable selection and exact primary epoch", async () => {
  const seen: { url: URL; body: unknown }[] = [];
  const definition = {
    primary_graph_id: "project",
    expected_graph_epoch: "18446744073709551615",
    references: [],
  };
  const revision = "a".repeat(64);
  const reply = { revision, definition };
  const fetch: FetchLike = async (url, init) => {
    seen.push({
      url: new URL(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(reply),
    };
  };
  const client = new LbbClient({
    baseUrl: "https://example.test",
    graph: "project",
    fetch,
  });
  assert.deepEqual(await client.saveDatasetView(definition), reply);
  assert.deepEqual(await client.getDatasetView(revision), reply);
  const body = {
    query: "ASK {}",
    expected_graph_epoch: definition.expected_graph_epoch,
    references: [],
    view_revision: revision,
  };
  await client.sparqlDataset(body);
  assert.equal(seen[0].url.pathname, "/v1/catalog/views");
  assert.deepEqual(seen[0].body, definition);
  assert.equal(seen[1].url.searchParams.get("revision"), revision);
  assert.equal(seen[2].url.searchParams.get("graph"), "project");
  assert.deepEqual(seen[2].body, body);
});
