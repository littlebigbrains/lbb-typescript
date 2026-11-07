import assert from "node:assert/strict";
import { test } from "node:test";
import { LbbClient, type FetchLike } from "./client.js";

test("namespace queries retain environment scope and exact source epochs without a client graph fence", async () => {
  let calls = 0;
  const fetch: FetchLike = async (input, init) => {
    calls++;
    const url = new URL(input);
    assert.equal(url.pathname, "/v1/query/namespace");
    assert.equal(url.searchParams.get("stack"), "production");
    assert.equal(url.searchParams.has("graph"), false);
    assert.equal(url.searchParams.has("expected_graph_epoch"), false);
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      namespace_id: "customer-namespace",
      query: "ASK {}",
      include_descendants: true,
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () =>
        JSON.stringify({
          results: '{"head":{},"boolean":true}',
          namespace: {
            id: "customer-namespace",
            incarnation: "immutable",
            authority_revision: 1,
          },
          selection_token: "selection",
          coverage: { selected_graphs: 1, queried_graphs: 1, complete: true },
          sources: [
            {
              name: "urn:lbb:graph:project",
              graph_id: "project",
              graph_epoch: "18446744073709551615",
              commit_seq: 1,
              generation: 1,
              snapshot_token: "snapshot",
            },
          ],
          charged_read_bytes: 123,
        }),
    };
  };
  const client = new LbbClient({
    baseUrl: "https://example.test",
    environment: "production",
    graph: "unrelated",
    expectedGraphEpoch: "99",
    fetch,
  });
  const result = await client.sparqlNamespace({
    namespace_id: "customer-namespace",
    query: "ASK {}",
    include_descendants: true,
  });
  assert.equal(result.sources[0].graph_epoch, "18446744073709551615");
  assert.equal(result.coverage.complete, true);
  assert.equal(calls, 1);
});

test("namespace queries do not automatically retry failed execution or hide a server graph limit", async () => {
  for (const status of [400, 503]) {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      return {
        ok: false,
        status,
        headers: { get: () => "application/json" },
        text: async () =>
          JSON.stringify({
            error: "query failed",
            code:
              status === 400
                ? "namespace_query_graph_limit"
                : "storage_degraded",
          }),
      };
    };
    const client = new LbbClient({
      baseUrl: "https://example.test",
      fetch,
      maxRetries: 2,
    });
    await assert.rejects(
      client.sparqlNamespace({ namespace_id: "customer", query: "ASK {}" }),
    );
    assert.equal(calls, 1);
  }
});
