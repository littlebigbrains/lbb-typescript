// The grading script's metrics (general linking 9.2) on a run small enough
// to count by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReport, grade, wilsonLow, type Gold, type Run } from "./grade.js";

const gold: Gold = {
  format: "lbb.link.gold.v1",
  records: {
    contact: "e:contact",
    lead: "e:lead",
    deal: "e:deal",
    note: "e:note",
    other: "e:other",
  },
  groups: [
    {
      id: "mira",
      mentions: [
        { record: "contact", field: "name", span: "Mira Tannenholt-Ruiz" },
        { record: "lead", field: "first_name+last_name", span: "Mira Ruiz" },
        { record: "deal", field: "name", span: "M. Tannenholt" },
        { record: "note", field: "body", span: "Mimi T." },
      ],
    },
    {
      id: "kim",
      mentions: [
        { record: "other", field: "name", span: "Kim Oak" },
        { record: "note", field: "body", span: "K. Oak" },
      ],
    },
  ],
};

const run: Run = {
  mentions: [
    {
      iri: "m1",
      record: "e:contact",
      field: "name",
      span: "Mira Tannenholt-Ruiz",
      role: "self",
      thing: "t1",
    },
    {
      iri: "m2",
      record: "e:lead",
      field: "first_name+last_name",
      span: "Mira Ruiz",
      role: "self",
      thing: "t2",
    },
    {
      iri: "m3",
      record: "e:deal",
      field: "name",
      span: "M. Tannenholt",
      role: "refers",
      thing: "t1",
    },
    { iri: "m4", record: "e:note", field: "body", span: "Mimi T.", role: "refers", thing: null },
    { iri: "m5", record: "e:other", field: "name", span: "Kim Oak", role: "self", thing: "t3" },
    // A wrong link: K. Oak in Mira's thing. And a mention the gold does not list.
    { iri: "m6", record: "e:note", field: "body", span: "K. Oak", role: "refers", thing: "t1" },
    { iri: "m7", record: "e:note", field: "body", span: "Lena Fair", role: "refers", thing: null },
  ],
  links: [
    { a: "m3", b: "m1", confidence: 0.9 },
    { a: "m6", b: "m1", confidence: 0.85 },
    { a: "m7", b: "m5", confidence: 0.81 },
  ],
  review: [{ a: "m4", b: "m3", confidence: 0.6, kind: "link" }],
  identities: [
    { records: ["e:contact", "e:lead"], confidence: 1 },
    { records: ["e:contact", "e:other"], confidence: 0.9 },
  ],
};

test("the metrics of a run against its gold", () => {
  const report = grade(gold, run);
  assert.deepEqual(report.mentions, { run: 7, gold: 6, matched: 6, unjudged: 1 });
  // m3-m1 right, m6-m1 wrong; m7-m5 is unjudged (m7 is not in the gold, and the gold is not complete).
  assert.deepEqual([report.links.right, report.links.total, report.links.unjudged], [1, 2, 1]);
  // Things: t1 = {m1, m3, m6}: pairs m1-m3 (right), m1-m6, m3-m6 (wrong). Gold pairs: 6 of Mira, 1 of Kim.
  assert.deepEqual([report.pairs.precision.right, report.pairs.precision.total], [1, 3]);
  assert.deepEqual([report.pairs.recall.right, report.pairs.recall.total], [1, 7]);
  // B-cubed purity: m1, m3: 2/3; m6: 1/3; m2, m4, m5 alone: 1 → (2/3 + 2/3 + 1/3 + 1 + 1 + 1) / 6.
  assert.equal(report.purity, Math.round((((2 / 3) * 2 + 1 / 3 + 3) / 6) * 10_000) / 10_000);
  // Completeness: m1, m3: 2/4; m2, m4: 1/4; m5: 1/2; m6: 1/2.
  assert.equal(
    report.completeness,
    Math.round((((2 / 4) * 2 + (1 / 4) * 2 + 1 / 2 + 1 / 2) / 6) * 10_000) / 10_000,
  );
  // Linkable: every matched mention (all groups have two or more); m4 has an open row.
  assert.deepEqual([report.reviewShare.right, report.reviewShare.total], [1, 6]);
  // Identities: contact-lead right, contact-other wrong; the gold's one record pair is found.
  assert.deepEqual([report.identities.precision.right, report.identities.precision.total], [1, 2]);
  assert.deepEqual([report.identities.recall.right, report.identities.recall.total], [1, 1]);
  assert.match(formatReport(report), /link precision at the gate: 0.5 \(1 of 2/);
});

test("with a complete gold, a mention it does not list is a thing of its own", () => {
  const report = grade({ ...gold, complete: true }, run);
  assert.deepEqual([report.links.right, report.links.total, report.links.unjudged], [1, 3, 0]);
});

test("the 95% Wilson interval starts where the bars read it", () => {
  assert.equal(wilsonLow(19, 19), 0.8318);
  assert.equal(wilsonLow(95, 100), 0.8882);
  assert.equal(wilsonLow(0, 10), 0);
  assert.equal(wilsonLow(0, 0), null);
});
