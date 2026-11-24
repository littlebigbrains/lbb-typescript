import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, type FetchLike } from "./client.js";

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

function client(answers: unknown[]) {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    seen.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: init?.headers ?? {},
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const body = answers.shift() ?? {};
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      text: async () => JSON.stringify(body),
    };
  };
  return {
    client: new LbbClient({
      baseUrl: "http://h",
      graph: "interviews",
      fetch,
      retryDelayMs: 0,
      maxRetries: 0,
    }),
    seen,
  };
}

const scope = {
  subjects: ["https://x.test/person/jana"],
  follow: [{ predicate: "https://x.test/spokenBy", direction: "in" as const }],
};

test("erasures.preview sends a dry run without a key", async () => {
  const { client: lbb, seen } = client([{ object: "erasure_preview" }]);
  const preview = await lbb.erasures.preview(scope, {
    idempotencyKey: "ignored",
  });
  assert.equal(preview.object, "erasure_preview");
  assert.equal(seen[0]?.method, "POST");
  assert.equal(seen[0]?.path, "/v1/erasures");
  assert.equal(seen[0]?.query.get("graph"), "interviews");
  assert.deepEqual(seen[0]?.body, { ...scope, dry_run: true });
  assert.equal(seen[0]?.headers["idempotency-key"], undefined);
});

test("erasures.erase sends the scope under a key", async () => {
  const { client: lbb, seen } = client([
    { id: "ers_1", object: "erasure", status: "masked" },
    { id: "ers_1", object: "erasure", status: "masked" },
  ]);
  const erasure = await lbb.erasures.erase(scope);
  assert.equal(erasure.id, "ers_1");
  assert.deepEqual(seen[0]?.body, { ...scope, dry_run: false });
  assert.match(seen[0]?.headers["idempotency-key"] ?? "", /^erase/);
  await lbb.erasures.erase(scope, { idempotencyKey: "withdraw-jana" });
  assert.equal(seen[1]?.headers["idempotency-key"], "withdraw-jana");
});

test("erasures.get and erasures.list read the graph's erasures", async () => {
  const { client: lbb, seen } = client([
    { id: "ers_1", object: "erasure" },
    { object: "list", data: [], has_more: false },
  ]);
  await lbb.erasures.get("ers_1");
  assert.equal(seen[0]?.path, "/v1/erasures/get");
  assert.equal(seen[0]?.query.get("id"), "ers_1");
  const list = await lbb.erasures.list();
  assert.equal(list.object, "list");
  assert.equal(seen[1]?.path, "/v1/erasures");
  assert.equal(seen[1]?.query.get("graph"), "interviews");
});
