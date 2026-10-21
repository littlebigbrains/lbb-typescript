// values-extract on its samples, with mock models whose rules are fixed:
// the reasoning model reads the first size (`60x40 cm`, or `Breite 60 cm`)
// with its unit, the first material and the water supply of each text, and the decision
// model says a quote from a sentence about an accessory (`Zubehör`) or a
// conditional variant (`Bei Einsatz`) does not support its value. The
// expected values come from samples/expected.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  ENTITY_IRI_NAMESPACE,
  entityIdFromIri,
  entityRef,
  stableHashHex,
  type DecideAnswer,
  type Schemas,
} from "@littlebigbrain/client";
import {
  MockActivities,
  mockId,
  phases,
  readJson,
  runMessage,
  runTurn,
  samplesDir,
  triggerMessage,
  type MockRules,
} from "../_shared/testing.js";
import {
  check,
  createWorkflow,
  defaults,
  evidenceOf,
  legacyValueKey,
  ontology,
  quoteHolds,
  typed,
  unitOf,
  unitProblem,
  valueItemKey,
} from "./workflow.js";

const SAMPLES = samplesDir(import.meta.url, "values-extract");
const RECORDS = readJson<{ name: string; text: string }[]>(join(SAMPLES, "records.json"));
interface ExpectedValue {
  property: string;
  value: number | string | null;
  accept?: string[];
  quote?: string;
}
const EXPECTED = readJson<{
  records: { name: string; values: ExpectedValue[]; leave_out: ExpectedValue[] }[];
}>(join(SAMPLES, "expected.json"));

const iriOf = (name: string) => ENTITY_IRI_NAMESPACE + mockId(`EquipmentItem:${name}`);

const MATERIALS = [
  "Sanitärkeramik",
  "Stahl emailliert",
  "Mineralguss",
  "Edelstahl",
  "Kristallglas",
  "Keramik",
  "Glas",
];

/** The mock reasoning model: the first size, material and water supply of a text. */
function readValues(text: string) {
  const values: { property: string; value: string; unit: string; quote: string }[] = [];
  const size = text.match(/(?:ca\. )?(\d+)x(\d+) cm/);
  const width = text.match(/Breite (\d+) cm/);
  if (size)
    values.push(
      { property: "width_cm", value: size[1]!, unit: "cm", quote: size[0] },
      { property: "depth_cm", value: size[2]!, unit: "cm", quote: size[0] },
    );
  else if (width)
    values.push({ property: "width_cm", value: width[1]!, unit: "cm", quote: width[0] });
  const material = MATERIALS.map((m) => ({
    m,
    at: text.search(new RegExp(`(?<![\\p{L}])${m}(?![\\p{L}])`, "u")),
  }))
    .filter((found) => found.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  if (material)
    values.push({ property: "material", value: material.m, unit: "", quote: material.m });
  const water = text.match(/Anschluss[^.]*?(Kalt- und Warmwasser|Kaltwasser)/);
  if (water)
    values.push({
      property: "water_supply",
      value: water[1] === "Kaltwasser" ? "kalt" : "kalt und warm",
      unit: "",
      quote: water[0],
    });
  return values;
}

/** The mock decision model: the support of each quote, from the sentence that holds it. */
function support(text: string, instructions: string, options: string[]): DecideAnswer {
  const quote = instructions.match(/Quote: "(.*)"$/s)![1]!;
  const sentence = text.split(/(?<=\.)\s+/).find((s) => s.includes(quote)) ?? "";
  const p = /Zubehör|Bei Einsatz/.test(sentence) ? 0.05 : /etwa/.test(sentence) ? 0.6 : 0.92;
  const choice = p >= 0.5 ? "supported" : "not_supported";
  return {
    choice,
    confidence: Math.max(p, 1 - p),
    probabilities: Object.fromEntries(options.map((o) => [o, o === "supported" ? p : (1 - p) / 2])),
  };
}

interface Row {
  name: string;
  text?: string;
  box?: Record<string, number>;
}

function rules(records: Row[], more: MockRules = {}): MockRules {
  return {
    reason: (request) => ({
      values: readValues((JSON.parse(request.prompt) as { text: string }).text),
    }),
    decide: (request) =>
      Object.fromEntries(
        Object.entries(request.questions).map(([id, q]) => [
          id,
          support(
            (request.state as { text: string }).text,
            q.instructions,
            Object.keys(q.criteria),
          ),
        ]),
      ),
    sparql: (query) => {
      assert.ok(query.startsWith("# values-extract: texts"));
      return records
        .filter((r) => query.includes(iriOf(r.name)))
        .map((r) => ({
          s: iriOf(r.name),
          label: r.name,
          ...(r.text !== undefined ? { text: r.text } : {}),
          ...Object.fromEntries(Object.entries(r.box ?? {}).map(([k, v]) => [k, String(v)])),
        }));
    },
    ...more,
  };
}

/** The values written on an instance: its owned properties. */
const written = (lbb: MockActivities, name: string) =>
  lbb.graph.entities.get(iriOf(name))?.properties ?? {};

const matches = (got: unknown, want: ExpectedValue) =>
  typeof want.value === "number"
    ? got === want.value
    : (want.accept ?? [String(want.value).toLowerCase()]).includes(
        String(got).trim().toLowerCase(),
      );

test("the samples give the values of the answer key and none it leaves out", async () => {
  const lbb = new MockActivities(rules(RECORDS));
  const { state, turns } = await runMessage(
    createWorkflow(lbb),
    triggerMessage(
      "values-extract",
      RECORDS.map((r) => iriOf(r.name)),
    ),
  );

  for (const record of EXPECTED.records) {
    const values = written(lbb, record.name);
    for (const want of record.values)
      assert.ok(
        matches(values[want.property], want),
        `${record.name} ${want.property}: ${values[want.property]}`,
      );
    for (const out of record.leave_out)
      assert.ok(
        out.value === null ? !(out.property in values) : !matches(values[out.property], out),
        `${record.name} leaves out ${out.property}`,
      );
    assert.deepEqual(
      Object.keys(values).sort(),
      record.values.map((v) => v.property).sort(),
      record.name,
    );
  }
  assert.deepEqual(state, {
    instances: 6,
    values_proposed: 22,
    written: 20,
    review: 0,
    weak_support: 2,
    quote_not_found: 0,
    invalid_value: 0,
    unknown_property: 0,
    duplicate: 0,
    failed: 0,
    commits: 1,
    removed: 0,
  });
  assert.equal(lbb.questions.size, 0);
  assert.equal(lbb.reviews.size, 0);
  assert.equal(turns.length, 1);
});

test("each written value has a source whose evidence is a quote of the text", async () => {
  const lbb = new MockActivities(rules(RECORDS));
  await runMessage(
    createWorkflow(lbb),
    triggerMessage(
      "values-extract",
      RECORDS.map((r) => iriOf(r.name)),
    ),
  );

  const edges = lbb.graph.edgesOf("HAS_VALUE_SOURCE");
  assert.equal(edges.length, 20);
  for (const edge of edges) {
    const record = RECORDS.find((r) => iriOf(r.name) === edge.source)!;
    const evidence = edge.evidence as { text: string };
    assert.ok(record.text.includes(evidence.text), evidence.text);
    const source = lbb.graph.entities.get(edge.target)!;
    assert.equal(source.type, "ValueSource");
    assert.ok((source.properties.support as number) >= defaults.gate);
  }
});

test("each step reports its phase as the LBB-run values.extract words it", async () => {
  const lbb = new MockActivities(rules(RECORDS));
  const { turns } = await runMessage(
    createWorkflow(lbb),
    triggerMessage(
      "values-extract",
      RECORDS.map((r) => iriOf(r.name)),
    ),
  );
  assert.deepEqual(phases(turns), ["reading values", "asking the decision model", "writing facts"]);
  assert.deepEqual(
    turns[0]!.progress
      .filter((p) => p.phase === "reading values")
      .map((p) => [p.step, p.done, p.total, p.unit]),
    RECORDS.map((_, i) => [`values-${i}`, i, RECORDS.length, "instances"]),
  );
});

test("a value below the gate goes to review, and the checks run in LBB's order", async () => {
  const record = {
    name: "S 9.1",
    text: "S 9.1 Becken aus Kunststoff. Breite etwa 70 cm, Tiefe 40 cm.",
  };
  // The checks of values.extract: the property, then the first value of
  // it, then the type, then the quote. A second material is a duplicate
  // even when the first one fails a later check.
  const proposals = [
    { property: "width_cm", value: "70", unit: "cm", quote: "Breite etwa 70 cm" },
    { property: "depth_cm", value: "vierzig", unit: "cm", quote: "Tiefe 40 cm" },
    { property: "material", value: "Kunststoff", unit: "", quote: "Becken aus Kunststoff" },
    { property: "material", value: "Holz", unit: "", quote: "aus Holz gefertigt" },
    { property: "height_cm", value: "80", unit: "", quote: "Becken aus Kunststoff" },
  ];
  const lbb = new MockActivities(rules([record], { reason: () => ({ values: proposals }) }));
  const { state, turns } = await runMessage(
    createWorkflow(lbb),
    triggerMessage("values-extract", [iriOf(record.name)]),
  );
  assert.deepEqual(
    turns[0]!.progress.find((p) => p.phase === "filing review items"),
    { step: "review", phase: "filing review items", done: 0, total: 1, unit: "items" },
  );

  assert.deepEqual(written(lbb, record.name), { material: "Kunststoff" });
  assert.equal(state.values_proposed, 5);
  assert.equal(state.written, 1);
  assert.equal(state.review, 1);
  assert.equal(state.invalid_value, 1);
  assert.equal(state.duplicate, 1);
  assert.equal(state.unknown_property, 1);
  const [item] = [...lbb.questions.values()];
  assert.equal(item!.kind, "value");
  // The key of LBB's values.extract: its instance and property.
  assert.equal(item!.key, valueItemKey("values-extract", iriOf(record.name), "width_cm"));
  assert.equal(
    item!.key,
    `starter:values-extract:value:${stableHashHex(["value_item_v2", entityIdFromIri(iriOf(record.name)), "width_cm"]).slice(0, 24)}`,
  );
  assert.equal(item!.title, "Set width_cm of S 9.1 to 70");
  assert.equal(item!.rationale, "The text supports the value with 0.60, below the gate 0.8.");
  assert.deepEqual(item!.workflow, { name: "values-extract" });
  assert.deepEqual(item!.subject, {
    iri: iriOf(record.name),
    type: "EquipmentItem",
    name: record.name,
  });
  assert.deepEqual(item!.question, {
    property: "width_cm",
    value: 70,
    unit: "cm",
    confidence: item!.question.confidence,
  });
  assert.equal(item!.evidence![0]!.quote, "Breite etwa 70 cm");
  assert.deepEqual(item!.facts!.entity_properties![0]!.properties, { width_cm: 70 });

  // Accepted, the value is written with the others the next time the instance is read.
  const accepting = new MockActivities(
    rules([record], {
      reason: () => ({ values: proposals }),
      reviewAnswer: () => ({ decision: "accept" }),
    }),
  );
  await runMessage(
    createWorkflow(accepting),
    triggerMessage("values-extract", [iriOf(record.name)]),
  );
  assert.deepEqual(written(accepting, record.name), { width_cm: 70, material: "Kunststoff" });

  // Corrected, the person's number is written as given, in the property's unit.
  const correcting = new MockActivities(
    rules([record], {
      reason: () => ({ values: proposals }),
      reviewAnswer: () => ({ decision: "correct", value: 72 }),
    }),
  );
  await runMessage(
    createWorkflow(correcting),
    triggerMessage("values-extract", [iriOf(record.name)]),
  );
  assert.deepEqual(written(correcting, record.name), { width_cm: 72, material: "Kunststoff" });
});

/** A second message to the same workflow, at a later commit (its own step effect ids). */
const later = (iri: string) => ({
  ...triggerMessage("values-extract", [iri]),
  as_of_commit_seq: 8,
});

test("a person's correction stays when new evidence reads another value, which asks again", async () => {
  const records = [
    { name: "S 9.3", text: "S 9.3 Becken aus Kunststoff. Breite etwa 70 cm, Tiefe 40 cm." },
  ];
  let proposals = [{ property: "width_cm", value: "70", unit: "cm", quote: "Breite etwa 70 cm" }];
  const lbb = new MockActivities(
    rules(records, {
      reason: () => ({ values: proposals }),
      reviewAnswer: (request) =>
        request.question.property === "width_cm" ? { decision: "correct", value: 72 } : undefined,
    }),
  );
  const workflow = createWorkflow(lbb);
  await runMessage(workflow, triggerMessage("values-extract", [iriOf("S 9.3")]));
  assert.deepEqual(written(lbb, "S 9.3"), { width_cm: 72 });

  // A new version of the text, and the model reads 80 above the gate: the
  // person is asked again, and the corrected 72 stays until they answer.
  records[0]!.text = "S 9.3 Becken aus Kunststoff. Breite 80 cm.";
  proposals = [{ property: "width_cm", value: "80", unit: "cm", quote: "Breite 80 cm" }];
  await runMessage(workflow, later(iriOf("S 9.3")));
  assert.deepEqual(written(lbb, "S 9.3"), { width_cm: 72 });
  const [item] = await lbb.reviewItems([
    valueItemKey("values-extract", iriOf("S 9.3"), "width_cm"),
  ]);
  assert.equal(item!.status, "open");
  assert.deepEqual(item!.question?.value, 80);
  assert.deepEqual(item!.previous_answer, { decision: "correct", value: 72 });
});

test("an accepted value stays when new evidence reads the same value, and asks nothing", async () => {
  const records = [{ name: "S 9.5", text: "S 9.5 Becken. Breite etwa 70 cm." }];
  let proposals = [{ property: "width_cm", value: "70", unit: "cm", quote: "Breite etwa 70 cm" }];
  const lbb = new MockActivities(
    rules(records, {
      reason: () => ({ values: proposals }),
      reviewAnswer: () => ({ decision: "accept" }),
    }),
  );
  const workflow = createWorkflow(lbb);
  await runMessage(workflow, triggerMessage("values-extract", [iriOf("S 9.5")]));
  assert.deepEqual(written(lbb, "S 9.5"), { width_cm: 70 });
  records[0]!.text = "S 9.5 Becken. Breite 70 cm.";
  proposals = [{ property: "width_cm", value: "70", unit: "cm", quote: "Breite 70 cm" }];
  await runMessage(workflow, later(iriOf("S 9.5")));
  assert.deepEqual(written(lbb, "S 9.5"), { width_cm: 70 });
  assert.equal(lbb.previous.size, 0, "nothing is asked again");
});

test("a rejected value is not written again, even above the gate", async () => {
  const records = [{ name: "S 9.6", text: "S 9.6 Becken. Breite etwa 70 cm." }];
  let proposals = [{ property: "width_cm", value: "70", unit: "cm", quote: "Breite etwa 70 cm" }];
  const lbb = new MockActivities(
    rules(records, {
      reason: () => ({ values: proposals }),
      reviewAnswer: () => ({ decision: "reject" }),
    }),
  );
  const workflow = createWorkflow(lbb);
  await runMessage(workflow, triggerMessage("values-extract", [iriOf("S 9.6")]));
  assert.deepEqual(written(lbb, "S 9.6"), {});
  records[0]!.text = "S 9.6 Becken. Breite 70 cm.";
  proposals = [{ property: "width_cm", value: "70", unit: "cm", quote: "Breite 70 cm" }];
  await runMessage(workflow, later(iriOf("S 9.6")));
  assert.deepEqual(written(lbb, "S 9.6"), {});
});

test("an answer the graph refused is not written, and the batch's other values are", async () => {
  const records = [
    { name: "S 9.7", text: "S 9.7 Becken. Breite etwa 70 cm." },
    { name: "S 9.8", text: "S 9.8 Becken. Breite 60 cm." },
  ];
  const lbb = new MockActivities(
    rules(records, {
      reason: (request) =>
        (JSON.parse(request.prompt) as { text: string }).text.includes("S 9.7")
          ? {
              values: [
                { property: "width_cm", value: "70", unit: "cm", quote: "Breite etwa 70 cm" },
              ],
            }
          : { values: [{ property: "width_cm", value: "60", unit: "cm", quote: "Breite 60 cm" }] },
      reviewAnswer: () => ({ decision: "correct", value: 72 }),
      reviewRefused: () => "the shape MaxWidth rejects 72",
    }),
  );
  await runMessage(
    createWorkflow(lbb),
    triggerMessage(
      "values-extract",
      records.map((r) => iriOf(r.name)),
    ),
  );
  assert.deepEqual(written(lbb, "S 9.7"), {});
  assert.deepEqual(written(lbb, "S 9.8"), { width_cm: 60 });
});

test("a value the graph refused is not written when a later text states it", async () => {
  const records = [{ name: "S 9.6", text: "S 9.6 Becken. Breite etwa 70 cm." }];
  let proposals = [{ property: "width_cm", value: "70", unit: "cm", quote: "Breite etwa 70 cm" }];
  const lbb = new MockActivities(
    rules(records, {
      reason: () => ({ values: proposals }),
      reviewAnswer: () => ({ decision: "correct", value: 72 }),
      reviewRefused: () => "the shape MaxWidth rejects 72",
    }),
  );
  const workflow = createWorkflow(lbb);
  await runMessage(workflow, triggerMessage("values-extract", [iriOf("S 9.6")]));
  assert.deepEqual(written(lbb, "S 9.6"), {});
  // The text now states 72 above the gate: the graph refused it, so it is
  // not written; the item stays open for the person.
  records[0]!.text = "S 9.6 Becken. Breite 72 cm.";
  proposals = [{ property: "width_cm", value: "72", unit: "cm", quote: "Breite 72 cm" }];
  await runMessage(workflow, later(iriOf("S 9.6")));
  assert.deepEqual(written(lbb, "S 9.6"), {});
});

test("the value a person decided on, quoted from another span, asks nothing", async () => {
  const records = [{ name: "S 9.2", text: "S 9.2 Becken. Breite etwa 70 cm." }];
  let proposals = [{ property: "width_cm", value: "70", unit: "cm", quote: "Breite etwa 70 cm" }];
  const lbb = new MockActivities(
    rules(records, {
      reason: () => ({ values: proposals }),
      reviewAnswer: () => ({ decision: "correct", value: 72 }),
    }),
  );
  const workflow = createWorkflow(lbb);
  await runMessage(workflow, triggerMessage("values-extract", [iriOf("S 9.2")]));
  assert.deepEqual(written(lbb, "S 9.2"), { width_cm: 72 });
  // The same text; the model quotes another span of it, and spells the unit
  // otherwise. The person decided on 70 already.
  proposals = [{ property: "width_cm", value: "70", unit: "CM", quote: "etwa 70 cm" }];
  await runMessage(workflow, later(iriOf("S 9.2")));
  assert.deepEqual(written(lbb, "S 9.2"), { width_cm: 72 });
  assert.equal(lbb.previous.size, 0, "nothing is asked again");
});

test("the evidence of a value is its quote and the unit the text states, as LBB marks it", () => {
  const [checked] = check(
    [{ property: "width_cm", value: "60", unit: "CM", quote: "Breite  60 cm" }],
    defaults.properties,
    "Waschtisch, Breite 60 cm",
    { width_cm: "cm" },
  );
  // LBB's golden: values_evidence_hash("Breite 60 cm", "cm").
  assert.equal(evidenceOf(checked!), "952222f8bb95037753aab03b96bab676");
});

test("a held value keeps its source link", async () => {
  const records = [{ name: "S 9.9", text: "S 9.9 Becken. Breite etwa 70 cm." }];
  let proposals = [{ property: "width_cm", value: "70", unit: "cm", quote: "Breite etwa 70 cm" }];
  const lbb = new MockActivities(
    rules(records, {
      reason: () => ({ values: proposals }),
      reviewAnswer: () => ({ decision: "accept" }),
    }),
  );
  const workflow = createWorkflow(lbb);
  await runMessage(workflow, triggerMessage("values-extract", [iriOf("S 9.9")]));
  const links = () =>
    lbb.graph.edgesOf("HAS_VALUE_SOURCE").filter((edge) => edge.source === iriOf("S 9.9")).length;
  assert.equal(links(), 1);
  // New evidence with another value: asked again, the accepted 70 and its
  // source link stay.
  records[0]!.text = "S 9.9 Becken. Breite 85 cm.";
  proposals = [{ property: "width_cm", value: "85", unit: "cm", quote: "Breite 85 cm" }];
  await runMessage(workflow, later(iriOf("S 9.9")));
  assert.deepEqual(written(lbb, "S 9.9"), { width_cm: 70 });
  assert.equal(links(), 1);
  assert.equal(lbb.previous.size, 1);
});

for (const [status, writes] of [
  ["accepted", { width_cm: 70 }],
  ["open", {}],
  ["dismissed", {}],
] as const) {
  test(`a value an earlier version filed as a suggestion keeps working (${status})`, async () => {
    const record = { name: "S 9.4", text: "S 9.4 Becken. Breite etwa 70 cm." };
    const proposals = [
      { property: "width_cm", value: "70", unit: "cm", quote: "Breite etwa 70 cm" },
    ];
    const lbb = new MockActivities(rules([record], { reason: () => ({ values: proposals }) }));
    // The key of the suggestion: one per value.
    const key = legacyValueKey("values-extract", iriOf(record.name), {
      property: "width_cm",
      value: "70",
      quote: "",
      outcome: "",
    });
    const facts: Schemas["SuggestedFacts"] = {
      entity_properties: [
        {
          ...entityRef(iriOf(record.name), "EquipmentItem", record.name),
          properties: { width_cm: 70 },
        },
      ],
      triplets: [],
    };
    lbb.reviews.set(key, { key, title: "Set width_cm of S 9.4 to 70", status, facts });
    await runMessage(createWorkflow(lbb), triggerMessage("values-extract", [iriOf(record.name)]));
    // An accepted one is written again, an open one stays the question (no
    // value item), and a dismissed one is a reject of its value.
    assert.equal(lbb.questions.size, 0);
    assert.equal(lbb.reviews.get(key)?.status, status);
    assert.deepEqual(written(lbb, record.name), writes);
  });
}

test("an instance that leaves the class keeps its values, as in LBB's values.extract", async () => {
  const lbb = new MockActivities(rules(RECORDS));
  const workflow = createWorkflow(lbb);
  const first = await runMessage(
    workflow,
    triggerMessage(
      "values-extract",
      RECORDS.map((r) => iriOf(r.name)),
    ),
  );
  const commits = lbb.graph.commits;
  const { state } = await runMessage(
    workflow,
    triggerMessage("values-extract", [], [iriOf("S 4.1")]),
    first.state,
  );

  // Its values go with its fields when it is retracted; the turn writes nothing.
  assert.equal(written(lbb, "S 4.1").width_cm, 60);
  assert.equal(lbb.graph.ofType("ValueSource").length, 20);
  assert.equal(lbb.graph.commits, commits);
  assert.equal(state.removed, 1);
  assert.equal(state.instances, 6);
});

test("a value that changes back is written again: each write's id is its turn's effect id", async () => {
  // The finding of workflows-dogfooding.md 1.5: an id made from what a
  // write holds repeats when the value goes A, B, A, and the commit path
  // answers the repeat as a replay. An effect id is new for each message.
  const texts = [
    "S 7.1 Waschtisch, Breite 55 cm.",
    "S 7.1 Waschtisch, Breite 60 cm.",
    "S 7.1 Waschtisch, Breite 55 cm.",
  ];
  let text = texts[0]!;
  const lbb = new MockActivities(
    rules([
      {
        name: "S 7.1",
        get text() {
          return text;
        },
      },
    ]),
  );
  const workflow = createWorkflow(lbb);
  const widths: unknown[] = [];
  const keys: string[] = [];
  let state: unknown = {};
  for (const [n, next] of texts.entries()) {
    text = next;
    const message = {
      ...triggerMessage("values-extract", [iriOf("S 7.1")]),
      as_of_commit_seq: 7 + n,
    };
    const { result, turn } = await runTurn(workflow, state, message);
    state = result.state;
    widths.push(written(lbb, "S 7.1").width_cm);
    keys.push(
      (turn.outputs[turn.keys.indexOf("write")] as { idempotency_key: string }).idempotency_key,
    );
  }
  assert.deepEqual(widths, [55, 60, 55]);
  assert.equal(new Set(keys).size, 3, keys.join(" "));
  assert.equal(lbb.graph.commits, 3);
});

test("an instance whose model call is refused goes back to the watch and keeps its values", async () => {
  const lbb = new MockActivities(rules(RECORDS));
  const workflow = createWorkflow(lbb);
  const iris = RECORDS.map((r) => iriOf(r.name));
  const first = await runMessage(workflow, triggerMessage("values-extract", iris));
  const refusing = new MockActivities({
    ...rules(RECORDS),
    refuses: (kind, request) =>
      kind === "reason" && (request as { prompt: string }).prompt.includes("S 4.2"),
  });
  // The graph of the first run, read by the second.
  for (const [iri, entity] of lbb.graph.entities) refusing.graph.entities.set(iri, entity);
  refusing.graph.edges = [...lbb.graph.edges];
  const { state, turns } = await runMessage(
    createWorkflow(refusing),
    { ...triggerMessage("values-extract", iris), as_of_commit_seq: 8 },
    first.state,
  );

  assert.equal(turns.length, 1);
  assert.deepEqual(
    refusing.requeued.map((r) => r.failed.map((f) => f.instance)),
    [[iriOf("S 4.2")]],
  );
  assert.equal(written(refusing, "S 4.2").width_cm, 50);
  assert.equal(state.failed, 1);
  assert.equal(state.instances, 12);
});

test("a value's evidence has the instance's page box as its region", async () => {
  const record = {
    name: "S 9.2",
    text: "S 9.2 Handtuchspender, Edelstahl, 30x10 cm.",
    box: { page: 3, x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.3 },
  };
  const lbb = new MockActivities(rules([record]));
  await runMessage(createWorkflow(lbb), triggerMessage("values-extract", [iriOf(record.name)]));
  const edge = lbb.graph.edgesOf("HAS_VALUE_SOURCE")[0]!;
  assert.deepEqual((edge.evidence as { region: unknown }).region, {
    page: 3,
    x0: 0.1,
    y0: 0.2,
    x1: 0.6,
    y1: 0.3,
    confidence: 0.92,
  });
});

test("a message of more instances than a turn reads continues in a new turn", async () => {
  const many = Array.from({ length: 30 }, (_, n) => ({ ...RECORDS[n % 6]!, name: `S 5.${n + 1}` }));
  const lbb = new MockActivities(rules(many));
  const { turns, state } = await runMessage(
    createWorkflow(lbb),
    triggerMessage(
      "values-extract",
      many.map((r) => iriOf(r.name)),
    ),
  );
  assert.equal(turns.length, 2);
  assert.ok(turns.every((t) => t.keys.length <= 64));
  assert.equal(state.instances, 30);
});

test("values take their property's type, and a quote is in the text", () => {
  assert.equal(typed("60", "f64"), 60);
  assert.equal(typed("0,5", "f64"), 0.5);
  assert.equal(typed("2.5", "i64"), null);
  assert.equal(typed("ja", "bool"), true);
  assert.equal(typed("2026-09-16", "date_time"), "2026-09-16T00:00:00Z");
  assert.equal(typed("16.09.2026", "date_time"), null);
  assert.equal(typed("2026-09-16T08:30:00Z", "datetime"), "2026-09-16T08:30:00Z");
  assert.equal(typed("0x10", "i64"), null);
  assert.equal(typed("1,5", "f64"), 1.5);
  assert.deepEqual(
    check(
      [
        { property: "width_cm", value: "60", quote: "60x40" },
        { property: "width_cm", value: "61", quote: "61x40" },
      ],
      defaults.properties,
      "text: Waschtisch 60x40",
    ).map((v) => v.outcome),
    ["", "duplicate"],
  );
  assert.ok(quoteHolds("ca.  60x40 cm", "60", "Waschtisch, ca. 60x40 cm, weiß"));
  assert.ok(!quoteHolds("weiß", "Keramik", "Waschtisch, weiß"));
  assert.ok(!quoteHolds("aus Holz gefertigt", "Holz", "Waschtisch aus Keramik"));
});

test("a number in another unit, or with none, goes to review and is not written", async () => {
  const record = {
    name: "S 9.2",
    text: "S 9.2 Waschtisch, Breite 600 mm, Tiefe 45, aus Keramik.",
  };
  const proposals = [
    { property: "width_cm", value: "600", unit: "mm", quote: "Breite 600 mm" },
    { property: "depth_cm", value: "45", unit: "", quote: "Waschtisch, Breite 600 mm, Tiefe 45" },
    { property: "material", value: "Keramik", unit: "", quote: "aus Keramik" },
  ];
  const lbb = new MockActivities(rules([record], { reason: () => ({ values: proposals }) }));
  const { state } = await runMessage(
    createWorkflow(lbb),
    triggerMessage("values-extract", [iriOf(record.name)]),
  );
  assert.deepEqual(written(lbb, record.name), { material: "Keramik" });
  assert.equal(state.instances, 1);
  assert.equal(state.values_proposed, 3);
  assert.equal(state.written, 1);
  assert.equal(state.review, 2);
  const rationales = [...lbb.questions.values()].map((item) => item.rationale ?? "").sort();
  assert.match(
    rationales[0]!,
    /^The unit is not confirmed: the text states mm; the property holds cm\./,
  );
  assert.match(
    rationales[1]!,
    /^The unit is not confirmed: the text states no unit; the property holds cm\./,
  );
});

test("the ontology declares the unit of each number property", () => {
  const ops = ontology();
  assert.deepEqual(
    ops.flatMap((op) => (op.op === "add_property" && op.unit ? [[op.name, op.unit]] : [])),
    [
      ["width_cm", "cm"],
      ["depth_cm", "cm"],
    ],
  );
  assert.equal(unitOf(defaults, "material"), undefined);
  assert.equal(unitOf({ ...defaults, units: { material: "cm" } }, "material"), undefined);
  assert.equal(unitProblem("cm", "cm", "ca. 60x40cm"), undefined);
  assert.equal(unitProblem("m2", "m²", "20 m²"), undefined);
  assert.equal(unitProblem("cm", "cm", "Breite 60"), "the quote does not state the unit cm");
  assert.equal(unitProblem("m", "m", "600 mm"), "the quote does not state the unit m");
  // A number with its unit in `value`, against the rules: LBB reads the two
  // apart, and so does the template.
  const [width] = check(
    [{ property: "width_cm", value: "60 cm", unit: "", quote: "Breite 60 cm" }],
    defaults.properties,
    "Waschtisch, Breite 60 cm",
    { width_cm: "cm" },
  );
  assert.equal(width!.typed, 60);
  assert.equal(width!.unconfirmed, undefined);
});
