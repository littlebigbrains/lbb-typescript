import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, type Schemas } from "./client.js";
import { workflow, WorkflowWorker } from "./workflows.js";

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
