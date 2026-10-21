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
  stableHashHex,
  type DecideAnswer,
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
  ontology,
  quoteHolds,
  typed,
  unitOf,
  unitProblem,
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
  const [key, item] = [...lbb.reviews.entries()][0]!;
  // The key of LBB's values.extract: its instance, property and value.
  assert.equal(
    key,
    `starter:values-extract:value:${stableHashHex([entityIdFromIri(iriOf(record.name)), "width_cm", "70"]).slice(0, 24)}`,
  );
  assert.equal(item!.title, "Set width_cm of S 9.1 to 70");
  assert.equal(
    item!.rationale,
    'The text supports the value with 0.60, below the gate 0.8: "Breite etwa 70 cm"',
  );
  assert.deepEqual(item!.origin, {
    kind: "agent",
    id: "starter:values-extract",
    label: "values.extract",
  });
  assert.equal(item!.workflow, "values-extract");
  assert.deepEqual(item!.facts!.entity_properties![0]!.properties, { width_cm: 70 });

  // Accepted, the value is written with the others the next time the instance is read.
  const accepting = new MockActivities(
    rules([record], { reason: () => ({ values: proposals }), reviewStatus: () => "accepted" }),
  );
  await runMessage(
    createWorkflow(accepting),
    triggerMessage("values-extract", [iriOf(record.name)]),
  );
  assert.deepEqual(written(accepting, record.name), { width_cm: 70, material: "Kunststoff" });
});

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
  const rationales = [...lbb.reviews.values()].map((item) => item.rationale).sort();
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
