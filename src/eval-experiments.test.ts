import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, type FetchLike } from "./client.js";
import { isEvalExperimentOpen } from "./eval-experiments.js";

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

const EXPERIMENT = {
  id: "exp_1791967648726a1b2c3d4e5f6",
  object: "eval_experiment",
  created: "2026-10-26T10:00:00.000000Z",
  workflow: { name: "sinks", created: "2026-10-20T10:00:00.000000Z" },
  dataset: { id: "ds_1791967648726a1b2c3d4e5f6", name: "sinks", items: 6 },
  change: { kind: "model", use: "extract" },
  status: "running",
};

const REQUEST = {
  workflow: "sinks",
  dataset: "ds_1791967648726a1b2c3d4e5f6",
  b: {
    model: {
      use: "extract" as const,
      model: { provider: "mock", model: "mock-candidate" },
    },
  },
};

test("experiments map each operation to its route", async () => {
  const { client: lbb, seen } = client([
    { body: { ...EXPERIMENT, status: "queued" } },
    {
      body: {
        object: "eval_experiment_estimate",
        items: 6,
        a_micro_usd: 6600,
        b_micro_usd: 6600,
        estimate_micro_usd: 13200,
        max_cost_micro_usd: 5_000_000,
      },
    },
    { body: EXPERIMENT },
    { body: { ...EXPERIMENT, status: "cancelled" } },
  ]);
  const started = await lbb.evals.experiments.create(REQUEST);
  const estimate = await lbb.evals.experiments.estimate(REQUEST);
  const read = await lbb.evals.experiments.get(EXPERIMENT.id);
  const cancelled = await lbb.evals.experiments.cancel(EXPERIMENT.id);

  assert.equal(started.status, "queued");
  assert.equal(estimate.estimate_micro_usd, 13200);
  assert.equal(read.id, EXPERIMENT.id);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(
    seen.map((s) => `${s.method} ${s.path}`),
    [
      "POST /v1/evals/experiments",
      "POST /v1/evals/experiments/estimate",
      "GET /v1/evals/experiments/get",
      "POST /v1/evals/experiments/cancel",
    ],
  );
  assert.deepEqual(seen[0]?.body, REQUEST);
  assert.deepEqual(seen[1]?.body, REQUEST);
  assert.equal(seen[2]?.query.get("id"), EXPERIMENT.id);
  assert.equal(seen[3]?.query.get("id"), EXPERIMENT.id);
  // A create and a cancel carry an idempotency key; an estimate and a read
  // carry none.
  assert.match(
    seen[0]?.headers["idempotency-key"] ?? "",
    /^eval-experiments\.create:/,
  );
  assert.equal(seen[1]?.headers["idempotency-key"], undefined);
  assert.match(
    seen[3]?.headers["idempotency-key"] ?? "",
    /^eval-experiments\.cancel:/,
  );
});

test("a create sent with the caller's key keeps it", async () => {
  const { client: lbb, seen } = client([{ body: EXPERIMENT }]);
  await lbb.evals.experiments.create(REQUEST, { idempotencyKey: "mine-1" });
  assert.equal(seen[0]?.headers["idempotency-key"], "mine-1");
});

test("experiments page through the list envelope with their filters", async () => {
  const page = (cursor: string | null, id: string) => ({
    body: {
      object: "list",
      data: [{ ...EXPERIMENT, id }],
      has_more: cursor !== null,
      next_cursor: cursor,
    },
  });
  const { client: lbb, seen } = client([
    page("exp_1791967648726a1b2c3d4e5f7", "exp_1791967648726a1b2c3d4e5f8"),
    page(null, "exp_1791967648726a1b2c3d4e5f7"),
  ]);
  const ids: string[] = [];
  for await (const experiment of lbb.evals.experiments.all({
    workflow: "sinks",
    status: "done",
    limit: 1,
  }))
    ids.push(experiment.id);
  assert.deepEqual(ids, [
    "exp_1791967648726a1b2c3d4e5f8",
    "exp_1791967648726a1b2c3d4e5f7",
  ]);
  assert.equal(seen[0]?.query.get("workflow"), "sinks");
  assert.equal(seen[0]?.query.get("status"), "done");
  assert.equal(seen[0]?.query.get("limit"), "1");
  assert.equal(seen[0]?.query.get("cursor"), null);
  assert.equal(seen[1]?.query.get("cursor"), "exp_1791967648726a1b2c3d4e5f7");
});

test("wait reads the experiment until it ends", async () => {
  const { client: lbb, seen } = client([
    { body: { ...EXPERIMENT, status: "queued" } },
    { body: EXPERIMENT },
    { body: { ...EXPERIMENT, status: "done" } },
  ]);
  const done = await lbb.evals.experiments.wait(EXPERIMENT.id, {
    intervalMs: 1,
  });
  assert.equal(done.status, "done");
  assert.equal(seen.length, 3);
  assert.ok(isEvalExperimentOpen({ status: "queued" }));
  assert.ok(!isEvalExperimentOpen({ status: "cancelled" }));
});

test("wait throws a TimeoutError when the experiment stays open", async () => {
  const { client: lbb } = client(
    Array.from({ length: 50 }, () => ({ body: EXPERIMENT })),
  );
  await assert.rejects(
    lbb.evals.experiments.wait(EXPERIMENT.id, { intervalMs: 1, timeoutMs: 5 }),
    (error: Error) => error.name === "TimeoutError",
  );
});

test("a refusal raises the experiment's code", async () => {
  const { client: lbb } = client([
    {
      status: 400,
      body: {
        error: {
          type: "invalid_request_error",
          code: "experiment_arms_mixed",
          message: "B changes one part of A",
          param: "b",
        },
      },
    },
  ]);
  await assert.rejects(
    lbb.evals.experiments.create({ ...REQUEST, b: { revision: "wrev_1" } }),
    (error: { code?: string }) => error.code === "experiment_arms_mixed",
  );
});
