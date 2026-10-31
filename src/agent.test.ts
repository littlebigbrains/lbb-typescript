// The agent step's interpreter: the spec, the tools' refusals, the keys, the
// commit body, the host over a client, the capture, the replay purity of the
// prompt and the size of the saved record. The crash and replay protocol is
// in `agent-conformance.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, LbbError, type FetchLike } from "./client.js";
import { captureActivities, lbbActivities } from "./activities.js";
import {
  agentValueKey,
  agentWorkKey,
  commitBody,
  propertyName,
  refuseQuery,
  resolveSpec,
  runAgent,
  specPin,
  type AgentProposal,
  type AgentSpec,
} from "./agent.js";
import { lbbAgentHost } from "./agent-host.js";
import { WorkflowError } from "./workflows.js";
import {
  FakeEngine,
  FakeWorld,
  type ModelReply,
  type WorldDef,
} from "./agent-fakes.test.js";

const BASE = "https://littlebigbrain.com/e/";
const D1 = `${BASE}00000000000000000000000000000d01`;
const D2 = `${BASE}00000000000000000000000000000d02`;
const DOC = `${BASE}00000000000000000000000000000f01`;
const A = "a".repeat(64);
const STAMP = "2026-10-01T10:00:00Z";
const TEXT = "Door D-1\nWidth: 600 mm\nHeight: 2100 mm\nWeight: 40 kg\n";

const spec = (extra: Partial<AgentSpec> = {}): AgentSpec => ({
  instructions: "Read the size of each door from its datasheet.",
  owns: { properties: ["width_cm", "height_cm"] },
  input: { file: A, instances: [D1] },
  ...extra,
});

const world = (extra: Partial<WorldDef> = {}): WorldDef => ({
  files: {
    [A]: {
      uploaded_at: STAMP,
      content_type: "text/plain",
      document: DOC,
      text: TEXT,
    },
  },
  entities: {
    [D1]: { type: "Door", name: "D-1" },
    [D2]: { type: "Door", name: "D-2" },
  },
  ...extra,
});

const width = {
  subject: D1,
  property: "width_cm",
  value: "600",
  unit: "mm",
  file: { sha256: A },
  locator: "line=0,4",
  quote: "Width: 600 mm",
};

const reply = (
  tool: string,
  args: Record<string, unknown>,
  cost = 1000,
): ModelReply => ({
  tool,
  arguments: args,
  summary: "",
  cost_micro_usd: cost,
});

// ---- the spec -------------------------------------------------------------

test("a spec outside its bounds is refused with the bound named", () => {
  assert.throws(() => resolveSpec(spec({ instructions: " " })), WorkflowError);
  assert.throws(
    () => resolveSpec(spec({ maxIterations: 13 })),
    /maxIterations/,
  );
  assert.throws(() => resolveSpec(spec({ maxIterations: 0 })), /maxIterations/);
  assert.throws(
    () => resolveSpec(spec({ maxCostMicroUsd: 2_000_001 })),
    /maxCostMicroUsd/,
  );
  assert.throws(() => resolveSpec(spec({ maxWallMs: 9_999 })), /maxWallMs/);
  assert.throws(() => resolveSpec(spec({ maxReadMs: 999 })), /maxReadMs/);
  assert.throws(() => resolveSpec(spec({ maxProposals: 65 })), /maxProposals/);
  assert.throws(
    () => resolveSpec(spec({ maxReviewItems: 51 })),
    /maxReviewItems/,
  );
  assert.throws(() => resolveSpec(spec({ pinWaitMs: 59_999 })), /pinWaitMs/);
  assert.throws(() => resolveSpec(spec({ gate: 1.5 })), /gate/);
  assert.throws(() => resolveSpec(spec({ owns: { properties: [] } })), /owns/);
  assert.throws(
    () => resolveSpec(spec({ tools: ["graph.read", "graph.read"] })),
    /tools/,
  );
  assert.throws(
    () => resolveSpec(spec({ tools: ["shell" as never] })),
    /tools/,
  );
  const resolved = resolveSpec(spec());
  assert.equal(resolved.maxIterations, 8);
  assert.equal(resolved.maxCostMicroUsd, 200_000);
  assert.equal(resolved.maxWallMs, 600_000);
  assert.equal(resolved.maxReadMs, 60_000);
  assert.equal(resolved.maxProposals, 64);
  assert.equal(resolved.maxReviewItems, 10);
  assert.equal(resolved.pinWaitMs, 900_000);
  assert.deepEqual(resolved.tools, [
    "graph.read",
    "files.read",
    "propose_write",
  ]);
});

test("a step key outside letters, digits, _ and - is refused before any step", async () => {
  const engine = new FakeEngine();
  const run = new FakeWorld(world());
  for (const key of ["", "a b", "a.b", "x".repeat(65)])
    await assert.rejects(
      runAgent(run.host(), engine.context(), key, spec()),
      WorkflowError,
    );
  assert.equal(engine.order.length, 0);
});

test("the pin changes with the instructions, the tools, the caps and the gate only", () => {
  const base = specPin(spec());
  assert.equal(specPin(spec()), base);
  // What a message names does not enter the pin.
  assert.equal(specPin(spec({ input: { file: A, instances: [D2] } })), base);
  assert.equal(specPin(spec({ message: { big: "x".repeat(100) } })), base);
  assert.notEqual(specPin(spec({ instructions: "Read the weight." })), base);
  assert.notEqual(specPin(spec({ tools: ["graph.read"] })), base);
  assert.notEqual(specPin(spec({ maxIterations: 7 })), base);
  assert.notEqual(specPin(spec({ gate: 0.5 })), base);
});

// ---- keys -----------------------------------------------------------------

test("the Review key and the work key are pure functions of their parts", () => {
  assert.equal(
    propertyName("https://littlebigbrain.com/p/width_cm"),
    "width_cm",
  );
  assert.equal(propertyName("width_cm"), "width_cm");
  const key = agentValueKey("doors", D1, "width_cm");
  assert.match(key, /^agent:doors:value:[0-9a-f]{24}$/);
  assert.equal(key, agentValueKey("doors", D1, "width_cm"));
  assert.notEqual(key, agentValueKey("doors", D1, "height_cm"));
  assert.notEqual(key, agentValueKey("doors", D2, "width_cm"));
  assert.notEqual(key, agentValueKey("windows", D1, "width_cm"));
  const work = agentWorkKey("doors", "wf-1", "msg-1");
  assert.match(work, /^wk_[0-9a-f]{16}$/);
  assert.equal(work, agentWorkKey("doors", "wf-1", "msg-1"));
  assert.notEqual(work, agentWorkKey("doors", "wf-1", "msg-2"));
});

// ---- the tools' refusals --------------------------------------------------

test("graph.read runs a SELECT or an ASK and nothing else", () => {
  assert.equal(refuseQuery("SELECT ?s WHERE { ?s ?p ?o }"), null);
  assert.equal(
    refuseQuery("PREFIX ex: <http://e/> SELECT ?s WHERE { ?s ex:p ?o }"),
    null,
  );
  assert.equal(refuseQuery("ask { ?s ?p ?o }"), null);
  assert.match(refuseQuery("INSERT DATA { <a> <b> <c> }") ?? "", /SELECT/);
  assert.match(refuseQuery("DELETE WHERE { ?s ?p ?o }") ?? "", /SELECT/);
  assert.match(
    refuseQuery("CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }") ?? "",
    /SELECT/,
  );
  assert.match(
    refuseQuery("SELECT ?s WHERE { SERVICE <http://x> { ?s ?p ?o } }") ?? "",
    /SERVICE/,
  );
  assert.match(
    refuseQuery(
      "SELECT ?s WHERE { ?s <https://littlebigbrain.com/search#similarTo> 'x' }",
    ) ?? "",
    /similarity/,
  );
  // SERVICE in a comment or in a string is no keyword; the reader of `#`, IRIs
  // and strings is tested in `agent-review.test.ts`.
  assert.equal(
    refuseQuery("SELECT ?s WHERE { ?s ?p 'SERVICE' } # SERVICE"),
    null,
  );
});

test("graph.read reads at the commit the run began at; the host reads strong without one", async () => {
  const run = new FakeWorld(
    world({
      reads: [{ match: "SELECT", vars: ["door"], rows: [{ door: D2 }] }],
    }),
    [
      reply("graph.read", { query: "SELECT ?door WHERE { ?door a ?c }" }),
      reply("propose_write", {
        proposals: [{ ...width, subject: D2 }],
      }),
      reply("finish", { summary: "done" }),
    ],
  );
  const engine = new FakeEngine();
  const result = await runAgent(run.host(), engine.context(), "agent", spec());
  assert.deepEqual(run.readAt, [41]);
  // The row the read returned is a subject the run may now propose for.
  assert.equal(result.proposals[0]?.verdict.code, "grounded");
  assert.equal(result.proposals[0]?.subject, D2);
  assert.equal(result.counts.written, 1);
});

test("a query that writes is refused by the tool and reaches no host", async () => {
  const run = new FakeWorld(world(), [
    reply("graph.read", { query: "INSERT DATA { <a> <b> <c> }" }),
    reply("finish", { summary: "done" }),
  ]);
  const engine = new FakeEngine();
  const result = await runAgent(run.host(), engine.context(), "agent", spec());
  assert.equal(run.counters.sparql, 0);
  assert.equal(result.trace[0]?.ok, false);
});

test("a file read that is out of range is a refusal in the trace, not a failure", async () => {
  const run = new FakeWorld(world(), [
    reply("files.read", { file: A, locator: "line=0,99" }),
    reply("files.read", { file: A, locator: "page=1" }),
    reply("files.read", { file: A, locator: "line=1,2" }),
    reply("finish", { summary: "done" }),
  ]);
  const engine = new FakeEngine();
  const result = await runAgent(run.host(), engine.context(), "agent", spec());
  assert.deepEqual(
    result.trace.map((line) => line.ok),
    [false, false, true, true].slice(0, result.trace.length),
  );
  assert.equal(result.outcome, "finished");
});

test("graph.read calls past max_read_ms answer read_budget", async () => {
  const slow = new FakeWorld(
    world({ reads: [{ match: "SELECT", vars: ["s"], rows: [] }] }),
    [
      reply("graph.read", { query: "SELECT ?s WHERE { ?s ?p ?o }" }),
      reply("graph.read", { query: "SELECT ?s WHERE { ?s ?p ?o }" }),
      reply("finish", { summary: "done" }),
    ],
  );
  const host = slow.host();
  const inner = host.sparql;
  host.sparql = async (query, at, signal) => {
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    return inner(query, at, signal);
  };
  const engine = new FakeEngine();
  const result = await runAgent(
    host,
    engine.context(),
    "agent",
    spec({ maxReadMs: 1_000 }),
  );
  assert.equal(slow.counters.sparql, 1);
  assert.equal(result.tools["graph.read"], 2);
  assert.equal(result.trace[1]?.ok, false);
  assert.match(result.trace[1]?.note ?? "", /read_budget/);
});

// ---- limits ---------------------------------------------------------------

test("a message that fills the saved bytes ends the loop at the byte guard", async () => {
  const run = new FakeWorld(world(), [reply("finish", { summary: "done" })]);
  const engine = new FakeEngine();
  const result = await runAgent(
    run.host(),
    engine.context(),
    "agent",
    spec({ message: { text: "x".repeat(140_000) } }),
  );
  assert.equal(result.outcome, "limit");
  assert.equal(result.limit, "bytes");
  assert.equal(run.counters.reason, 0);
});

test("a run whose steps fill the record stops under the engine's limit", async () => {
  // Twelve iterations, each as large as the bounds allow: a 100-row read of
  // wide rows, a 4 KiB file read, six proposals.
  const rows = Array.from({ length: 100 }, (_, n) => ({
    s: `${BASE}${n.toString(16).padStart(32, "0")}`,
    v: "v".repeat(300),
  }));
  const text = `${"w".repeat(100)}\n`.repeat(200);
  const big = new FakeWorld(
    world({
      files: {
        [A]: {
          uploaded_at: STAMP,
          content_type: "text/plain",
          document: DOC,
          text,
        },
      },
      reads: [{ match: "SELECT", vars: ["s", "v"], rows }],
    }),
    Array.from({ length: 12 }, (_, n) =>
      n % 3 === 0
        ? reply("graph.read", {
            query: `SELECT ?s ?v WHERE { ?s ?p ?v } # ${n}`,
          })
        : n % 3 === 1
          ? reply("files.read", { file: A, locator: `line=${n},${n + 90}` })
          : reply("propose_write", {
              proposals: Array.from({ length: 6 }, (_, k) => ({
                ...width,
                subject: rows[k + n]!.s,
                property: k % 2 ? "width_cm" : "height_cm",
                quote: "w".repeat(100),
                locator: `line=0,2`,
              })),
            }),
    ),
  );
  const engine = new FakeEngine();
  const result = await runAgent(
    big.host(),
    engine.context(),
    "agent",
    spec({ maxIterations: 12, maxProposals: 64 }),
  );
  assert.ok(["finished", "limit"].includes(result.outcome));
  // The 256 KiB limit is the engine's; the guard keeps the run well under it.
  assert.ok(
    engine.savedBytes() < 256 * 1024,
    `the saved record holds ${engine.savedBytes()} bytes`,
  );
});

test("a budget refusal from the model stops the attempt and saves no decision", async () => {
  const run = new FakeWorld(world(), [reply("finish", { summary: "done" })]);
  const host = run.host();
  host.reason = async () => {
    throw new LbbError(429, "{}", {
      type: "rate_limit_error",
      code: "workflow_budget_exceeded",
      message: "the budget is spent",
      retry_at_ms: 1_800_000_000_000,
    });
  };
  const engine = new FakeEngine();
  await assert.rejects(
    runAgent(host, engine.context(), "agent", spec()),
    (error) =>
      error instanceof LbbError &&
      error.code === "workflow_budget_exceeded" &&
      error.retryAtMs === 1_800_000_000_000,
  );
  // The start step is saved and the decision is not: the next attempt asks again.
  assert.deepEqual(engine.order, ["agent.start"]);
});

test("a commit refused for a lost fence or for ownership ends the attempt with the refusal", async () => {
  for (const code of ["workflow_fence_lost", "write_outside_owns"]) {
    const run = new FakeWorld(
      world({
        commit_error: {
          status: code === "workflow_fence_lost" ? 409 : 403,
          code,
        },
      }),
      [
        reply("propose_write", { proposals: [width] }),
        reply("finish", { summary: "done" }),
      ],
    );
    const engine = new FakeEngine();
    await assert.rejects(
      runAgent(run.host(), engine.context(), "agent", spec()),
      (error) => error instanceof LbbError && error.code === code,
      code,
    );
    // Nothing was written or filed, and the write step is not saved.
    assert.equal(run.commits.size, 0);
    assert.equal(run.reviews.size, 0);
    assert.equal(engine.saved.has("agent.commit.write"), false);
  }
});

test("the result of the largest run fits the 64 KiB the engine allows a turn result", async () => {
  // 64 proposals, each with a verdict message at its bound, a summary at its
  // bound, and a trace of 16 lines: what a workflow that returns the result
  // as its turn result sends to `complete`.
  const subjects = Array.from(
    { length: 64 },
    (_, n) => `${BASE}${(n + 1).toString(16).padStart(32, "0")}`,
  );
  const proposal = (n: number) => ({
    subject: subjects[n]!,
    property: n % 2 ? "width_cm" : "height_cm",
    value: "600",
    unit: "mm",
    file: { sha256: A },
    locator: "line=0,2",
    quote: `q${n}`.padEnd(40, "q"),
  });
  const calls = 11;
  const run = new FakeWorld(
    world({
      ground: [
        {
          quote: "qq",
          verdict: {
            ok: false,
            code: "quote_not_found",
            message: "m".repeat(200),
          },
        },
      ],
    }),
    [
      ...Array.from({ length: calls }, (_, call) =>
        reply("propose_write", {
          proposals: Array.from({ length: 6 }, (_, k) =>
            proposal((call * 6 + k) % 64),
          ),
        }),
      ),
      reply("finish", { summary: "s".repeat(2_048) }),
    ],
  );
  const engine = new FakeEngine();
  const result = await runAgent(
    run.host(),
    engine.context(),
    "agent",
    spec({
      maxIterations: 12,
      maxProposals: 64,
      input: { file: A, instances: subjects },
    }),
  );
  assert.equal(result.proposals.length, 64);
  // The run may stop at a cap before its summary: count the longest summary
  // either way.
  const bytes =
    new TextEncoder().encode(JSON.stringify(result)).length +
    2_048 -
    new TextEncoder().encode(result.summary).length;
  assert.ok(bytes < 64 * 1024, `the result holds ${bytes} bytes`);
});

// ---- the prompt is a function of the saved steps --------------------------

test("a replayed turn builds the same prompt for the step it runs again", async () => {
  const script = [
    reply("files.read", { file: A, locator: "line=0,4" }),
    reply("propose_write", { proposals: [width] }),
    reply("finish", { summary: "done" }),
  ];
  const prompts = async (kill?: number) => {
    const run = new FakeWorld(world(), script);
    const host = run.host();
    const seen = new Map<string, string>();
    const reason = host.reason;
    host.reason = (request, options) => {
      seen.set(options.effectId ?? "", request.prompt);
      return reason(request, options);
    };
    const engine = new FakeEngine();
    if (kill !== undefined) {
      engine.kill = { at: kill, phase: "after_save" };
      await assert.rejects(runAgent(host, engine.context(), "agent", spec()));
      engine.kill = undefined;
    }
    await runAgent(host, engine.context(), "agent", spec());
    return seen;
  };
  const whole = await prompts();
  for (const kill of [2, 3, 4, 5]) {
    const replayed = await prompts(kill);
    for (const [effect, prompt] of replayed)
      assert.equal(
        prompt,
        whole.get(effect),
        `${effect} after a kill at step ${kill}`,
      );
  }
});

// ---- the mock plan ----------------------------------------------------------

test("a plan runs the loop with no model and a plan support in place of the decision", async () => {
  const run = new FakeWorld(world());
  const engine = new FakeEngine();
  const result = await runAgent(
    run.host(),
    engine.context(),
    "agent",
    spec({ gate: 0.6 }),
    {
      plan: [
        { tool: "files.read", arguments: { file: A, locator: "line=0,4" } },
        { tool: "propose_write", arguments: { proposals: [width] } },
      ],
      planSupport: 0.2,
    },
  );
  assert.equal(run.counters.reason, 0);
  assert.equal(run.counters.decide, 0);
  assert.equal(result.outcome, "finished");
  // The plan ended, so the loop finished; the support is below the gate.
  assert.equal(result.counts.review, 1);
  assert.equal(result.counts.written, 0);
});

// ---- the commit body --------------------------------------------------------

test("the commit body lists each subject's own properties and the value sources", () => {
  const proposal = (
    subject: string,
    property: string,
    value: string,
  ): AgentProposal => ({
    subject,
    property,
    value,
    sha256: A,
    locator: "line=0,4",
    quote: `${property}: ${value}`,
    verdict: {
      code: "grounded",
      typed: { f64: Number(value) } as never,
      stated: `${value} mm`,
      document: DOC,
    },
    support: 0.9,
  });
  const described = new Map([
    [D1, { type: "Door", name: "D-1" }],
    [D2, { type: "Door", name: "D-2" }],
  ]);
  const body = commitBody(
    [proposal(D1, "width_cm", "600"), proposal(D2, "height_cm", "2100")],
    described,
  );
  assert.equal(body.edge_idempotency, "append");
  assert.deepEqual(
    body.replace_owned?.subject_properties?.map((entry) => ({
      key: entry.subject.key,
      properties: entry.properties,
    })),
    [
      {
        key: "\u0000lbb-eid:00000000000000000000000000000d01",
        properties: ["width_cm"],
      },
      {
        key: "\u0000lbb-eid:00000000000000000000000000000d02",
        properties: ["height_cm"],
      },
    ],
  );
  // A list per subject and no list for all of them.
  assert.equal(body.replace_owned?.properties, undefined);
  assert.equal(body.replace_owned?.relations, undefined);
  assert.equal(body.replace_owned?.retract_entities, undefined);
  assert.deepEqual(
    body.triplets?.map((edge) => [
      edge.relation,
      edge.target.type,
      edge.target.key,
    ]),
    [
      [
        "HAS_VALUE_SOURCE",
        "ValueSource",
        "value:00000000000000000000000000000d01:width_cm",
      ],
      [
        "HAS_VALUE_SOURCE",
        "ValueSource",
        "value:00000000000000000000000000000d02:height_cm",
      ],
    ],
  );
  assert.deepEqual(body.triplets?.[0]?.evidence, {
    text: "width_cm: 600",
    source_id: `${DOC}#line=0,4`,
    source_sha256: A,
  });
  // The body has no observation id and no region.
  assert.equal(JSON.stringify(body).includes("observation_id"), false);
  assert.equal(JSON.stringify(body).includes("region"), false);
});

// ---- the host over a client -------------------------------------------------

interface Call {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

/** A client whose server answers by `METHOD /path`. */
function served(
  routes: Record<string, (call: Call) => { status?: number; body?: unknown }>,
) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.search,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: init?.headers ?? {},
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    const answer = route
      ? route(call)
      : { status: 404, body: { error: { code: "not_found" } } };
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
  const client = new LbbClient({
    baseUrl: "http://h",
    graph: "main",
    fetch,
    retryDelayMs: 0,
  });
  return { client, calls };
}

const sparqlAnswer = (vars: string[], rows: Record<string, string>[]) => ({
  results: JSON.stringify({
    head: { vars },
    results: {
      bindings: rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k, { type: "uri", value: v }]),
        ),
      ),
    },
  }),
  row_page: { returned: rows.length, total: rows.length },
});

test("the host reads at a commit when it is told one, and strong otherwise", async () => {
  const { client, calls } = served({
    "POST /v1/query/sparql-text": () => ({
      body: sparqlAnswer(["s"], [{ s: D1 }]),
    }),
    "GET /v1/graph/metadata": () => ({ body: { snapshot: { commit_seq: 7 } } }),
  });
  const host = lbbAgentHost(client, lbbActivities(client));
  assert.deepEqual(await host.head(), { commitSeq: 7 });
  const at = await host.sparql("SELECT ?s WHERE { ?s ?p ?o }", 7);
  assert.deepEqual(at.rows, [{ s: D1 }]);
  await host.sparql("SELECT ?s WHERE { ?s ?p ?o }", undefined);
  const reads = calls.filter((call) => call.path === "/v1/query/sparql-text");
  assert.equal(reads[0]?.body?.as_of_commit_seq, 7);
  assert.equal(reads[0]?.query.includes("consistency"), false);
  assert.equal(reads[1]?.body?.as_of_commit_seq, undefined);
  assert.match(reads[1]?.query ?? "", /consistency=strong/);
});

test("a graph that cannot say its commit reads at the head", async () => {
  const { client } = served({
    "GET /v1/graph/metadata": () => ({
      status: 404,
      body: { error: { code: "not_found" } },
    }),
  });
  const host = lbbAgentHost(client, lbbActivities(client));
  assert.deepEqual(await host.head(), { commitSeq: null });
});

test("the host commits under the step's effect id with the turn's fence", async () => {
  const { client, calls } = served({
    "POST /v1/graph/commit": () => ({
      body: { commit_seq: 12, replayed: false },
    }),
  });
  const host = lbbAgentHost(client, lbbActivities(client));
  const done = await host.commit(
    { edge_idempotency: "append" },
    {
      idempotencyKey: "wf/msg/agent.commit.write",
      fence: { token: "t", turn: 1 } as never,
    },
  );
  assert.deepEqual(done, { commitSeq: 12, replayed: false });
  assert.equal(
    calls[0]?.headers["Idempotency-Key"] ??
      calls[0]?.headers["idempotency-key"],
    "wf/msg/agent.commit.write",
  );
  assert.deepEqual(calls[0]?.body?.workflow_fence, { token: "t", turn: 1 });
});

test("ground names the workflow for a stack key and never under a credential", async () => {
  const { client, calls } = served({
    "POST /v1/workflows/activities/ground": () => ({
      body: { results: [{ ok: true }] },
    }),
  });
  const activities = lbbActivities(client);
  const item = {
    subject: D1,
    property: "https://littlebigbrain.com/p/width_cm",
    value: "600",
    file: { sha256: A, uploaded_at: STAMP },
    locator: "line=0,4",
    quote: "Width: 600 mm",
  };
  assert.deepEqual(await activities.ground([item], { workflow: "doors" }), [
    { ok: true },
  ]);
  await activities.ground([item]);
  await lbbAgentHost(client, activities, { workflow: "doors" }).ground([item]);
  await lbbAgentHost(client, activities, {
    workflow: "doors",
    hosted: true,
  }).ground([item]);
  assert.equal(calls[0]?.body?.workflow, "doors");
  assert.equal("workflow" in (calls[1]?.body ?? {}), false);
  assert.equal(calls[2]?.body?.workflow, "doors");
  assert.equal("workflow" in (calls[3]?.body ?? {}), false);
});

// ---- the capture ----------------------------------------------------------

function captureServer() {
  return served({
    "GET /v1/files/record": () => ({
      body: {
        sha256: A,
        uploaded_at: STAMP,
        content_type: "text/plain",
        document: DOC,
      },
    }),
    "POST /v1/workflows/activities/ground": (call) => ({
      body: {
        results: ((call.body?.items as unknown[]) ?? []).map(() => ({
          ok: true,
          value: { f64: 600 },
          stated: "600",
          evidence: {
            quote: "Width: 600 mm",
            source_id: `${DOC}#line=0,4`,
            source_sha256: A,
            uploaded_at: STAMP,
          },
        })),
      },
    }),
    "GET /v1/graph/metadata": () => ({
      body: { snapshot: { commit_seq: 41 } },
    }),
    "GET /v1/ontology": () => ({
      body: {
        entity_type_defs: [
          { name: "Door", iri: "https://littlebigbrain.com/c/door" },
        ],
      },
    }),
    "POST /v1/query/sparql-text": () => ({
      body: sparqlAnswer(
        ["s", "label", "class"],
        [{ s: D1, label: "D-1", class: "https://littlebigbrain.com/c/door" }],
      ),
    }),
    "POST /v1/graph/commit": () => ({
      body: { dry_run: true, would_write: {}, errors: [] },
    }),
    "GET /v1/reviews": () => ({
      body: { object: "list", data: [], has_more: false },
    }),
  });
}

test("a capture keeps the commit after its dry run and writes nothing", async () => {
  const { client, calls } = captureServer();
  const capture = captureActivities(lbbActivities(client), {
    workflow: "doors",
  });
  const engine = new FakeEngine();
  const result = await capture.activities.agent(
    engine.context(),
    "agent",
    spec(),
    {
      plan: [{ tool: "propose_write", arguments: { proposals: [width] } }],
    },
  );
  assert.equal(result.outcome, "finished");
  assert.equal(result.counts.written, 1);
  const kept = capture.result();
  assert.equal(kept.writes.length, 1);
  assert.equal(kept.writes[0]?.check, "dry_run");
  assert.deepEqual(kept.writes[0]?.errors, []);
  assert.equal(kept.writes[0]?.stepKey, "agent.commit.write");
  assert.equal(
    kept.writes[0]?.body.replace_owned?.subject_properties?.length,
    1,
  );
  assert.equal(kept.reviews.length, 0);
  // The run reports what it would have written, as a live run does.
  assert.deepEqual(
    kept.results.map((input) => [input.iri, input.outcome]),
    [[D1, "written"]],
  );
  // Only the dry run reached the commit route, and no Review item was filed.
  const commits = calls.filter((call) => call.path === "/v1/graph/commit");
  assert.equal(commits.length, 1);
  assert.match(commits[0]?.query ?? "", /dry_run=true/);
  assert.equal(
    calls.some((call) => call.method === "POST" && call.path === "/v1/reviews"),
    false,
  );
});

test("a capture keeps the Review item and files none", async () => {
  const { client, calls } = captureServer();
  const capture = captureActivities(lbbActivities(client), {
    workflow: "doors",
  });
  const engine = new FakeEngine();
  const result = await capture.activities.agent(
    engine.context(),
    "agent",
    spec({ gate: 0.6 }),
    {
      plan: [{ tool: "propose_write", arguments: { proposals: [width] } }],
      planSupport: 0.1,
    },
  );
  assert.equal(result.counts.review, 1);
  const kept = capture.result();
  assert.equal(kept.writes.length, 0);
  assert.equal(kept.reviews.length, 1);
  assert.equal((kept.reviews[0]?.request as { kind?: string }).kind, "value");
  assert.deepEqual(
    kept.results.map((input) => input.outcome),
    ["review"],
  );
  assert.equal(
    calls.some((call) => call.method === "POST" && call.path === "/v1/reviews"),
    false,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.path === "/v1/graph/commit" && !call.query.includes("dry_run"),
    ),
    false,
  );
});

test("a capture without a client cannot run an agent step", async () => {
  const { client } = captureServer();
  const bare = { ...lbbActivities(client) };
  const capture = captureActivities(bare);
  const engine = new FakeEngine();
  assert.throws(
    () => capture.activities.agent(engine.context(), "agent", spec()),
    /needs a client/,
  );
});
