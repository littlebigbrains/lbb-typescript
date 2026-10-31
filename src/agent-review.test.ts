// Tests that came from the review of the interpreter: a slow read, a stale
// answer, a refused commit, a query with a `#`, the support request, the
// labels and the run results. Each one fails without its fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { refuseQuery, runAgent, type AgentSpec } from "./agent.js";
import {
  D1,
  FakeEngine,
  FakeWorld,
  sampleReply as reply,
  sampleWidth as width,
  sampleWorld as world,
  SHA,
  type WorldDef,
} from "./agent-fakes.test.js";
import type { WorkflowRunInput } from "./run-results.js";

const spec = (extra: Partial<AgentSpec> = {}): AgentSpec => ({
  instructions: "Read the size of each door from its datasheet.",
  owns: { properties: ["width_cm", "height_cm"] },
  input: { file: SHA, instances: [D1] },
  ...extra,
});

/** Let the microtasks and the I/O of the loop run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const finish = reply("finish", { summary: "done" });

async function run(
  def: WorldDef,
  script: ReturnType<typeof reply>[],
  agent: Partial<AgentSpec> = {},
  hooks: (world: FakeWorld, engine: FakeEngine) => void = () => {},
) {
  const fake = new FakeWorld(def, script);
  const engine = new FakeEngine();
  hooks(fake, engine);
  const results: WorkflowRunInput[] = [];
  const host = fake.host();
  host.report = (input) => results.push(input);
  const result = await runAgent(host, engine.context(), "agent", spec(agent));
  return { fake, engine, result, results };
}

// ---- a slow tool is a tool result, not a failed turn --------------------------

test("a graph.read past 15 seconds answers read_budget and the loop goes on", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const query = "SELECT ?s WHERE { ?s ?p ?o }";
  const fake = new FakeWorld(world(), [
    reply("graph.read", { query }),
    reply("graph.read", { query }),
    finish,
  ]);
  const host = fake.host();
  let calls = 0;
  host.sparql = (_query, _at, signal) => {
    calls += 1;
    return new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason));
    });
  };
  const running = runAgent(
    host,
    new FakeEngine().context(),
    "agent",
    spec({ maxReadMs: 1_000 }),
  );
  await settle();
  t.mock.timers.tick(15_000);
  const result = await running;
  assert.equal(result.outcome, "finished");
  assert.equal(result.trace[0]?.ok, false);
  assert.match(result.trace[0]?.note ?? "", /read_budget/);
  // The slow call used the budget of the run, so the next read is refused
  // without a call.
  assert.equal(calls, 1);
  assert.match(result.trace[1]?.note ?? "", /read_budget/);
});

test("a propose_write whose check takes past the tool time answers tool_timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = new FakeWorld(world(), [
    reply("propose_write", { proposals: [width] }),
    finish,
  ]);
  const host = fake.host();
  host.ground = (_items, options) =>
    new Promise((_, reject) => {
      options?.signal?.addEventListener("abort", () =>
        reject(options.signal?.reason),
      );
    });
  const running = runAgent(host, new FakeEngine().context(), "agent", spec());
  await settle();
  t.mock.timers.tick(40_000);
  const result = await running;
  assert.equal(result.outcome, "finished");
  assert.equal(result.trace[0]?.ok, false);
  assert.match(result.trace[0]?.note ?? "", /tool_timeout/);
});

// ---- the pin covers owns ------------------------------------------------------

test("the pin changes when the owned properties change", async () => {
  const { specPin } = await import("./agent.js");
  assert.notEqual(
    specPin(spec({ owns: { properties: ["width_cm"] } })),
    specPin(spec({ owns: { properties: ["width_cm", "height_cm"] } })),
  );
  // The order and the case of the names are no change.
  assert.equal(
    specPin(spec({ owns: { properties: ["height_cm", "width_cm"] } })),
    specPin(spec({ owns: { properties: ["width_cm", "HEIGHT_CM"] } })),
  );
});

test("the pin follows the text the code builds for the models", async () => {
  const { agentPin, scaffoldDigest } = await import("./agent-protocol.js");
  const tools = ["graph.read", "files.read", "propose_write"] as const;
  const pinned = {
    tools,
    instructions: "Read the sizes.",
    maxIterations: 8,
    maxCostMicroUsd: 200_000,
    maxWallMs: 600_000,
    maxReadMs: 60_000,
    maxProposals: 64,
    maxReviewItems: 10,
    owns: ["width_cm"],
  };
  // Another prompt scaffold, another pin: a replay under the same effect id
  // with other text would be refused by the server.
  assert.notEqual(
    agentPin({ ...pinned, scaffold: "one" }),
    agentPin({ ...pinned, scaffold: "two" }),
  );
  // Without the override the pin takes the digest of the running code.
  assert.equal(
    agentPin(pinned),
    agentPin({ ...pinned, scaffold: scaffoldDigest(tools) }),
  );
  // The digest covers the tool descriptions: other tools, other digest.
  assert.notEqual(scaffoldDigest(tools), scaffoldDigest(["graph.read"]));
});

// ---- an answer in force holds for its evidence --------------------------------

const pair = (property: string, subject = D1) => `${subject}|${property}`;
const proposing = [reply("propose_write", { proposals: [width] }), finish];

test("a person's answer on the same value holds and nothing is written or filed", async () => {
  const { fake, result } = await run(
    world({
      answers: {
        [pair("width_cm")]: { decision: "accept", asked: "600", value: 600 },
      },
    }),
    proposing,
  );
  assert.equal(fake.commits.size, 0);
  assert.equal(fake.reviews.size, 0);
  assert.equal(result.proposals[0]?.disposition, "answered");
});

test("an answer on another value and other evidence asks again and writes nothing", async () => {
  const { fake, result } = await run(
    world({
      answers: {
        [pair("width_cm")]: {
          decision: "accept",
          asked: 500,
          value: 500,
          evidence_hash: "an-older-mark",
        },
      },
    }),
    proposing,
  );
  assert.equal(fake.commits.size, 0);
  assert.equal(fake.reviews.size, 1);
  assert.equal(result.proposals[0]?.disposition, "review");
  // The item names the evidence it is asked on.
  const body = [...fake.reviews.values()][0]!;
  assert.match(String(body.evidence_hash), /^[0-9a-f]{32}$/);
});

test("a rejected value does not stop another value of the same pair", async () => {
  const { fake, result } = await run(
    world({
      answers: { [pair("width_cm")]: { decision: "reject", asked: 500 } },
    }),
    proposing,
  );
  assert.equal(fake.commits.size, 1);
  assert.equal(result.proposals[0]?.disposition, "written");
});

test("the same rejected value is skipped", async () => {
  const { fake, result } = await run(
    world({
      answers: { [pair("width_cm")]: { decision: "reject", asked: 600 } },
    }),
    proposing,
  );
  assert.equal(fake.commits.size, 0);
  assert.equal(fake.reviews.size, 0);
  assert.equal(result.proposals[0]?.disposition, "rejected");
});

test("an item asked again holds the value: it is filed, not written", async () => {
  const { fake, result } = await run(
    world({
      answers: {
        [pair("width_cm")]: {
          decision: "reject",
          asked: 500,
          reopened: true,
        },
      },
    }),
    proposing,
  );
  assert.equal(fake.commits.size, 0);
  assert.equal(result.proposals[0]?.disposition, "review");
});

// ---- a refused commit -----------------------------------------------------------

test("a commit the graph refuses as invalid files the values to Review with the reason", async () => {
  const { fake, result } = await run(
    world({ commit_error: { status: 400, code: "schema_validation_failed" } }),
    [
      reply("propose_write", {
        proposals: [
          width,
          // A value that stays failed: it is not owned.
          { ...width, property: "weight_kg", quote: "Weight: 40 kg" },
        ],
      }),
      finish,
    ],
  );
  assert.equal(result.outcome, "finished");
  assert.equal(fake.commits.size, 0);
  assert.equal(result.counts.review, 1);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.proposals[0]?.verdict.code, "commit_refused");
  const body = [...fake.reviews.values()][0]!;
  assert.match(String(body.rationale), /refused/i);
});

test("a commit that may have landed still ends the run as uncertain", async () => {
  const { fake, result } = await run(
    world({ commit_error: { status: 409, code: "idempotency_conflict" } }),
    proposing,
  );
  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "agent_effect_uncertain");
  assert.equal(fake.reviews.size, 0);
});

test("a commit that fails on the server is thrown for the turn to retry", async () => {
  await assert.rejects(
    run(
      world({ commit_error: { status: 503, code: "overloaded" } }),
      proposing,
    ),
  );
});

// ---- the recheck cannot read the file -----------------------------------------

test("a file the recheck cannot scan in time is not reported as changed", async () => {
  const { fake, result } = await run(world(), proposing, {}, (fake, engine) => {
    engine.onSaved = (key) => {
      if (key === "agent.i01.tool")
        fake.def.ground = [
          {
            quote: "",
            verdict: { ok: false, code: "scan_budget", message: "too big" },
          },
        ];
    };
  });
  assert.equal(fake.commits.size, 0);
  assert.equal(result.proposals[0]?.verdict.code, "scan_budget");
  const body = [...fake.reviews.values()][0]!;
  assert.doesNotMatch(String(body.rationale), /changed/i);
  assert.match(String(body.rationale), /again|check/i);
});

// ---- the support request ------------------------------------------------------

test("the support question names the subject and carries the source text", async () => {
  const { fake } = await run(world(), proposing, { gate: 0.5 });
  const request = fake.decideRequests[0] as {
    state: { sources: Record<string, string> };
    questions: Record<string, { instructions: string }>;
  };
  const question = request.questions.v0!.instructions;
  assert.match(question, /Item: D-1 \(Door\)/);
  assert.match(question, /Value: 600/);
  const source = /Source: (\S+)/.exec(question)?.[1] ?? "";
  assert.ok(source, "the question names its source");
  assert.match(request.state.sources[source] ?? "", /Width: 600 mm/);
});

// ---- labels ---------------------------------------------------------------------

test("a label never passes 64 characters, even for a step key at its limit", async () => {
  const fake = new FakeWorld(world(), proposing);
  await runAgent(
    fake.host(),
    new FakeEngine().context(),
    "k".repeat(64),
    spec({ gate: 0.5, workflow: "w".repeat(64) }),
  );
  assert.ok(fake.labels.length >= 3, "decisions and the support question ask");
  for (const label of fake.labels)
    assert.ok((label ?? "").length <= 64, `${label}`);
});

// ---- run results ----------------------------------------------------------------

test("a failed value shows no quote in the run results: the quote is not verified", async () => {
  const { results } = await run(world(), [
    reply("propose_write", {
      proposals: [{ ...width, property: "weight_kg", quote: "Weight: 40 kg" }],
    }),
    finish,
  ]);
  const failed = results.filter((input) => input.outcome === "failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.values?.[0]?.quote, "");
});

// ---- the query reader -----------------------------------------------------------

test("refuseQuery reads IRIs and strings before comments", () => {
  // A `#` in an IRI or a string starts no comment.
  assert.equal(
    refuseQuery("PREFIX x: <http://e/ns#> SELECT ?s WHERE { ?s x:p ?o }"),
    null,
  );
  assert.equal(
    refuseQuery("BASE <http://e/#> SELECT ?s WHERE { ?s ?p ?o }"),
    null,
  );
  assert.equal(
    refuseQuery('SELECT ?s WHERE { ?s ?p "a # b" . ?s ?q ?o }'),
    null,
  );
  assert.equal(refuseQuery("SELECT ?s WHERE { ?s ?p '''a # b ''' }"), null);
  assert.equal(
    refuseQuery('SELECT ?s WHERE { ?s ?p """a "quoted" # b""" }'),
    null,
  );
  assert.equal(
    refuseQuery("SELECT ?s WHERE { ?s ?p ?o FILTER(?o < 5 && ?o > 1) }"),
    null,
  );
  // A real comment ends the line.
  assert.equal(
    refuseQuery("SELECT ?s WHERE { ?s ?p ?o } # SERVICE <http://x>"),
    null,
  );
  // SERVICE after such a prefix is still SERVICE.
  assert.match(
    refuseQuery(
      "PREFIX x: <http://e/ns#> SELECT * WHERE { SERVICE <http://x> { ?s ?p ?o } }",
    ) ?? "",
    /SERVICE/,
  );
  assert.match(
    refuseQuery("PREFIX x: <http://e/ns#> INSERT DATA { <a> <b> <c> }") ?? "",
    /SELECT/,
  );
  // The similarity predicate is refused as an IRI and as a prefixed name, and
  // a string that holds the word is no predicate.
  assert.match(
    refuseQuery(
      "SELECT ?s WHERE { ?s <https://littlebigbrain.com/search#similarTo> 'x' }",
    ) ?? "",
    /similarity/,
  );
  assert.match(
    refuseQuery(
      "PREFIX search: <https://littlebigbrain.com/search#> SELECT ?s WHERE { ?s search:similarTo 'x' }",
    ) ?? "",
    /similarity/,
  );
  assert.equal(refuseQuery("SELECT ?s WHERE { ?s ?p 'similarTo' }"), null);
});
