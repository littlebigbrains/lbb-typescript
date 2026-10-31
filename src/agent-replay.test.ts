// A model effect keeps its first request even when the worker dies before
// saving the step. A resume must send that request byte for byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, specPin, type AgentHost, type AgentSpec } from "./agent.js";
import type { ReasonOptions, ReasonRequest } from "./activities.js";
import {
  askedOf,
  canonicalJson,
  jsonSize,
  proposalLine,
  scaffoldDigest,
  SUPPORT_CONTEXT_BYTES,
} from "./agent-protocol.js";
import { LbbError } from "./transport.js";
import {
  D1,
  FakeEngine,
  FakeWorld,
  Killed,
  sampleReply as reply,
  sampleWidth as width,
  sampleWorld as world,
  SHA,
} from "./agent-fakes.test.js";

const spec = (properties: string[], gate?: number): AgentSpec => ({
  instructions: "Read the size of each door from its datasheet.",
  owns: { properties },
  input: { file: SHA, instances: [D1] },
  ...(gate === undefined ? {} : { gate }),
});
const finish = reply("finish", { summary: "done" });

/** The activity server refuses other request bytes under a begun effect ID. */
function withEffectIdentity(host: AgentHost) {
  const requests = new Map<string, string>();
  const check = (effect: string | undefined, request: unknown) => {
    assert.ok(effect);
    const bytes = JSON.stringify(request);
    const begun = requests.get(effect);
    if (begun !== undefined && begun !== bytes)
      throw new LbbError(409, "{}", {
        type: "error",
        code: "activity_effect_conflict",
        message: "the begun model effect has another request",
      });
    requests.set(effect, bytes);
  };
  const reason = host.reason;
  host.reason = async <T>(request: ReasonRequest, options: ReasonOptions) => {
    check(options.effectId, { request, label: options.label });
    return reason<T>(request, options);
  };
  const decide = host.decide;
  host.decide = async (request, options) => {
    check(options.effectId, { request, label: options.label });
    return decide(request, options);
  };
  return { host, requests };
}

test("a begun decision resumes with equivalent owned properties", async () => {
  const variants = [
    ["height_cm", "width_cm"],
    ["WIDTH_CM", "HEIGHT_CM"],
    [
      "https://littlebigbrain.com/p/width_cm",
      "https://littlebigbrain.com/p/HEIGHT_CM",
      "width_cm",
    ],
  ];
  for (const properties of variants) {
    const original = spec(["width_cm", "height_cm"]);
    const resumed = spec(properties);
    assert.equal(specPin(original), specPin(resumed));
    const fake = new FakeWorld(world(), [finish]);
    const engine = new FakeEngine();
    const { host, requests } = withEffectIdentity(fake.host());
    engine.kill = { at: 2, phase: "before_save" };
    await assert.rejects(
      runAgent(host, engine.context(), "agent", original),
      Killed,
    );
    const effect = engine.effectId("agent.i01.decide");
    assert.ok(requests.has(effect), "the model effect began before the crash");
    engine.kill = undefined;
    const result = await runAgent(host, engine.context(), "agent", resumed);
    assert.equal(result.outcome, "finished");
    assert.equal(fake.modelCalls.get(effect), 2);
    assert.equal(fake.billed.size, 1, "one billed effect across attempts");
  }
});

test("a begun support decision keeps its request after the item is renamed", async () => {
  const def = world();
  const fake = new FakeWorld(def, [
    reply("propose_write", { proposals: [width] }),
    finish,
  ]);
  const engine = new FakeEngine();
  const { host, requests } = withEffectIdentity(fake.host());
  engine.kill = { at: 5, phase: "before_save" };
  const input = spec(["width_cm", "height_cm"], 0.5);
  await assert.rejects(
    runAgent(host, engine.context(), "agent", input),
    Killed,
  );
  const effect = engine.effectId("agent.commit.support");
  const begun = requests.get(effect);
  assert.ok(begun, "the support model effect began before the crash");
  assert.match(begun, /Item: D-1/);
  def.entities![D1] = { name: "Renamed door", type: "Renamed type" };
  // Change the support window while keeping the cited four-line place valid:
  // the later commit recheck still checks that live evidence independently.
  fake.files.get(SHA)!.text =
    "Changed context\nWidth: 600 mm\nHeight: 2100 mm\nWeight: 40 kg\n";
  const descriptions = fake.counters.describe;
  const decide = host.decide;
  host.decide = async (request, options) => {
    assert.equal(
      fake.counters.describe,
      descriptions,
      "support resume uses the saved item description",
    );
    return decide(request, options);
  };
  engine.kill = undefined;
  const result = await runAgent(host, engine.context(), "agent", input);
  assert.equal(result.outcome, "finished");
  assert.equal(requests.get(effect), begun);
  assert.equal(fake.modelCalls.get(effect), 2);
  assert.equal(fake.commits.size, 1);
  assert.equal(
    engine.checkpoints.size,
    0,
    "completed operation releases its resume data",
  );
});

test("the scaffold pin includes proposal and tool observation renderers", () => {
  const tools = ["graph.read", "files.read", "propose_write"] as const;
  const original = scaffoldDigest(tools);
  for (const changed of [
    {
      askedOf,
      proposalLine: (p: Parameters<typeof proposalLine>[0]) =>
        `${proposalLine(p)}!`,
    },
    {
      proposalLine,
      askedOf: (a: Parameters<typeof askedOf>[0]) => `${askedOf(a)}!`,
    },
  ])
    assert.notEqual(original, scaffoldDigest(tools, changed));
});

test("support waits for the frozen context acknowledgement before calling the model", async () => {
  const fake = new FakeWorld(world(), [
    reply("propose_write", { proposals: [width] }),
    finish,
  ]);
  const engine = new FakeEngine();
  engine.onHeartbeat = (key) => {
    if (key === "agent.commit.support")
      throw new Error("lost checkpoint acknowledgement");
  };
  const { host } = withEffectIdentity(fake.host());
  const input = spec(["width_cm"], 0.5);
  await assert.rejects(
    runAgent(host, engine.context(), "agent", input),
    /lost checkpoint acknowledgement/,
  );
  assert.equal(fake.counters.decide, 0);
  assert.ok(engine.checkpoints.has("agent.commit.support"));
  fake.def.entities![D1] = { name: "Renamed", type: "Changed" };
  engine.onHeartbeat = undefined;
  const decide = host.decide;
  host.decide = async (request, options) => {
    assert.equal(
      fake.counters.describe,
      1,
      "support uses its acknowledged context",
    );
    return decide(request, options);
  };
  const result = await runAgent(host, engine.context(), "agent", input);
  assert.equal(result.outcome, "finished");
  assert.match(JSON.stringify(fake.decideRequests[0]), /Item: D-1/);
});

test("an invalid frozen support context calls no model and reads no live description", async () => {
  for (const checkpoint of [
    {},
    {
      version: 1,
      workflow: "doors",
      label: "doors support",
      items: [],
      sources: {},
    },
    {
      version: 1,
      workflow: "doors",
      label: "doors support",
      items: [{ label: "D-1", type: "Door", source: "missing" }],
      sources: {},
    },
    { padding: "x".repeat(SUPPORT_CONTEXT_BYTES) },
  ]) {
    const fake = new FakeWorld(world(), [
      reply("propose_write", { proposals: [width] }),
      finish,
    ]);
    const engine = new FakeEngine();
    engine.checkpoints.set("agent.commit.support", checkpoint);
    await assert.rejects(
      runAgent(fake.host(), engine.context(), "agent", spec(["width_cm"], 0.5)),
      /support checkpoint is invalid/,
    );
    assert.equal(fake.counters.decide, 0);
    assert.equal(fake.counters.describe, 0);
  }
});

test("the largest support context fits the checkpoint and turn budgets with escaped text", async () => {
  const properties = Array.from({ length: 64 }, (_, n) => `size_${n}`);
  const quotes = properties.map((_, n) => `Width ${n}: 600 mm`);
  const def = world();
  def.entities![D1] = {
    name: "\u0001".repeat(1_000),
    type: '\\"'.repeat(1_000),
  };
  def.files![SHA]!.text = quotes
    .map((quote) => `${quote} ${'\\"\u0001😀'.repeat(400)}`)
    .join("\n");
  const script = Array.from({ length: 11 }, (_, n) =>
    reply("propose_write", {
      proposals: properties.slice(n * 6, (n + 1) * 6).map((property, k) => ({
        ...width,
        property,
        locator: `line=${n * 6 + k},${n * 6 + k + 1}`,
        quote: quotes[n * 6 + k]!,
      })),
    }),
  );
  const fake = new FakeWorld(def, [...script, finish]);
  const engine = new FakeEngine();
  const { host } = withEffectIdentity(fake.host());
  // This exercises serialization bounds independently of the ground verifier.
  host.ground = async (items) =>
    items.map(() => ({ ok: true, value: { f64: 600 }, stated: "600" }));
  const decide = host.decide;
  let checked = false;
  host.decide = async (request, options) => {
    const checkpoint = engine.checkpoints.get("agent.commit.support");
    const bytes = jsonSize(checkpoint);
    assert.ok(bytes <= SUPPORT_CONTEXT_BYTES, `${bytes} checkpoint bytes`);
    assert.ok(
      bytes > SUPPORT_CONTEXT_BYTES - 16,
      "the source windows fill the available JSON budget",
    );
    assert.ok(
      engine.savedBytes() + 32 * 1_024 < 256 * 1_024,
      "the live checkpoint and a maximum-size trigger message fit the turn",
    );
    assert.equal(Object.keys(request.questions).length, 64);
    checked = true;
    return decide(request, options);
  };
  const input = {
    ...spec(properties, 0.5),
    maxIterations: 12,
    maxProposals: 64,
  };
  engine.kill = { at: 25, phase: "before_save" };
  await assert.rejects(
    runAgent(host, engine.context(), "agent", input),
    Killed,
  );
  // The server's JSON storage may reorder object keys. Reconstructed requests
  // keep literal JSON bytes stable as well as the server's canonical hash.
  engine.checkpoints.set(
    "agent.commit.support",
    JSON.parse(canonicalJson(engine.checkpoints.get("agent.commit.support"))),
  );
  engine.kill = undefined;
  const result = await runAgent(host, engine.context(), "agent", input);
  assert.equal(result.outcome, "finished");
  assert.equal(checked, true);
  assert.equal(engine.checkpoints.size, 0);
  assert.equal(result.counts.written, 64);
});
