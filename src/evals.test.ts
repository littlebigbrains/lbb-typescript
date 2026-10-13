import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, type FetchLike } from "./index.js";

/** A fetch that answers `{}` and keeps each request. */
function recordingFetch() {
  const requests: Array<{ url: string; method?: string; body?: string }> = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "{}",
    };
  };
  return { fetch, requests };
}

test("evals runAnswers posts the app's answers and results reads its series", async () => {
  const { fetch, requests } = recordingFetch();
  const client = new LbbClient({ baseUrl: "http://h", graph: "crm", fetch });
  const answers = [
    {
      golden: "g1",
      sparql: "ASK { ?s ?p ?o }",
      route: {
        kind: "lookup" as const,
        confidence: 0.75,
        by: "router" as const,
      },
    },
    { golden: "g2", error: "the model timed out" },
  ];

  await client.evals.runAnswers(
    { runner: "my-agent", answers },
    { consistency: "strong" },
  );
  await client.evals.results({ runner: "my-agent", limit: 5 });

  assert.equal(requests.length, 2);
  const run = new URL(requests[0]?.url ?? "");
  assert.equal(requests[0]?.method, "POST");
  assert.equal(run.pathname, "/v1/evals/run/answers");
  assert.equal(run.searchParams.get("consistency"), "strong");
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
    runner: "my-agent",
    answers,
  });
  const results = new URL(requests[1]?.url ?? "");
  assert.equal(requests[1]?.method, "GET");
  assert.equal(results.pathname, "/v1/evals/results");
  assert.equal(results.searchParams.get("runner"), "my-agent");
  assert.equal(results.searchParams.get("limit"), "5");
});

test("evals label sends the route of a question", async () => {
  const { fetch, requests } = recordingFetch();
  const client = new LbbClient({ baseUrl: "http://h", graph: "crm", fetch });

  await client.evals.label("t1", { valid: true, route: "aggregate" });

  assert.equal(new URL(requests[0]?.url ?? "").searchParams.get("trace"), "t1");
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
    valid: true,
    route: "aggregate",
  });
});
