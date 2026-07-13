import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LbbClient,
  LbbError,
  parseSparqlResults,
  type FetchLike,
  type Schemas,
} from "./client.js";

const validStructuredPlanV2: Schemas["AskStructuredPlanV2"] = {
  v: 2,
  target_types: ["DATABASE"],
  relation_steps: [{ relation: "STORES", direction: "either" }],
  filters: [],
  hop_limit: 2,
  result_limit: 10,
  path_limit: 10,
  frontier_limit: 1000,
  execution_mode: "hybrid",
};
// @ts-expect-error malformed V2 plans are rejected by the generated SDK type.
const malformedStructuredPlanV2: Schemas["AskStructuredPlanV2"] = { v: 2 };
void validStructuredPlanV2;
void malformedStructuredPlanV2;

type FetchCall = {
  input: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  };
};

type FetchResponse = {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
};

function recordingFetch(
  responses: FetchResponse | FetchResponse[] = { status: 200, body: "{}" },
): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const fallback = Array.isArray(responses)
    ? responses[responses.length - 1]
    : responses;
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    const next = queue.shift() ?? fallback ?? {};
    const status = next.status ?? 200;
    const headers = new Map(
      Object.entries(next.headers ?? {}).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      },
      text: async () => next.body ?? "{}",
    };
  };
  return { fetch, calls };
}

test("waitForIndexLineage retains the satisfying build and replica headers", async () => {
  const lineage = {
    head_commit_seq: 7,
    bm25_indexed_commit_seq: 7,
    ann_indexed_commit_seq: 7,
    adjacency_indexed_commit_seq: 7,
    caught_up: true,
    manifest_view_token: "index-view:abc",
    observed_at_micros: 1,
  };
  const { fetch, calls } = recordingFetch({
    body: JSON.stringify({
      graph: { tenant_id: "t", graph_id: "g", branch_id: "main" },
      snapshot: { commit_seq: 7, compacted_seq: 0 },
      ontology_version: 1,
      head_generation: 1,
      wal_tail_commits: 0,
      wal_tail_bytes: 0,
      segment_count: 0,
      segment_bytes: 0,
      object_count: 0,
      object_bytes: 0,
      adjacency_indexed_commit_seq: 7,
      unindexed_tail_commits: 0,
      index_lineage: lineage,
      temporal_coverage: {},
    }),
    headers: {
      "lbb-build-commit": "deadbeef",
      "lbb-replica": "eu1-node2",
      "x-request-id": "req-1",
    },
  });
  const observed = await new LbbClient({
    baseUrl: "http://h",
    fetch,
  }).waitForIndexLineage(7);
  assert.equal(observed.lineage.manifest_view_token, "index-view:abc");
  assert.equal(observed.buildCommit, "deadbeef");
  assert.equal(observed.replica, "eu1-node2");
  assert.equal(observed.requestId, "req-1");
  assert.equal(calls.length, 1);
});

test("namespace facts.create injects auth, scope, version, and idempotency", async () => {
  const { fetch, calls } = recordingFetch({
    body: JSON.stringify({
      graph_created: false,
      idempotency_key: "ik_test_1",
      commit: {
        commit_seq: 1,
        visibility_token: "snap:1",
        observation_ids: [],
        entity_ids: [],
        edge_event_ids: [],
        indexed: false,
        idempotent_replay: false,
        no_op: true,
        skipped_edges: [],
      },
    }),
  });
  const client = new LbbClient({
    baseUrl: "http://h:7400/",
    apiKey: "lbb_sk_test_client",
    fetch,
  });

  const result = await client
    .graph("main", { branch: "b" })
    .facts.create({ triplets: [] }, { idempotencyKey: "ik_test_1" });
  assert.equal(result.commit.commit_seq, 1);
  assert.equal(result.commit.no_op, true);
  assert.deepEqual(result.commit.skipped_edges, []);

  const [call] = calls;
  assert.equal(call.input, "http://h:7400/v1/graph/commit?graph=main&branch=b");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers?.authorization, "Bearer lbb_sk_test_client");
  assert.equal(call.init.headers?.["content-type"], "application/json");
  assert.equal(call.init.headers?.["lbb-version"], "2026-06-22");
  assert.equal(call.init.headers?.["idempotency-key"], "ik_test_1");
  assert.deepEqual(JSON.parse(call.init.body ?? ""), { triplets: [] });
});

test("sparqlText sends row paging fields and exposes row_page", async () => {
  const { fetch, calls } = recordingFetch({
    body: JSON.stringify({
      results: JSON.stringify({
        head: { vars: ["s"] },
        results: { bindings: [] },
      }),
      row_page: {
        returned: 50,
        total: 611,
        offset: 100,
        limit: 50,
        has_more: true,
        next_offset: 150,
      },
    }),
  });
  const client = new LbbClient({ baseUrl: "http://h", graph: "main", fetch });

  const result = await client.sparqlText({
    query: "SELECT ?s WHERE { ?s ?p ?o }",
    limit: 50,
    offset: 100,
  });

  assert.equal(calls[0].input, "http://h/v1/query/sparql-text?graph=main");
  assert.deepEqual(JSON.parse(calls[0].init.body ?? ""), {
    query: "SELECT ?s WHERE { ?s ?p ?o }",
    limit: 50,
    offset: 100,
  });
  assert.equal(result.row_page.returned, 50);
  assert.equal(result.row_page.total, 611);
  assert.equal(result.row_page.next_offset, 150);
});

test("graphEdges scopes and pages an entity's edges", async () => {
  const { fetch, calls } = recordingFetch({
    body: JSON.stringify({
      object: "list",
      data: [],
      has_more: true,
      next_cursor: "300",
      snapshot: {},
      total_count: 782,
    }),
  });
  const client = new LbbClient({ baseUrl: "http://h", graph: "main", fetch });

  const result = await client.graphEdges({
    type: "PERSON",
    name: "ada",
    direction: "out",
    limit: 150,
    cursor: 150,
    asOfCommitSeq: 42,
  });

  const input = calls[0].input;
  assert.match(input, /^http:\/\/h\/v1\/graph\/edges\?/);
  assert.match(input, /type=PERSON/);
  assert.match(input, /name=ada/);
  assert.match(input, /direction=out/);
  assert.match(input, /cursor=150/);
  assert.match(input, /as_of_commit_seq=42/);
  assert.equal(result.total_count, 782);
  assert.equal(result.next_cursor, "300");
});

test("commitDryRun sends dry_run=true and no idempotency key", async () => {
  const { fetch, calls } = recordingFetch({
    body: JSON.stringify({
      dry_run: true,
      op_count: 2,
      triplets: 1,
      entity_properties: 0,
    }),
  });
  const client = new LbbClient({ baseUrl: "http://h", graph: "main", fetch });

  const result = await client.commitDryRun({ triplets: [] });

  assert.match(calls[0].input, /dry_run=true/);
  assert.equal(
    (calls[0].init.headers as Record<string, string>)["idempotency-key"],
    undefined,
  );
  assert.equal(result.dry_run, true);
  assert.equal(result.op_count, 2);
});

test("entities.list projects fields and bulk-fetches ids in one call", async () => {
  const { fetch, calls } = recordingFetch({
    body: JSON.stringify({
      object: "list",
      data: [{ name: "ada", attributes: { title: "VP" } }],
      has_more: false,
      next_cursor: null,
      snapshot: {},
      total_count: 1,
    }),
  });
  const client = new LbbClient({ baseUrl: "http://h", graph: "main", fetch });

  const page = await client.entities.list({
    fields: ["title", "status"],
    ids: ["abc", "def"],
  });

  assert.match(calls[0].input, /fields=title%2Cstatus/);
  assert.match(calls[0].input, /ids=abc%2Cdef/);
  assert.equal(page.total_count, 1);
});

test("entities.filterByAttributes builds structured SPARQL property filters", async () => {
  const { fetch, calls } = recordingFetch({
    body: JSON.stringify({
      vars: ["svc"],
      solutions: [],
      groups: [],
      snapshot: {},
      row_page: {
        returned: 0,
        total: 0,
        offset: 0,
        limit: 50,
        has_more: false,
      },
    }),
  });
  const client = new LbbClient({ baseUrl: "http://h", graph: "main", fetch });

  await client.entities.filterByAttributes({
    patterns: [
      {
        subject: { var: "svc" },
        predicate: "WRITES_TO",
        object: { var: "db" },
      },
    ],
    where: [
      { field: "slo", op: "ge", value: 0.99 },
      { var: "db", field: "tier", value: "prod" },
    ],
    select: ["svc"],
    limit: 25,
  });

  assert.equal(calls[0].input, "http://h/v1/query/sparql?graph=main");
  assert.deepEqual(JSON.parse(calls[0].init.body ?? ""), {
    patterns: [
      {
        subject: { var: "svc" },
        predicate: "WRITES_TO",
        object: { var: "db" },
      },
    ],
    filters: [
      {
        compare: {
          op: "ge",
          left: { property: { var: "svc", field: "slo" } },
          right: { value: { f64: 0.99 } },
        },
      },
      {
        compare: {
          op: "eq",
          left: { property: { var: "db", field: "tier" } },
          right: { value: { str: "prod" } },
        },
      },
    ],
    select: ["svc"],
    limit: 25,
  });
});

test("ontologyView opts into per-relation counts only when asked", async () => {
  const { fetch, calls } = recordingFetch({
    body: JSON.stringify({ relation_defs: [] }),
  });
  const client = new LbbClient({ baseUrl: "http://h", graph: "main", fetch });

  await client.ontologyView();
  await client.ontologyView({ counts: true });

  assert.equal(calls[0].input, "http://h/v1/ontology?graph=main");
  assert.match(calls[1].input, /^http:\/\/h\/v1\/ontology\?/);
  assert.match(calls[1].input, /counts=true/);
});

test("sparqlRows parses SELECT bindings into typed terms and flat rows", async () => {
  const { fetch } = recordingFetch({
    body: JSON.stringify({
      results: JSON.stringify({
        head: { vars: ["s", "o"] },
        results: {
          bindings: [
            {
              s: { type: "uri", value: "https://littlebigbrain.com/e/a" },
              o: { type: "literal", value: "Acme" },
            },
            // Sparse row: `o` unbound and omitted, per the spec.
            { s: { type: "uri", value: "https://littlebigbrain.com/e/b" } },
          ],
        },
      }),
      row_page: {
        returned: 2,
        total: 2,
        offset: 0,
        limit: 50,
        has_more: false,
      },
    }),
  });
  const client = new LbbClient({ baseUrl: "http://h", graph: "main", fetch });

  const result = await client.sparqlRows({
    query: "SELECT ?s ?o WHERE { ?s ?p ?o }",
  });
  assert.deepEqual(result.vars, ["s", "o"]);
  assert.equal(result.boolean, null);
  assert.equal(result.bindings.length, 2);
  assert.equal(result.bindings[0].s.type, "uri");
  assert.deepEqual(result.rows, [
    { s: "https://littlebigbrain.com/e/a", o: "Acme" },
    { s: "https://littlebigbrain.com/e/b" },
  ]);
});

test("parseSparqlResults surfaces the ASK boolean", () => {
  const parsed = parseSparqlResults({
    results: JSON.stringify({ head: {}, boolean: true }),
    row_page: { returned: 0, total: 0, offset: 0, limit: 0, has_more: false },
  });
  assert.equal(parsed.boolean, true);
  assert.deepEqual(parsed.rows, []);
});

test("search.hybrid encodes the v1 GET search route", async () => {
  const { fetch, calls } = recordingFetch();
  const client = new LbbClient({ baseUrl: "http://h", fetch });
  await client.search.hybrid("customer identity", {
    topK: 5,
    source: "persisted",
    consistency: "strong",
    lexical: false,
    bm25: true,
    vector: true,
    targets: ["concepts", "entities"],
  });
  const input = calls[0].input;
  assert.match(input, /^http:\/\/h\/v1\/search\?/);
  assert.match(input, /query=customer%20identity/);
  assert.match(input, /top_k=5/);
  assert.match(input, /source=persisted/);
  assert.match(input, /consistency=strong/);
  assert.match(input, /lexical=false/);
  assert.match(input, /bm25=true/);
  assert.match(input, /vector=true/);
  assert.match(input, /targets=concepts%2Centities/);
});

test("search.hybrid rides the bitemporal cursor as query params", async () => {
  const { fetch, calls } = recordingFetch();
  const client = new LbbClient({ baseUrl: "http://h", fetch });
  await client.search.hybrid("customer identity", {
    asOf: "2026-01-15T00:00:00Z",
    asOfCommitSeq: 42,
  });
  const input = calls[0].input;
  assert.match(input, /as_of=2026-01-15T00%3A00%3A00Z/);
  assert.match(input, /as_of_commit_seq=42/);
});

test("search.feedback posts labels with idempotency", async () => {
  const { fetch, calls } = recordingFetch({
    body: JSON.stringify({
      accepted: 1,
      commit_seq: 2,
      visibility_token: "acme:main:main:0:2",
      feedback_graph: {
        tenant_id: "acme",
        graph_id: "__lbb_feedback",
        branch_id: "main",
      },
      idempotent_replay: false,
    }),
  });
  const client = new LbbClient({
    baseUrl: "http://h",
    graph: "crm",
    branch: "main",
    fetch,
  });
  await client.search.feedback(
    {
      query: "identity records",
      labels: [
        {
          target: {
            kind: "entity",
            entity: { entity_type: "ACCOUNT", name: "Acme" },
          },
          grade: 3,
        },
      ],
    },
    { idempotencyKey: "fb_1" },
  );

  const [call] = calls;
  assert.equal(call.input, "http://h/v1/search/feedback?graph=crm&branch=main");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers?.["idempotency-key"], "fb_1");
  assert.deepEqual(JSON.parse(call.init.body ?? ""), {
    query: "identity records",
    labels: [
      {
        target: {
          kind: "entity",
          entity: { entity_type: "ACCOUNT", name: "Acme" },
        },
        grade: 3,
      },
    ],
  });
});

test("typed suggestion adoption posts a replay-safe trainable signal", async () => {
  const { fetch, calls } = recordingFetch({
    body: JSON.stringify({
      accepted: 1,
      receipt_id: "signal-receipt:r1",
      event_id: "signal-event:r1:0",
      replayed: false,
      accepted_count: 1,
      trainable_count: 1,
      excluded_count: 0,
      exclusions: {},
    }),
  });
  const client = new LbbClient({ baseUrl: "http://h", fetch });
  const ack = await client.suggestionAdopted(
    {
      v: 1,
      suggestion_id: "s-1",
      candidate_id: "c-1",
      prefix: "sto",
      text: "STORES",
      rank: 0,
    },
    { idempotencyKey: "suggestion-retry-1" },
  );
  assert.equal(ack.trainable_count, 1);
  assert.equal(
    calls[0].init.headers?.["idempotency-key"],
    "suggestion-retry-1",
  );
  assert.equal(calls[0].input, "http://h/v1/signals");
});

test("search.feedbackExport reads scoped feedback rows", async () => {
  const { fetch, calls } = recordingFetch({
    body: JSON.stringify({
      rows: [],
      counts: {},
      graph: {},
      feedback_graph: {},
    }),
  });
  const client = new LbbClient({
    baseUrl: "http://h",
    graph: "crm",
    branch: "main",
    fetch,
  });
  await client.search.feedbackExport();
  assert.equal(
    calls[0].input,
    "http://h/v1/search/feedback/export?graph=crm&branch=main",
  );
  assert.equal(calls[0].init.method, "GET");
});

test("search.feedbackSummary reads scoped feedback administration counts", async () => {
  const { fetch, calls } = recordingFetch({
    body: JSON.stringify({
      raw_events: 0,
      deduped_events: 0,
      grades: {},
      splits: {},
      graph: {},
      feedback_graph: {},
    }),
  });
  const client = new LbbClient({
    baseUrl: "http://h",
    graph: "crm",
    branch: "main",
    fetch,
  });
  await client.search.feedbackSummary();
  assert.equal(
    calls[0].input,
    "http://h/v1/search/feedback/summary?graph=crm&branch=main",
  );
  assert.equal(calls[0].init.method, "GET");
});

test("entities namespace encodes list filters", async () => {
  const { fetch, calls } = recordingFetch({
    body: JSON.stringify({ entities: [] }),
  });
  const client = new LbbClient({
    baseUrl: "http://h",
    graph: "main",
    branch: "b",
    fetch,
  });
  await client.entities.list({ type: "SERVICE", limit: 10, query: "billing" });

  const input = calls[0].input;
  assert.match(input, /^http:\/\/h\/v1\/graph\/entities\?/);
  assert.match(input, /graph=main/);
  assert.match(input, /branch=b/);
  assert.match(input, /type=SERVICE/);
  assert.match(input, /limit=10/);
  assert.match(input, /q=billing/);
});

test("entities namespace encodes detail lookups", async () => {
  const entity = { id: "01", type: "SERVICE", name: "billing-api" };
  const snapshot = { commit_seq: 3, indexed_seq: 0 };
  const { fetch, calls } = recordingFetch({
    body: JSON.stringify({
      snapshot,
      entity,
      attributes: { status: "synced" },
      metadata: {
        snapshot,
        entity,
        last_commit: 3,
        object_hash: "blake3:test",
        object_key: "wal/test.graphwal.zst",
        object_kind: "wal",
      },
      current_state: [],
      outgoing: [],
      incoming: [],
      history: [],
      observations: [],
    }),
  });
  const client = new LbbClient({
    baseUrl: "http://h",
    graph: "main",
    branch: "b",
    fetch,
  });
  const detail = await client.entities.detail({
    type: "SERVICE",
    name: "billing-api",
  });

  const input = calls[0].input;
  assert.match(input, /^http:\/\/h\/v1\/graph\/entity\?/);
  assert.match(input, /graph=main/);
  assert.match(input, /branch=b/);
  assert.match(input, /type=SERVICE/);
  assert.match(input, /name=billing-api/);
  assert.equal(detail.attributes?.status, "synced");
});

test("schema namespace uses v1 schema routes", async () => {
  const { fetch, calls } = recordingFetch({
    body: JSON.stringify({ conforms: true }),
  });
  const client = new LbbClient({ baseUrl: "http://h", graph: "main", fetch });

  await client.schema.view();
  await client.schema.view({ audit: true });
  await client.schema.preview({ desired_mode: "warn" });
  await client.schema.publish({
    preview_digest: "sha256:test",
    desired_mode: "warn",
  });
  await client.schema.audit();

  assert.equal(calls[0].input, "http://h/v1/schema?graph=main");
  assert.equal(calls[1].input, "http://h/v1/schema?graph=main&audit=true");
  assert.equal(calls[2].input, "http://h/v1/schema/preview?graph=main");
  assert.equal(calls[2].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[2].init.body ?? ""), {
    desired_mode: "warn",
  });
  assert.equal(calls[3].input, "http://h/v1/schema/publish?graph=main");
  assert.equal(calls[4].input, "http://h/v1/schema/audit?graph=main");
});

test("creates graph and forks branch with scoped v1 URLs", async () => {
  const { fetch, calls } = recordingFetch();
  const client = new LbbClient({
    baseUrl: "http://h",
    graph: "research",
    branch: "analysis",
    fetch,
  });

  await client.createGraph();
  await client.createBranch({ from_branch: "main" });

  assert.equal(
    calls[0].input,
    "http://h/v1/graph/create?graph=research&branch=analysis",
  );
  assert.equal(
    calls[1].input,
    "http://h/v1/graph/branch?graph=research&branch=analysis",
  );
  assert.equal(calls[1].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].init.body ?? ""), {
    from_branch: "main",
  });
});

test("rawRequest returns request metadata", async () => {
  const { fetch } = recordingFetch({
    body: JSON.stringify({ ok: true }),
    headers: { "x-request-id": "req_123", "lbb-version": "2026-06-22" },
  });
  const client = new LbbClient({ baseUrl: "http://h", fetch });
  const response = await client.rawRequest<{ ok: boolean }>(
    "GET",
    "/v1/status",
  );

  assert.deepEqual(response.data, { ok: true });
  assert.equal(response.status, 200);
  assert.equal(response.requestId, "req_123");
  assert.equal(response.version, "2026-06-22");
});

test("retries retryable failures", async () => {
  const { fetch, calls } = recordingFetch([
    {
      status: 503,
      body: JSON.stringify({ error: { message: "retry", code: "api_error" } }),
    },
    { status: 200, body: JSON.stringify({ ok: true }) },
  ]);
  const client = new LbbClient({
    baseUrl: "http://h",
    fetch,
    maxRetries: 1,
    retryDelayMs: 0,
  });

  await client.status();
  assert.equal(calls.length, 2);
});

test("retries network failures for safe reads", async () => {
  let attempts = 0;
  const fetch: FetchLike = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("connection reset");
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
  };
  const client = new LbbClient({
    baseUrl: "http://h",
    fetch,
    maxRetries: 1,
    retryDelayMs: 0,
  });

  await client.status();
  assert.equal(attempts, 2);
});

test("aborts requests at the configured per-attempt timeout", async () => {
  const fetch: FetchLike = async (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        {
          once: true,
        },
      );
    });
  const client = new LbbClient({
    baseUrl: "http://h",
    fetch,
    maxRetries: 0,
    timeoutMs: 5,
  });

  await assert.rejects(
    () => client.status(),
    (error: unknown) => error instanceof Error && error.name === "TimeoutError",
  );
});

test("invalid success JSON includes response context", async () => {
  const { fetch } = recordingFetch({
    status: 200,
    body: "not-json",
    headers: { "x-request-id": "req_bad_json" },
  });
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  await assert.rejects(
    () => client.status(),
    (error: unknown) =>
      error instanceof SyntaxError &&
      error.message.includes("HTTP 200") &&
      error.message.includes("req_bad_json"),
  );
});

test("does not retry unsafe writes without an idempotency key", async () => {
  const { fetch, calls } = recordingFetch([
    {
      status: 503,
      body: JSON.stringify({ error: { message: "retry", code: "api_error" } }),
    },
    { status: 200, body: JSON.stringify({ ok: true }) },
  ]);
  const client = new LbbClient({
    baseUrl: "http://h",
    fetch,
    maxRetries: 1,
    retryDelayMs: 0,
  });

  await assert.rejects(() => client.graph("main").create());
  assert.equal(calls.length, 1);
});

test("retries idempotency-keyed writes", async () => {
  const { fetch, calls } = recordingFetch([
    {
      status: 503,
      body: JSON.stringify({ error: { message: "retry", code: "api_error" } }),
    },
    { status: 200, body: JSON.stringify({ ok: true }) },
  ]);
  const client = new LbbClient({
    baseUrl: "http://h",
    fetch,
    maxRetries: 1,
    retryDelayMs: 0,
  });

  await client
    .graph("main")
    .facts.create({ triplets: [] }, { idempotencyKey: "retry-safe" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers?.["idempotency-key"], "retry-safe");
  assert.equal(calls[1].init.headers?.["idempotency-key"], "retry-safe");
});

test("throws typed LbbError on structured errors", async () => {
  const { fetch } = recordingFetch({
    status: 401,
    body: JSON.stringify({
      error: {
        type: "auth_error",
        code: "unauthorized",
        message: "missing bearer",
        param: null,
        request_id: "req_body",
        doc_url: "https://littlebigbrain.com/errors/unauthorized",
        retryable: true,
        retry_after_seconds: 2,
      },
    }),
  });
  const client = new LbbClient({ baseUrl: "http://h", fetch });
  await assert.rejects(
    () => client.status(),
    (error: unknown) =>
      error instanceof LbbError &&
      error.status === 401 &&
      error.code === "unauthorized" &&
      error.type === "auth_error" &&
      error.requestId === "req_body" &&
      error.retryable === true &&
      error.retryAfterSeconds === 2 &&
      error.message === "missing bearer",
  );
});

test("stack activity stays on the bearer-scoped /v1 route", async () => {
  const { fetch, calls } = recordingFetch({
    body: JSON.stringify({ ok: true }),
  });
  const client = new LbbClient({ baseUrl: "http://h", apiKey: "k", fetch });

  await client.stackActivity("1h");

  assert.equal(calls[0].input, "http://h/v1/stack/activity?window=1h");
  assert.equal(calls[0].init.headers?.authorization, "Bearer k");
});

test("facts.import serializes lines to NDJSON with batch/strict params", async () => {
  const { fetch, calls } = recordingFetch({
    status: 200,
    body: JSON.stringify({
      graph_created: false,
      lines_read: 2,
      triplets: 1,
      properties: 1,
      batches: 1,
      indexed: false,
      error_count: 0,
    }),
  });
  const client = new LbbClient({ baseUrl: "http://h", graph: "main", fetch });
  const result = await client.graph("main").facts.import(
    [
      {
        source: { type: "Author", name: "Ada", key: "orcid:1" },
        relation: "AFFILIATED_WITH",
        target: { type: "University", name: "Cambridge", key: "ror:1" },
      },
      {
        type: "Author",
        name: "Ada",
        key: "orcid:1",
        properties: { h_index: 52 },
      },
    ],
    { batch: 500, strict: true },
  );
  assert.equal(result.triplets, 1);
  const call = calls[0];
  assert.match(call.input, /\/v1\/graph\/import\?/);
  assert.match(call.input, /batch=500/);
  assert.match(call.input, /strict=true/);
  assert.equal(call.init.headers?.["content-type"], "application/x-ndjson");
  assert.match(call.init.headers?.["idempotency-key"] ?? "", /^import:/);
  // Body is newline-delimited JSON, one object per line.
  const lines = (call.init.body ?? "").split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).relation, "AFFILIATED_WITH");
  assert.equal(JSON.parse(lines[1]).properties.h_index, 52);
});

test("facts.importRdf posts N-Triples through the native RDF endpoint", async () => {
  const { fetch, calls } = recordingFetch({
    status: 200,
    body: JSON.stringify({
      graph_created: false,
      lines_read: 1,
      triples_read: 1,
      resource_triples: 1,
      literal_triples: 0,
      duplicate_resource_triples: 0,
      duplicate_literal_triples: 0,
      imported_triplets: 1,
      batches: 1,
      indexed: false,
      predicate_count: 1,
      predicates: [],
      error_count: 0,
    }),
  });
  const client = new LbbClient({ baseUrl: "http://h", graph: "main", fetch });
  const body = "<http://ex/s> <http://ex/p> <http://ex/o> .\n";
  const result = await client.graph("main").facts.importRdf(body, {
    batch: 500,
    strict: true,
    blankNodeScope: "document-42",
    resourceType: "RdfResource",
    edgeIdempotency: "append",
  });
  assert.equal(result.imported_triplets, 1);
  const call = calls[0];
  assert.match(call.input, /\/v1\/graph\/import\/rdf\?/);
  assert.match(call.input, /batch=500/);
  assert.match(call.input, /strict=true/);
  assert.match(call.input, /blank_node_scope=document-42/);
  assert.match(call.input, /format=ntriples/);
  assert.match(call.input, /resource_type=RdfResource/);
  assert.match(call.init.headers?.["idempotency-key"] ?? "", /^import-rdf:/);
  assert.match(call.input, /edge_idempotency=append/);
  assert.equal(call.init.headers?.["content-type"], "application/n-triples");
  assert.equal(call.init.body, body);
});

test("facts.importRdf selects Turtle and forwards its base IRI", async () => {
  const { fetch, calls } = recordingFetch({
    status: 200,
    body: JSON.stringify({ imported_triplets: 1 }),
  });
  const client = new LbbClient({ baseUrl: "http://h", graph: "main", fetch });
  const body = "@prefix ex: <http://ex/> . ex:s ex:p ex:o .";
  const result = await client.graph("main").facts.importRdf(body, {
    format: "turtle",
    baseIri: "http://base/",
    graphUri: "http://ex/graph",
  });
  assert.equal(result.imported_triplets, 1);
  const call = calls[0];
  assert.match(call.input, /format=turtle/);
  assert.match(call.input, /base_iri=http%3A%2F%2Fbase%2F/);
  assert.match(call.input, /graph_uri=http%3A%2F%2Fex%2Fgraph/);
  assert.equal(call.init.headers?.["content-type"], "text/turtle");
  assert.equal(call.init.body, body);
});

test("graph.exportRdf returns RDF dataset text instead of JSON parsing it", async () => {
  const turtle = "<http://ex/s> <http://ex/p> <http://ex/o> <http://ex/g> .\n";
  const { fetch, calls } = recordingFetch({
    status: 200,
    body: turtle,
    headers: { "content-type": "application/n-quads; charset=utf-8" },
  });
  const client = new LbbClient({ baseUrl: "http://h", fetch });
  const result = await client.graph("research", { branch: "draft" }).exportRdf({
    format: "nquads",
    maxTriples: 500,
    asOfCommitSeq: 7,
  });
  assert.equal(result, turtle);
  const call = calls[0];
  assert.match(call.input, /\/v1\/graph\/export\/rdf\?/);
  assert.match(call.input, /graph=research/);
  assert.match(call.input, /branch=draft/);
  assert.match(call.input, /max_triples=500/);
  assert.match(call.input, /as_of_commit_seq=7/);
  assert.match(call.input, /format=nquads/);
});

test("graph.retract posts edge/entity retractions", async () => {
  const { fetch, calls } = recordingFetch({
    status: 200,
    body: JSON.stringify({
      commit_seq: 4,
      visibility_token: "tok",
      retracted_edges: 1,
      retracted_entities: 0,
    }),
  });
  const client = new LbbClient({ baseUrl: "http://h", graph: "main", fetch });
  const result = await client.graph("main").retract({
    edges: [
      {
        source: { type: "Author", name: "Ada" },
        relation: "AFFILIATED_WITH",
        target: { type: "University", name: "Cambridge" },
      },
    ],
  });
  assert.equal(result.retracted_edges, 1);
  assert.match(calls[0].input, /\/v1\/graph\/retract\?graph=main/);
  assert.equal(calls[0].init.method, "POST");
  assert.ok(
    calls[0].init.headers?.["idempotency-key"],
    "retract gets an idempotency key",
  );
});
