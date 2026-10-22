import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, type FetchLike } from "./client.js";

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
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
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
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
      maxRetries: 2,
    }),
    seen,
  };
}

const DATASET = {
  id: "ds_1791967648726a1b2c3d4e5f6",
  object: "eval_dataset",
  created: "2026-10-21T10:00:00.000000Z",
  name: "sinks",
  kind: "values",
  install: { properties: { width_cm: "f64" } },
  item_count: 1,
};

const ITEM = {
  name: "S 1",
  text: "S 1 Waschtisch, 60 cm breit.",
  values: [{ property: "width_cm", value: 60, quote: "60 cm" }],
  leave_out: [],
};

test("datasets create with an idempotency key, list, read, add items, export and delete", async () => {
  const { client: lbb, seen } = client([
    { body: { ...DATASET, items: [ITEM] } },
    {
      body: {
        object: "list",
        data: [DATASET],
        has_more: true,
        next_cursor: DATASET.id,
      },
    },
    { body: { object: "list", data: [DATASET], has_more: false } },
    { body: { ...DATASET, items: [ITEM] } },
    { body: { ...DATASET, item_count: 2, items: [ITEM, ITEM] } },
    {
      body: {
        records: [{ name: "S 1", text: ITEM.text }],
        expected: { about: [], install: DATASET.install, records: [] },
      },
    },
    { body: { id: DATASET.id, object: "eval_dataset", deleted: true } },
  ]);
  const created = await lbb.evals.datasets.create({
    name: "sinks",
    kind: "values",
    install: { properties: { width_cm: "f64" } },
    items: [ITEM],
  });
  assert.equal(created.id, DATASET.id);
  assert.equal(seen[0]?.method, "POST");
  assert.equal(seen[0]?.path, "/v1/evals/datasets");
  assert.match(
    seen[0]?.headers["idempotency-key"] ?? "",
    /^eval-datasets\.create:/,
  );
  assert.equal(seen[0]?.body?.name, "sinks");
  // `all` pages through the list.
  const all = [];
  for await (const dataset of lbb.evals.datasets.all({ limit: 1 }))
    all.push(dataset);
  assert.equal(all.length, 2);
  assert.equal(seen[1]?.path, "/v1/evals/datasets");
  assert.equal(seen[1]?.query.get("limit"), "1");
  assert.equal(seen[2]?.query.get("cursor"), DATASET.id);
  const read = await lbb.evals.datasets.get(DATASET.id);
  assert.equal(read.items?.length, 1);
  assert.equal(seen[3]?.path, "/v1/evals/datasets/get");
  assert.equal(seen[3]?.query.get("id"), DATASET.id);
  const added = await lbb.evals.datasets.addItems(DATASET.id, [ITEM]);
  assert.equal(added.item_count, 2);
  assert.equal(seen[4]?.path, "/v1/evals/datasets/items");
  assert.deepEqual(seen[4]?.body, { id: DATASET.id, items: [ITEM] });
  assert.match(
    seen[4]?.headers["idempotency-key"] ?? "",
    /^eval-datasets\.items:/,
  );
  const files = await lbb.evals.datasets.export(DATASET.id);
  assert.equal(files.records[0]?.text, ITEM.text);
  assert.equal(seen[5]?.path, "/v1/evals/datasets/export");
  const deleted = await lbb.evals.datasets.delete(DATASET.id);
  assert.deepEqual(deleted, {
    id: DATASET.id,
    object: "eval_dataset",
    deleted: true,
  });
  assert.equal(seen[6]?.method, "DELETE");
  assert.equal(seen[6]?.path, "/v1/evals/datasets");
  assert.equal(seen[6]?.query.get("id"), DATASET.id);
  assert.equal(seen[6]?.body, undefined);
  assert.match(
    seen[6]?.headers["idempotency-key"] ?? "",
    /^eval-datasets\.delete:/,
  );
});

test("a delete that fails with a 5xx is retried under the same key", async () => {
  const { client: lbb, seen } = client([
    { status: 503, body: { error: { code: "unavailable", message: "busy" } } },
    { body: { id: DATASET.id, object: "eval_dataset", deleted: true } },
  ]);
  const deleted = await lbb.evals.datasets.delete(DATASET.id);
  assert.equal(deleted.deleted, true);
  assert.equal(seen.length, 2);
  assert.equal(
    seen[0]?.headers["idempotency-key"],
    seen[1]?.headers["idempotency-key"],
  );
});

test("a test's answers save as its one dataset by its source", async () => {
  const { client: lbb, seen } = client([{ body: DATASET }]);
  await lbb.evals.datasets.create(
    {
      name: "sinks answers",
      kind: "values",
      source: { kind: "test", id: "wtest_1791967648726a1b2c3d4e5f6" },
    },
    { idempotencyKey: "save-1" },
  );
  assert.equal(seen[0]?.headers["idempotency-key"], "save-1");
  assert.deepEqual(seen[0]?.body, {
    name: "sinks answers",
    kind: "values",
    source: { kind: "test", id: "wtest_1791967648726a1b2c3d4e5f6" },
  });
});
