import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, LbbCapabilityError, type FetchLike } from "./client.js";

function current() {
  const ids = ["identity-store", "auth-outage", "sso-customer"];
  return {
    object: "demo_run",
    version: "demo/1",
    graph: { tenant_id: "acme", graph_id: "research", branch_id: "main" },
    dataset_id: "semantic_graph",
    epoch: 4 as number | null,
    served_at_seq: 7 as number | null,
    outcome: "passed",
    passed: true,
    complete: true,
    expected_case_count: 3,
    completed_case_count: 3 as number | null,
    case_payloads: "available",
    issue: null as string | null,
    class_embedding_checks: "not_requested",
    limits: {
      max_cases: 3,
      max_rows_per_case: 2,
      max_query_bytes: 8192,
      max_result_bytes: 8192,
      max_ontology_bytes: 1048576,
      deadline_millis: 5000,
    },
    cases: ids.map((id) => {
      const variable = id === "identity-store" ? "database" : "customer";
      const iri = `https://example.org/${id}`;
      return {
        id,
        label: id,
        query_kind: "sparql_select",
        query: `SELECT DISTINCT ?${variable} WHERE {} LIMIT 2`,
        variable,
        expected: [{ "@id": iri }],
        epoch: 4,
        served_at_seq: 7,
        outcome: "passed",
        issue: null as string | null,
        actual_result: {
          format: "application/sparql-results+json",
          document: JSON.stringify({
            head: { vars: [variable] },
            results: {
              bindings: [{ [variable]: { type: "uri", value: iri } }],
            },
          }),
        },
      };
    }),
  };
}
function clientFor(payload: unknown) {
  const calls: { url: string; method?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method });
    return new Response(
      JSON.stringify(
        new URL(url).pathname === "/version"
          ? { capabilities: ["rdf_demo_checks_v1"] }
          : payload,
      ),
      { status: 200 },
    );
  };
  return {
    client: new LbbClient({ baseUrl: "http://h", graph: "research", fetch }),
    calls,
  };
}

test("demoRun explicitly selects typed demo/1 and retains exact RDF result documents", async () => {
  const payload = current();
  const { client, calls } = clientFor(payload);
  const response = await client.demoRun();
  assert.deepEqual(response, payload);
  assert.equal(
    response.cases[0].actual_result.document,
    payload.cases[0].actual_result.document,
  );
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "POST");
  const url = new URL(calls[1].url);
  assert.equal(url.searchParams.get("version"), "demo/1");
  assert.equal(url.searchParams.get("dataset"), "semantic_graph");
  assert.equal(url.searchParams.get("graph"), "research");
});

test("demoRun refuses ignored versions, hollow success, mismatched pins and wrong exact terms", async () => {
  const invalid: unknown[] = [
    { dataset: { id: "semantic_graph" }, passed: true, cases: [] },
    { ...current(), version: "demo/2" },
  ];
  for (const mutate of [
    (v: ReturnType<typeof current>) => {
      v.cases = [];
      v.completed_case_count = 0;
    },
    (v: ReturnType<typeof current>) => {
      v.cases[1].epoch = 5;
    },
    (v: ReturnType<typeof current>) => {
      v.cases[1].served_at_seq = 8;
    },
    (v: ReturnType<typeof current>) => {
      v.cases[1].id = v.cases[0].id;
    },
    (v: ReturnType<typeof current>) => {
      v.completed_case_count = 2;
    },
    (v: ReturnType<typeof current>) => {
      v.cases[0].expected = [];
    },
    (v: ReturnType<typeof current>) => {
      v.cases[0].actual_result.document =
        v.cases[0].actual_result.document.replace(
          "https://example.org/identity-store",
          "https://example.org/identity-store-decoy",
        );
    },
    (v: ReturnType<typeof current>) => {
      v.cases[0].actual_result.document = "not JSON";
    },
  ]) {
    const value = current();
    mutate(value);
    invalid.push(value);
  }
  for (const forbidden of [String.fromCharCode(0), "\n", " "]) {
    const value = current();
    const invalidIri = value.cases[0].expected[0]["@id"] + forbidden;
    value.cases[0].expected[0]["@id"] = invalidIri;
    const document = JSON.parse(value.cases[0].actual_result.document);
    document.results.bindings[0][value.cases[0].variable].value = invalidIri;
    value.cases[0].actual_result.document = JSON.stringify(document);
    invalid.push(value);
  }
  for (const payload of invalid)
    await assert.rejects(
      () => clientFor(payload).client.demoRun(),
      LbbCapabilityError,
    );
});

test("interruptions withhold old rows and pins instead of reporting empty data", async () => {
  const payload = current();
  payload.cases = [];
  payload.completed_case_count = null;
  payload.case_payloads = "withheld";
  payload.epoch = null;
  payload.served_at_seq = null;
  payload.outcome = "unavailable";
  payload.passed = false;
  payload.complete = false;
  payload.issue = "timeout";
  assert.deepEqual(await clientFor(payload).client.demoRun(), payload);
  const retired = current();
  retired.issue = "snapshot_changed";
  retired.outcome = "unavailable";
  retired.passed = false;
  retired.complete = false;
  retired.case_payloads = "withheld";
  await assert.rejects(
    () => clientFor(retired).client.demoRun(),
    LbbCapabilityError,
  );
  const partial = current();
  partial.cases = partial.cases.slice(0, 1);
  partial.completed_case_count = 1;
  partial.issue = "timeout";
  partial.outcome = "unavailable";
  partial.passed = false;
  partial.complete = false;
  await assert.rejects(
    () => clientFor(partial).client.demoRun(),
    LbbCapabilityError,
  );
});

test("unsupported RDF terms retain their literal lexical evidence without a pass", async () => {
  const payload = current();
  payload.outcome = "unavailable";
  payload.passed = false;
  payload.complete = false;
  payload.cases[0].outcome = "unavailable";
  payload.cases[0].issue = "unexpected_term_shape";
  payload.cases[0].actual_result.document = JSON.stringify({
    head: { vars: ["database"] },
    results: {
      bindings: [
        {
          database: {
            type: "literal",
            value: "9007199254740993",
            datatype: "http://www.w3.org/2001/XMLSchema#integer",
          },
        },
      ],
    },
  });
  const result = await clientFor(payload).client.demoRun();
  assert.equal(
    result.cases[0].actual_result.document,
    payload.cases[0].actual_result.document,
  );
  assert.equal(result.passed, false);
});

test("legacy selection is explicit and refuses a current response", async () => {
  const payload = {
    dataset: { id: "semantic_graph" },
    passed: false,
    cases: [],
  };
  const { client, calls } = clientFor(payload);
  assert.deepEqual(await client.demoRun({ version: "legacy" }), payload);
  assert.equal(new URL(calls[0].url).searchParams.get("version"), "legacy");
  await assert.rejects(
    () => clientFor(current()).client.demoRun({ version: "legacy" }),
    LbbCapabilityError,
  );
});

test("missing capability sends no demo or mutation POST", async () => {
  const calls: { url: string; method?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method });
    return new Response(JSON.stringify({ capabilities: [] }));
  };
  const client = new LbbClient({ baseUrl: "http://old", fetch });
  await assert.rejects(() => client.demoRun(), LbbCapabilityError);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/version");
  assert.equal(
    calls.some((call) => call.method === "POST"),
    false,
  );
});

test("demoRun binds its dataset selector exactly, including an explicit empty string", async () => {
  for (const dataset of ["basic", ""]) {
    const { client, calls } = clientFor(current());
    await assert.rejects(() => client.demoRun({ dataset }), LbbCapabilityError);
    const post = calls.find((call) => call.method === "POST");
    assert.ok(post);
    assert.equal(new URL(post.url).searchParams.get("dataset"), dataset);
  }
});
