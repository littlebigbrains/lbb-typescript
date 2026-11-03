// ontology-fit on its samples, with a mock reasoning model whose rules are
// fixed: a sentence about an issue proposes the class `Issue`, "due",
// "status" and "Assigned to" propose its facts, a room in the same text
// widens `concerns_room`, a list of who was present proposes the relation
// `attended_by` the ontology has, and a text about the inspection gets a
// quote that is not in the text. The mock decision model finds every quote
// supports its change. The expected keys come from samples/expected.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENTITY_IRI_NAMESPACE, type Schemas } from "@littlebigbrain/client";
import {
  MockActivities,
  mockId,
  phases,
  readJson,
  runMessage,
  samplesDir,
  triggerMessage,
  type MockRules,
} from "../_shared/testing.js";
import { chunkText, createWorkflow, displayName, keyPart, quoteInText } from "./workflow.js";
import { sampleOntology } from "./samples.js";

const SAMPLES = samplesDir(import.meta.url, "ontology-fit");
const TEXTS = readJson<{ name: string; text: string }[]>(join(SAMPLES, "texts.json"));
const EXPECTED_MD = readFileSync(join(SAMPLES, "expected.md"), "utf8");
/** The keys of the table "Proposals a good run makes". */
const EXPECTED_KEYS = [
  ...EXPECTED_MD.split("## Proposals a good run makes")[1]!
    .split("## Proposals a good run may make")[0]!
    .matchAll(/`(fit:[^`]+)`/g),
].map((m) => m[1]!);

const iriOf = (name: string) => ENTITY_IRI_NAMESPACE + mockId(`FieldNote:${name}`);

/** The ontology view of the graph before the run, built from the sample ontology. */
function view(): Schemas["OntologyView"] {
  const ops = sampleOntology;
  const types = ops.flatMap((op) => (op.op === "add_entity_type" ? [op.name] : []));
  return {
    graph: { tenant_id: "t", graph_id: "samples", branch_id: "main" },
    ontology_version: 3,
    entity_types: [],
    relations: [],
    entity_type_defs: types.map((name) => ({
      name,
      stable_id: `type:${name}`,
      properties: [],
      resolvable: true,
      since_version: 1,
    })),
    relation_defs: ops.flatMap((op) =>
      op.op === "add_relation"
        ? [
            {
              name: op.name,
              src_types: op.domain ?? [],
              dst_types: op.range ?? [],
              cardinality: "many_to_many",
              since_version: 1,
              symmetric: false,
              temporal_semantics: "bitemporal",
              transitive: false,
            },
          ]
        : [],
    ),
    property_defs: ops.flatMap((op) =>
      op.op === "add_property"
        ? [{ name: op.name, value_type: op.value_type ?? "text", required: false }]
        : [],
    ),
  } as Schemas["OntologyView"];
}

/** Whether the ontology has a change already: the dry run's no-op. */
function covered(op: Schemas["OntologyEvolveOp"], v: Schemas["OntologyView"]): boolean {
  const has = (names: { name: string }[] | undefined, name: string) =>
    (names ?? []).some((n) => n.name.toLowerCase() === name.toLowerCase());
  if (op.op === "add_entity_type") return has(v.entity_type_defs, op.name);
  if (op.op === "add_property") return has(v.property_defs, op.name);
  if (op.op === "add_relation") return has(v.relation_defs, op.name);
  if (op.op === "widen_relation") {
    const r = v.relation_defs?.find((d) => d.name.toLowerCase() === op.relation.toLowerCase());
    return Boolean(
      r &&
      (op.add_domain ?? []).every((d) => r.src_types.includes(d)) &&
      (op.add_range ?? []).every((d) => r.dst_types.includes(d)),
    );
  }
  return false;
}

const proposal = (fields: Partial<Record<string, string>>) => ({
  kind: "",
  name: "",
  parent: "",
  class: "",
  value_type: "",
  domain: "",
  range: "",
  quote: "",
  reason: "",
  ...fields,
});

function propose(text: string) {
  const sentences = text.split(/(?<=\.)\s+/);
  const find = (pattern: RegExp) => sentences.find((s) => pattern.test(s));
  const out = [];
  const issue = find(/\bissues?\b/i);
  if (issue)
    out.push(
      proposal({
        kind: "add_class",
        name: "Issue",
        quote: issue,
        reason: "The texts follow issues.",
      }),
    );
  const deadline = find(/\bdue\b/);
  if (issue && deadline)
    out.push(
      proposal({
        kind: "add_property",
        name: "due_date",
        class: "Issue",
        value_type: "date_time",
        quote: deadline,
      }),
    );
  const status = find(/\bstatus\b/i);
  if (issue && status)
    out.push(
      proposal({
        kind: "add_property",
        name: "status",
        class: "Issue",
        value_type: "keyword",
        quote: status,
      }),
    );
  const owner = find(/Assigned to/);
  if (issue && owner)
    out.push(
      proposal({
        kind: "add_relation",
        name: "assigned_to",
        domain: "Issue",
        range: "Vendor",
        quote: owner,
      }),
    );
  const room = find(/\broom 0\.\d+/);
  if (issue && room)
    out.push(
      proposal({ kind: "widen_relation", name: "concerns_room", domain: "Issue", quote: room }),
    );
  const present = find(/Present:|Attendees:/);
  if (present)
    out.push(
      proposal({
        kind: "add_relation",
        name: "attended_by",
        domain: "FieldNote",
        range: "Vendor",
        quote: present,
      }),
    );
  if (find(/\binspection\b/i))
    out.push(
      proposal({
        kind: "add_class",
        name: "Inspection",
        quote: "The inspection takes place tomorrow.",
      }),
    );
  return out;
}

function rules(more: MockRules = {}): MockRules {
  const v = view();
  return {
    ontology: v,
    reason: (request) => ({
      proposals: propose((JSON.parse(request.prompt) as { text: string }).text),
    }),
    decide: (request) =>
      Object.fromEntries(
        Object.keys(request.questions).map((id) => [
          id,
          { choice: "supported", confidence: 0.9, probabilities: { supported: 0.9 } },
        ]),
      ),
    evolve: (ops) => ({ no_op: ops.every((op) => covered(op, v)) }),
    sparql: (query) =>
      TEXTS.filter((t) => query.includes(iriOf(t.name))).map((t) => ({
        s: iriOf(t.name),
        class: "FieldNote",
        label: t.name,
        text: t.text,
      })),
    ...more,
  };
}

test("the samples give the changes of expected.md, one review item per key", async () => {
  const lbb = new MockActivities(rules());
  const { state, turns } = await runMessage(
    createWorkflow(lbb),
    triggerMessage(
      "field-notes",
      TEXTS.map((t) => iriOf(t.name)),
    ),
  );

  assert.deepEqual(phases(turns), ["reading texts", "filing review items"]);
  assert.deepEqual(
    turns[0]!.progress.filter((p) => p.phase === "filing review items").map((p) => p.done),
    [0, 1, 2, 3, 4],
  );
  assert.equal(EXPECTED_KEYS.length, 5);
  assert.deepEqual([...lbb.reviews.keys()].sort(), [...EXPECTED_KEYS].sort());
  // The counters of LBB's fit: the quote of Inspection is not in its text, attended_by is
  // covered (texts 1 and 2 list who was present).
  assert.deepEqual(state, {
    instances: 5,
    chunks: 5,
    failed_chunks: 0,
    proposals: 22,
    kept: 19,
    filed: 5,
    updated: 14,
    reopened: 0,
    quote_not_found: 1,
    invalid: 0,
    already_covered: 2,
    weak_support: 0,
    skipped: 0,
  });
  const issue = lbb.reviews.get("fit:field-notes/add_class/issue")!;
  assert.equal(issue.workflow, "field-notes");
  assert.deepEqual(issue.change, [{ op: "add_entity_type", name: "Issue" }]);
  assert.equal(issue.evidence!.records, 5);
});

test("a change names the classes it needs, and a widening keeps the relation's name", async () => {
  const lbb = new MockActivities(rules());
  await runMessage(
    createWorkflow(lbb),
    triggerMessage(
      "field-notes",
      TEXTS.map((t) => iriOf(t.name)),
    ),
  );

  assert.deepEqual(
    lbb.reviews.get("fit:field-notes/add_relation/issue/assigned-to/vendor")!.change,
    [
      { op: "add_entity_type", name: "Issue" },
      {
        op: "add_relation",
        name: "assigned_to",
        domain: ["Issue"],
        range: ["Vendor"],
        cardinality: null,
        temporal_semantics: null,
        reducer: null,
        inverse_name: null,
        transitive: false,
        symmetric: false,
      },
    ],
  );
  assert.deepEqual(
    lbb.reviews.get("fit:field-notes/widen_relation/concerns-room/issue/x")!.change,
    [
      { op: "add_entity_type", name: "Issue" },
      { op: "widen_relation", relation: "concerns_room", add_domain: ["Issue"], add_range: [] },
    ],
  );
  assert.equal(
    lbb.reviews.get("fit:field-notes/add_property/issue/due-date")!.title,
    "Add property due_date to Issue",
  );
});

test("a change the ontology has, and a quote that is not in the text, are not filed", async () => {
  const lbb = new MockActivities(rules());
  await runMessage(
    createWorkflow(lbb),
    triggerMessage(
      "field-notes",
      TEXTS.map((t) => iriOf(t.name)),
    ),
  );
  const keys = [...lbb.reviews.keys()];

  assert.ok(!keys.some((k) => k.includes("attended")), "attended_by is already in the ontology");
  assert.ok(!keys.some((k) => k.includes("inspection")), "its quote is not in the text");
  for (const item of lbb.reviews.values())
    for (const sample of item.evidence!.samples! as { entity: string; quote: string }[]) {
      const text = TEXTS.find((t) => iriOf(t.name) === sample.entity)!.text;
      assert.ok(quoteInText(sample.quote, text), sample.quote);
    }
});

test("keys keep lowercase ASCII letters and digits, other runs as one dash", () => {
  assert.equal(keyPart("Issue"), "issue");
  assert.equal(keyPart("concerns_room"), "concerns-room");
  assert.equal(keyPart("-"), "x");
  assert.equal(keyPart("façade"), "fa-ade");
});

test("a long text is read in chunks as LBB reads it, and a class name in its words", () => {
  const sentence = "The issue in room 0.12 is resolved. ";
  const long = sentence.repeat(3_000);
  const chunks = chunkText(long);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((c) => [...c].length <= 40_000));
  // Each chunk ends after a sentence and shares 1,000 characters with the next.
  assert.ok(chunks[0]!.endsWith("resolved."));
  assert.equal(chunks[1]!.slice(0, 1_000), chunks[0]!.slice(-1_000));
  assert.deepEqual(chunkText("short"), ["short"]);
  assert.equal(displayName("customerIdentityData"), "customer identity data");
  assert.equal(displayName("depends_on"), "depends on");
  assert.equal(displayName("fieldnote"), "fieldnote");
});
