import { test } from "node:test";
import assert from "node:assert/strict";
import { recordHostedAgentResult } from "./hosted-agent.js";
import { RunResultsCollector } from "./run-results.js";
import {
  TURN_RUN,
  type ActivityTurn,
  type WorkflowContext,
} from "./workflows.js";
import type { AgentResult } from "./agent.js";

function context() {
  const turn = { results: new RunResultsCollector() } as ActivityTurn;
  const ctx = { [TURN_RUN]: turn } as unknown as WorkflowContext;
  return { ctx, turn };
}
function result(over: Partial<AgentResult> = {}): AgentResult {
  return {
    outcome: "finished",
    summary: "Dimensions read",
    iterations: 2,
    maxIterations: 8,
    tools: { propose_write: 1 },
    costMicroUsd: 42,
    pin: "pin",
    workKey: "wk_0000000000000000",
    proposals: [],
    counts: { written: 0, review: 0, failed: 0, dropped: 0 },
    trace: [],
    ...over,
  };
}

test("a terminal failure retains the source input and compact record even without proposals", () => {
  const { ctx, turn } = context();
  recordHostedAgentResult(
    ctx,
    { iri: "urn:source" },
    result({
      outcome: "failed",
      code: "agent_pin_changed",
      summary: "Code changed",
    }),
  );
  const input = turn.results!.report()!.inputs![0]!;
  assert.equal(input.iri, "urn:source");
  assert.equal(input.outcome, "failed");
  assert.equal(input.agent?.code, "agent_pin_changed");
  assert.equal(input.agent?.work_key, "wk_0000000000000000");
  assert.deepEqual(input.agent?.proposals, {
    written: 0,
    review: 0,
    failed: 0,
    dropped: 0,
  });
  assert.ok(!("workKey" in input.agent!));
});

test("projection preserves replayed duplicate and converted value under the original source", () => {
  const { ctx, turn } = context();
  turn.results!.add({
    iri: "urn:part",
    label: "P3",
    outcome: "duplicate",
    values: [
      {
        property: "width_cm",
        value: "60",
        quote: "Width: 600 mm",
        stated: "600 mm",
        outcome: "duplicate",
      },
    ],
  });
  recordHostedAgentResult(
    ctx,
    { iri: "urn:file" },
    result({
      counts: { written: 1, review: 0, failed: 0, dropped: 0 },
      proposals: [
        {
          subject: "urn:part",
          property: "width_cm",
          value: "600",
          unit: "mm",
          sha256: "ab".repeat(32),
          locator: "line=1,2",
          quote: "Width: 600 mm",
          verdict: { code: "grounded", stated: "600 mm" },
          disposition: "written",
        },
      ],
    }),
  );
  const report = turn.results!.report()!;
  assert.equal(report.inputs!.length, 1);
  const input = report.inputs![0]!;
  assert.equal(input.iri, "urn:file");
  assert.equal(input.outcome, "duplicate");
  assert.equal(input.values![0]!.outcome, "duplicate");
  assert.equal(input.values![0]!.value, "60");
  assert.equal(input.values![0]!.stated, "600 mm");
  assert.equal(input.values![0]!.subject, "urn:part");
});

test("failed and dropped grounded proposals keep their dispositions", () => {
  const { ctx, turn } = context();
  const proposals = ["failed", "dropped"].map((disposition, i) => ({
    subject: `urn:part${i}`,
    property: "width_cm",
    value: "60",
    sha256: "ab".repeat(32),
    locator: "line=1,2",
    quote: "Width: 600 mm",
    verdict: { code: "grounded" as const },
    disposition: disposition as "failed" | "dropped",
  }));
  recordHostedAgentResult(
    ctx,
    { iri: "urn:file" },
    result({
      proposals,
      counts: { written: 0, review: 0, failed: 1, dropped: 1 },
    }),
  );
  assert.deepEqual(
    turn.results!.report()!.inputs![0]!.values!.map((v) => v.outcome),
    ["failed", "dropped"],
  );
});

test("unverified proposed text is not retained as evidence and verified evidence links its Document", () => {
  for (const code of [
    "quote_not_found",
    "source_changed",
    "source_not_pinned",
  ] as const) {
    const { ctx, turn } = context();
    recordHostedAgentResult(
      ctx,
      { iri: "urn:file" },
      result({
        proposals: [
          {
            subject: "urn:part",
            property: "width_cm",
            value: "60",
            sha256: "ab".repeat(32),
            locator: "line=1,2",
            quote: "Invented line",
            verdict: { code, document: "urn:document" },
            disposition: "failed",
          },
        ],
        counts: { written: 0, review: 0, failed: 1, dropped: 0 },
      }),
    );
    const value = turn.results!.report()!.inputs![0]!.values![0]!;
    assert.equal(value.quote, "", code);
    assert.ok(!value.source, code);
  }
  const { ctx, turn } = context();
  recordHostedAgentResult(
    ctx,
    { iri: "urn:file" },
    result({
      proposals: [
        {
          subject: "urn:part",
          property: "width_cm",
          value: "60",
          sha256: "ab".repeat(32),
          locator: "line=1,2",
          quote: "Width: 60 cm",
          verdict: { code: "grounded", document: "urn:document" },
          disposition: "written",
        },
      ],
      counts: { written: 1, review: 0, failed: 0, dropped: 0 },
    }),
  );
  const value = turn.results!.report()!.inputs![0]!.values![0]!;
  assert.equal(value.quote, "Width: 60 cm");
  assert.equal(value.source, "urn:document#line=1,2");
});

test("Review projection keeps normalized typed value apart from the original stated value", () => {
  const { ctx, turn } = context();
  turn.results!.add({
    iri: "urn:part",
    label: "P3",
    outcome: "review",
    values: [
      {
        property: "width_cm",
        value: "600 mm",
        quote: "Width: 600 mm",
        outcome: "review",
        review_item: "review-1",
      },
    ],
  });
  recordHostedAgentResult(
    ctx,
    { iri: "urn:source" },
    result({
      proposals: [
        {
          subject: "urn:part",
          property: "width_cm",
          value: "600",
          unit: "mm",
          sha256: "ab".repeat(32),
          locator: "line=1,2",
          quote: "Width: 600 mm",
          verdict: {
            code: "weak_support",
            typed: { f64: 60 },
            stated: "600 mm",
            document: "urn:document",
          },
          disposition: "review",
        },
      ],
      counts: { written: 0, review: 1, failed: 0, dropped: 0 },
    }),
  );
  const value = turn.results!.report()!.inputs![0]!.values![0]!;
  assert.equal(value.value, "60");
  assert.equal(value.stated, "600 mm");
  assert.equal(value.review_item, "review-1");
  assert.equal(value.outcome, "review");
});
