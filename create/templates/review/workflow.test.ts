// review on its samples: a graph in memory with the instances and the proposals of
// samples/proposals.json, the queries of the workflow answered from it, and no model (the review
// calls none). The expected statuses and facts come from samples/expected.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Schemas } from "@littlebigbrain/client";
import {
  MockActivities,
  phases,
  readJson,
  runMessage,
  samplesDir,
  triggerMessage,
  type MemoryGraph,
} from "../_shared/testing.js";
import * as review from "./decision.js";
import {
  instancesCommit,
  proposalsCommit,
  sampleOntology,
  statementOf,
  type SampleProposals,
} from "./samples.js";
import { createWorkflow, defaults, ontology, type Settings } from "./workflow.js";

const SAMPLES = samplesDir(import.meta.url, "review");
const DATA = readJson<SampleProposals>(join(SAMPLES, "proposals.json"));
interface Expected {
  statuses: Record<string, { status: string; held?: boolean }>;
  facts: { subject: string; predicate: string; object: string | number }[];
  review_items: number;
  items: { instance: string; title: string; facts: string[] }[];
}
const EXPECTED = readJson<Expected>(join(SAMPLES, "expected.json"));
/** The settings of the answer key: every statement about a new instance goes to a person. */
const SAMPLE_SETTINGS: Settings = { ...defaults, alwaysReview: [review.NEW_INSTANCE] };

/** The ontology view `GET /v1/ontology` answers for evolve operations. */
function viewOf(ops: Schemas["OntologyEvolveOp"][]): Schemas["OntologyView"] {
  const list = ops as {
    op: string;
    name: string;
    domain?: string[];
    range?: string[];
    value_type?: string;
  }[];
  return {
    graph: { tenant_id: "t", graph_id: "samples", branch_id: "main" },
    ontology_version: 2,
    entity_types: [],
    relations: [],
    entity_type_defs: list
      .filter((o) => o.op === "add_entity_type")
      .map((o) => ({
        name: o.name,
        iri: review.classIri(o.name),
        stable_id: o.name.toLowerCase(),
        super_types: [],
        properties: [],
        resolvable: true,
        since_version: 1,
      })),
    relation_defs: list
      .filter((o) => o.op === "add_relation")
      .map((o) => ({
        name: o.name,
        src_types: o.domain ?? [],
        dst_types: o.range ?? [],
        inverse_name: null,
        cardinality: "many_to_many",
        temporal_semantics: "atemporal",
        transitive: false,
        symmetric: false,
        since_version: 1,
      })),
    property_defs: list
      .filter((o) => o.op === "add_property")
      .map((o) => ({ name: o.name, value_type: o.value_type!, required: false })),
  } as unknown as Schemas["OntologyView"];
}
const VIEW = viewOf([...ontology(), ...sampleOntology]);

/** The queries of the workflow, answered from the graph in memory. */
function sparql(query: string, graph: MemoryGraph): Record<string, string>[] {
  const named = [...query.matchAll(/<(https:\/\/littlebigbrain\.com\/e\/[0-9a-f]+)>/g)].map(
    (m) => m[1]!,
  );
  const field = (name: string) => (e: { properties: Record<string, unknown> }) =>
    e.properties[name] === undefined ? undefined : String(e.properties[name]);
  if (query.startsWith("# review: proposals"))
    return named.flatMap((iri) => {
      const e = graph.entities.get(iri);
      if (!e) return [];
      const row: Record<string, string | undefined> = {
        x: iri,
        label: e.name,
        s: field("fact_subject")(e),
        p: field("fact_predicate")(e),
        o: field("fact_object")(e),
        dt: field("fact_datatype")(e),
        c: field("fact_confidence")(e),
        ev: field("fact_evidence")(e),
        by: field("proposed_by")(e),
        status: field("fact_status")(e),
      };
      return [
        Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as Record<
          string,
          string
        >,
      ];
    });
  if (query.startsWith("# review: entities"))
    return named.flatMap((iri) => {
      const e = graph.entities.get(iri);
      return e ? [{ s: iri, type: review.classIri(e.type), label: e.name }] : [];
    });
  if (query.startsWith("# review: new instances")) {
    const literals = [...query.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
    return graph
      .ofType(defaults.className)
      .filter(
        (e) =>
          literals.includes(String(e.properties.fact_subject)) &&
          literals.includes(String(e.properties.fact_predicate)),
      )
      .map((e) => ({
        s: String(e.properties.fact_subject),
        p: String(e.properties.fact_predicate),
        o: String(e.properties.fact_object),
      }));
  }
  if (query.startsWith("# review: values")) {
    const [subject, predicate] = [...query.matchAll(/<([^>]+)>/g)].map((m) => m[1]!);
    const e = graph.entities.get(subject!);
    const value = e?.properties[predicate!.slice(review.PROPERTY_NS.length)];
    return value === undefined ? [] : [{ v: String(value) }];
  }
  if (query.startsWith("# review: edge")) {
    const [subject, predicate, object] = [...query.matchAll(/<([^>]+)>/g)].map((m) => m[1]!);
    return graph.edges.some(
      (e) =>
        e.source === subject && review.relationIri(e.relation) === predicate && e.target === object,
    )
      ? [{ s: subject! }]
      : [];
  }
  throw new Error(`a query the mock does not know: ${query.slice(0, 40)}`);
}

/** A graph in memory with the sample instances and proposals, and the IRIs of both. */
function sampleGraph(data: SampleProposals = DATA) {
  const lbb = new MockActivities({ ontology: VIEW, sparql });
  lbb.graph.apply({ subjects: [], ...instancesCommit(data) });
  const iris = new Map(
    data.instances.map((i) => [
      i.id,
      lbb.graph.iriOf({ type: i.class, name: i.name, key: `sample:${i.id}` }),
    ]),
  );
  const rows = proposalsCommit(data, iris).entity_properties!;
  lbb.graph.apply({ subjects: [], entity_properties: rows });
  const proposals = new Map(data.proposals.map((p, n) => [p.id, lbb.graph.iriOf(rows[n]!)]));
  return { lbb, iris, proposals };
}

const statusOf = (graph: MemoryGraph, iri: string) =>
  graph.entities.get(iri)!.properties.fact_status;

test("the samples get the statuses and the facts of the answer key", async () => {
  const { lbb, iris, proposals } = sampleGraph();
  const { state, turns } = await runMessage(
    createWorkflow(lbb, SAMPLE_SETTINGS),
    triggerMessage("review", [...proposals.values()]),
  );

  for (const [id, want] of Object.entries(EXPECTED.statuses))
    assert.equal(statusOf(lbb.graph, proposals.get(id)!), want.status, id);
  const edges = lbb.graph
    .edgesOf("HAS_EQUIPMENT")
    .map((e) => `${e.source} ${e.target}`)
    .sort();
  const want = EXPECTED.facts
    .filter((f) => f.predicate === "HAS_EQUIPMENT")
    .map((f) => `${iris.get(f.subject)} ${iris.get(String(f.object))}`)
    .sort();
  assert.deepEqual(edges, want);
  assert.equal(lbb.graph.entities.get(iris.get("room-012")!)!.properties.area_m2, 62.4);
  assert.equal(lbb.reviews.size, EXPECTED.review_items);
  // LBB's counters: written counts a statement the graph held already too.
  assert.deepEqual(state, {
    proposals: 14,
    written: 5,
    held_already: 1,
    in_review: 5,
    refused: 4,
    new_instance: 3,
    items: 3,
  });
  assert.equal(turns.length, 1);
  assert.ok(turns[0]!.keys.length <= 64);
  // Each step reports its phase as the LBB-run review words it.
  assert.deepEqual(phases(turns), ["deciding proposals", "writing facts", "filing review items"]);
  const deciding = turns[0]!.progress.filter((p) => p.phase === "deciding proposals");
  assert.deepEqual(
    deciding.map((p) => [p.step, p.done, p.total, p.unit]),
    deciding.map((_, i) => [`decide-${i}`, i, deciding.length, "proposals"]),
  );
});

test("a written fact names its proposal as evidence, a refusal and a review say why", async () => {
  const { lbb, iris, proposals } = sampleGraph();
  await runMessage(
    createWorkflow(lbb, SAMPLE_SETTINGS),
    triggerMessage("review", [...proposals.values()]),
  );
  const edge = lbb.graph
    .edgesOf("HAS_EQUIPMENT")
    .find((e) => e.source === iris.get("room-012") && e.target === iris.get("t1"))!;
  assert.deepEqual(edge.evidence, {
    text: JSON.stringify({ sample: "p1", line: "T1 Einzeltisch, 28 Stück" }),
    source_id: proposals.get("p1"),
  });
  assert.equal(edge.confidence, 0.95);
  // The names of the instances stay as they were.
  assert.equal(lbb.graph.entities.get(iris.get("t1")!)!.name, "T 1 Einzeltisch");
  const note = (id: string) =>
    lbb.graph.entities.get(proposals.get(id)!)!.properties.review_note as string;
  assert.match(note("p6"), /vierzehn/);
  assert.match(note("p11"), /points to Equipment/);
  assert.match(note("p2"), /below the gate 0\.8/);
  assert.match(note("p7"), /rule new_instance/);
  assert.equal(note("p1"), undefined);
  const item = [...lbb.reviews.values()].find((r) => r.title.includes("Raum 0.12"))!;
  assert.equal(item.title, "Room Raum 0.12 Klassenraum: 1 fact to check");
  assert.equal(item.workflow, "review");
});

test("one item per instance: a new instance's facts in order, its type required", async () => {
  const { lbb, proposals } = sampleGraph();
  await runMessage(
    createWorkflow(lbb, SAMPLE_SETTINGS),
    triggerMessage("review", [...proposals.values()]),
  );
  const items = [...lbb.reviews.values()];
  const expected = EXPECTED.items.map((item) => item.title).sort();
  assert.deepEqual(items.map((item) => item.title).sort(), expected);
  const m7 = items.find((item) => item.title === "New Equipment M 7 Medienwagen")!;
  const samples = m7.evidence!.samples as Record<string, unknown>[];
  assert.deepEqual(
    samples.map((sample) => [sample.kind, sample.fact]),
    [
      ["type", "is a Equipment"],
      ["label", "label · M 7 Medienwagen"],
      ["link", "HAS_EQUIPMENT ← Raum 0.12 Klassenraum"],
    ],
  );
  assert.deepEqual(
    samples.map((sample) => sample.proposal),
    ["p7", "p8", "p9"].map((id) => proposals.get(id)),
  );
  assert.equal(samples[0]!.line, "M 7 Medienwagen, 1 Stück");
  // The type's status and its write are required; the link is not. The status rows come
  // first, one per fact, as in LBB's item; the statements after them.
  const required = (m7.facts as { required?: { row: number }[] }).required!.map((r) => r.row);
  assert.deepEqual(required, [samples[0]!.row, samples[0]!.rows].flat());
  assert.deepEqual(
    samples.map((sample) => sample.row),
    [0, 1, 2],
  );
  assert.equal(samples[2]!.required, undefined);
  assert.deepEqual(samples[2]!.triplets, [0]);
  assert.match(m7.key!, /^starter:review:instance:[0-9a-f]{24}:[0-9a-f]{12}$/);
  assert.deepEqual((m7.mapping as { review: { new: boolean } }).review.new, true);
});

test("accepting a review item writes its statement and the proposal's accepted", async () => {
  const { lbb, iris, proposals } = sampleGraph();
  await runMessage(
    createWorkflow(lbb, SAMPLE_SETTINGS),
    triggerMessage("review", [...proposals.values()]),
  );
  // A person accepts every item: the server commits each item's facts.
  for (const item of lbb.reviews.values())
    lbb.graph.apply({
      subjects: [],
      triplets: item.facts!.triplets ?? [],
      entity_properties: item.facts!.entity_properties ?? [],
    });
  const m7 = lbb.graph.entities.get(
    statementOf(
      DATA.proposals.find((p) => p.id === "p7")!,
      iris,
    ).subject,
  )!;
  assert.equal(m7.type, "Equipment");
  assert.equal(m7.name, "M 7 Medienwagen");
  assert.equal(m7.properties.proposed_in, proposals.get("p7"));
  assert.ok(
    lbb.graph
      .edgesOf("HAS_EQUIPMENT")
      .some((e) => e.source === iris.get("room-012") && e.target === m7.iri),
  );
  for (const id of ["p2", "p7", "p8", "p9", "p12"])
    assert.equal(statusOf(lbb.graph, proposals.get(id)!), "accepted", id);
  // The label's item names s21 again (the server renames it; the graph in memory keeps names).
  const rename = [...lbb.reviews.values()].find((r) =>
    r.title.startsWith("Equipment S 2.1 Spiegel"),
  )!;
  const renamed = rename.facts!.entity_properties!.find((row) => row.type === "Equipment")!;
  assert.deepEqual(renamed.name, "S 2.1 Spiegel, Kristallglas");
  assert.equal(renamed.key, `\u0000lbb-eid:${iris.get("s21")!.slice(-32)}`);
});

test("by default the gate decides a new instance: written at the gate, an item below it", async () => {
  assert.deepEqual(defaults.alwaysReview, []);
  const { lbb, iris, proposals } = sampleGraph();
  await runMessage(createWorkflow(lbb), triggerMessage("review", [...proposals.values()]));
  const m7 = lbb.graph.entities.get(
    statementOf(
      DATA.proposals.find((p) => p.id === "p7")!,
      iris,
    ).subject,
  )!;
  assert.equal(m7.type, "Equipment");
  assert.equal(m7.name, "M 7 Medienwagen");
  for (const id of ["p7", "p8", "p9"])
    assert.equal(statusOf(lbb.graph, proposals.get(id)!), "written", id);
  const titles = [...lbb.reviews.values()].map((item) => item.title);
  assert.ok(!titles.some((title) => title.includes("M 7")), titles.join(", "));
  assert.equal(lbb.reviews.size, EXPECTED.review_items - 1);

  // The same new instance below the gate goes to a person, in one item.
  const unsure: SampleProposals = {
    ...DATA,
    proposals: DATA.proposals.map((p) =>
      ["p7", "p8", "p9"].includes(p.id) ? { ...p, confidence: 0.5 } : p,
    ),
  };
  const below = sampleGraph(unsure);
  await runMessage(
    createWorkflow(below.lbb),
    triggerMessage("review", [...below.proposals.values()]),
  );
  for (const id of ["p7", "p8", "p9"])
    assert.equal(statusOf(below.lbb.graph, below.proposals.get(id)!), "in_review", id);
  const item = [...below.lbb.reviews.values()].find(
    (r) => r.title === "New Equipment M 7 Medienwagen",
  )!;
  assert.equal((item.evidence!.samples as unknown[]).length, 3);
  const note = below.lbb.graph.entities.get(below.proposals.get("p7")!)!.properties
    .review_note as string;
  assert.match(note, /below the gate 0\.8/);
});

test("a predicate rule sends its statements to a person whatever their confidence", async () => {
  const { lbb, proposals } = sampleGraph();
  const settings: Settings = { ...defaults, alwaysReview: [review.relationIri("HAS_EQUIPMENT")] };
  await runMessage(
    createWorkflow(lbb, settings),
    triggerMessage("review", [...proposals.values()]),
  );
  assert.equal(lbb.graph.edgesOf("HAS_EQUIPMENT").length, 1, "only the edge the graph held");
  assert.equal(statusOf(lbb.graph, proposals.get("p1")!), "in_review");
  assert.equal(statusOf(lbb.graph, proposals.get("p5")!), "written");
});

test("a proposal is decided once: a second message changes nothing", async () => {
  const { lbb, proposals } = sampleGraph();
  const workflow = createWorkflow(lbb);
  await runMessage(workflow, triggerMessage("review", [...proposals.values()]));
  const before = JSON.stringify([...lbb.graph.entities.values()]);
  const items = lbb.reviews.size;
  const { state } = await runMessage(workflow, triggerMessage("review", [...proposals.values()]), {
    proposals: 14,
  });
  assert.equal(JSON.stringify([...lbb.graph.entities.values()]), before);
  assert.equal(lbb.reviews.size, items);
  assert.equal(state.proposals, 14);
});

test("a message of more proposals than a turn decides continues in a new turn", async () => {
  const many: SampleProposals = {
    ...DATA,
    proposals: Array.from({ length: 40 }, (_, n) => ({
      id: `q${n}`,
      subject: n % 2 ? "room-012" : "room-014",
      predicate: "area_m2",
      object: `${10 + n}`,
      datatype: "http://www.w3.org/2001/XMLSchema#double",
      confidence: 0.9,
      line: `Fläche ${10 + n} m²`,
    })),
  };
  const { lbb, proposals } = sampleGraph(many);
  const { turns, state } = await runMessage(
    createWorkflow(lbb),
    triggerMessage("review", [...proposals.values()]),
  );
  assert.equal(turns.length, 2);
  assert.ok(turns.every((t) => t.keys.length <= 64));
  // The first value of each room is written; each later one would replace it, so it goes to a person.
  assert.deepEqual(state, {
    proposals: 40,
    written: 2,
    held_already: 0,
    in_review: 38,
    refused: 0,
    new_instance: 0,
    items: 4,
  });
});

test("the decision reads the statement's terms as the LBB review does", () => {
  const ontology = review.readOntology(VIEW);
  const room: review.Known = {
    iri: `https://littlebigbrain.com/e/${"a".repeat(32)}`,
    class: "Room",
    label: "R",
    exists: true,
  };
  const seen = { entities: new Map([[room.iri, room]]) };
  const rules = { gate: 0.8, alwaysReview: [] };
  const terms = review.classify(
    { subject: room.iri, predicate: review.propertyIri("area_m2"), object: "14.2" },
    ontology,
    { ...seen, current: ["15"] },
    "FactProposal",
  );
  assert.deepEqual(review.decide(terms, "", 0.99, rules), {
    status: "in_review",
    why: "The subject's area_m2 is 15 already: writing 14.2 would replace it.",
  });
  const typed = review.classify(
    { subject: room.iri, predicate: review.RDF_TYPE, object: review.classIri("Equipment") },
    ontology,
    seen,
    "FactProposal",
  );
  assert.equal(typed.kind, "refused");
  // A label is a text: an IRI as a label is refused.
  const label = review.classify(
    { subject: room.iri, predicate: review.RDFS_LABEL, object: room.iri },
    ontology,
    seen,
    "FactProposal",
  );
  assert.deepEqual(label, {
    kind: "refused",
    why: "A label is a text; the object is an IRI or empty.",
  });
  assert.equal(review.coerce("12", "i64"), 12);
  assert.equal(review.coerce("1.5", "i64"), null);
  assert.equal(review.coerce("true", "bool"), true);
  assert.equal(review.isEntity(room.iri), true);
  assert.equal(review.isEntity("https://example.org/x"), false);
});
