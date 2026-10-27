import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, LbbCapabilityError, type FetchLike } from "./client.js";

function currentPayload() {
  return {
    object: "status",
    version: "status/1",
    ok: true,
    complete: false,
    service: "lbb-server",
    mode: "single",
    uptime_seconds: 1,
    bind: "127.0.0.1:7400",
    storage: "local-fs",
    auth_required: false,
    graph: { tenant_id: "acme", graph_id: "research", branch_id: "main" },
    graph_status: {
      epoch: 3,
      complete: false,
      rdf: {
        availability: "available",
        issue: null,
        snapshot: { commit_seq: 7, compacted_seq: 0, served_at_seq: 5 },
        publication_caught_up: false,
        published_lag_commits: 2,
      },
      class_embeddings: {
        availability: "unavailable",
        issue: "missing",
        complete: false,
        configured_count: null,
        attempted_count: 0,
        inspected_count: 0,
        model_id: null,
        next_model_id: null,
        embeddings: [],
        max_embeddings: 16,
        metadata_budget_bytes: 16777216,
      },
    },
    snapshot_cache: {
      entries: 0,
      total_bytes: 0,
      pinned_bytes: 0,
      pinned_ceiling_bytes: 1,
      budget_bytes: 1,
    },
  };
}
function clientFor(payload: unknown) {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    calls.push(input);
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  return {
    client: new LbbClient({ baseUrl: "http://h", graph: "research", fetch }),
    calls,
  };
}

test("current status sends its explicit version and preserves unknown coverage", async () => {
  const payload = currentPayload();
  const { client, calls } = clientFor(payload);
  const status = await client.status({ version: "status/1" });
  assert.deepEqual(status, payload);
  assert.equal(status.graph_status.class_embeddings.configured_count, null);
  assert.equal(status.graph_status.rdf.publication_caught_up, false);
  assert.equal(status.complete, false);
  assert.equal(new URL(calls[0]).searchParams.get("version"), "status/1");
  assert.equal(new URL(calls[0]).searchParams.get("graph"), "research");
});

test("current status refuses legacy 200 and malformed current responses", async () => {
  for (const payload of [
    { ok: true, graph_status: {}, persisted_index: {} },
    { ...currentPayload(), version: "status/2" },
    { object: "status", version: "status/1", complete: true },
    {
      ...currentPayload(),
      graph_status: { ...currentPayload().graph_status, class_embeddings: {} },
    },
  ]) {
    const { client } = clientFor(payload);
    await assert.rejects(
      () => client.status({ version: "status/1" }),
      LbbCapabilityError,
    );
  }
});

test("unversioned status preserves existing behavior and explicit legacy is checked", async () => {
  const payload = { ok: true, graph_status: {}, persisted_index: {} };
  const { client, calls } = clientFor(payload);
  assert.deepEqual(await client.status(), payload);
  assert.equal(new URL(calls[0]).searchParams.has("version"), false);
  assert.deepEqual(await client.status({ version: "legacy" }), payload);
  const wrong = clientFor(currentPayload()).client;
  await assert.rejects(
    () => wrong.status({ version: "legacy" }),
    LbbCapabilityError,
  );
});

function populatedPayload() {
  const base = currentPayload();
  const fields = [
    { path: ["https://example.org/label"], name: "label", max: 1 },
  ];
  const serving = {
    version: 1,
    state: "ready",
    model_id: "current-model",
    dim: 2,
    fields,
    entries: 0,
    runs: 0,
    stored_bytes: 0,
    embedded_through_seq: 5,
    usage: { texts: 0, tokens_estimate: 0, cost_usd_estimate: 0 },
  };
  const building = {
    ...serving,
    version: 2,
    state: "backfilling",
    model_id: "next-model",
    backfill: {
      target_seq: 5,
      scanned: 0,
      embedded: 0,
      reused: 0,
      removed: 0,
      rescan: false,
    },
  };
  return {
    ...base,
    complete: true,
    graph_status: {
      ...base.graph_status,
      complete: true,
      class_embeddings: {
        availability: "available",
        issue: null,
        complete: true,
        configured_count: 1,
        attempted_count: 1,
        inspected_count: 1,
        model_id: "current-model",
        next_model_id: "next-model",
        max_embeddings: 16,
        metadata_budget_bytes: 16777216,
        embeddings: [
          {
            name: "things",
            availability: "available",
            issue: null,
            status: {
              name: "things",
              class: "https://example.org/Thing",
              recipe: {
                class: "https://example.org/Thing",
                fields,
                model_id: "next-model",
                dim: 2,
                metric: "cosine",
                title: ["https://example.org/label"],
              },
              serving,
              building,
              head_seq: 7,
              published_seq: 5,
              lag_commits: 2,
              created_at: "now",
              updated_at: "now",
            },
          },
        ],
      },
    },
  };
}
const removeField = Symbol("remove field");
const mutations: Array<[string[], unknown]> = [
  [["ok"], false],
  [["snapshot_cache", "entries"], true],
  [["graph_status", "epoch"], removeField],
  [["graph_status", "rdf", "issue"], "invalid_issue"],
  [["graph_status", "rdf", "issue"], removeField],
  [["graph_status", "rdf", "publication_caught_up"], true],
  [["graph_status", "rdf", "snapshot", "stale"], null],
  [["graph_status", "class_embeddings", "configured_count"], removeField],
  [["graph_status", "class_embeddings", "attempted_count"], true],
  [["graph_status", "class_embeddings", "inspected_count"], 0],
  [["complete"], false],
  ...[
    [["created_at"], removeField],
    [["recipe", "dim"], "2"],
    [["recipe", "metric"], "invalid"],
    [["recipe", "title"], null],
    [["recipe", "fields", "0", "path"], [4]],
    [["serving", "usage", "texts"], true],
    [["serving", "usage", "cost_usd_estimate"], Number.NaN],
    [
      ["serving", "recall"],
      { samples: 1, recall_at_k: Number.POSITIVE_INFINITY, last: 1 },
    ],
    [["serving", "state"], "invalid"],
    [["serving", "stored_bytes"], null],
    [["building", "backfill", "rescan"], null],
  ].map(
    ([path, value]) =>
      [
        [
          "graph_status",
          "class_embeddings",
          "embeddings",
          "0",
          "status",
          ...(path as string[]),
        ],
        value,
      ] as [string[], unknown],
  ),
];

test("current status validates nested types, explicit null observations and diagnostic consistency", async () => {
  const valid = populatedPayload();
  const response = await clientFor(valid).client.status({
    version: "status/1",
  });
  assert.equal(
    response.complete,
    true,
    "inspection coverage is independent of RDF/class readiness",
  );
  assert.equal(response.graph_status.rdf.publication_caught_up, false);
  assert.equal(
    response.graph_status.class_embeddings.embeddings[0].status?.building
      ?.model_id,
    "next-model",
  );
  for (const [path, replacement] of mutations) {
    const payload = structuredClone(valid) as unknown as Record<
      string,
      unknown
    >;
    let owner = payload;
    for (const key of path.slice(0, -1))
      owner = owner[key] as Record<string, unknown>;
    const name = path[path.length - 1];
    if (replacement === removeField) delete owner[name];
    else owner[name] = replacement;
    await assert.rejects(
      () => clientFor(payload).client.status({ version: "status/1" }),
      LbbCapabilityError,
      path.join("."),
    );
  }
  const partial = structuredClone(valid);
  partial.complete = false;
  partial.graph_status.complete = false;
  const roster = partial.graph_status.class_embeddings;
  roster.complete = false;
  roster.configured_count = 2;
  roster.attempted_count = 2;
  roster.inspected_count = 1;
  // The roster is observed even when a named recipe is unavailable.
  const partialPayload = partial as unknown as Record<string, unknown>;
  const rawRoster = (partialPayload.graph_status as Record<string, unknown>)
    .class_embeddings as Record<string, unknown>;
  rawRoster.issue = "missing";
  (rawRoster.embeddings as unknown[]).push({
    name: "unavailable",
    availability: "unavailable",
    issue: "missing",
    status: null,
  });
  assert.deepEqual(
    await clientFor(partialPayload).client.status({ version: "status/1" }),
    partialPayload,
  );
});

test("unsupported runtime status versions cannot be ignored by an older server", async () => {
  const { client, calls } = clientFor({
    ok: true,
    persisted_index: {},
    graph_status: {},
  });
  await assert.rejects(
    () => client.status({ version: "status/2" } as never),
    TypeError,
  );
  assert.equal(
    calls.length,
    0,
    "unsupported version is refused before any request",
  );
});

test("prepared source API default and explicit older headers preserve diagnostic query selection", async () => {
  for (const apiVersion of [undefined, "2026-10-21", "2026-10-27"]) {
    for (const version of ["status/1", "legacy"] as const) {
      const payload =
        version === "status/1"
          ? currentPayload()
          : { ok: true, graph_status: {}, persisted_index: {} };
      const seen: Array<{
        header: string | undefined;
        version: string | null;
      }> = [];
      const fetch: FetchLike = async (input, init) => {
        seen.push({
          header: init?.headers?.["lbb-version"],
          version: new URL(input).searchParams.get("version"),
        });
        return new Response(JSON.stringify(payload));
      };
      const client = new LbbClient({
        baseUrl: "http://h",
        fetch,
        ...(apiVersion ? { apiVersion } : {}),
      });
      const result =
        version === "status/1"
          ? await client.status({ version: "status/1" })
          : await client.status({ version: "legacy" });
      assert.deepEqual(result, payload);
      assert.deepEqual(seen, [{ header: apiVersion ?? "2026-10-27", version }]);
    }
  }
});
