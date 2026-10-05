import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, type FetchLike } from "./index.js";

/** A fetch that answers `payloads` in order and keeps each request. */
function queuedFetch(payloads: Array<{ status?: number; body: unknown }>) {
  const requests: Array<{ url: string; method?: string; body?: string }> = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const next = payloads.shift() ?? { body: {} };
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(next.body),
    };
  };
  return { fetch, requests };
}

const korn = {
  text: "David Korn",
  iri: "https://x.test/e/korn",
  label: "David Korn",
  class: "https://x.test/class/Person",
  score: 1,
  by: "exact",
};

test("query names posts the text and returns the candidates", async () => {
  const { fetch, requests } = queuedFetch([
    {
      body: {
        candidates: [korn],
        index_ready: true,
        index_names: 8,
        commit_seq: 4,
        ms: 3,
      },
    },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", graph: "crm", fetch });

  const found = await client.query.names({
    text: "Summarize David Korn's deals",
    limit: 3,
  });

  assert.equal(found.candidates[0]?.iri, korn.iri);
  assert.equal(found.index_ready, true);
  assert.deepEqual(requests, [
    {
      url: "http://h/v1/query/names?graph=crm",
      method: "POST",
      body: JSON.stringify({ text: "Summarize David Korn's deals", limit: 3 }),
    },
  ]);
});

test("query describe and commitAt read the graph's tools", async () => {
  const { fetch, requests } = queuedFetch([
    {
      body: {
        commit_seq: 4,
        partial: false,
        classes: [],
        properties: [],
        statements: [],
        prefixes: {},
        text: "Published commit 4.\n",
        age_ms: 10,
      },
    },
    {
      body: {
        moment: "2026-06-19T00:00:00Z",
        as_of_commit_seq: 5,
        committed_at: "2026-06-18T09:00:00Z",
        resolved_by: "commit_time",
      },
    },
    {
      body: {
        moment: "2026-06-18T10:30:00Z",
        note: "The moment is before the graph's first commit (2026-07-01T00:00:00Z). The graph held nothing then.",
        first_commit_at: "2026-07-01T00:00:00Z",
      },
    },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  const described = await client.query.describe({
    question: "Which clubs are active?",
  });
  assert.equal(described.commit_seq, 4);
  const at = await client.query.commitAt({ date: "2026-06-18" });
  assert.equal(at.as_of_commit_seq, 5);
  const before = await client.query.commitAt({
    moment: "2026-06-18T12:30:00+02:00",
  });
  assert.equal(before.as_of_commit_seq, undefined);

  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.url}`),
    [
      "POST http://h/v1/query/describe",
      "GET http://h/v1/graph/commit-at?date=2026-06-18",
      "GET http://h/v1/graph/commit-at?moment=2026-06-18T12%3A30%3A00%2B02%3A00",
    ],
  );
  assert.equal(
    requests[0]?.body,
    JSON.stringify({ question: "Which clubs are active?" }),
  );
});

test("query compare pages with the cursor and keeps consistency on the URL", async () => {
  const page = (offset: number, next?: string) => ({
    before: {
      as_of_commit_seq: 1,
      resolved_by: "commit_time",
      rows: 1200,
      total: 1200,
      complete: true,
      pages: 3,
      ms: 40,
    },
    after: {
      as_of_commit_seq: 2,
      resolved_by: "latest",
      rows: 1230,
      total: 1230,
      complete: true,
      pages: 3,
      ms: 41,
    },
    vars: ["c", "stage"],
    key: ["c"],
    added: [],
    removed: [],
    changed: [],
    totals: { added: 50, removed: 20, changed: 300, unchanged: 880 },
    offset,
    ...(next ? { next_cursor: next } : {}),
    ms: 90,
  });
  const { fetch, requests } = queuedFetch([
    { body: page(0, "7b22") },
    { body: page(100) },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch });
  const body = {
    query: "SELECT ?c ?stage WHERE { ?c <https://x.test/p/stage> ?stage }",
    before: { date: "2026-06-05" },
    key: ["c"],
  };

  const first = await client.query.compare(body, { consistency: "strong" });
  assert.equal(first.totals.changed, 300);
  const second = await client.query.compare({
    ...body,
    cursor: first.next_cursor ?? undefined,
  });
  assert.equal(second.offset, 100);
  assert.equal(second.next_cursor, undefined);

  assert.equal(
    requests[0]?.url,
    "http://h/v1/query/compare?consistency=strong",
  );
  assert.equal(JSON.parse(requests[1]?.body ?? "{}").cursor, "7b22");
});
