import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, LbbError, type FetchLike, type Schemas } from "./client.js";
import { PROBE_BODY } from "./rdf-native-writes.js";

// The refusals below are the bodies the server sends for a graph that stores
// RDF (`rdf_native_write_refused` in lbb-graph-query, `json_error_with_code`
// in lbb-server). The Rust route test `rdf_native_client_writes` pins the same
// texts, so a change to either side fails a test.
function refusal(operation: string): string {
  return JSON.stringify({
    error: {
      type: "invalid_request_error",
      code: "rdf_native_graph",
      message:
        `${operation} is not available on this graph: its truth is written by the ` +
        "RDF-native routes. Write RDF statements with POST /v1/graph/import/rdf, " +
        "`graph rdf bulk-load`, or SPARQL Update instead.",
      param: null,
      request_id: null,
      doc_url: "https://docs.littlebigbrain.com/sdks/errors/#rdf_native_graph",
    },
  });
}

const BARE_COMMIT = "a triplet / property / observation commit";
const BARE_DRY_RUN = "a triplet / property commit dry run";
const ENTITY_RETRACT =
  "entity retract (use replace_owned.retract_entities for RDF entity cleanup)";

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A server whose graph stores RDF, or holds records, as the routes answer. */
function server(truth: "rdf_native" | "property_graph") {
  let current = truth;
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push({
      method: init?.method ?? "GET",
      url,
      headers: init?.headers ?? {},
      body,
    });
    const reply = (status: number, payload: string) => ({
      ok: status < 300,
      status,
      headers: { get: () => null },
      text: async () => payload,
    });
    if (url.pathname === "/v1/graph/commit") {
      if (
        current === "rdf_native" &&
        (body.replace_owned ?? undefined) === undefined
      ) {
        return reply(
          400,
          refusal(url.searchParams.has("dry_run") ? BARE_DRY_RUN : BARE_COMMIT),
        );
      }
      const doomed = (
        (body.replace_owned as { retract_entities?: { type: string }[] })
          ?.retract_entities ?? []
      ).some((entity) => entity.type === "Nope");
      if (doomed)
        return reply(
          400,
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              code: "invalid_input",
              message:
                "replace_owned.retract_entities: unknown entity type 'Nope'",
            },
          }),
        );
      if (url.searchParams.has("dry_run"))
        return reply(
          200,
          JSON.stringify({ dry_run: true, op_count: 3, triplets: 1 }),
        );
      return reply(
        200,
        JSON.stringify({
          graph_created: false,
          idempotency_key: "k",
          replayed: false,
          commit_seq: 7,
          visibility_token: "v7",
          entities_written: 2,
          edges_written: 1,
          commit: {},
          ...(body.replace_owned
            ? {
                owned: {
                  edges_retracted: 0,
                  fields_removed: 0,
                  entities_retracted: (
                    (body.replace_owned as { retract_entities?: unknown[] })
                      .retract_entities ?? []
                  ).length,
                },
              }
            : {}),
        }),
      );
    }
    if (url.pathname === "/v1/graph/retract") {
      const entities = (body.entities as unknown[] | undefined) ?? [];
      if (current === "rdf_native" && entities.length > 0)
        return reply(400, refusal(ENTITY_RETRACT));
      return reply(
        200,
        JSON.stringify({
          commit_seq: 6,
          visibility_token: "v6",
          retracted_edges: ((body.edges as unknown[] | undefined) ?? []).length,
          retracted_entities: entities.length,
        }),
      );
    }
    if (url.pathname === "/version")
      return reply(
        200,
        JSON.stringify({ capabilities: ["durable_import_jobs_v1"] }),
      );
    if (url.pathname === "/v1/graph/import-jobs")
      return reply(
        202,
        JSON.stringify({ job_id: "import:job-1", state: "queued" }),
      );
    return reply(404, "{}");
  };
  return {
    fetch,
    calls,
    /** The graph turns out to be of the other kind. */
    become(next: "rdf_native" | "property_graph") {
      current = next;
    },
  };
}

function client(fetch: FetchLike, graph = "main"): LbbClient {
  return new LbbClient({
    baseUrl: "https://db.example.test",
    graph,
    fetch,
    maxRetries: 0,
  });
}

const facts: Schemas["TripletCommitFile"] = {
  triplets: [
    {
      source: { type: "SERVICE", name: "api" },
      relation: "WRITES_TO",
      target: { type: "DATABASE", name: "primary" },
      confidence: 0.9,
      evidence: "runbook",
    },
    {
      source: { type: "SERVICE", name: "worker" },
      relation: "WRITES_TO",
      target: { type: "DATABASE", name: "primary" },
      evidence: { text: "deploy notes" },
    },
  ],
  entity_properties: [
    { type: "SERVICE", name: "api", properties: { tier: "gold" } },
  ],
  edge_idempotency: "skip_unchanged",
  property_merge: "merge",
  observed_at: "2026-11-01T00:00:00Z",
};

test("commit on a graph that stores RDF sends the same facts that own nothing", async () => {
  const { fetch, calls } = server("rdf_native");
  const lbb = client(fetch);
  const done = await lbb.commit(facts, { idempotencyKey: "load-1" });
  assert.equal(done.commitSeq, 7);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.body.replace_owned, undefined);
  const owned = calls[1]!.body;
  // One subject selects the route; no relation or property is owned, so no
  // earlier statement is removed.
  assert.deepEqual(owned.replace_owned, {
    subjects: [{ type: "SERVICE", name: "api" }],
    relations: [],
    properties: [],
  });
  // Every fact and option of the caller is kept, unchanged.
  const { replace_owned: _owned, ...rest } = owned;
  void _owned;
  assert.deepEqual(rest, facts);
  // The refused request wrote nothing, so the retry replays under the key.
  assert.equal(calls[0]!.headers["idempotency-key"], "load-1");
  assert.equal(calls[1]!.headers["idempotency-key"], "load-1");
});

test("the client remembers an RDF graph and sends the owned form first", async () => {
  const { fetch, calls } = server("rdf_native");
  const lbb = client(fetch);
  await lbb.commit(facts);
  calls.length = 0;
  await lbb.commit(facts);
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0]!.body.replace_owned, undefined);
  // A client scoped from it, and graph().facts.create, share what it learned.
  calls.length = 0;
  await lbb.graph("main").facts.create(facts);
  await lbb.withScope({ graph: "main" }).commit(facts);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.body.replace_owned !== undefined));
  // Another graph is not assumed to store RDF.
  calls.length = 0;
  await lbb.graph("other").facts.create(facts);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.body.replace_owned, undefined);
});

test("graph().facts.create on a new graph works on the first call", async () => {
  const { fetch, calls } = server("rdf_native");
  const created = await client(fetch, "kb").graph("kb").facts.create(facts);
  assert.equal(created.commit_seq, 7);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url.searchParams.get("graph"), "kb");
  assert.notEqual(calls[1]!.body.replace_owned, undefined);
});

test("a graph of records gets one plain request", async () => {
  const { fetch, calls } = server("property_graph");
  await client(fetch).commit(facts);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.replace_owned, undefined);
});

test("a commit that carries replace_owned is sent once, as given", async () => {
  const { fetch, calls } = server("rdf_native");
  const owned = {
    ...facts,
    replace_owned: {
      subjects: [{ type: "SERVICE", name: "api" }],
      relations: ["WRITES_TO"],
    },
  };
  await client(fetch).commit(owned);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.body.replace_owned, owned.replace_owned);
});

test("another refusal is not retried", async () => {
  const fetch: FetchLike = async () => ({
    ok: false,
    status: 400,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          code: "invalid_input",
          message: "x",
        },
      }),
  });
  const calls: number[] = [];
  const counting: FetchLike = async (input, init) => {
    calls.push(1);
    return fetch(input, init);
  };
  await assert.rejects(client(counting).commit(facts), (error: unknown) => {
    assert.ok(error instanceof LbbError);
    assert.equal(error.code, "invalid_input");
    return true;
  });
  assert.equal(calls.length, 1);
});

test("properties alone name the subject, with an entity id as its key", async () => {
  const { fetch, calls } = server("rdf_native");
  await client(fetch).commit({
    entity_properties: [
      {
        type: "SERVICE",
        name: "api",
        entity_id: "0123456789abcdef0123456789abcdef",
        properties: { tier: "gold" },
      },
    ],
  });
  assert.deepEqual(calls[1]!.body.replace_owned, {
    subjects: [
      {
        type: "SERVICE",
        name: "api",
        key: "\u0000lbb-eid:0123456789abcdef0123456789abcdef",
      },
    ],
    relations: [],
    properties: [],
  });
});

test("a dry run on a graph that stores RDF previews the owned commit", async () => {
  const { fetch, calls } = server("rdf_native");
  const report = await client(fetch).commitDryRun(facts);
  assert.equal(report.dry_run, true);
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every((call) => call.url.searchParams.get("dry_run") === "true"),
  );
  assert.equal(calls[1]!.body.replace_owned !== undefined, true);
});

test("entity_embeddings are refused with what to do instead", async () => {
  const { fetch, calls } = server("rdf_native");
  const lbb = client(fetch);
  const withVectors: Schemas["TripletCommitFile"] = {
    ...facts,
    entity_embeddings: [
      {
        type: "SERVICE",
        name: "api",
        model_id: "m",
        vector: [0.1, 0.2],
      } as Schemas["EntityEmbeddingInput"],
    ],
  };
  const check = (error: unknown) => {
    assert.ok(error instanceof LbbError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "rdf_native_graph");
    assert.match(error.message, /entity_embeddings/);
    assert.match(error.message, /embeddings\.declare/);
    assert.match(error.message, /POST \/v1\/search/);
    assert.match(error.message, /Nothing was written/);
    return true;
  };
  await assert.rejects(lbb.commit(withVectors), check);
  // Only the first, refused request went out: the owned form was never sent.
  assert.equal(calls.length, 1);
  // A remembered graph does not refuse alone: the server is asked once more.
  await assert.rejects(lbb.commit(withVectors), check);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.body.replace_owned === undefined));
});

test("a graph the client remembers as RDF-native but that takes records is not refused by the client alone", async () => {
  const { fetch, calls, become } = server("rdf_native");
  const lbb = client(fetch);
  await lbb.commit(facts);
  become("property_graph");
  calls.length = 0;
  const withVectors: Schemas["TripletCommitFile"] = {
    ...facts,
    entity_embeddings: [
      {
        type: "SERVICE",
        name: "api",
        model_id: "m",
        vector: [0.1, 0.2],
      } as Schemas["EntityEmbeddingInput"],
    ],
  };
  const done = await lbb.commit(withVectors);
  assert.equal(done.commit_seq, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.replace_owned, undefined);
  // The stale entry is gone: the next commit asks the server first again.
  calls.length = 0;
  await lbb.commit(facts);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.replace_owned, undefined);
});

test("confidence and valid time on a link without evidence are refused, not dropped", async () => {
  const { fetch, calls } = server("rdf_native");
  const lbb = client(fetch);
  const link = {
    source: { type: "SERVICE", name: "api" },
    relation: "WRITES_TO",
    target: { type: "DATABASE", name: "primary" },
  };
  const check = (words: RegExp) => (error: unknown) => {
    assert.ok(error instanceof LbbError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "rdf_native_graph");
    assert.match(error.message, /evidence/);
    assert.match(error.message, words);
    assert.match(error.message, /Nothing was written/);
    return true;
  };
  await assert.rejects(
    lbb.commit({ triplets: [{ ...link, confidence: 0.4 }] }),
    check(/confidence/),
  );
  // Only the refused plain request went out; the owned form was never sent.
  assert.equal(calls.length, 1);
  await assert.rejects(
    lbb.commit({
      triplets: [{ ...link, valid_time: { start: "2020-01-01" } }],
    }),
    check(/valid_time/),
  );
  // The start that observed_at would give a link is lost the same way.
  await assert.rejects(
    lbb.commit({
      triplets: [link],
      observed_at: "2026-11-01T00:00:00Z",
    }),
    check(/observed_at/),
  );
  assert.ok(calls.every((call) => call.body.replace_owned === undefined));
});

test("confidence and valid time with evidence go through, and so does a confidence of 1", async () => {
  const { fetch, calls } = server("rdf_native");
  const lbb = client(fetch);
  const link = {
    source: { type: "SERVICE", name: "api" },
    relation: "WRITES_TO",
    target: { type: "DATABASE", name: "primary" },
  };
  const triplets = [
    {
      ...link,
      confidence: 0.4,
      valid_time: { start: "2020-01-01" },
      evidence: { text: "runbook" },
    },
    // A confidence of 1 is the default: nothing is lost without evidence.
    { ...link, confidence: 1 },
  ];
  await lbb.commit({ triplets });
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1]!.body.replace_owned, undefined);
  // With observed_at the second link would lose its start, so the commit is
  // refused as a whole.
  await assert.rejects(
    lbb.commit({ triplets, observed_at: "2026-11-01T00:00:00Z" }),
    /observed_at/,
  );
});

test("preconditions are refused before an owned commit is sent", async () => {
  const { fetch, calls } = server("rdf_native");
  await assert.rejects(
    client(fetch).commit({
      ...facts,
      preconditions: { expected_head_commit_seq: 3 },
    }),
    (error: unknown) => {
      assert.ok(error instanceof LbbError);
      assert.equal(error.code, "rdf_native_graph");
      assert.match(error.message, /preconditions/);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("retract of entities needs purge_entity_properties on a graph that stores RDF", async () => {
  const { fetch, calls } = server("rdf_native");
  await assert.rejects(
    client(fetch).retract({
      entities: [{ type: "SERVICE", name: "api" }],
    }),
    (error: unknown) => {
      assert.ok(error instanceof LbbError);
      assert.equal(error.code, "rdf_native_graph");
      assert.match(error.message, /purge_entity_properties: true/);
      assert.match(error.message, /Nothing was removed/);
      return true;
    },
  );
  // Nothing but the refused request went out.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url.pathname, "/v1/graph/retract");
});

test("retract with purge_entity_properties removes whole records as an owned commit", async () => {
  const { fetch, calls } = server("rdf_native");
  const entities = [
    { type: "SERVICE", name: "api" },
    { type: "SERVICE", name: "worker" },
  ];
  const done = await client(fetch).retract(
    { entities, purge_entity_properties: true },
    { idempotencyKey: "gone-1" },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.url.pathname, "/v1/graph/commit");
  assert.deepEqual(calls[1]!.body, {
    replace_owned: {
      subjects: [],
      relations: [],
      properties: [],
      retract_entities: entities,
    },
  });
  assert.equal(calls[1]!.headers["idempotency-key"], "gone-1:rdf");
  assert.equal(done.commit_seq, 7);
  assert.equal(done.visibility_token, "v7");
  assert.equal(done.retracted_entities, 2);
  assert.equal(done.purged_entities, 2);
});

test("exact links retract first, under their own key, beside whole records", async () => {
  const { fetch, calls } = server("rdf_native");
  const edge = {
    source: { type: "SERVICE", name: "api" },
    relation: "WRITES_TO",
    target: { type: "DATABASE", name: "primary" },
  };
  const done = await client(fetch)
    .graph("main")
    .retract(
      {
        edges: [edge],
        entities: [{ type: "SERVICE", name: "worker" }],
        purge_entity_properties: true,
      },
      { idempotencyKey: "gone-2" },
    );
  // The refused request, a dry run of the records' commit (no key, nothing
  // written), the links, then the records.
  assert.deepEqual(
    calls.map((call) => [
      call.url.pathname,
      call.url.searchParams.has("dry_run"),
      call.headers["idempotency-key"],
    ]),
    [
      ["/v1/graph/retract", false, "gone-2"],
      ["/v1/graph/commit", true, undefined],
      ["/v1/graph/retract", false, "gone-2:edges"],
      ["/v1/graph/commit", false, "gone-2:rdf"],
    ],
  );
  assert.deepEqual(calls[2]!.body, { edges: [edge], entities: [] });
  assert.equal(done.retracted_edges, 1);
  assert.equal(done.retracted_entities, 1);
});

test("retract of edges alone is one plain request, and a graph of records is unchanged", async () => {
  const native = server("rdf_native");
  const edge = {
    source: { type: "SERVICE", name: "api" },
    relation: "WRITES_TO",
    target: { type: "DATABASE", name: "primary" },
  };
  await client(native.fetch).retract({ edges: [edge] });
  assert.equal(native.calls.length, 1);

  const records = server("property_graph");
  await client(records.fetch).retract({
    entities: [{ type: "SERVICE", name: "api" }],
  });
  assert.equal(records.calls.length, 1);
  assert.deepEqual(records.calls[0]!.body, {
    entities: [{ type: "SERVICE", name: "api" }],
  });
});

test("an import job is refused before the upload on a graph that stores RDF", async () => {
  const { fetch, calls } = server("rdf_native");
  const lbb = client(fetch);
  const lines = [facts.triplets![0]!];
  const check = (error: unknown) => {
    assert.ok(error instanceof LbbError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "rdf_native_graph");
    assert.match(error.message, /importRdf/);
    assert.match(error.message, /Nothing was uploaded/);
    return true;
  };
  await assert.rejects(
    lbb.submitImport(lines, { idempotencyKey: "j-1" }),
    check,
  );
  // The capability check and the dry run that learned the kind of graph.
  assert.deepEqual(
    calls.map((call) => call.url.pathname),
    ["/version", "/v1/graph/commit"],
  );
  assert.equal(calls[1]!.url.searchParams.get("dry_run"), "true");
  // The probe is the commit no graph accepts, and it carries no key.
  assert.deepEqual(calls[1]!.body, PROBE_BODY);
  assert.equal(calls[1]!.headers["idempotency-key"], undefined);
  // The next call asks the server again: a remembered graph does not refuse
  // an upload alone. Nothing is uploaded.
  calls.length = 0;
  await assert.rejects(
    lbb.submitImport(lines, { idempotencyKey: "j-2" }),
    check,
  );
  assert.deepEqual(
    calls.map((call) => call.url.pathname),
    ["/v1/graph/commit"],
  );
});

test("the import job check runs before the source is read, and closes the source", async () => {
  const { fetch } = server("rdf_native");
  let started = 0;
  let closed = 0;
  const source = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          started += 1;
          return { done: true as const, value: undefined };
        },
        return: async () => {
          closed += 1;
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  await assert.rejects(
    client(fetch).submitImport(source, { idempotencyKey: "j-4" }),
    /Nothing was uploaded/,
  );
  assert.equal(started, 0, "not one record was read");
  assert.equal(closed, 1, "the source was closed");
});

test("the dry run that learns the kind of graph tells a graph of records from one that stores RDF", async () => {
  const records = server("property_graph");
  const refusedByRecords = async () => {
    // A graph of records does not know the probe's type.
    const probe = await client(records.fetch).request<{ dry_run: boolean }>(
      "POST",
      "/v1/graph/commit",
      { body: PROBE_BODY, query: { dry_run: true } },
    );
    return probe;
  };
  assert.equal((await refusedByRecords()).dry_run, true);
  const native = server("rdf_native");
  await assert.rejects(
    client(native.fetch).request("POST", "/v1/graph/commit", {
      body: PROBE_BODY,
      query: { dry_run: true },
    }),
    (error: unknown) =>
      error instanceof LbbError && error.code === "rdf_native_graph",
  );
});

test("an import job goes ahead on a graph of records", async () => {
  const { fetch, calls } = server("property_graph");
  const accepted = await client(fetch).submitImport([facts.triplets![0]!], {
    idempotencyKey: "j-3",
  });
  assert.equal(accepted.job_id, "import:job-1");
  assert.deepEqual(
    calls.map((call) => call.url.pathname),
    ["/version", "/v1/graph/commit", "/v1/graph/import-jobs"],
  );
});

test("a null replace_owned is a plain commit", async () => {
  const { fetch, calls } = server("rdf_native");
  await client(fetch).commit({ ...facts, replace_owned: null });
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1]!.body.replace_owned, null);
});

test("a commit without a key uses one key for the refused and the owned attempt", async () => {
  const { fetch, calls } = server("rdf_native");
  await client(fetch).commit(facts);
  await client(fetch, "kb").graph("kb").facts.create(facts);
  assert.equal(calls.length, 4);
  for (const [first, second] of [
    [calls[0]!, calls[1]!],
    [calls[2]!, calls[3]!],
  ]) {
    assert.match(first.headers["idempotency-key"] ?? "", /^facts\.create:/);
    assert.equal(
      second.headers["idempotency-key"],
      first.headers["idempotency-key"],
    );
  }
  // Two calls are two writes: their keys differ.
  assert.notEqual(
    calls[0]!.headers["idempotency-key"],
    calls[2]!.headers["idempotency-key"],
  );
});

test("a retract that names a record of an unknown type changes nothing", async () => {
  const { fetch, calls } = server("rdf_native");
  const edge = {
    source: { type: "SERVICE", name: "api" },
    relation: "WRITES_TO",
    target: { type: "DATABASE", name: "primary" },
  };
  await assert.rejects(
    client(fetch).retract({
      edges: [edge],
      entities: [{ type: "Nope", name: "x" }],
      purge_entity_properties: true,
    }),
    (error: unknown) =>
      error instanceof LbbError && error.code === "invalid_input",
  );
  // The refused request and the dry run: no link was retracted and no record
  // was removed.
  assert.deepEqual(
    calls.map((call) => [
      call.url.pathname,
      call.url.searchParams.has("dry_run"),
    ]),
    [
      ["/v1/graph/retract", false],
      ["/v1/graph/commit", true],
    ],
  );
});

test("a retract of more than 1,000 records is refused before anything is sent to change the graph", async () => {
  const { fetch, calls } = server("rdf_native");
  const entities = Array.from({ length: 1001 }, (_, n) => ({
    type: "SERVICE",
    name: `s${n}`,
  }));
  const lbb = client(fetch);
  await assert.rejects(
    lbb.retract({
      edges: [
        {
          source: entities[0]!,
          relation: "WRITES_TO",
          target: { type: "DATABASE", name: "primary" },
        },
      ],
      entities,
      purge_entity_properties: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof LbbError);
      assert.equal(error.code, "rdf_native_graph");
      assert.match(error.message, /1000/);
      assert.match(error.message, /batches/);
      return true;
    },
  );
  // Only the refused plain request, then (the graph being known) one more to
  // confirm; no dry run, no link, no commit.
  await assert.rejects(
    lbb.retract({ entities, purge_entity_properties: true }),
    /1000/,
  );
  assert.ok(
    calls.every(
      (call) =>
        call.url.pathname === "/v1/graph/retract" &&
        (call.body.entities as unknown[]).length === 1001,
    ),
  );
});

test("a retract names the collateral on neighbours", async () => {
  const { fetch } = server("rdf_native");
  await assert.rejects(
    client(fetch).retract({ entities: [{ type: "SERVICE", name: "api" }] }),
    /left with no link and no field because of it loses its type and label too/,
  );
});

test("a remembered graph that takes records is not refused by the client alone on a retract", async () => {
  const { fetch, calls, become } = server("rdf_native");
  const lbb = client(fetch);
  await lbb.commit(facts);
  become("property_graph");
  calls.length = 0;
  const done = await lbb.retract({
    entities: [{ type: "SERVICE", name: "api" }],
  });
  assert.equal(done.commit_seq, 6);
  assert.deepEqual(
    calls.map((call) => call.url.pathname),
    ["/v1/graph/retract"],
  );
});
