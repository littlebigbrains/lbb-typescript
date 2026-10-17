import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, type Schemas } from "./client.js";
import { workflow, WorkflowWorker, type WorkflowContext } from "./workflows.js";
import {
  WorkflowExecutionError,
  WorkflowTurnReader,
  type WorkflowReadOptions,
  type WorkflowReadRequest,
} from "./workflow-execution.js";

type Task = Schemas["WorkflowTurnTask"];
type Credential = Schemas["WorkflowExecutionCredential"] & {
  issued_at_ms?: number;
};
const epoch = "18446744073709551615";
function credential(): Credential {
  const issued = Date.now();
  return {
    token: "lbb_wke_execution.signature",
    issued_at_ms: issued,
    expires_at_ms: issued + 60_000,
    graph_id: "project",
    graph_epoch: epoch,
    workflow_id: "agent",
    turn: 1,
    attempt: 1,
    run_id: "run-exact",
    operations: ["sparql_read"],
  };
}
function task(issued: Credential | null = credential()): Task {
  return {
    workflow_type: "analysis",
    state: {},
    token: "secret-lease",
    lease_ms: 60_000,
    effect_prefix: "stable",
    execution_credential: issued,
    turn: {
      workflow_id: "agent",
      number: 1,
      message_id: "m1",
      message: {},
      version: "v1",
      status: "running",
      attempt: 1,
      created_at_ms: 1,
      updated_at_ms: 1,
      ready_at_ms: 1,
      steps: [],
      result: null,
      state_after: null,
      sequence: 1,
      run: { id: "run-exact", started_at_ms: 1, queue_before: 1 },
    },
  };
}
interface Seen {
  url: URL;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  signal?: AbortSignal;
}
function setup(
  answer: (seen: Seen) => unknown | Response | Promise<unknown | Response>,
) {
  const seen: Seen[] = [];
  const client = new LbbClient({
    baseUrl: "https://example.test",
    graph: "project",
    environment: "prod",
    apiKey: "environment-admin",
    maxRetries: 5,
    retryDelayMs: 0,
    fetch: async (input, init) => {
      const call = {
        url: new URL(input),
        body: JSON.parse(String(init?.body ?? "{}")),
        headers: init?.headers ?? {},
        signal: init?.signal ?? undefined,
      };
      seen.push(call);
      const value = await answer(call);
      return value instanceof Response
        ? value
        : new Response(JSON.stringify(value), { status: 200 });
    },
  });
  return { client, seen };
}
function read(ctx: WorkflowContext, query: string) {
  assert.ok(ctx.sparql, "context supports workflow reads");
  return ctx.sparql(query);
}

const result = {
  results: '{"head":{},"boolean":true}',
  row_page: { returned: 0, total: 0, offset: 0, limit: 0, has_more: false },
};

test("worker opts in, reads on execution bearer, and checkpoints on control channel", async () => {
  const claimed = task();
  const { client, seen } = setup((call) => {
    if (call.url.pathname.endsWith("/claim")) return { task: claimed };
    if (call.url.pathname.endsWith("/execution-credential"))
      return credential();
    if (call.url.pathname.endsWith("/sparql-text")) return result;
    return {};
  });
  const definition = workflow({
    name: "analysis",
    version: "v1",
    initialState: {},
    async onMessage(ctx) {
      const answer = await ctx.step("read", () => read(ctx, "ASK {}"));
      assert.deepEqual(answer, result);
      return { state: {}, result: answer.results };
    },
  });
  await new WorkflowWorker(client, [definition], {
    worker: "remote",
    executionReads: true,
  }).runOnce();
  assert.equal(seen[0].body.include_execution_credential, true);
  const query = seen.find((call) => call.url.pathname.endsWith("/sparql-text"));
  assert.ok(query);
  assert.equal(
    query.headers.authorization,
    "Bearer lbb_wke_execution.signature",
  );
  assert.equal(query.url.searchParams.get("graph"), "project");
  assert.equal(query.url.searchParams.get("expected_graph_epoch"), epoch);
  assert.equal(query.url.searchParams.get("stack"), "prod");
  assert.deepEqual(query.body, { query: "ASK {}" });
  const refresh = seen.find((call) =>
    call.url.pathname.endsWith("/execution-credential"),
  );
  assert.deepEqual(refresh?.body, {
    workflow_id: "agent",
    turn: 1,
    token: "secret-lease",
  });
  for (const call of seen.filter((call) => call !== query))
    assert.equal(call.headers.authorization, "Bearer environment-admin");
  assert.ok(seen.some((call) => call.url.pathname.endsWith("/checkpoint")));
  assert.ok(seen.some((call) => call.url.pathname.endsWith("/complete")));
});

test("default remains control-only; opted-in missing credential fails before handler", async () => {
  for (const executionReads of [false, true]) {
    let ran = false;
    const { client, seen } = setup((call) =>
      call.url.pathname.endsWith("/claim") ? { task: task(null) } : {},
    );
    const definition = workflow({
      name: "analysis",
      version: "v1",
      initialState: {},
      async onMessage(ctx) {
        ran = true;
        if (!executionReads) await read(ctx, "ASK {}");
        return { state: {} };
      },
    });
    await new WorkflowWorker(client, [definition], {
      worker: "remote",
      executionReads,
    }).runOnce();
    assert.equal(
      seen[0].body.include_execution_credential,
      executionReads ? true : undefined,
    );
    assert.equal(ran, !executionReads);
    assert.ok(
      seen.some(
        (call) =>
          call.url.pathname.endsWith("/fail") &&
          call.body.non_retryable === true,
      ),
    );
    assert.equal(
      seen.filter((call) => call.url.pathname.endsWith("/sparql-text")).length,
      0,
    );
  }
});

test("body/header/scope overrides and malformed issued credentials fail locally", async () => {
  const { client, seen } = setup(() => result);
  const reader = new WorkflowTurnReader(client, task());
  for (const key of [
    "request",
    "route",
    "reason",
    "graph",
    "expected_graph_epoch",
    "headers",
  ])
    await assert.rejects(
      reader.sparql({
        query: "ASK {}",
        [key]: "override",
      } as WorkflowReadRequest),
      WorkflowExecutionError,
    );
  for (const options of [
    { headers: { authorization: "Bearer admin" } },
    { graph: "other" },
    { timeoutMs: 0 },
  ])
    await assert.rejects(
      reader.sparql("ASK {}", options as WorkflowReadOptions),
      WorkflowExecutionError,
    );
  for (const update of [
    { token: "environment-admin" },
    { issued_at_ms: -1 },
    { issued_at_ms: 1.5 },
    { issued_at_ms: 1000, expires_at_ms: 61_001 },
    { issued_at_ms: 1000, expires_at_ms: 1000 },
    { operations: ["write"] },
    { graph_epoch: "01" },
    { graph_epoch: "18446744073709551616" },
    { attempt: 2 },
    { run_id: "other" },
  ])
    assert.throws(
      () =>
        new WorkflowTurnReader(
          client,
          task({ ...credential(), ...update } as Credential),
        ),
      WorkflowExecutionError,
    );
  const noRun = task();
  noRun.turn.run = undefined;
  assert.throws(
    () => new WorkflowTurnReader(client, noRun),
    WorkflowExecutionError,
  );
  assert.equal(seen.length, 0);
  assert.equal(
    JSON.stringify(reader),
    "{}",
    "reader serialization does not disclose lease/credential",
  );
});

test("refresh cannot change the frozen graph epoch or turn attempt", async () => {
  for (const [key, value] of Object.entries({
    graph_id: "other",
    graph_epoch: "7",
    workflow_id: "other",
    turn: 2,
    attempt: 2,
    run_id: "other",
    token: "environment-admin",
  })) {
    const { client, seen } = setup(() => ({ ...credential(), [key]: value }));
    const reader = new WorkflowTurnReader(client, task());
    await assert.rejects(reader.sparql("ASK {}"), WorkflowExecutionError);
    assert.equal(seen.length, 1);
    assert.equal(
      seen[0].url.pathname,
      "/v1/workflows/turns/execution-credential",
    );
    assert.equal(seen[0].headers.authorization, "Bearer environment-admin");
  }
});

test("rejections never retry with control credentials and task mutation cannot change authority", async () => {
  const { client, seen } = setup((call) =>
    call.url.pathname.endsWith("/execution-credential")
      ? credential()
      : new Response('{"error":{"code":"batch_database_busy"}}', {
          status: 429,
        }),
  );
  const claimed = task();
  const reader = new WorkflowTurnReader(client, claimed);
  if (claimed.execution_credential)
    claimed.execution_credential.token = "environment-admin";
  await assert.rejects(reader.sparql("ASK {}"));
  assert.equal(seen.length, 2);
  assert.equal(seen[0].headers.authorization, "Bearer environment-admin");
  assert.equal(
    seen[1].headers.authorization,
    "Bearer lbb_wke_execution.signature",
  );
});

test("caller abort cancels an active read and an already aborted turn sends nothing", async () => {
  const controller = new AbortController();
  let started: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { client, seen } = setup((call) =>
    call.url.pathname.endsWith("/execution-credential")
      ? credential()
      : new Promise((_resolve, reject) => {
          started();
          call.signal?.addEventListener(
            "abort",
            () => reject(call.signal?.reason),
            { once: true },
          );
        }),
  );
  const reader = new WorkflowTurnReader(client, task());
  const reading = reader.sparql("ASK {}", { signal: controller.signal });
  await entered;
  controller.abort(new Error("caller stopped"));
  await assert.rejects(reading, /caller stopped/);
  const stopped = new AbortController();
  stopped.abort(new Error("turn stopped"));
  await assert.rejects(
    new WorkflowTurnReader(client, task(), stopped.signal).sparql("ASK {}"),
    /turn stopped/,
  );
  assert.equal(seen.length, 2);
});

test("worker heartbeat loss aborts execution reads before any completion", async () => {
  const claimed = task();
  claimed.lease_ms = 60;
  const { client, seen } = setup((call) => {
    if (call.url.pathname.endsWith("/claim")) return { task: claimed };
    if (call.url.pathname.endsWith("/execution-credential"))
      return credential();
    if (call.url.pathname.endsWith("/heartbeat"))
      return new Response('{"error":{"code":"lease_lost"}}', { status: 403 });
    if (call.url.pathname.endsWith("/sparql-text"))
      return new Promise((_resolve, reject) => {
        call.signal?.addEventListener(
          "abort",
          () => reject(call.signal?.reason),
          { once: true },
        );
      });
    return {};
  });
  const definition = workflow({
    name: "analysis",
    version: "v1",
    initialState: {},
    async onMessage(ctx) {
      await ctx.step("read", () => read(ctx, "ASK {}"));
      return { state: {} };
    },
  });
  await new WorkflowWorker(client, [definition], {
    worker: "remote",
    executionReads: true,
  }).runOnce();
  assert.ok(seen.some((call) => call.url.pathname.endsWith("/heartbeat")));
  assert.ok(
    seen.find((call) => call.url.pathname.endsWith("/sparql-text"))?.signal
      ?.aborted,
  );
  assert.equal(
    seen.filter((call) => call.url.pathname.endsWith("/complete")).length,
    0,
  );
});

test("acknowledged query and analysis checkpoints replay after worker restart", async () => {
  const saved: Task["turn"]["steps"] = [];
  let claim = 0;
  let queries = 0;
  let modelCalls = 0;
  const { client, seen } = setup((call) => {
    if (call.url.pathname.endsWith("/claim")) {
      claim += 1;
      const recovered = task({ ...credential(), attempt: claim });
      recovered.turn.attempt = claim;
      recovered.turn.steps = structuredClone(saved);
      return { task: recovered };
    }
    if (call.url.pathname.endsWith("/execution-credential"))
      return { ...credential(), attempt: claim };
    if (call.url.pathname.endsWith("/sparql-text")) {
      queries += 1;
      return { ...result, results: JSON.stringify({ version: claim }) };
    }
    if (call.url.pathname.endsWith("/checkpoint")) {
      saved.push({
        key: String(call.body.key),
        kind: "step",
        output: structuredClone(call.body.output),
        delay_ms: null,
        at_ms: 1,
        wake_at_ms: null,
        signal_name: null,
      });
    }
    return {};
  });
  const definition = workflow({
    name: "analysis",
    version: "v1",
    initialState: {},
    async onMessage(ctx) {
      // This acknowledged step is the stable input, not the live graph head.
      const input = await ctx.step("capture", () =>
        read(ctx, "SELECT ?x WHERE { ?x ?p ?o } LIMIT 1"),
      );
      if (claim === 1)
        throw new Error("worker stops after input acknowledgement");
      const output = await ctx.step("analyse", async () => {
        modelCalls += 1;
        // Provider work consumes the saved input outside a database request.
        return { source: JSON.parse(input.results), score: 7 };
      });
      if (claim === 2)
        throw new Error("worker stops after output acknowledgement");
      return { state: {}, result: output };
    },
  });
  for (let restart = 0; restart < 3; restart += 1)
    await new WorkflowWorker(client, [definition], {
      worker: `remote-${restart}`,
      executionReads: true,
    }).runOnce();
  assert.equal(queries, 1, "later graph versions are not queried on replay");
  assert.equal(modelCalls, 1, "acknowledged provider output is reused");
  assert.deepEqual(
    saved.map((step) => step.key),
    ["capture", "analyse"],
  );
  assert.deepEqual(
    seen.find((call) => call.url.pathname.endsWith("/complete"))?.body.result,
    { source: { version: 1 }, score: 7 },
  );
  assert.equal(
    seen.filter((call) => call.url.pathname.endsWith("/fail")).length,
    2,
  );
});

test("refresh follows each intended read budget on monotonic time despite clock skew", async (t) => {
  let elapsed = 100;
  t.mock.method(performance, "now", () => elapsed);
  let wall = 9_000_000_000_000;
  t.mock.method(Date, "now", () => wall);
  let refreshes = 0;
  const { client, seen } = setup((call) => {
    if (call.url.pathname.endsWith("/execution-credential")) {
      refreshes += 1;
      return {
        ...credential(),
        issued_at_ms: 1_000_000,
        expires_at_ms: 1_060_000,
      };
    }
    return result;
  });
  const reader = new WorkflowTurnReader(client, task());
  await reader.sparql("ASK {}", { timeoutMs: 10_000 });
  assert.equal(refreshes, 1, "unknown task age requires fresh lifetime");
  wall = 1; // A worker clock behind the issuer changes no deadline.
  elapsed += 49_500;
  await reader.sparql("ASK {}", { timeoutMs: 1000 });
  assert.equal(refreshes, 1, "10.5 seconds still covers a one-second read");
  await reader.sparql("ASK {}", { timeoutMs: 10_000 });
  assert.equal(refreshes, 2, "10-second read refreshes with one-second margin");
  elapsed += 29_500;
  await reader.sparql("ASK {}", { timeoutMs: 120_000 });
  assert.equal(refreshes, 3, "read budget is capped at 30 seconds plus margin");
  assert.equal(
    seen.filter((call) => call.url.pathname.endsWith("/sparql-text")).length,
    4,
  );
});

test("refresh round trip exhaustion and missing lifetime fail the worker retryably", async (t) => {
  let elapsed = 100;
  t.mock.method(performance, "now", () => elapsed);
  for (const missing of [false, true]) {
    const { client, seen } = setup((call) => {
      if (call.url.pathname.endsWith("/claim")) return { task: task() };
      if (call.url.pathname.endsWith("/execution-credential")) {
        if (missing) return { ...credential(), issued_at_ms: undefined };
        elapsed += 500;
        return { ...credential(), issued_at_ms: 1000, expires_at_ms: 1400 };
      }
      return {};
    });
    await new WorkflowWorker(
      client,
      [
        workflow({
          name: "analysis",
          version: "v1",
          initialState: {},
          async onMessage(ctx) {
            await read(ctx, "ASK {}");
            return { state: {} };
          },
        }),
      ],
      { worker: "remote", executionReads: true },
    ).runOnce();
    assert.equal(
      seen.filter((call) => call.url.pathname.endsWith("/sparql-text")).length,
      0,
    );
    const failure = seen.find((call) => call.url.pathname.endsWith("/fail"));
    assert.equal(failure?.body.non_retryable, false);
    assert.match(
      String(failure?.body.error),
      missing ? /upgrade the server/ : /lifetime elapsed/,
    );
  }
});

test("short refreshed leases allow a bounded read and 401/403 responses never replay", async () => {
  for (const status of [200, 401, 403]) {
    const { client, seen } = setup((call) => {
      if (call.url.pathname.endsWith("/execution-credential"))
        return { ...credential(), issued_at_ms: 1000, expires_at_ms: 11_000 };
      return status === 200 ? result : new Response("{}", { status });
    });
    const reading = new WorkflowTurnReader(client, task()).sparql("ASK {}", {
      timeoutMs: 30_000,
    });
    if (status === 200) assert.deepEqual(await reading, result);
    else await assert.rejects(reading);
    assert.equal(seen.length, 2, "one refresh, one query, no automatic replay");
    assert.equal(
      seen[1].headers.authorization,
      "Bearer lbb_wke_execution.signature",
    );
  }
});

test("legacy custom WorkflowContext implementations do not require sparql", () => {
  const context: WorkflowContext = {
    signal: new AbortController().signal,
    workflowId: "id",
    messageId: "message",
    turn: 1,
    step: async () => {
      throw new Error("not used");
    },
    waitForSignal: async () => ({ received: false, value: null }),
    sleep: async () => {},
    continue: (state, message) => ({ state, continuation: { message } }),
  };
  assert.equal(context.sparql, undefined);
});

test("query timeout uses the short server lifetime minus the whole refresh round trip", async (t) => {
  let elapsed = 100;
  t.mock.method(performance, "now", () => elapsed);
  const timers: number[] = [];
  const realTimeout = setTimeout;
  t.mock.method(
    globalThis,
    "setTimeout",
    (...args: Parameters<typeof setTimeout>) => {
      timers.push(Number(args[1]));
      return realTimeout(...args);
    },
  );
  const { client, seen } = setup((call) => {
    if (call.url.pathname.endsWith("/execution-credential")) {
      elapsed += 500;
      return { ...credential(), issued_at_ms: 1000, expires_at_ms: 11_000 };
    }
    return result;
  });
  assert.deepEqual(
    await new WorkflowTurnReader(client, task()).sparql("ASK {}"),
    result,
  );
  assert.deepEqual(timers, [30_000, 9_500]);
  assert.equal(seen.length, 2);
});
