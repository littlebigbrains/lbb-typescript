// ontology-fit on its samples, with a mock reasoning model whose rules are
// fixed: a sentence about a defect (`Mangel`) proposes the class `Mangel`,
// `Frist`, `Status` and `Zuständig` propose its facts, a room in the same
// text widens `betrifft_raum`, a list of who was present proposes the
// relation `anwesend` the ontology has, and a text about the acceptance
// (`Abnahme`) gets a quote that is not in the text. The mock decision model
// finds every quote supports its change. The expected keys come from
// samples/expected.md.
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

const iriOf = (name: string) => ENTITY_IRI_NAMESPACE + mockId(`Baustellenbericht:${name}`);

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
  const defect = find(/Mangel|Mängel/);
  if (defect)
    out.push(
      proposal({
        kind: "add_class",
        name: "Mangel",
        quote: defect,
        reason: "The texts follow defects.",
      }),
    );
  const deadline = find(/Frist/);
  if (defect && deadline)
    out.push(
      proposal({
        kind: "add_property",
        name: "frist",
        class: "Mangel",
        value_type: "date_time",
        quote: deadline,
      }),
    );
  const status = find(/Status/);
  if (defect && status)
    out.push(
      proposal({
        kind: "add_property",
        name: "status",
        class: "Mangel",
        value_type: "keyword",
        quote: status,
      }),
    );
  const owner = find(/Zuständig/);
  if (defect && owner)
    out.push(
      proposal({
        kind: "add_relation",
        name: "zustaendig",
        domain: "Mangel",
        range: "Firma",
        quote: owner,
      }),
    );
  const room = find(/Raum 0\.\d+/);
  if (defect && room)
    out.push(
      proposal({ kind: "widen_relation", name: "betrifft_raum", domain: "Mangel", quote: room }),
    );
  const present = find(/Anwesend:|Teilnehmer:/);
  if (present)
    out.push(
      proposal({
        kind: "add_relation",
        name: "anwesend",
        domain: "Baustellenbericht",
        range: "Firma",
        quote: present,
      }),
    );
  if (find(/Abnahme/))
    out.push(
      proposal({ kind: "add_class", name: "Abnahme", quote: "Die Abnahme findet morgen statt." }),
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
        class: "Baustellenbericht",
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
      "berichte",
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
  // The counters of LBB's fit: the quote of Abnahme is not in its text, anwesend is covered
  // (texts 1 and 2 list who was present).
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
  const mangel = lbb.reviews.get("fit:berichte/add_class/mangel")!;
  assert.equal(mangel.workflow, "berichte");
  assert.deepEqual(mangel.change, [{ op: "add_entity_type", name: "Mangel" }]);
  assert.equal(mangel.evidence!.records, 5);
});

test("a change names the classes it needs, and a widening keeps the relation's name", async () => {
  const lbb = new MockActivities(rules());
  await runMessage(
    createWorkflow(lbb),
    triggerMessage(
      "berichte",
      TEXTS.map((t) => iriOf(t.name)),
    ),
  );

  assert.deepEqual(lbb.reviews.get("fit:berichte/add_relation/mangel/zustaendig/firma")!.change, [
    { op: "add_entity_type", name: "Mangel" },
    {
      op: "add_relation",
      name: "zustaendig",
      domain: ["Mangel"],
      range: ["Firma"],
      cardinality: null,
      temporal_semantics: null,
      reducer: null,
      inverse_name: null,
      transitive: false,
      symmetric: false,
    },
  ]);
  assert.deepEqual(lbb.reviews.get("fit:berichte/widen_relation/betrifft-raum/mangel/x")!.change, [
    { op: "add_entity_type", name: "Mangel" },
    { op: "widen_relation", relation: "betrifft_raum", add_domain: ["Mangel"], add_range: [] },
  ]);
  assert.equal(
    lbb.reviews.get("fit:berichte/add_property/mangel/frist")!.title,
    "Add property frist to Mangel",
  );
});

test("a change the ontology has, and a quote that is not in the text, are not filed", async () => {
  const lbb = new MockActivities(rules());
  await runMessage(
    createWorkflow(lbb),
    triggerMessage(
      "berichte",
      TEXTS.map((t) => iriOf(t.name)),
    ),
  );
  const keys = [...lbb.reviews.keys()];

  assert.ok(!keys.some((k) => k.includes("anwesend")), "anwesend is already in the ontology");
  assert.ok(!keys.some((k) => k.includes("abnahme")), "its quote is not in the text");
  for (const item of lbb.reviews.values())
    for (const sample of item.evidence!.samples! as { entity: string; quote: string }[]) {
      const text = TEXTS.find((t) => iriOf(t.name) === sample.entity)!.text;
      assert.ok(quoteInText(sample.quote, text), sample.quote);
    }
});

test("keys keep lowercase ASCII letters and digits, other runs as one dash", () => {
  assert.equal(keyPart("Mangel"), "mangel");
  assert.equal(keyPart("betrifft_raum"), "betrifft-raum");
  assert.equal(keyPart("-"), "x");
  assert.equal(keyPart("zuständig"), "zust-ndig");
});

test("a long text is read in chunks as LBB reads it, and a class name in its words", () => {
  const sentence = "Der Mangel in Raum 0.12 ist behoben. ";
  const long = sentence.repeat(3_000);
  const chunks = chunkText(long);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((c) => [...c].length <= 40_000));
  // Each chunk ends after a sentence and shares 1,000 characters with the next.
  assert.ok(chunks[0]!.endsWith("behoben."));
  assert.equal(chunks[1]!.slice(0, 1_000), chunks[0]!.slice(-1_000));
  assert.deepEqual(chunkText("kurz"), ["kurz"]);
  assert.equal(displayName("customerIdentityData"), "customer identity data");
  assert.equal(displayName("depends_on"), "depends on");
  assert.equal(displayName("baustellenbericht"), "baustellenbericht");
});
