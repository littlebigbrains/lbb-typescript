import assert from "node:assert/strict";
import { test } from "node:test";
import { LbbClient, type Schemas } from "./client.js";

const scope: Schemas["CaptureScope"] = {
  tenant_id: "tenant",
  source_id: "source",
  source_incarnation: "incarnation",
  capture_epoch: 1,
  connection_id: "connection",
  dataset_id: "dataset",
  graph_id: "main",
  graph_epoch: 0,
};
const lease = { term: 1, owner: "worker", expires_at_ms: 100 };

test("source discovery retries its exact connection and fence without a destination in the body", async () => {
  const calls: { url: string; auth: string; body: string }[] = [];
  const client = new LbbClient({
    baseUrl: "https://fixture",
    apiKey: "owner",
    graph: "not-created",
    retryDelayMs: 0,
    fetch: async (url, init) => {
      calls.push({
        url,
        auth: init?.headers?.authorization ?? "",
        body: String(init?.body),
      });
      if (calls.length === 1) throw new Error("lost reply");
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });
  const request = { id: "job", expected_revision: 3 };
  await client.cdc.cancelSourceDiscovery("source_1", request);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].auth, "Bearer owner");
  assert.equal(
    new URL(calls[0].url).pathname,
    "/v1/cdc/source-discovery/cancel",
  );
  assert.equal(
    new URL(calls[0].url).searchParams.get("connection_id"),
    "source_1",
  );
  assert.deepEqual(JSON.parse(calls[0].body), request);
  await client.cdc.sourceDiscoveryStatus("source_1");
  await client.cdc.sourceDiscoveryInput("source_1");
  assert.equal(new URL(calls[2].url).pathname, "/v1/cdc/source-discovery");
  assert.equal(
    new URL(calls[3].url).pathname,
    "/v1/cdc/source-discovery/input",
  );
  assert.equal(
    new URL(calls[3].url).searchParams.get("connection_id"),
    "source_1",
  );
});

test("CDC apply retries an identical fenced request and preserves graph and worker authorization", async () => {
  const calls: { url: string; auth: string; body: string }[] = [];
  const receipt = {
    applied_sequence: 1,
    graph_sequence: 1,
    visibility_token: "opaque",
    replay: true,
  };
  const client = new LbbClient({
    baseUrl: "https://fixture",
    apiKey: "admin",
    graph: "main",
    retryDelayMs: 0,
    fetch: async (url, init) => {
      calls.push({
        url,
        auth: init?.headers?.authorization ?? "",
        body: String(init?.body),
      });
      if (calls.length === 1) throw new Error("lost response");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(receipt),
      };
    },
  });
  assert.deepEqual(
    await client.cdc.apply(
      {
        scope,
        lease,
        configuration_generation: 1,
        mapping_hash: "a".repeat(64),
        expected_applied_sequence: 0,
        sequence: 1,
        descriptor: "b".repeat(64),
      },
      { headers: { authorization: "Bearer worker" } },
    ),
    receipt,
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0]!.auth, "Bearer worker");
  assert.equal(new URL(calls[0]!.url).searchParams.get("graph"), "main");
  assert.equal(new URL(calls[0]!.url).pathname, "/v1/cdc/apply/commit");
});

test("CDC credential issue and generation-changing controls do not retry ambiguous mutations", async () => {
  let attempts = 0;
  const client = new LbbClient({
    baseUrl: "https://fixture",
    retryDelayMs: 0,
    fetch: async () => {
      attempts++;
      throw new Error("lost response");
    },
  });
  await assert.rejects(
    client.cdc.issueCredential({
      scope,
      owner: "worker",
      role: "apply",
      ttl_ms: 300_000,
    }),
    /lost response/,
  );
  assert.equal(attempts, 1);
  await assert.rejects(
    client.cdc.setApplyMode({ scope, expected_generation: 1, mode: "paused" }),
    /lost response/,
  );
  assert.equal(attempts, 2);
});

test("discovery controls preserve exact graph epoch and attempt identity across lost replies", async () => {
  const calls: { url: string; auth: string; body: string }[] = [];
  const client = new LbbClient({
    baseUrl: "https://fixture",
    apiKey: "owner",
    graph: "setup",
    retryDelayMs: 0,
    fetch: async (url, init) => {
      calls.push({
        url,
        auth: init?.headers?.authorization ?? "",
        body: String(init?.body),
      });
      if (calls.length === 1) throw new Error("lost response");
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: "draft", phase: { state: "cancelled" } }),
      };
    },
  });
  const request = { graph_epoch: 7, id: "draft", expected_revision: 3 };
  await client.cdc.cancelDiscovery(request);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].auth, "Bearer owner");
  assert.equal(new URL(calls[0].url).pathname, "/v1/cdc/discovery/cancel");
  assert.equal(new URL(calls[0].url).searchParams.get("graph"), "setup");
  assert.deepEqual(JSON.parse(calls[0].body), request);
  await client.cdc.discoveryStatus();
  await client.cdc.discoveryInput();
  assert.equal(new URL(calls[2].url).pathname, "/v1/cdc/discovery");
  assert.equal(new URL(calls[3].url).pathname, "/v1/cdc/discovery/input");
});

test("discovery approval retries the reviewed catalog and original revision without changing the mapping", async () => {
  const calls: { url: string; body: string }[] = [];
  const client = new LbbClient({
    baseUrl: "https://fixture",
    graph: "setup",
    retryDelayMs: 0,
    fetch: async (url, init) => {
      calls.push({ url, body: String(init?.body) });
      if (calls.length === 2) throw new Error("approval response lost");
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });
  const request: Schemas["DiscoveryApprovalRequest"] = {
    id: "draft",
    graph_epoch: 7,
    expected_revision: 3,
    catalog: "a".repeat(64),
    max_capture_bytes: 1024 * 1024,
    mapping: {
      tables: {
        pg_16384: {
          class_iri: "urn:Customer",
          properties: { id: "urn:id" },
          foreign_keys: [],
        },
      },
    },
  };
  await client.cdc.reviewDiscovery(request);
  await client.cdc.approveDiscovery(request);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], calls[2]);
  assert.equal(calls[0].body, calls[1].body);
  assert.deepEqual(JSON.parse(calls[2].body), request);
  assert.equal(new URL(calls[0].url).pathname, "/v1/cdc/discovery/review");
  assert.equal(new URL(calls[1].url).pathname, "/v1/cdc/discovery/approve");
  assert.equal(new URL(calls[1].url).searchParams.get("graph"), "setup");
});

test("CDC operational metadata preserves epoch and graph scope and never retries an ambiguous CAS", async () => {
  const requests: { url: string; body: string }[] = [];
  const client = new LbbClient({
    baseUrl: "https://fixture",
    graph: "selected",
    retryDelayMs: 0,
    fetch: async (url, init) => {
      requests.push({ url, body: String(init?.body) });
      if (init?.method === "POST") throw new Error("lost metadata reply");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ document: null }),
      };
    },
  });
  assert.equal(await client.cdc.metadata(7, "health"), null);
  const url = new URL(requests[0]!.url);
  assert.equal(url.pathname, "/v1/cdc/metadata");
  assert.equal(url.searchParams.get("graph"), "selected");
  assert.equal(url.searchParams.get("graph_epoch"), "7");
  assert.equal(url.searchParams.get("name"), "health");
  const body = {
    graph_epoch: 7,
    name: "control",
    expected_version: 3,
    value: { operations: [] },
  };
  await assert.rejects(client.cdc.putMetadata(body), /lost metadata reply/);
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1]!.body), body);
});

test("customer source controls use the connection identity and preserve review fences", async () => {
  const calls: { url: URL; method: string; body: unknown }[] = [];
  const client = new LbbClient({
    baseUrl: "https://fixture",
    apiKey: "owner",
    graph: "unrelated",
    maxRetries: 0,
    fetch: async (url, init) => {
      calls.push({
        url: new URL(url),
        method: init!.method!,
        body: init?.body ? JSON.parse(init.body) : null,
      });
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });
  await client.cdc.sourceStatus("customers");
  await client.cdc.sourceInput("customers");
  await client.cdc.startSource("customers", { plan: "a".repeat(64) });
  await client.cdc.pauseCustomer("customers", {
    customer: "b".repeat(64),
    expected_revision: 7,
    paused: true,
  });
  await client.cdc.reconcileSource("customers");
  assert.deepEqual(
    calls.map((c) => c.url.pathname),
    ["status", "input", "start", "customer/pause", "reconcile"].map(
      (p) => `/v1/cdc/source/${p}`,
    ),
  );
  for (const call of calls)
    assert.equal(call.url.searchParams.get("connection_id"), "customers");
  assert.deepEqual(calls[2].body, { plan: "a".repeat(64) });
  assert.deepEqual(calls[3].body, {
    customer: "b".repeat(64),
    expected_revision: 7,
    paused: true,
  });
});
