import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "./agent.js";
import { stableHashHex } from "./hash.js";
import {
  D1,
  FakeEngine,
  FakeWorld,
  SHA,
  STAMP,
  sampleReply as reply,
  sampleWidth as width,
  sampleWorld as world,
} from "./agent-fakes.test.js";

test("a limit keeps a grounded quote for live and hosted-test Review", async () => {
  for (const hosted of [false, true]) {
    const fake = new FakeWorld(world(), [
      reply("propose_write", { proposals: [width] }),
    ]);
    const result = await runAgent(
      fake.host(),
      new FakeEngine().context(),
      "agent",
      {
        instructions: "Read the door width.",
        owns: { properties: ["width_cm"] },
        input: { file: SHA, instances: [D1] },
        maxIterations: 1,
      },
      { hosted },
    );
    assert.equal(result.outcome, "limit");
    assert.equal(fake.commits.size, 0);
    const body = [...fake.reviews.values()][0]!;
    assert.equal((body.evidence as { quote: string }[])[0]?.quote, width.quote);
    assert.equal(
      Object.hasOwn(body, "evidence_hash"),
      !hosted,
      "the hosted server owns the evidence mark",
    );
  }
});

test("a hosted answer holds for the server's exact stamped evidence hash", async () => {
  const fake = new FakeWorld(
    world({
      answers: {
        [`${D1}|width_cm`]: {
          decision: "correct",
          value: "700",
          asked: "500",
          evidence_hash: stableHashHex([SHA, STAMP, width.quote]),
        },
      },
    }),
    [
      reply("propose_write", { proposals: [width] }),
      reply("finish", { summary: "done" }),
    ],
  );
  const result = await runAgent(
    fake.host(),
    new FakeEngine().context(),
    "agent",
    {
      instructions: "Read the door width.",
      owns: { properties: ["width_cm"] },
      input: { file: SHA, instances: [D1] },
    },
    { hosted: true },
  );
  assert.equal(result.proposals[0]?.disposition, "answered");
  assert.equal(fake.reviews.size, 0);
  assert.equal(fake.commits.size, 0);
});

test("a rejected quote or changed source supplies no Review evidence", async () => {
  for (const code of ["quote_not_found", "source_changed"]) {
    const fake = new FakeWorld(
      world({ ground: [{ quote: width.quote, verdict: { ok: false, code } }] }),
      [
        reply("propose_write", { proposals: [width] }),
        reply("finish", { summary: "done" }),
      ],
    );
    await runAgent(
      fake.host(),
      new FakeEngine().context(),
      "agent",
      {
        instructions: "Read the door width.",
        owns: { properties: ["width_cm"] },
        input: { file: SHA, instances: [D1] },
      },
      { hosted: true },
    );
    const body = [...fake.reviews.values()][0]!;
    assert.deepEqual(body.evidence, []);
  }
});
