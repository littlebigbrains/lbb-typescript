// The agent step conformance suite (sdk/conformance/agent-step) on `runAgent`:
// each scenario runs to the end once, and then again with the attempt ended at
// every step boundary, after the step's output was saved and after its effect
// ran and before the output was saved. The invariants of every kill: one
// commit, one Review item per key, no second model call for a saved decision,
// the cost counted once, and the pin checked first. The format is in the
// suite's README.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, type AgentResult, type AgentSpec } from "./agent.js";
import { WorkflowWait } from "./workflows.js";
import {
  FakeEngine,
  FakeWorld,
  Killed,
  type KillPhase,
  type ModelReply,
  type WorldDef,
} from "./agent-fakes.test.js";

type Obj = Record<string, unknown>;

interface Scenario {
  name: string;
  rule: string;
  spec: Obj;
  world: WorldDef;
  model: ModelReply[];
  events?: { after: string; do: "change_file" | "bump_epoch"; file?: string }[];
  pin_change?: Obj;
  expect: Obj;
}

/** The scenarios, found above the test file (`conformance/` in the public repositories, `sdk/conformance/` here). */
function scenarioFiles(): { dir: string; files: string[] } {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    for (const candidate of [
      join(dir, "conformance", "agent-step", "scenarios"),
      join(dir, "sdk", "conformance", "agent-step", "scenarios"),
    ])
      if (existsSync(candidate)) {
        const files = readdirSync(candidate)
          .filter((name) => name.endsWith(".json"))
          .sort();
        if (files.length) return { dir: candidate, files };
      }
    const up = dirname(dir);
    if (up === dir) throw new Error("the agent step scenarios are not found");
    dir = up;
  }
}

/** The spec a scenario states, in the SDK's names. */
function specOf(raw: Obj): AgentSpec {
  const spec: Record<string, unknown> = {};
  const names: Record<string, string> = {
    max_iterations: "maxIterations",
    max_cost_micro_usd: "maxCostMicroUsd",
    max_wall_ms: "maxWallMs",
    max_read_ms: "maxReadMs",
    max_proposals: "maxProposals",
    max_review_items: "maxReviewItems",
    pin_wait_ms: "pinWaitMs",
  };
  for (const [key, value] of Object.entries(raw))
    spec[names[key] ?? key] = value;
  return spec as unknown as AgentSpec;
}

/** One attempt of the agent step on `engine` and `world`. */
function attempt(
  engine: FakeEngine,
  world: FakeWorld,
  spec: AgentSpec,
): Promise<AgentResult> {
  return runAgent(world.host(), engine.context(), "agent", spec);
}

function wire(scenario: Scenario, engine: FakeEngine, world: FakeWorld): void {
  engine.onSaved = (key) => {
    for (const event of scenario.events ?? []) {
      if (event.after !== key) continue;
      if (event.do === "bump_epoch") world.epoch = `${world.epoch}-again`;
      else if (event.do === "change_file" && event.file) {
        const file = world.files.get(event.file);
        if (file) file.uploaded_at = "2026-10-02T09:30:00Z";
      }
    }
  };
}

function fresh(scenario: Scenario) {
  const world = new FakeWorld(structuredClone(scenario.world), scenario.model);
  const engine = new FakeEngine();
  wire(scenario, engine, world);
  return { world, engine };
}

function checkExpect(
  scenario: Scenario,
  result: AgentResult,
  world: FakeWorld,
  engine: FakeEngine,
): void {
  const expect = scenario.expect;
  const seen = new Set<string>();
  const check = <T>(name: string, actual: T) => {
    if (!(name in expect)) return;
    seen.add(name);
    assert.deepEqual(actual, expect[name], `${scenario.name}: ${name}`);
  };
  check("outcome", result.outcome);
  check("limit", result.limit);
  check("code", result.code);
  check("counts", result.counts);
  check("iterations", result.iterations);
  check("cost_micro_usd", result.costMicroUsd);
  check("commits", world.commits.size);
  check("review_items", world.reviews.size);
  check("model_calls", world.billed.size);
  check("steps", engine.order);
  check(
    "verdicts",
    Object.fromEntries(
      result.proposals.map((p) => [p.property, p.verdict.code]),
    ),
  );
  const bodies = [...world.reviews.values()];
  const evidence = (body: Obj) =>
    (body.evidence as unknown[] | undefined)?.length ?? 0;
  check(
    "reviews_with_evidence",
    bodies.filter((body) => evidence(body) > 0).length,
  );
  check(
    "reviews_without_evidence",
    bodies.filter((body) => evidence(body) === 0).length,
  );
  if ("subject_properties" in expect) {
    seen.add("subject_properties");
    const commit = [...world.commits.values()][0];
    const entries = (commit?.body.replace_owned?.subject_properties ?? []).map(
      (entry) => ({
        id: String(entry.subject.key).replace("\u0000lbb-eid:", ""),
        properties: entry.properties,
      }),
    );
    assert.deepEqual(
      entries,
      expect.subject_properties,
      `${scenario.name}: subject_properties`,
    );
    // The commit sets no property of the list `properties`.
    assert.equal(commit?.body.replace_owned?.properties, undefined);
  }
  seen.add("pin_wait");
  for (const key of Object.keys(expect))
    assert.ok(seen.has(key), `${scenario.name}: unknown expectation ${key}`);
}

const { dir: root, files } = scenarioFiles();

for (const file of files) {
  const scenario = JSON.parse(
    readFileSync(join(root, file), "utf8"),
  ) as Scenario;
  const spec = specOf(scenario.spec);

  test(`agent step: ${scenario.name}`, async () => {
    // The run to the end.
    const { world, engine } = fresh(scenario);
    const base = await attempt(engine, world, spec);
    checkExpect(scenario, base, world, engine);
    const steps = engine.order.length;
    assert.ok(steps > 0);
    // A saved decision is never asked again in an uninterrupted run, and the
    // result's cost is what the models billed.
    for (const calls of world.modelCalls.values()) assert.equal(calls, 1);
    assert.equal(base.costMicroUsd, world.billedTotal());

    // The kill at every boundary.
    for (let at = 1; at <= steps; at++) {
      for (const phase of ["after_save", "before_save"] as KillPhase[]) {
        const label = `${scenario.name}: killed at step ${at} (${phase})`;
        const run = fresh(scenario);
        run.engine.kill = { at, phase };
        await assert.rejects(
          attempt(run.engine, run.world, spec),
          Killed,
          label,
        );
        run.engine.kill = undefined;
        const savedAtKill = new Set(run.engine.saved.keys());
        const callsAtKill = new Map(run.world.modelCalls);
        const resumed = await attempt(run.engine, run.world, spec);
        // The same result and the same world as the uninterrupted run.
        assert.deepEqual(resumed, base, `${label}: result`);
        assert.deepEqual(
          run.world.summary(),
          world.summary(),
          `${label}: world`,
        );
        // One commit: applied once, however often it was sent.
        assert.equal(run.world.applied, world.applied, `${label}: applied`);
        // One Review item per key: the same keys, however often they were filed.
        assert.deepEqual(
          [...run.world.reviews.keys()].sort(),
          [...world.reviews.keys()].sort(),
          `${label}: review keys`,
        );
        // No second model call for a saved decision.
        for (const key of savedAtKill) {
          if (run.engine.kinds.get(key) !== "model") continue;
          const effect = run.engine.effectId(key);
          assert.equal(
            run.world.modelCalls.get(effect) ?? 0,
            callsAtKill.get(effect) ?? 0,
            `${label}: model call for saved step ${key}`,
          );
        }
        // The cost counted once: what the models billed, each call once.
        assert.equal(
          resumed.costMicroUsd,
          run.world.billedTotal(),
          `${label}: cost`,
        );
      }
    }

    // The pin is checked first: a resume with another pin waits, and calls
    // nothing before it waits.
    if (scenario.pin_change) {
      const changed = specOf({ ...scenario.spec, ...scenario.pin_change });
      for (let at = 1; at <= steps; at++) {
        const label = `${scenario.name}: pin change after step ${at}`;
        const run = fresh(scenario);
        run.engine.kill = { at, phase: "after_save" };
        await assert.rejects(
          attempt(run.engine, run.world, spec),
          Killed,
          label,
        );
        run.engine.kill = undefined;
        const before = JSON.stringify(run.world.counters);
        const calls = new Map(run.world.modelCalls);
        const stepRuns = new Map(run.engine.runs);
        await assert.rejects(
          attempt(run.engine, run.world, changed),
          (error) => error instanceof WorkflowWait,
          label,
        );
        assert.equal(
          JSON.stringify(run.world.counters),
          before,
          `${label}: host calls`,
        );
        assert.deepEqual(run.world.modelCalls, calls, `${label}: model calls`);
        assert.deepEqual(run.engine.runs, stepRuns, `${label}: no step began`);
        // The old code claims it and finishes.
        const finished = await attempt(run.engine, run.world, spec);
        assert.deepEqual(finished, base, `${label}: old code finishes`);
      }
    }
  });
}
