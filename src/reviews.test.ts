import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, type FetchLike } from "./client.js";
import { LbbError } from "./transport.js";

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
}

type Answer = { status?: number; body?: unknown };

function client(answers: Answer[]) {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    seen.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: init?.headers ?? {},
    });
    const answer = answers.shift() ?? { body: {} };
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      text: async () => JSON.stringify(answer.body ?? {}),
    };
  };
  return {
    client: new LbbClient({
      baseUrl: "http://h",
      graph: "tender",
      fetch,
      retryDelayMs: 0,
      maxRetries: 0,
    }),
    seen,
  };
}

const item = {
  id: "rev_1",
  object: "review_item",
  kind: "value",
  status: "open",
};

test("reviews.all pages with the list's filters until has_more is false", async () => {
  const { client: lbb, seen } = client([
    {
      body: { object: "list", data: [item], has_more: true, next_cursor: "c1" },
    },
    {
      body: {
        object: "list",
        data: [{ ...item, id: "rev_2" }],
        has_more: false,
      },
    },
  ]);
  const ids: string[] = [];
  for await (const each of lbb.reviews.all({ status: "open", limit: 1 })) {
    ids.push(each.id);
  }
  assert.deepEqual(ids, ["rev_1", "rev_2"]);
  assert.equal(seen[0]?.query.get("cursor"), null);
  assert.equal(seen[1]?.query.get("cursor"), "c1");
  assert.equal(seen[1]?.query.get("status"), "open");
});

test("reviews.get reads /get, and the earlier route of an older data plane", async () => {
  const { client: lbb, seen } = client([
    { body: item },
    {
      status: 404,
      body: {
        error: {
          type: "not_found_error",
          code: "not_found",
          message: "no route for /v1/reviews/get",
        },
      },
    },
    { body: item },
    {
      status: 404,
      body: {
        error: {
          type: "not_found_error",
          code: "not_found",
          message: "no review item rev_9",
        },
      },
    },
  ]);
  assert.equal((await lbb.reviews.get("rev_1")).id, "rev_1");
  assert.equal((await lbb.reviews.get("rev_1")).id, "rev_1");
  await assert.rejects(lbb.reviews.get("rev_9"), (error: unknown) => {
    assert.ok(error instanceof LbbError);
    assert.equal(error.status, 404);
    return true;
  });
  assert.deepEqual(
    seen.map((each) => each.path),
    [
      "/v1/reviews/get",
      "/v1/reviews/get",
      "/v1/reviews/detail",
      "/v1/reviews/get",
    ],
  );
});

test("each review write sends an idempotency key: the caller's, else its own", async () => {
  const { client: lbb, seen } = client([
    { body: item },
    { body: { batch_id: "b", answered: 1, skipped: 0, results: [] } },
    { body: item },
    { body: item },
  ]);
  await lbb.reviews.answer("rev_1", { answer: { decision: "accept" } });
  await lbb.reviews.answerBatch({
    ids: ["rev_2"],
    answer: { decision: "accept" },
  });
  await lbb.reviews.withdraw("rev_1", "superseded");
  await lbb.reviews.comment(
    "rev_1",
    { text: "checked" },
    { idempotencyKey: "comment-1" },
  );
  const keys = seen.map((each) => each.headers["idempotency-key"] ?? "");
  assert.match(keys[0] ?? "", /^reviews\.answer:/);
  assert.match(keys[1] ?? "", /^reviews\.answerBatch:/);
  assert.match(keys[2] ?? "", /^reviews\.withdraw:/);
  assert.equal(keys[3], "comment-1");
});
