import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, type FetchLike, type Schemas } from "./client.js";
import { LbbError } from "./transport.js";
import {
  fanInIdentity,
  isFanInIdentity,
  workflow,
  workflowOfIdentity,
  WorkflowWorker,
} from "./workflows.js";

type Task = Schemas["WorkflowTurnTask"];
function task(steps: Task["turn"]["steps"] = []): Task {
  return {
    workflow_type: "counter",
    state: { count: 0 },
    token: "token",
    lease_ms: 60_000,
    effect_prefix: "stable",
    turn: {
      workflow_id: "agent",
      number: 1,
      message_id: "m1",
      message: { add: 1 },
      version: "v1",
      status: "running",
      attempt: 1,
      created_at_ms: 1,
      updated_at_ms: 1,
      ready_at_ms: 1,
      steps,
      result: null,
      state_after: null,
      sequence: 1,
    },
  };
}
function setup(
  tasks: Task[],
  failComplete = false,
  respond?: (path: string, body: Record<string, unknown>) => unknown,
) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const client = new LbbClient({
    baseUrl: "http://localhost:7400",
    maxRetries: 2,
    retryDelayMs: 0,
    fetch: async (input, init) => {
      const path = new URL(input).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      calls.push({ path, body });
      if (path.endsWith("/complete") && failComplete) {
        failComplete = false;
        throw new TypeError("lost response");
      }
      return new Response(
        JSON.stringify(
          path.endsWith("/claim")
            ? { task: tasks.shift() ?? null }
            : (respond?.(path, body) ?? {}),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  return { client, calls };
}
test("replay reuses named results and a lost completion retries the same state/reply", async () => {
  const old = task([{ key: "increment", kind: "step", output: 7, at_ms: 2 }]);
  const { client, calls } = setup([old], true);
  let effects = 0;
  const counter = workflow({
    name: "counter",
    version: "v1",
    initialState: { count: 0 },
    async onMessage(ctx, state, message: { add: number }) {
      const value = await ctx.step("increment", async () => {
        effects++;
        return state.count + message.add;
      });
      return { state: { count: value }, result: value };
    },
  });
  await new WorkflowWorker(client, [counter], { worker: "test" }).runOnce();
  assert.equal(effects, 0);
  const done = calls.filter((c) => c.path.endsWith("/complete"));
  assert.equal(done.length, 2);
  assert.deepEqual(done[0].body, done[1].body);
  assert.deepEqual(done[0].body.state, { count: 7 });
  assert.equal(calls.filter((c) => c.path.endsWith("/checkpoint")).length, 0);
});
test("sleeps release the worker and resume with stable effect ids and atomic continuation", async () => {
  const first = task();
  const second = task([
    { key: "effect", kind: "step", output: 1, at_ms: 2 },
    {
      key: "timer",
      kind: "sleep",
      output: null,
      delay_ms: 1000,
      at_ms: 3,
      wake_at_ms: 1003,
    },
  ]);
  second.token = "new-token";
  const { client, calls } = setup([first, second]);
  let effects = 0;
  const counter = workflow({
    name: "counter",
    version: "v1",
    initialState: { count: 0 },
    async onMessage(ctx, state, message: { add: number }) {
      const value = await ctx.step("effect", async ({ effectId }) => {
        assert.equal(effectId, "stable/effect");
        effects++;
        return message.add;
      });
      await ctx.sleep("timer", 1000);
      return ctx.continue({ count: state.count + value }, { add: 2 });
    },
  });
  const worker = new WorkflowWorker(client, [counter], { worker: "test" });
  await worker.runOnce();
  assert.equal(calls.filter((c) => c.path.endsWith("/complete")).length, 0);
  await worker.runOnce();
  assert.equal(effects, 1);
  const done = calls.find((c) => c.path.endsWith("/complete"));
  assert.deepEqual(done?.body.continuation, { message: { add: 2 } });
  assert.deepEqual(done?.body.state, { count: 1 });
});
test("changed step order is a permanent failure and cannot commit state", async () => {
  const { client, calls } = setup([
    task([{ key: "old-name", kind: "step", output: 1, at_ms: 2 }]),
  ]);
  const counter = workflow({
    name: "counter",
    version: "v1",
    initialState: 0,
    async onMessage(ctx) {
      await ctx.step("new-name", async () => 1);
      return { state: 1 };
    },
  });
  await new WorkflowWorker(client, [counter], { worker: "test" }).runOnce();
  assert.equal(
    calls.find((c) => c.path.endsWith("/fail"))?.body.non_retryable,
    true,
  );
  assert.equal(
    calls.some((c) => c.path.endsWith("/complete")),
    false,
  );
});
test("a commit refused as outside owns fails the turn for good; another 403 keeps its attempts", async () => {
  const { client, calls } = setup([task(), task()]);
  let refusal: LbbError = new LbbError(403, "{}", {
    code: "write_outside_owns",
    message: "the commit writes a property that its workflow does not own",
  });
  const counter = workflow({
    name: "counter",
    version: "v1",
    initialState: 0,
    async onMessage(ctx) {
      await ctx.step("write", async () => {
        throw refusal;
      });
      return { state: 1 };
    },
  });
  const worker = new WorkflowWorker(client, [counter], { worker: "test" });
  await worker.runOnce();
  refusal = new LbbError(403, "{}", {
    code: "owner_reserved",
    message: "the owner is reserved",
  });
  await worker.runOnce();
  const fails = calls.filter((c) => c.path.endsWith("/fail"));
  assert.equal(fails.length, 2);
  assert.equal(fails[0]?.body.non_retryable, true);
  assert.equal(fails[1]?.body.non_retryable, false);
});
test("a value JSON cannot hold fails the turn for good and names where it is", async () => {
  const { client, calls } = setup([task(), task()]);
  const counter = workflow<number, { add?: number; full?: boolean }>({
    name: "counter",
    version: "v1",
    initialState: 0,
    async onMessage(ctx, _state, message) {
      if (message.add === 1)
        // A field left undefined, as a sync message without `full` once did.
        return ctx.continue(1, { full: undefined });
      return { state: 1 };
    },
  });
  await new WorkflowWorker(client, [counter], { worker: "test" }).runOnce();
  const fail = calls.find((c) => c.path.endsWith("/fail"))?.body;
  assert.equal(fail?.non_retryable, true);
  assert.match(
    JSON.stringify(fail),
    /JSON serializable \(use null for no result\): continuation\.message\.full is undefined/,
  );
  assert.equal(
    calls.some((c) => c.path.endsWith("/complete")),
    false,
  );

  const stepper = workflow({
    name: "counter",
    version: "v1",
    initialState: 0,
    async onMessage(ctx) {
      await ctx.step("page.0", async () => ({ rows: [1, undefined] }));
      return { state: 1 };
    },
  });
  calls.length = 0;
  await new WorkflowWorker(client, [stepper], { worker: "test" }).runOnce();
  assert.match(
    JSON.stringify(calls.find((c) => c.path.endsWith("/fail"))?.body),
    /step \\"page\.0\\"\.rows\[1\] is undefined/,
  );
});

test("sequential effects checkpoint before completion and fresh turns do not inherit steps", async () => {
  const t1 = task(),
    t2 = task();
  t2.turn.number = 2;
  t2.turn.message_id = "m2";
  t2.state = { count: 1 };
  t2.effect_prefix = "next";
  const { client, calls } = setup([t1, t2]);
  const ids: string[] = [];
  const counter = workflow({
    name: "counter",
    version: "v1",
    initialState: { count: 0 },
    async onMessage(ctx, state) {
      const n = await ctx.step("add", async ({ effectId }) => {
        ids.push(effectId);
        return state.count + 1;
      });
      return { state: { count: n } };
    },
  });
  const worker = new WorkflowWorker(client, [counter], { worker: "test" });
  await worker.runOnce();
  await worker.runOnce();
  assert.deepEqual(ids, ["stable/add", "next/add"]);
  assert.deepEqual(
    calls.filter((c) => c.path.endsWith("/complete")).map((c) => c.body.state),
    [{ count: 1 }, { count: 2 }],
  );
});
test("handles preserve message id and graph scope", async () => {
  const { client, calls } = setup([]);
  const def = workflow({
    name: "counter",
    version: "v1",
    initialState: 0,
    async onMessage(_ctx, state, message: number) {
      return { state: state + message };
    },
  });
  const handle = await def.start(client, "agent");
  await handle.send(2, { id: "dedupe" });
  await handle.cancelTurn(3);
  assert.deepEqual(calls.find((c) => c.path.endsWith("/message"))?.body, {
    workflow_id: "agent",
    id: "dedupe",
    message: 2,
  });
  assert.equal(calls.find((c) => c.path.endsWith("/control"))?.body.turn, 3);
  assert.ok(client.graph("other").workflows);
});

test("deleteInstance posts the workflow id to the delete route in the graph scope", async () => {
  const seen: { method?: string; url: URL; body: unknown }[] = [];
  const client = new LbbClient({
    baseUrl: "http://localhost:7400",
    maxRetries: 0,
    fetch: async (input, init) => {
      seen.push({
        method: init?.method,
        url: new URL(input),
        body: JSON.parse(String(init?.body ?? "null")),
      });
      return new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const deleted = await client.graph("crm").workflows.deleteInstance("agent");
  assert.deepEqual(deleted, { deleted: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.method, "POST");
  assert.equal(seen[0]?.url.pathname, "/v1/workflows/instances/delete");
  assert.equal(seen[0]?.url.searchParams.get("graph"), "crm");
  assert.deepEqual(seen[0]?.body, { workflow_id: "agent" });
});

test("durable signal wait releases the worker and resumes from the received checkpoint", async () => {
  const resolved = {
    key: "review",
    kind: "signal" as const,
    signal_name: "approval",
    delay_ms: 10_000,
    output: { received: true, value: { approved: true } },
    at_ms: 2,
    wake_at_ms: 10002,
  };
  const second = task([resolved]);
  second.token = "resumed";
  const { client, calls } = setup([task(), second], false, (path) =>
    path.endsWith("/wait-signal")
      ? {
          ...task().turn,
          status: "waiting",
          steps: [{ ...resolved, output: null }],
        }
      : undefined,
  );
  const agent = workflow({
    name: "counter",
    version: "v1",
    initialState: { approved: false },
    async onMessage(ctx) {
      const approval = await ctx.waitForSignal<{ approved: boolean }>(
        "review",
        { name: "approval", timeoutMs: 10_000 },
      );
      return {
        state: approval.received ? approval.value : { approved: false },
      };
    },
  });
  const worker = new WorkflowWorker(client, [agent], { worker: "w" });
  await worker.runOnce();
  assert.equal(calls.filter((c) => c.path.endsWith("/complete")).length, 0);
  await client.workflows
    .handle("agent")
    .signal("approval", { approved: true }, { turn: 1, id: "approval-id" });
  assert.deepEqual(calls.at(-1)?.body, {
    workflow_id: "agent",
    turn: 1,
    id: "approval-id",
    name: "approval",
    value: { approved: true },
  });
  await worker.runOnce();
  assert.equal(calls.filter((c) => c.path.endsWith("/wait-signal")).length, 1);
  assert.deepEqual(calls.at(-1)?.body.state, { approved: true });
});
test("model/tool progress is checkpointed separately from lease renewal and supplies a resume cursor", async () => {
  const { client, calls } = setup([task()], false, (path) =>
    path.endsWith("/operation")
      ? { operation: { checkpoint: { cursor: 3 } } }
      : undefined,
  );
  const agent = workflow({
    name: "counter",
    version: "v1",
    initialState: { documents: 0 },
    async onMessage(ctx) {
      const value = await ctx.step(
        "crawl",
        async ({ effectId, checkpoint, heartbeat }) => {
          assert.equal(effectId, "stable/crawl");
          assert.deepEqual(checkpoint, { cursor: 3 });
          await heartbeat({ documents: 4 }, { checkpoint: { cursor: 4 } });
          await heartbeat({ documents: 5 });
          return 5;
        },
        { kind: "tool", timeoutMs: 1000, heartbeatTimeoutMs: 500 },
      );
      return { state: { documents: value } };
    },
  });
  await new WorkflowWorker(client, [agent], { worker: "w" }).runOnce();
  const progress = calls.filter((c) => c.path.endsWith("/progress"));
  assert.deepEqual(
    progress.map((c) => c.body.sequence),
    [1, 2],
  );
  assert.deepEqual(progress[1].body.checkpoint, { cursor: 4 });
  assert.equal(calls.filter((c) => c.path.endsWith("/heartbeat")).length, 0);
  assert.deepEqual(calls.at(-1)?.body.state, { documents: 5 });
});
test("a stalled provider cannot keep a worker occupied past the progress deadline", async () => {
  const { client, calls } = setup([task()]);
  let aborted = false;
  const agent = workflow({
    name: "counter",
    version: "v1",
    initialState: {},
    async onMessage(ctx) {
      await ctx.step(
        "model",
        async ({ signal }) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          return new Promise<never>(() => {}); // A provider which ignores cancellation.
        },
        { kind: "model", timeoutMs: 1000, heartbeatTimeoutMs: 100 },
      );
      return { state: {} };
    },
  });
  await new WorkflowWorker(client, [agent], { worker: "w" }).runOnce();
  assert.equal(aborted, true);
  assert.equal(
    calls.some(
      (c) => c.path.endsWith("/complete") || c.path.endsWith("/checkpoint"),
    ),
    false,
  );
});
test("a late operation admission response cannot start a model call after lease loss", async () => {
  const claimed = task();
  claimed.lease_ms = 90;
  let effects = 0;
  const client = new LbbClient({
    baseUrl: "http://localhost:7400",
    fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/claim")) return Response.json({ task: claimed });
      if (path.endsWith("/operation")) {
        // Deliberately ignores AbortSignal to simulate an already in-flight response.
        await new Promise((resolve) => setTimeout(resolve, 100));
        return Response.json({ operation: { checkpoint: null } });
      }
      return Response.json({ error: "lease lost" }, { status: 409 });
    },
  });
  const agent = workflow({
    name: "counter",
    version: "v1",
    initialState: {},
    async onMessage(ctx) {
      await ctx.step("model", async () => {
        effects++;
        return "unexpected";
      });
      return { state: {} };
    },
  });
  await new WorkflowWorker(client, [agent], { worker: "w" }).runOnce();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(effects, 0);
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test("progress is coalesced: a phase change at once, then at most one write per interval, the last value when the step returns", async () => {
  const { client, calls } = setup([task()]);
  const agent = workflow({
    name: "counter",
    version: "v1",
    initialState: {},
    async onMessage(ctx) {
      await ctx.step("read", async ({ heartbeat, progress }) => {
        await heartbeat({ started: true }, { checkpoint: { page: 0 } });
        progress("reading pages", { done: 1, total: 10, unit: "pages" });
        progress("reading pages", { done: 2, total: 10, unit: "pages" });
        progress("reading pages", { done: 3, total: 10, unit: "pages" });
        progress("writing facts", { done: 0 });
        progress("writing facts", { done: 5, unit: "items" });
        await sleep(300);
        progress("writing facts", { done: 6, unit: "items" });
        return 6;
      });
      return { state: {} };
    },
  });
  await new WorkflowWorker(client, [agent], {
    worker: "w",
    progressEveryMs: 200,
  }).runOnce();
  const progress = calls.filter((c) => c.path.endsWith("/progress"));
  assert.deepEqual(
    progress.map((c) => c.body.details),
    [
      { started: true },
      { phase: "reading pages", done: 1, total: 10, unit: "pages" },
      { phase: "writing facts", done: 0 },
      { phase: "writing facts", done: 5, unit: "items" },
      { phase: "writing facts", done: 6, unit: "items" },
    ],
  );
  assert.deepEqual(
    progress.map((c) => c.body.sequence),
    [1, 2, 3, 4, 5],
  );
  // Progress keeps the resume checkpoint of the last heartbeat.
  for (const call of progress.slice(1))
    assert.deepEqual(call.body.checkpoint, { page: 0 });
  // The last value goes out before the step's checkpoint.
  const order = calls.map((c) => c.path.split("/").pop());
  assert.ok(order.lastIndexOf("progress") < order.indexOf("checkpoint"));
  assert.deepEqual(calls.at(-1)?.body.state, {});
});
test("progress writes often enough for the step's progress timeout", async () => {
  const { client, calls } = setup([task()]);
  const agent = workflow({
    name: "counter",
    version: "v1",
    initialState: {},
    async onMessage(ctx) {
      await ctx.step(
        "embed",
        async ({ progress }) => {
          progress("embedding", { done: 1 });
          progress("embedding", { done: 2 });
          // Half the progress timeout: the held value goes out at 500 ms.
          await sleep(700);
          progress("embedding", { done: 3 });
          return 3;
        },
        { kind: "model", timeoutMs: 5_000, heartbeatTimeoutMs: 1_000 },
      );
      return { state: {} };
    },
  });
  await new WorkflowWorker(client, [agent], { worker: "w" }).runOnce();
  assert.deepEqual(
    calls
      .filter((c) => c.path.endsWith("/progress"))
      .map((c) => (c.body.details as { done: number }).done),
    [1, 2, 3],
  );
  assert.ok(calls.some((c) => c.path.endsWith("/complete")));
});
test("progress outside the convention fails the turn for good and writes nothing", async () => {
  for (const [phase, counts] of [
    ["", { done: 1 }],
    ["reading", { done: -1 }],
    ["reading", { done: 1.5 }],
    ["reading", { done: 1, total: -3 }],
    ["reading", { done: 1, unit: "pages/s" }],
  ] as const) {
    const { client, calls } = setup([task()]);
    const agent = workflow({
      name: "counter",
      version: "v1",
      initialState: {},
      async onMessage(ctx) {
        await ctx.step("read", async ({ progress }) => {
          progress(phase, counts);
          return 1;
        });
        return { state: {} };
      },
    });
    await new WorkflowWorker(client, [agent], { worker: "w" }).runOnce();
    assert.equal(
      calls.find((c) => c.path.endsWith("/fail"))?.body.non_retryable,
      true,
      `${phase} ${JSON.stringify(counts)}`,
    );
    assert.equal(
      calls.some((c) => c.path.endsWith("/progress")),
      false,
    );
  }
});
test("a handler reads its message's origin, and senders and the inbox carry origins", async () => {
  const claimed = task();
  claimed.turn.origin = { kind: "commit", to_seq: 9 };
  const { client, calls } = setup([claimed], false, (path) =>
    path.endsWith("/inbox") ? { messages: [] } : undefined,
  );
  let seen: unknown;
  const agent = workflow({
    name: "counter",
    version: "v1",
    initialState: {},
    async onMessage(ctx) {
      seen = ctx.origin;
      return { state: {} };
    },
  });
  await new WorkflowWorker(client, [agent], { worker: "w" }).runOnce();
  assert.deepEqual(seen, { kind: "commit", to_seq: 9 });
  const handle = client.workflows.handle("agent");
  await handle.send(
    { n: 1 },
    { id: "m-1", origin: { kind: "app", note: "nightly import" } },
  );
  assert.deepEqual(calls.at(-1)?.body, {
    workflow_id: "agent",
    id: "m-1",
    message: { n: 1 },
    origin: { kind: "app", note: "nightly import" },
  });
  const seenUrls: URL[] = [];
  const reader = new LbbClient({
    baseUrl: "http://localhost:7400",
    fetch: async (input) => {
      seenUrls.push(new URL(input));
      return Response.json({ messages: [], instances: [] });
    },
  });
  await reader.workflows
    .handle("agent")
    .inbox({ after: 2, limit: 10, payloads: true });
  await reader.workflows.inboxByType("counter", { version: "v1", after: "a" });
  assert.equal(seenUrls[0]?.pathname, "/v1/workflows/instances/inbox");
  assert.deepEqual(Object.fromEntries(seenUrls[0]!.searchParams), {
    id: "agent",
    after: "2",
    limit: "10",
    payloads: "true",
  });
  assert.equal(seenUrls[1]?.pathname, "/v1/workflows/inbox");
  assert.deepEqual(Object.fromEntries(seenUrls[1]!.searchParams), {
    workflow_type: "counter",
    version: "v1",
    after: "a",
  });
});

test("activity calls of a turn name its run and their usage goes with the completion", async () => {
  const { lbbActivities } = await import("./activities.js");
  const claimed = task();
  claimed.turn.run = {
    id: "0000000000001-agent-1",
    started_at_ms: 1,
    queue_before: 1,
  };
  const { client, calls } = setup([claimed], true, (path, body) => {
    if (path.endsWith("/activities/reason"))
      return body.effect_id === "stable/kept"
        ? {
            value: {},
            model: "m",
            tokens_in: 0,
            tokens_out: 0,
            cost_micro_usd: 0,
            cached: true,
          }
        : {
            value: { code: "P3" },
            model: "m",
            tokens_in: 120,
            tokens_out: 30,
            cost_micro_usd: 9,
            cached: false,
          };
    if (path.endsWith("/activities/embed"))
      return {
        vectors: [[0.1]],
        model: "e",
        dim: 1,
        tokens_in: 5,
        cost_micro_usd: 1,
        cached: false,
      };
    return {};
  });
  const lbb = lbbActivities(client);
  const counter = workflow({
    name: "counter",
    version: "v1",
    initialState: { count: 0 },
    async onMessage(ctx, state) {
      await ctx.step("define", (s) =>
        lbb.reason(
          { prompt: "p", schema: { type: "object" } },
          { effectId: s.effectId, instance: "manual-px-210.pdf" },
        ),
      );
      // A second call of one step, with an id made from the step's.
      await ctx.step("embed", (s) =>
        lbb.embed({ texts: ["t"] }, { effectId: `${s.effectId}.2` }),
      );
      // A kept answer is no call and costs nothing.
      await ctx.step("kept", (s) =>
        lbb.reason(
          { prompt: "p", schema: { type: "object" } },
          { effectId: s.effectId },
        ),
      );
      return { state };
    },
  });
  await new WorkflowWorker(client, [counter], { worker: "test" }).runOnce();
  const activity = calls.filter((c) => c.path.includes("/activities/"));
  assert.equal(activity.length, 3);
  assert.deepEqual(activity[0].body.workflow, {
    identity: "agent",
    turn: 1,
    run_id: "0000000000001-agent-1",
    step: "define",
    instance: "manual-px-210.pdf",
  });
  assert.deepEqual(activity[1].body.workflow, {
    identity: "agent",
    turn: 1,
    run_id: "0000000000001-agent-1",
    step: "embed",
  });
  const done = calls.filter((c) => c.path.endsWith("/complete"));
  // The completion's retry after a lost answer sends the same usage.
  assert.equal(done.length, 2);
  assert.deepEqual(done[0].body, done[1].body);
  assert.deepEqual(done[0].body.usage, {
    calls: 2,
    errors: 0,
    tokens_in: 125,
    tokens_out: 30,
    cost_micro_usd: 10,
  });
  // Outside a turn an activity names no run.
  await lbb.reason(
    { prompt: "p", schema: { type: "object" } },
    { effectId: "other" },
  );
  assert.equal(calls.at(-1)?.body.workflow, undefined);
});

test("a turn without activity calls completes without usage, and a refused call counts as an error", async () => {
  const { lbbActivities } = await import("./activities.js");
  const { client, calls } = setup([task(), task()]);
  const quiet = workflow({
    name: "counter",
    version: "v1",
    initialState: { count: 0 },
    async onMessage(_ctx, state) {
      return { state };
    },
  });
  await new WorkflowWorker(client, [quiet], { worker: "test" }).runOnce();
  const first = calls.filter((c) => c.path.endsWith("/complete"));
  assert.equal(first.length, 1);
  assert.equal(first[0].body.usage, undefined);

  const refusing = new LbbClient({
    baseUrl: "http://localhost:7400",
    maxRetries: 0,
    fetch: async (input, init) => {
      const path = new URL(input).pathname;
      calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
      if (path.endsWith("/claim"))
        return new Response(JSON.stringify({ task: task() }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (path.endsWith("/activities/reason"))
        return new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              code: "activity_request_refused",
              message: "too large",
            },
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        );
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const lbb = lbbActivities(refusing);
  const splitting = workflow({
    name: "counter",
    version: "v1",
    initialState: { count: 0 },
    async onMessage(ctx, state) {
      await ctx.step("ask", async (s) => {
        try {
          await lbb.reason(
            { prompt: "p", schema: { type: "object" } },
            { effectId: s.effectId },
          );
        } catch {
          // The template splits a refused request; here it gives up.
        }
        return null;
      });
      return { state };
    },
  });
  await new WorkflowWorker(refusing, [splitting], { worker: "test" }).runOnce();
  const last = calls.filter((c) => c.path.endsWith("/complete")).at(-1);
  assert.deepEqual(last?.body.usage, {
    calls: 1,
    errors: 1,
    tokens_in: 0,
    tokens_out: 0,
    cost_micro_usd: 0,
  });
});

test("blobs: put sends the raw bytes under the writing identity, get reads them back", async () => {
  const requests: Array<{
    url: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }> = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({
      url,
      method: init?.method,
      body: init?.body,
      headers: init?.headers,
    });
    if (init?.method === "POST")
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            key: "rooms/ab",
            sha256: "ab",
            bytes: 9,
            created: true,
          }),
      };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "catalogue",
      arrayBuffer: async () => new TextEncoder().encode("catalogue").buffer,
    };
  };
  const client = new LbbClient({ baseUrl: "http://h", graph: "main", fetch });
  const blob = await client.workflows.blobs.put("catalogue", {
    workflowId: "starter.rooms",
  });
  assert.equal(blob.key, "rooms/ab");
  assert.equal(
    requests[0]?.url,
    "http://h/v1/workflows/blobs?graph=main&workflow_id=starter.rooms",
  );
  assert.equal(
    requests[0]?.headers?.["content-type"],
    "application/octet-stream",
  );
  assert.equal(await client.workflows.blobs.getText("rooms/ab"), "catalogue");
  assert.ok(requests[1]?.url.includes("key=rooms%2Fab"), requests[1]?.url);
  await assert.rejects(
    client.workflows.blobs.put(new Uint8Array(8 * 1024 * 1024 + 1), {
      workflowId: "w",
    }),
    RangeError,
  );
});

test("the identities of a named workflow: shards and the fan-in identity", () => {
  assert.equal(workflowOfIdentity("starter.rooms"), "rooms");
  assert.equal(workflowOfIdentity("starter.rooms.3"), "rooms");
  assert.equal(workflowOfIdentity("starter.rooms.things"), "rooms");
  assert.equal(workflowOfIdentity("model-checks"), undefined);
  assert.equal(fanInIdentity("rooms", "things"), "starter.rooms.things");
  assert.ok(isFanInIdentity("starter.rooms.things"));
  assert.ok(!isFanInIdentity("starter.rooms.3"));
  assert.throws(() => fanInIdentity("rooms", "3things"), RangeError);
});
