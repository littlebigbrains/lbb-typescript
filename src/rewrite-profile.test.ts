import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, LbbError, type FetchLike } from "./index.js";

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

const stored = {
  version: 2,
  notes: "A deal's current stage is p:deal_stage.",
  examples: [
    {
      question: "My open deals",
      sparql: "SELECT ?d WHERE { ?d a <https://x.test/Deal> }",
    },
  ],
  updated_at: "2026-10-05T10:00:00.000Z",
};

test("query rewriteProfile reads the graph's profile", async () => {
  const { fetch, requests } = queuedFetch([{ body: stored }]);
  const client = new LbbClient({ baseUrl: "http://h", graph: "crm", fetch });

  const profile = await client.query.rewriteProfile();

  assert.equal(profile.version, 2);
  assert.equal(profile.examples[0]?.question, "My open deals");
  assert.deepEqual(requests, [
    {
      url: "http://h/v1/query/rewrite/profile?graph=crm",
      method: "GET",
      body: undefined,
    },
  ]);
});

test("query setRewriteProfile writes with the version read, and previews", async () => {
  const { fetch, requests } = queuedFetch([
    { body: { ...stored, version: 3, dry_run: true } },
    {
      status: 409,
      body: {
        error: {
          type: "conflict_error",
          code: "conflict",
          message: "the rewrite profile is at version 3, not 2",
        },
      },
    },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", fetch, retryDelayMs: 0 });
  const body = {
    notes: stored.notes,
    examples: stored.examples,
    expected_version: 2,
  };

  const preview = await client.query.setRewriteProfile(body, { dryRun: true });
  assert.equal(preview.dry_run, true);
  assert.equal(preview.version, 3);

  await assert.rejects(client.query.setRewriteProfile(body), (error) => {
    assert.ok(error instanceof LbbError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "conflict");
    return true;
  });
  assert.equal(
    requests[0]?.url,
    "http://h/v1/query/rewrite/profile?dry_run=true",
  );
  assert.equal(requests[0]?.method, "PUT");
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), body);
  assert.equal(requests[1]?.url, "http://h/v1/query/rewrite/profile");
  assert.equal(requests.length, 2, "a conflict is not retried");
});
