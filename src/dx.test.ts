import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LbbClient,
  LbbError,
  type Entity,
  type FetchLike,
  type Schemas,
} from "./index.js";

test("generated schemas exclude the retired request-time SHACL DTO family", () => {
  const noRetiredShaclModels: [
    Extract<keyof Schemas, `Shacl${string}`>,
  ] extends [never]
    ? true
    : false = true;
  assert.equal(noRetiredShaclModels, true);
});

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

  await client.entities.detail({ type: "SERVICE", name: "auth" });
  await client.ontology.view({ counts: true });
  await client.query.structured({ patterns: [], select: [] });

  assert.deepEqual(urls, [
    "http://h/v1/graph/entity?type=SERVICE&name=auth",
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

  assert.deepEqual(urls, [
    "http://h/v1/ontology",
    "http://h/v1/ontology/conformance",
    "http://h/v1/ontology/search",
    "http://h/v1/ontology/resolve",
    "http://h/v1/ontology/define",
    "http://h/v1/ontology/evolve",
  ]);
});

test("ontology suggestions namespace maps each operation to its route", async () => {
  const { fetch, urls, bodies } = queuedFetch([]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  await client.ontology.suggestions.list({
    status: "open",
    originKind: "integration",
    originId: "hubspot-main",
    limit: 20,
  });
  await client.ontology.suggestions.get("sg_1");
  await client.ontology.suggestions.create({
    title: "Add class Deal",
    origin: { kind: "integration", id: "hubspot-main" },
    change: [{ op: "add_entity_type", name: "Deal" }],
    key: "hubspot-main/deals",
  });
  await client.ontology.suggestions.validate("sg_1");
  await client.ontology.suggestions.accept("sg_1");
  await client.ontology.suggestions.dismiss("sg_1", { reason: "not now" });
  await client.ontology.suggestions.supersede("sg_1", { reason: "gone" });
  await client.ontology.suggestions.comment("sg_1", { text: "why?" });

  assert.deepEqual(urls, [
    "http://h/v1/ontology/suggestions?status=open&origin_kind=integration&origin_id=hubspot-main&limit=20",
    "http://h/v1/ontology/suggestions/detail?suggestion_id=sg_1",
    "http://h/v1/ontology/suggestions",
    "http://h/v1/ontology/suggestions/validate?suggestion_id=sg_1",
    "http://h/v1/ontology/suggestions/accept?suggestion_id=sg_1",
    "http://h/v1/ontology/suggestions/dismiss?suggestion_id=sg_1",
    "http://h/v1/ontology/suggestions/supersede?suggestion_id=sg_1",
    "http://h/v1/ontology/suggestions/comment?suggestion_id=sg_1",
  ]);
  assert.equal(bodies[4], "{}");
  assert.deepEqual(JSON.parse(bodies[5] ?? ""), { reason: "not now" });
});

test("ontology starters namespace maps each operation to its route and body", async () => {
  const { fetch, urls, bodies } = queuedFetch([]);
  const client = new LbbClient({ baseUrl: "http://h", graph: "crm", fetch });

  await client.ontology.starters.list();
  await client.ontology.starters.get("crm");
  await client.ontology.starters.apply("crm");
  await client.ontology.starters.apply("work", {
    dryRun: true,
    expectedOntologyVersion: 4,
  });
  await client.ontology.starters.update("crm");
  await client.graph("sales").ontology.starters.list();

  assert.deepEqual(urls, [
    "http://h/v1/ontology/starters?graph=crm",
    "http://h/v1/ontology/starters/detail?graph=crm&starter=crm",
    "http://h/v1/ontology/starters/apply?graph=crm",
    "http://h/v1/ontology/starters/apply?graph=crm",
    "http://h/v1/ontology/starters/update?graph=crm",
    "http://h/v1/ontology/starters?graph=sales",
  ]);
  assert.deepEqual(JSON.parse(bodies[2] ?? ""), { starter: "crm" });
  assert.deepEqual(JSON.parse(bodies[3] ?? ""), {
    starter: "work",
    dry_run: true,
    expected_ontology_version: 4,
  });
  assert.deepEqual(JSON.parse(bodies[4] ?? ""), { starter: "crm" });
});

test("a refused starter apply exposes its conflicts on the error", async () => {
  const conflict = {
    kind: "property",
    name: "priority",
    starter: "keyword",
    graph: "i64",
    message: "property priority is i64 in the graph",
  };
  const { fetch } = queuedFetch([
    {
      status: 409,
      body: {
        error: {
          type: "conflict_error",
          code: "starter_conflict",
          message: "the graph holds 1 term(s) of the Work starter differently",
          param: "starter",
          details: { conflicts: [conflict] },
        },
      },
    },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });
  await assert.rejects(client.ontology.starters.apply("work"), (error) => {
    assert.ok(error instanceof LbbError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "starter_conflict");
    assert.deepEqual(error.details, { conflicts: [conflict] });
    return true;
  });
});

test("ontology drafts namespace maps each operation to its route", async () => {
  const { fetch, urls, headers, bodies } = queuedFetch([
    { body: {} },
    { body: {} },
    { status: 503, body: { error: { message: "retry" } } },
    { body: {} },
    { body: {} },
    { body: {} },
    { body: {} },
  ]);
  const client = new LbbClient({
    baseUrl: "http://h",
    graph: "crm",
    fetch,
    maxRetries: 1,
    retryDelayMs: 0,
  });

  await client.ontology.drafts.create({
    connector_name: "hubspot",
    samples: [{ name: "Acme", industry: "retail" }],
  } as never);
  await client.ontology.drafts.get("d_1");
  await client.ontology.drafts.validate("d_1");
  await client.ontology.drafts.promote("d_1");
  await client.ontology.drafts.promote("d_1", { idempotencyKey: "promote-1" });
  await client.ontology.drafts.reject("d_1", "too broad");

  assert.deepEqual(urls, [
    "http://h/v1/ontology/drafts?graph=crm",
    "http://h/v1/ontology/drafts?graph=crm&draft_id=d_1",
    // validate is a read: a 503 is retried without an idempotency key.
    "http://h/v1/ontology/drafts/validate?graph=crm&draft_id=d_1",
    "http://h/v1/ontology/drafts/validate?graph=crm&draft_id=d_1",
    "http://h/v1/ontology/drafts/promote?graph=crm&draft_id=d_1",
    "http://h/v1/ontology/drafts/promote?graph=crm&draft_id=d_1",
    "http://h/v1/ontology/drafts/reject?graph=crm&draft_id=d_1&reason=too%20broad",
  ]);
  assert.equal(JSON.parse(bodies[0] ?? "").connector_name, "hubspot");
  assert.match(headers[4]["idempotency-key"] ?? "", /^ontology-draft-promote:/);
  assert.equal(headers[5]["idempotency-key"], "promote-1");
  assert.equal(headers[6]["idempotency-key"], undefined);
});

test("query.update sends SPARQL Update text with an idempotency key", async () => {
  const { fetch, urls, headers, bodies } = queuedFetch([
    { status: 204, body: undefined },
    { status: 204, body: undefined },
  ]);
  const client = new LbbClient({
    baseUrl: "http://h",
    graph: "catalog",
    fetch,
  });
  const update =
    'INSERT DATA { <https://example.com/sku/2> <http://www.w3.org/2000/01/rdf-schema#label> "Road shoe" }';

  const answer = await client.query.update(update);
  await client.graph("orders").query.update(update, {
    idempotencyKey: "catalog-2026-10-03",
  });

  assert.equal(answer, undefined);
  assert.deepEqual(urls, [
    "http://h/update?graph=catalog",
    "http://h/update?graph=orders",
  ]);
  assert.equal(bodies[0], update);
  assert.equal(headers[0]["content-type"], "application/sparql-update");
  assert.match(headers[0]["idempotency-key"] ?? "", /^sparql-update:/);
  assert.equal(headers[1]["idempotency-key"], "catalog-2026-10-03");
});

test("parsed SPARQL results carry the search report, the eval trace and the cursor", async () => {
  const search: Schemas["SparqlSearchReport"] = {
    plan: "filter_first",
    top: 3,
    hits: 3,
    complete: true,
    allowed: 25,
    candidates: 25,
    rounds: 1,
    clusters_probed: 4,
    entries_considered: 25,
    embeddings: ["product"],
    model_id: "openai/text-embedding-3-small",
    lag_commits: 0,
    timings: {
      resolve_ms: 0,
      embed_ms: 12,
      filter_ms: 3,
      index_ms: 1,
      rerank_ms: 1,
      check_ms: 0,
      total_ms: 17,
    },
    usage: { texts: 1, tokens_estimate: 4, cost_usd_estimate: 0 },
  };
  const rowPage = {
    returned: 1,
    total: 3,
    offset: 0,
    limit: 1,
    has_more: true,
  };
  const results = JSON.stringify({
    head: { vars: ["x", "score"] },
    results: {
      bindings: [
        {
          x: { type: "uri", value: "https://x.test/e/1" },
          score: { type: "literal", value: "0.91" },
        },
      ],
    },
  });
  const { fetch, bodies } = queuedFetch([
    {
      body: {
        results,
        row_page: rowPage,
        search,
        trace_id: "tr_1",
        next_cursor: "opaque-2",
      },
    },
    { body: { results, row_page: rowPage } },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });
  const query =
    'PREFIX search: <https://littlebigbrain.com/search#> SELECT ?x ?score WHERE { ?x search:similarTo "card payments" ; search:score ?score } LIMIT 3';

  const found = await client.query.sparql({ query, request: "card payments" });
  const plain = await client.sparqlRows({ query });

  assert.equal(JSON.parse(bodies[0] ?? "").request, "card payments");
  assert.deepEqual(found.rows, [{ x: "https://x.test/e/1", score: "0.91" }]);
  assert.equal(found.search?.plan, "filter_first");
  assert.equal(found.search?.complete, true);
  assert.equal(found.traceId, "tr_1");
  assert.equal(found.nextCursor, "opaque-2");
  assert.deepEqual(found.rowPage, rowPage);
  assert.equal("search" in plain, false);
  assert.equal("traceId" in plain, false);
  assert.equal("nextCursor" in plain, false);
  assert.equal(plain.rowPage?.total, 3);
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

function rewriteResponse(
  overrides: Partial<Schemas["QueryRewriteResponse"]> = {},
): Schemas["QueryRewriteResponse"] {
  return {
    route: {
      kind: "lookup",
      confidence: 0.92,
      by: "router",
      probabilities: { lookup: 0.92, search: 0.08 },
    },
    query: {
      sparql:
        "SELECT ?name WHERE { ?s <http://www.w3.org/2000/01/rdf-schema#label> ?name }",
      entailment: "none",
    },
    rationale: "The question names services by a condition.",
    attempts: 1,
    grounding: {
      commit_seq: 7,
      classes: 3,
      properties: 5,
      embeddings: 0,
      age_ms: 10,
    },
    models: [],
    timings: {
      ground_ms: 1,
      route_ms: 2,
      rewrite_ms: 3,
      run_ms: 4,
      total_ms: 10,
    },
    ...overrides,
  };
}

test("query rewrite posts the question with consistency on the URL and no retry", async () => {
  const { fetch, urls, bodies } = queuedFetch([
    {
      status: 503,
      body: {
        error: {
          code: "rewrite_model_unavailable",
          message: "the query rewriter model did not answer; try again",
        },
      },
    },
    { body: rewriteResponse() },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch, retryDelayMs: 0 });

  await assert.rejects(
    client.query.rewrite({ question: "Which services exist?" }),
    (error) => {
      assert.ok(error instanceof LbbError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "rewrite_model_unavailable");
      return true;
    },
  );
  assert.equal(urls.length, 1, "a rewrite spends model tokens: no retry");

  const response = await client.query.rewrite(
    { question: "Which services exist?", mode: "route" },
    { consistency: "strong" },
  );
  assert.equal(response.route.kind, "lookup");
  assert.deepEqual(urls, [
    "http://h/v1/query/rewrite",
    "http://h/v1/query/rewrite?consistency=strong",
  ]);
  assert.deepEqual(JSON.parse(bodies[1] ?? "{}"), {
    question: "Which services exist?",
    mode: "route",
  });
});

test("query rewrite retries when the caller asks for it", async () => {
  const { fetch, urls } = queuedFetch([
    { status: 503, body: { error: { code: "rewrite_model_unavailable" } } },
    { body: rewriteResponse() },
  ]);
  const client = new LbbClient({
    baseUrl: "http://h",
    graph: "main",
    fetch,
    retryDelayMs: 0,
    defaultConsistency: "eventual",
  });

  await client.query.rewrite(
    { question: "Which services exist?" },
    { retry: true },
  );
  assert.deepEqual(urls, [
    "http://h/v1/query/rewrite?graph=main&consistency=eventual",
    "http://h/v1/query/rewrite?graph=main&consistency=eventual",
  ]);
});

test("query ask runs the rewrite and parses its rows", async () => {
  const response = rewriteResponse({
    result: {
      results: JSON.stringify({
        head: { vars: ["name"] },
        results: {
          bindings: [
            { name: { type: "literal", value: "Auth Service" } },
            { name: { type: "literal", value: "Billing" } },
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
      snapshot: { commit_seq: 7, compacted_seq: 7, served_at_seq: 7 },
      trace_id: "tr_1",
    },
  });
  const { fetch, urls, bodies } = queuedFetch([{ body: response }]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  const answer = await client.query.ask("Which services exist?", {
    context: "Services of the platform team.",
    previous: [{ sparql: "SELECT * WHERE { ?s ?p ?o }", note: "too wide" }],
    limit: 50,
    asOfCommitSeq: 7,
    today: "2026-10-04",
    consistency: "strong",
  });

  assert.equal(urls[0], "http://h/v1/query/rewrite?consistency=strong");
  assert.deepEqual(JSON.parse(bodies[0] ?? "{}"), {
    question: "Which services exist?",
    run: true,
    context: "Services of the platform team.",
    previous: [{ sparql: "SELECT * WHERE { ?s ?p ?o }", note: "too wide" }],
    limit: 50,
    as_of_commit_seq: 7,
    today: "2026-10-04",
  });
  assert.equal(answer.route.kind, "lookup");
  assert.equal(answer.route.by, "router");
  assert.equal(answer.query?.entailment, "none");
  assert.equal(answer.rationale, "The question names services by a condition.");
  assert.deepEqual(answer.vars, ["name"]);
  assert.deepEqual(answer.rows, [
    { name: "Auth Service" },
    { name: "Billing" },
  ]);
  assert.equal(answer.boolean, null);
  assert.equal(answer.snapshot?.served_at_seq, 7);
  assert.equal(answer.error, null);
  assert.equal(answer.traceId, "tr_1");
  assert.equal(answer.rewrite.attempts, 1);
});

test("query ask sends the anchors and returns the linked names", async () => {
  const link: Schemas["QueryRewriteLink"] = {
    text: "Quelmann",
    iri: "https://x.test/e/quellmann",
    label: "Quellmann Fenstertechnik GmbH",
    class: "https://x.test/class/firm",
    score: 0.82,
    by: "fuzzy",
  };
  const anchor: Schemas["QueryRewriteAnchor"] = {
    iri: "https://x.test/e/nope",
    found: false,
    note: "not in the graph at the latest commit",
  };
  const { fetch, bodies } = queuedFetch([
    { body: rewriteResponse({ linked: [link], anchors: [anchor] }) },
    { body: rewriteResponse() },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  const answer = await client.query.ask("Show me everything about Quelmann.", {
    anchor: ["https://x.test/e/nope"],
  });
  assert.deepEqual(JSON.parse(bodies[0] ?? "{}"), {
    question: "Show me everything about Quelmann.",
    run: true,
    anchor: ["https://x.test/e/nope"],
  });
  assert.deepEqual(answer.linked, [link]);
  assert.deepEqual(answer.anchors, [anchor]);

  const bare = await client.query.ask("Which services exist?", { anchor: [] });
  assert.deepEqual(JSON.parse(bodies[1] ?? "{}"), {
    question: "Which services exist?",
    run: true,
  });
  assert.deepEqual(bare.linked, []);
  assert.deepEqual(bare.anchors, []);
  assert.equal(bare.history, null);
});

test("query ask sends a timeline and returns the history of a comparison", async () => {
  const history: Schemas["QueryRewriteHistory"] = {
    as_of_date: "2026-06-05",
    compare: true,
    as_of_commit_seq: 1,
    resolved_by: "timeline",
    label: "Tender",
    added: [{ t: { type: "uri", value: "https://x.test/e/c" } }],
    removed: [],
  };
  const { fetch, bodies } = queuedFetch([
    { body: rewriteResponse({ history }) },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });
  const timeline: Schemas["QueryRewriteTimelinePoint"][] = [
    { date: "2026-05-20", as_of_commit_seq: 1, label: "Tender" },
  ];

  const answer = await client.query.ask("What changed since 5 June?", {
    timeline,
  });
  assert.deepEqual(JSON.parse(bodies[0] ?? "{}"), {
    question: "What changed since 5 June?",
    run: true,
    timeline,
  });
  assert.deepEqual(answer.history, history);
});

test("query ask without a run keeps the route, the rationale and the error", async () => {
  const { fetch, bodies } = queuedFetch([
    {
      body: rewriteResponse({
        route: { kind: "unanswerable", confidence: 0.8, by: "rewriter" },
        query: null,
        rationale: "The graph holds no salaries.",
      }),
    },
    {
      body: rewriteResponse({
        attempts: 2,
        error: "unknown prefix ex",
      }),
    },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  const unanswerable = await client.query.ask("What does Ada earn?");
  assert.deepEqual(JSON.parse(bodies[0] ?? "{}"), {
    question: "What does Ada earn?",
    run: true,
  });
  assert.equal(unanswerable.route.kind, "unanswerable");
  assert.equal(unanswerable.query, null);
  assert.equal(unanswerable.rationale, "The graph holds no salaries.");
  assert.deepEqual(unanswerable.rows, []);
  assert.deepEqual(unanswerable.vars, []);
  assert.equal(unanswerable.traceId, null);

  const failed = await client.query.ask("Which services exist?", {
    route: "lookup",
  });
  assert.equal(JSON.parse(bodies[1] ?? "{}").route, "lookup");
  assert.equal(failed.error, "unknown prefix ex");
  assert.equal(failed.rewrite.attempts, 2);
  assert.deepEqual(failed.rows, []);
});

test("query ask returns the answer of an ASK query", async () => {
  const { fetch } = queuedFetch([
    {
      body: rewriteResponse({
        query: { sparql: "ASK { ?s ?p ?o }", entailment: "rdfs" },
        result: {
          results: JSON.stringify({ head: {}, boolean: true }),
          row_page: {
            returned: 0,
            total: 0,
            offset: 0,
            limit: 100,
            has_more: false,
          },
        },
      }),
    },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  const answer = await client.query.ask("Is there any fact?");
  assert.equal(answer.boolean, true);
  assert.deepEqual(answer.rows, []);
  assert.equal(answer.query?.entailment, "rdfs");
  assert.equal(answer.traceId, null);
});

test("query profile option asks for the server's measurements", async () => {
  const profile = {
    total_ms: 2.5,
    execution_ms: 1.0,
    rows: 0,
    rows_total: 0,
    result_cache: "bypassed",
    stages: [{ stage: "execute", ms: 1.0 }],
    join_orders: [],
  };
  const envelope = {
    results: JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }),
    profile,
  };
  const { fetch, bodies } = queuedFetch([
    { body: envelope },
    { body: envelope },
    { body: { results: envelope.results } },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  const parsed = await client.query.sparql(
    { query: "SELECT * WHERE { ?s ?p ?o }" },
    { profile: true },
  );
  const raw = await client.query.sparqlRaw({
    query: "ASK { ?s ?p ?o }",
    profile: true,
  });
  const plain = await client.query.sparql({ query: "ASK { ?s ?p ?o }" });

  assert.equal(JSON.parse(bodies[0] ?? "").profile, true);
  assert.equal(JSON.parse(bodies[1] ?? "").profile, true);
  assert.equal(JSON.parse(bodies[2] ?? "").profile, undefined);
  assert.equal(parsed.profile?.result_cache, "bypassed");
  assert.equal(raw.profile?.total_ms, 2.5);
  assert.equal(plain.profile, undefined);
});

test("a false profile is never sent, so older servers accept the body", async () => {
  const envelope = {
    results: JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }),
  };
  const { fetch, bodies } = queuedFetch([
    { body: envelope },
    { body: envelope },
    { body: envelope },
    { body: { snapshot: {}, vars: [], solutions: [] } },
    { body: { snapshot: {}, vars: [], solutions: [] } },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  await client.query.sparql({ query: "ASK {}", profile: false });
  await client.query.sparqlRaw({ query: "ASK {}" }, { profile: false });
  await client.sparqlText({ query: "ASK {}", profile: false });
  await client.query.structured({ patterns: [], select: [], profile: false });
  await client.sparql({ patterns: [], select: [], profile: false });

  for (const body of bodies) {
    assert.equal("profile" in JSON.parse(body ?? "{}"), false, body);
  }
});

test("graph namespace reads planner statistics with paging", async () => {
  const { fetch, urls } = queuedFetch([
    { body: { served_at_seq: null, predicates: [], next_cursor: null } },
    { body: { served_at_seq: 3, predicates: [], next_cursor: null } },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  const empty = await client.graph("main").plannerStats();
  const page = await client.plannerStats({ cursor: "3a", limit: 50 });

  assert.equal(empty.served_at_seq, null);
  assert.equal(page.served_at_seq, 3);
  assert.deepEqual(urls, [
    "http://h/v1/graph/planner-stats?graph=main",
    "http://h/v1/graph/planner-stats?cursor=3a&limit=50",
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

  await client.graph("support").query.structured({ patterns: [], select: [] });

  assert.equal(urls[0], "http://h/v1/query/sparql?graph=support");
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
