// The agent's `run_code` tool (SB-6): the code runs in a sandbox under the
// step's effect id, a run makes at most 3 calls, each call needs room for its
// worst case under the run's cost cap, and a run that ran code writes nothing:
// a person reviews every value it proposes. A spec that names no tools does not
// get `run_code`, so the pins of the runs before it do not change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, type AgentCodeRun, type AgentSpec } from "./agent.js";
import {
  ARGUMENTS_MAX_BYTES,
  DEFAULT_AGENT_TOOLS,
  RUN_CODE_ARGUMENTS_MAX_BYTES,
  RUN_CODE_CALLS,
  RUN_CODE_RESERVE_MICRO_USD,
  actionSchema,
  agentPin,
  parseAction,
} from "./agent-protocol.js";
import {
  D1,
  FakeEngine,
  FakeWorld,
  SHA,
  sampleReply as reply,
  sampleWidth as width,
  sampleWorld,
} from "./agent-fakes.test.js";

const TOOLS = [
  "graph.read",
  "files.read",
  "propose_write",
  "run_code",
] as const;

const spec = (extra: Partial<AgentSpec> = {}): AgentSpec => ({
  instructions: "Read the width of the door and check it with code.",
  owns: { properties: ["width_cm"] },
  input: { file: SHA, instances: [D1] },
  tools: [...TOOLS],
  ...extra,
});

const code = (n: number) =>
  reply("run_code", {
    code: "def run(input, config):\n    return {'width_cm': input['mm'] / 10}",
    input: { mm: 600, n },
  });

/** A world whose host runs code with a scripted answer and keeps the calls. */
function world(script: ReturnType<typeof reply>[], cost?: number) {
  const fake = new FakeWorld(sampleWorld(), script);
  const host = fake.host();
  const calls: { code: string; input: unknown; key: string }[] = [];
  host.runCode = async (request, options): Promise<AgentCodeRun> => {
    calls.push({ ...request, key: options.idempotencyKey });
    return {
      ok: true,
      status: "exited",
      exitCode: 0,
      result: { width_cm: 60 },
      sandbox: `sbx_${calls.length}`,
      command: `cmd_${calls.length}`,
      ...(cost !== undefined ? { costMicroUsd: cost } : {}),
    };
  };
  return { fake, host, calls };
}

function toolRecord(engine: FakeEngine, n: number) {
  const saved = engine.saved.get(`agent.i${String(n).padStart(2, "0")}.tool`);
  assert.ok(saved, `iteration ${n} ran a tool`);
  return saved as {
    ok: boolean;
    result: Record<string, unknown>;
    ran?: boolean;
    costMicroUsd?: number;
  };
}

test("run_code runs the code under the step's effect id and gives the model its result", async () => {
  const { host, calls } = world(
    [code(1), reply("finish", { summary: "done" })],
    400,
  );
  const engine = new FakeEngine();
  const result = await runAgent(host, engine.context(), "agent", spec());
  assert.equal(result.outcome, "finished");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.key, engine.effectId("agent.i01.tool"));
  assert.deepEqual(calls[0]?.input, { mm: 600, n: 1 });
  const saved = toolRecord(engine, 1);
  assert.equal(saved.ok, true);
  assert.equal(saved.ran, true);
  assert.equal(saved.result.result_json, JSON.stringify({ width_cm: 60 }));
  // The cost the sandbox reported counts with the models'.
  assert.equal(saved.costMicroUsd, 400);
  assert.equal(result.costMicroUsd, 2 * 1_000 + 400);
  assert.equal(result.tools.run_code, 1);
});

test("a run that ran code writes nothing: a grounded value goes to a person", async () => {
  const script = [
    reply("files.read", { file: SHA, locator: "line=0,4" }),
    code(1),
    reply("propose_write", { proposals: [width] }),
    reply("finish", { summary: "done" }),
  ];
  const { host } = world(script, 100);
  const result = await runAgent(
    host,
    new FakeEngine().context(),
    "agent",
    spec(),
  );
  assert.equal(result.outcome, "finished");
  assert.equal(result.proposals[0]?.verdict.code, "grounded");
  assert.equal(result.counts.written, 0);
  assert.equal(result.counts.review, 1);

  // The same run without run_code writes the value.
  const plain = new FakeWorld(sampleWorld(), [
    script[0]!,
    script[2]!,
    script[3]!,
  ]);
  const written = await runAgent(
    plain.host(),
    new FakeEngine().context(),
    "agent",
    spec(),
  );
  assert.equal(written.counts.written, 1);
});

test("a run makes at most three run_code calls", async () => {
  const script = [
    ...Array.from({ length: RUN_CODE_CALLS + 1 }, (_, i) => code(i + 1)),
    reply("finish", { summary: "done" }),
  ];
  const { host, calls } = world(script, 10);
  const engine = new FakeEngine();
  await runAgent(host, engine.context(), "agent", spec());
  assert.equal(calls.length, RUN_CODE_CALLS);
  const last = toolRecord(engine, RUN_CODE_CALLS + 1);
  assert.equal(last.ok, false);
  assert.equal(last.result.error, "run_code_limit");
  assert.equal(last.ran, undefined);
});

test("a call needs room for its worst case under the cost cap, and an unknown cost is the worst case", async () => {
  // Each decision costs 1,000 and each call its worst case, 2,220: after two
  // calls and three decisions the run holds 7,440 of 8,000, so a third call
  // does not fit.
  const script = [
    code(1),
    code(2),
    code(3),
    reply("finish", { summary: "done" }),
  ];
  const { host, calls } = world(script);
  const engine = new FakeEngine();
  await runAgent(
    host,
    engine.context(),
    "agent",
    spec({ maxCostMicroUsd: 8_000 }),
  );
  assert.equal(toolRecord(engine, 1).costMicroUsd, RUN_CODE_RESERVE_MICRO_USD);
  assert.equal(calls.length, 2);
  assert.equal(toolRecord(engine, 3).result.error, "cost_budget");
});

test("a host that cannot run code answers the tool, and a spec without tools has no run_code", async () => {
  const fake = new FakeWorld(sampleWorld(), [
    code(1),
    reply("finish", { summary: "done" }),
  ]);
  const engine = new FakeEngine();
  await runAgent(fake.host(), engine.context(), "agent", spec());
  assert.equal(toolRecord(engine, 1).result.error, "run_code_unavailable");

  assert.deepEqual(DEFAULT_AGENT_TOOLS, [
    "graph.read",
    "files.read",
    "propose_write",
  ]);
  const parsed = parseAction(
    { tool: "run_code", arguments_json: '{"code":"x"}', summary: "" },
    DEFAULT_AGENT_TOOLS,
  );
  assert.equal(parsed.ok, false);
  // A spec that names no tools pins as the three tools it had before.
  const base = {
    instructions: "x",
    maxIterations: 8,
    maxCostMicroUsd: 40_000,
    maxWallMs: 600_000,
    maxReadMs: 60_000,
    maxProposals: 12,
    maxReviewItems: 10,
    owns: ["width_cm"],
  };
  assert.notEqual(
    agentPin({ ...base, tools: DEFAULT_AGENT_TOOLS }),
    agentPin({ ...base, tools: TOOLS }),
  );
});

test("the code fits in the arguments only of a run with run_code", () => {
  const schema = (tools: readonly (typeof TOOLS)[number][]) =>
    (actionSchema(tools).properties!.arguments_json as { maxBytes: number })
      .maxBytes;
  assert.equal(schema(DEFAULT_AGENT_TOOLS), ARGUMENTS_MAX_BYTES);
  assert.equal(schema(TOOLS), RUN_CODE_ARGUMENTS_MAX_BYTES);
});
