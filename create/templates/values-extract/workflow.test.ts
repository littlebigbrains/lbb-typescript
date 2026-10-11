// values-extract on its samples, with mock models whose rules are fixed:
// the reasoning model reads the first size (`60x40 cm`, or `Breite 60 cm`),
// the first material and the water supply of each text, and the decision
// model says a quote from a sentence about an accessory (`Zubehör`) or a
// conditional variant (`Bei Einsatz`) does not support its value. The
// expected values come from samples/expected.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ENTITY_IRI_NAMESPACE, type DecideAnswer } from "@littlebigbrain/client";
import {
  MockActivities,
  mockId,
  readJson,
  runMessage,
  samplesDir,
  triggerMessage,
  type MockRules,
} from "../_shared/testing.js";
import { createWorkflow, defaults, quoteHolds, typed } from "./workflow.js";

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
  const values: { property: string; value: string; quote: string }[] = [];
  const size = text.match(/(?:ca\. )?(\d+)x(\d+) cm/);
  const width = text.match(/Breite (\d+) cm/);
  if (size)
    values.push(
      { property: "width_cm", value: size[1]!, quote: size[0] },
      { property: "depth_cm", value: size[2]!, quote: size[0] },
    );
  else if (width) values.push({ property: "width_cm", value: width[1]!, quote: width[0] });
  const material = MATERIALS.map((m) => ({
    m,
    at: text.search(new RegExp(`(?<![\\p{L}])${m}(?![\\p{L}])`, "u")),
  }))
    .filter((found) => found.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  if (material) values.push({ property: "material", value: material.m, quote: material.m });
  const water = text.match(/Anschluss[^.]*?(Kalt- und Warmwasser|Kaltwasser)/);
  if (water)
    values.push({
      property: "water_supply",
      value: water[1] === "Kaltwasser" ? "kalt" : "kalt und warm",
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

function rules(records: { name: string; text: string }[], more: MockRules = {}): MockRules {
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
        .map((r) => ({ s: iriOf(r.name), label: r.name, text: r.text }));
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
  assert.deepEqual(state, { instances: 6, written: 20, review: 0, dropped: 2 });
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

test("a value below the gate goes to review, and the checks drop wrong types and quotes", async () => {
  const record = {
    name: "S 9.1",
    text: "S 9.1 Becken aus Kunststoff. Breite etwa 70 cm, Tiefe 40 cm.",
  };
  const proposals = [
    { property: "width_cm", value: "70", quote: "Breite etwa 70 cm" },
    { property: "depth_cm", value: "vierzig", quote: "Tiefe 40 cm" },
    { property: "material", value: "Holz", quote: "aus Holz gefertigt" },
    { property: "material", value: "Kunststoff", quote: "Becken aus Kunststoff" },
  ];
  const lbb = new MockActivities(rules([record], { reason: () => ({ values: proposals }) }));
  const { state } = await runMessage(
    createWorkflow(lbb),
    triggerMessage("values-extract", [iriOf(record.name)]),
  );

  assert.deepEqual(written(lbb, record.name), { material: "Kunststoff" });
  assert.deepEqual(state, { instances: 1, written: 1, review: 1, dropped: 0 });
  const [item] = [...lbb.reviews.values()];
  assert.equal(item!.title, "Set width_cm of S 9.1 to 70");
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

test("an instance that leaves the class loses its values and their sources", async () => {
  const lbb = new MockActivities(rules(RECORDS));
  const workflow = createWorkflow(lbb);
  await runMessage(
    workflow,
    triggerMessage(
      "values-extract",
      RECORDS.map((r) => iriOf(r.name)),
    ),
  );
  await runMessage(workflow, triggerMessage("values-extract", [], [iriOf("S 4.1")]));

  assert.deepEqual(written(lbb, "S 4.1"), {});
  assert.ok(!lbb.graph.edgesOf("HAS_VALUE_SOURCE").some((e) => e.source === iriOf("S 4.1")));
  assert.equal(lbb.graph.ofType("ValueSource").length, 20 - 4);
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
  assert.ok(quoteHolds("ca.  60x40 cm", "60", "Waschtisch, ca. 60x40 cm, weiß"));
  assert.ok(!quoteHolds("weiß", "Keramik", "Waschtisch, weiß"));
  assert.ok(!quoteHolds("aus Holz gefertigt", "Holz", "Waschtisch aus Keramik"));
});
