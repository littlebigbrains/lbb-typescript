import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fitReport,
  jsonBytes,
  stepOutputResults,
  stepOutputWithResults,
  WORKFLOW_RUN_RESULTS_MAX_BYTES,
  type WorkflowRunInput,
} from "./run-results.js";

// The Python worker pins the same numbers (sdk/python/tests/test_run_results.py):
// both measure a report as UTF-8 of the JSON `JSON.stringify` writes.
test("a report is measured as UTF-8 of its JSON, as the Python worker measures it", () => {
  const value = {
    a: 60.0,
    b: "Größe – Küche",
    c: 1e-7,
    d: 0.5,
    e: [1e21, 123456789012345680000, -0.000001],
    f: null,
    g: true,
  };
  assert.equal(
    JSON.stringify(value),
    '{"a":60,"b":"Größe – Küche","c":1e-7,"d":0.5,"e":[1e+21,123456789012345680000,-0.000001],"f":null,"g":true}',
  );
  assert.equal(jsonBytes(value), 112);
});

/** `count` inputs with 32 values of `chars` characters each. */
function inputs(count: number, chars: number): WorkflowRunInput[] {
  return Array.from({ length: count }, (_, i) => ({
    label: `n${i}`,
    outcome: "written" as const,
    values: Array.from({ length: 32 }, (_, k) => ({
      property: `p${k}`,
      value: "é".repeat(chars),
      quote: "",
      outcome: "written",
    })),
  }));
}
/** 200 inputs of about 33 KB each: about 6.6 MB. */
const large = () => inputs(200, 512);

test("a report past 512 KiB loses the values of its last inputs first, and keeps every input and count", () => {
  const report = fitReport({ inputs: large(), counts: { written: 230 } });
  assert.ok(jsonBytes(report) <= WORKFLOW_RUN_RESULTS_MAX_BYTES);
  assert.equal(report.inputs?.length, 200);
  assert.equal(report.counts?.written, 230);
  const kept = (report.inputs ?? []).filter((input) => input.values?.length);
  // The same cut as the Python worker's.
  assert.equal(kept.length, 12);
  assert.equal(report.inputs?.[11]?.values?.length, 32);
  assert.equal(report.inputs?.[12]?.values?.length, 0);
});

test("a step keeps what it reported in its saved output, and reads it back", () => {
  // Three inputs of about 7 KB each, then three of about 33 KB.
  const reported = [...inputs(3, 100), ...inputs(3, 512)];
  const saved = stepOutputWithResults({ commit_seq: 12 }, "run-1", reported);
  const read = stepOutputResults(saved);
  assert.deepEqual(read.value, { commit_seq: 12 });
  assert.equal(read.run, "run-1");
  // Values while they fit in 32 KiB, then only the label and the outcome.
  assert.equal(read.results.length, 6);
  assert.equal(read.results[2]?.values?.length, 32);
  assert.deepEqual(read.results[3], { label: "n0", outcome: "written" });
  assert.ok(jsonBytes(saved) <= 60 * 1024);
  // An output without results reads as itself.
  assert.deepEqual(stepOutputResults({ commit_seq: 12 }), {
    value: { commit_seq: 12 },
    run: null,
    results: [],
  });
  assert.deepEqual(stepOutputWithResults(7, "run-1", []), 7);
});
