import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, type FetchLike } from "./client.js";
import {
  captureActivities,
  lbbActivities,
  type ReviewItemRequest,
} from "./activities.js";
import { isWorkflowTestOpen } from "./workflow-tests.js";
import type { WorkflowContext } from "./workflows.js";

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

type Answer = { status?: number; body?: unknown };

function fakeFetch(answers: Answer[]) {
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
  return { fetch, seen };
}

function client(answers: Answer[]) {
  const { fetch, seen } = fakeFetch(answers);
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

const TEST = {
  id: "wtest_1791967648726a1b2c3d4e5f6",
  object: "workflow_test",
  status: "queued",
};

test("tests start with an idempotency key and read, list, answer and cancel", async () => {
  const { client: lbb, seen } = client([
    { body: TEST },
    { body: { ...TEST, status: "done" } },
    {
      body: {
        object: "list",
        data: [TEST],
        has_more: true,
        next_cursor: TEST.id,
      },
    },
    { body: { object: "list", data: [TEST], has_more: false } },
    { body: TEST },
    { body: { ...TEST, status: "cancelled" } },
  ]);
  const started = await lbb.workflows.tests.create({
    name: "sinks",
    sample: 3,
  });
  assert.equal(started.id, TEST.id);
  assert.equal(seen[0]?.method, "POST");
  assert.equal(seen[0]?.path, "/v1/workflows/named/tests");
  assert.match(
    seen[0]?.headers["idempotency-key"] ?? "",
    /^workflow-tests\.create:/,
  );
  assert.deepEqual(seen[0]?.body, { name: "sinks", sample: 3 });
  const done = await lbb.workflows.tests.get(TEST.id);
  assert.equal(done.status, "done");
  assert.equal(seen[1]?.path, "/v1/workflows/named/tests/get");
  assert.equal(seen[1]?.query.get("id"), TEST.id);
  // `all` pages through the list.
  const all = [];
  for await (const item of lbb.workflows.tests.all({ name: "sinks" }))
    all.push(item);
  assert.equal(all.length, 2);
  assert.equal(seen[2]?.path, "/v1/workflows/named/tests");
  assert.equal(seen[2]?.query.get("name"), "sinks");
  assert.equal(seen[2]?.query.has("starter"), false);
  assert.equal(seen[3]?.query.get("cursor"), TEST.id);
  await lbb.workflows.tests.answer({
    id: TEST.id,
    iri: "lbb:e/1",
    property: "width_cm",
    answer: { decision: "correct", value: 45 },
  });
  assert.equal(seen[4]?.path, "/v1/workflows/named/tests/answer");
  assert.match(
    seen[4]?.headers["idempotency-key"] ?? "",
    /^workflow-tests\.answer:/,
  );
  const cancelled = await lbb.workflows.tests.cancel(TEST.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(seen[5]?.method, "POST");
  assert.equal(seen[5]?.path, "/v1/workflows/named/tests/cancel");
  assert.equal(seen[5]?.query.get("id"), TEST.id);
  assert.equal(
    "dataset" in lbb.workflows.tests,
    false,
    "a test's answers save as a dataset through evals.datasets",
  );
  assert.equal(isWorkflowTestOpen({ status: "running" }), true);
  assert.equal(isWorkflowTestOpen({ status: "failed" }), false);
});

test("wait reads the test until it ends", async () => {
  const { client: lbb, seen } = client([
    { body: { ...TEST, status: "running" } },
    { body: { ...TEST, status: "done" } },
  ]);
  const ended = await lbb.workflows.tests.wait(TEST.id, { intervalMs: 1 });
  assert.equal(ended.status, "done");
  assert.equal(seen.length, 2);
});

test("wait throws a TimeoutError when the test is still open after its timeout", async () => {
  const { client: lbb, seen } = client([
    { body: { ...TEST, status: "running" } },
    { body: { ...TEST, status: "running" } },
  ]);
  await assert.rejects(
    lbb.workflows.tests.wait(TEST.id, { intervalMs: 1, timeoutMs: 0 }),
    (error: Error) => {
      assert.equal(error.name, "TimeoutError");
      assert.equal(error.message, `workflow test ${TEST.id} is still running`);
      return true;
    },
  );
  assert.equal(seen.length, 1, "a timeout of 0 reads the test once");
});

/** A step context that runs each step once and names its effect id. */
function context(keys: string[], workflowId = "asker"): WorkflowContext {
  return {
    workflowId,
    turn: 1,
    step: async <T>(
      key: string,
      effect: (s: { effectId: string }) => Promise<T>,
    ) => {
      keys.push(key);
      return effect({ effectId: `turn/${key}` });
    },
  } as unknown as WorkflowContext;
}

const WRITE = {
  subjects: [{ type: "Fixture", name: "f1" }],
  properties: ["width_cm"],
  entity_properties: [
    { type: "Fixture", name: "f1", properties: { width_cm: 55 } },
  ],
};

test("a capture checks owned writes with the dry run and keeps them, and keeps review items", async () => {
  const { client: lbb, seen } = client([
    { body: { op_count: 1, written_properties: [] } },
  ]);
  const capture = captureActivities(lbbActivities(lbb));
  const keys: string[] = [];
  const written = await capture.activities.writeOwned(
    context(keys),
    "write",
    WRITE,
  );
  assert.deepEqual(keys, ["write"]);
  assert.equal(written.commit_seq, null, "nothing was committed");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.path, "/v1/graph/commit");
  assert.equal(seen[0]?.query.get("dry_run"), "true");
  assert.deepEqual(seen[0]?.body?.replace_owned, {
    subjects: [{ type: "Fixture", name: "f1" }],
    properties: ["width_cm"],
  });
  const filed = await capture.activities.review({
    workflow: "sinks",
    key: "starter:sinks:value:1:material",
    title: "Set material of f1 to Keramik",
  });
  assert.equal(filed.status, "open");
  assert.deepEqual(filed.origin, { kind: "agent", id: "starter:sinks" });
  assert.equal(seen.length, 1, "a review item is kept, not filed");
  const result = capture.result();
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0]?.check, "dry_run");
  assert.deepEqual(result.writes[0]?.errors, []);
  assert.equal(result.reviews.length, 1);
  assert.equal(
    result.reviews[0]?.request.title,
    "Set material of f1 to Keramik",
  );
  // What a live run would report: the write's subject with its field. The
  // review item names no subject, so it reports no input.
  assert.deepEqual(result.results, [
    {
      label: "f1",
      outcome: "written",
      values: [
        { property: "width_cm", value: "55", quote: "", outcome: "written" },
      ],
    },
  ]);
  capture.reset();
  assert.deepEqual(capture.result(), { writes: [], reviews: [], results: [] });
});

test("a capture checks a write's shape first, then the dry run, which an RDF-native graph refuses", async () => {
  const { client: lbb, seen } = client([
    {
      status: 400,
      body: {
        error: {
          code: "rdf_native_graph",
          message:
            "an RDF-native graph refuses a triplet / property commit dry run",
          type: "invalid_request_error",
        },
      },
    },
  ]);
  const capture = captureActivities(lbbActivities(lbb));
  await capture.activities.writeOwned(context([]), "write", {
    ...WRITE,
    triplets: [
      {
        source: { type: "Fixture", name: "f1" },
        relation: "",
        target: { type: "", name: "s" },
      },
    ],
  });
  assert.equal(seen.length, 0, "a write of the wrong shape is not sent");
  await capture.activities.writeOwned(context([]), "plain", {
    subjects: [],
    entity_properties: WRITE.entity_properties,
  });
  await capture.activities.writeOwned(context([]), "again", WRITE);
  const [shape, plain, again] = capture.result().writes;
  assert.equal(shape?.check, "shape");
  assert.deepEqual(shape?.errors, [
    "triplets[0].target needs a type and a name",
    "triplets[0].relation is empty",
  ]);
  assert.equal(plain?.check, "dry_run");
  assert.equal(again?.check, "dry_run");
  assert.deepEqual(again?.errors, []);
  // The dry run's refusal is the commit's: the write cannot land there.
  assert.equal(seen.length, 2);
  assert.equal(
    plain?.errors[0],
    "an RDF-native graph refuses a triplet / property commit dry run",
  );
  // Without a client, the local check, with the commit's own limits.
  const offline = captureActivities({
    ...lbbActivities(lbb),
  });
  await offline.activities.writeOwned(context([]), "write", WRITE);
  await offline.activities.writeOwned(context([]), "many", {
    ...WRITE,
    properties: Array.from({ length: 65 }, (_, i) => `p${i}`),
  });
  const [ok, many] = offline.result().writes;
  assert.equal(ok?.check, "shape");
  assert.deepEqual(ok?.errors, []);
  assert.deepEqual(many?.errors, [
    "replace_owned.properties holds at most 64 names",
  ]);
});

test("a capture's reason and decide calls name the test", async () => {
  const { client: lbb, seen } = client([
    {
      body: {
        value: {},
        model: "m",
        tokens_in: 1,
        tokens_out: 1,
        cost_micro_usd: 1,
        cached: false,
      },
    },
    {
      body: {
        answers: {},
        model: "m",
        tokens_in: 1,
        tokens_out: 0,
        cost_micro_usd: 1,
        cached: false,
      },
    },
  ]);
  const capture = captureActivities(lbbActivities(lbb), { workflow: "sinks" });
  await capture.activities.reason({ prompt: "p", schema: { type: "object" } });
  await capture.activities.decide({
    state: {},
    questions: { q: { instructions: "?", criteria: { a: "a", b: "b" } } },
  });
  assert.deepEqual(
    seen.map((request) => [request.path, request.body?.test]),
    [
      ["/v1/workflows/activities/reason", { workflow: "sinks" }],
      ["/v1/workflows/activities/decide", { workflow: "sinks" }],
    ],
  );
});

test("a capture keeps review items of every kind and files none", async () => {
  const { client: lbb, seen } = client([]);
  const capture = captureActivities(lbbActivities(lbb), { workflow: "sinks" });
  const question: ReviewItemRequest = {
    kind: "value",
    title: "Width of S 4.1",
    key: "sinks:s41:width_cm",
    question: { property: "width_cm", proposed: "60" },
    workflow: "sinks",
  };
  const item = await capture.activities.review(question);
  assert.equal(item.status, "open");
  assert.equal(item.kind, "value");
  assert.equal(item.scope, "test");
  const change = await capture.activities.review({
    title: "Add a class",
    change: [],
  });
  assert.equal(change.status, "open");
  const waited = await capture.activities.waitForReview(
    context([]),
    "ask",
    { ...question, key: "sinks:s41:depth_cm" },
    { timeoutMs: 60_000 },
  );
  assert.equal(waited.answered, false);
  // A trigger shard is refused, as the live call refuses it, and nothing is
  // kept.
  await assert.rejects(
    capture.activities.waitForReview(
      context([], "starter.sinks"),
      "ask",
      { ...question, key: "sinks:s41:height_cm" },
      { timeoutMs: 60_000 },
    ),
    /needs a run with its own identity/,
  );
  assert.equal(seen.length, 0, "nothing is filed");
  assert.deepEqual(
    capture.result().reviews.map((review) => review.request.title),
    ["Width of S 4.1", "Add a class", "Width of S 4.1"],
  );
});
