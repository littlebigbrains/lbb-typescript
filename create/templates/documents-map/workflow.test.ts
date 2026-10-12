// documents-map on its samples, with mock models whose rules are fixed: the grounding question
// picks the candidate whose label holds the entry's identifier, else a new instance; the class
// question picks Room for the room sheets, SpecSection for a section of the specification and
// Equipment for the rest; the typing question picks the relation whose range is the object's
// class. The trace and the expected proposals come from samples/trace.json and expected.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  ENTITY_IRI_NAMESPACE,
  type DecideAnswer,
  type DecideRequest,
  type FilePages,
  type Schemas,
} from "@littlebigbrain/client";
import {
  MockActivities,
  mockId,
  readJson,
  runMessage,
  runTurn,
  samplesDir,
  triggerMessage,
  Crash,
  type MemoryGraph,
  type MockRules,
} from "../_shared/testing.js";
import * as map from "./map.js";
import { sampleOntology, traceOntology, type SampleTrace } from "./samples.js";
import { createWorkflow, ontology, type Settings } from "./workflow.js";

const SAMPLES = samplesDir(import.meta.url, "documents-map");
const TRACE = readJson<SampleTrace>(join(SAMPLES, "trace.json"));
const PAGES = readJson<FilePages>(join(SAMPLES, "pages", "raumblaetter.json"));
interface Expected {
  instances: { document: string; identifier: string; class: string }[];
  facts: { subject: string; predicate: string; object: string }[];
  leave_out: { identifier: string }[];
}
const EXPECTED = readJson<Expected>(join(SAMPLES, "expected.json"));

// ---- the graph the trace is in ------------------------------------------------------------

const iri = (key: string) => ENTITY_IRI_NAMESPACE + mockId(key);
const sha = (document: string) => TRACE.documents.find((d) => d.name === document)!.sha256;
const docIri = (name: string) => iri(`doc:${name}`);
const entryIri = (document: string, identifier: string) => iri(`entry:${document}:${identifier}`);
const mentionIri = (m: SampleTrace["mentions"][number]) =>
  iri(`mention:${m.document}:${m.line_id}:${m.span}`);
const WORKFLOW = "documents-map";
const PROPOSER = `workflow/${WORKFLOW}`;

/** An instance the graph holds before the run. */
interface Instance {
  iri: string;
  class: string;
  label: string;
  identifier?: string;
}

/** The ontology view `GET /v1/ontology` answers for evolve operations. */
function viewOf(ops: Schemas["OntologyEvolveOp"][]): Schemas["OntologyView"] {
  const types: string[] = [];
  const relations: { name: string; domain: string[]; range: string[] }[] = [];
  for (const op of ops as { op: string; name: string; domain?: string[]; range?: string[] }[]) {
    if (op.op === "add_entity_type" && !types.includes(op.name)) types.push(op.name);
    if (op.op === "add_relation")
      relations.push({ name: op.name, domain: op.domain ?? [], range: op.range ?? [] });
  }
  return {
    graph: { tenant_id: "t", graph_id: "samples", branch_id: "main" },
    ontology_version: 3,
    entity_types: [],
    relations: [],
    entity_type_defs: types.map((name) => ({
      name,
      iri: map.classIri(name),
      stable_id: name.toLowerCase(),
      super_types: [],
      properties: [],
      resolvable: true,
      since_version: 1,
    })),
    relation_defs: relations.map((r) => ({
      name: r.name,
      src_types: r.domain,
      dst_types: r.range,
      inverse_name: null,
      cardinality: "many_to_many",
      temporal_semantics: "atemporal",
      transitive: false,
      symmetric: false,
      since_version: 1,
    })),
  } as unknown as Schemas["OntologyView"];
}

/** The queries of the workflow, answered from the trace, the instances and the graph in memory. */
function sparql(
  query: string,
  graph: MemoryGraph,
  trace: SampleTrace,
  instances: Instance[],
): Record<string, string>[] {
  const named = new Set(
    [...query.matchAll(/<(https:\/\/littlebigbrain\.com\/e\/[0-9a-f]+)>/g)].map((m) => m[1]!),
  );
  const box = (b: number[]) => ({ x0: `${b[0]}`, y0: `${b[1]}`, x1: `${b[2]}`, y1: `${b[3]}` });
  const linked = trace.mentions.filter((m) => m.link);
  if (query.startsWith("# documents-map: links"))
    return linked.map((m) => ({
      mention: mentionIri(m),
      relation: map.relationIri(m.link!.relation),
      entry: entryIri(m.link!.document, m.link!.identifier),
      doc: docIri(m.document),
      confidence: `${m.link!.confidence}`,
    }));
  if (query.startsWith("# documents-map: mentions"))
    return trace.mentions
      .filter((m) => named.has(docIri(m.document)))
      .map((m) => ({
        mention: mentionIri(m),
        doc: docIri(m.document),
        span: m.span,
        line: m.line_id,
        text: m.line_text,
        page: `${m.page}`,
        ...box(m.box),
      }));
  if (query.startsWith("# documents-map: entries"))
    return trace.entries
      .filter((e) => named.has(docIri(e.document)) || named.has(entryIri(e.document, e.identifier)))
      .map((e) => ({
        entry: entryIri(e.document, e.identifier),
        doc: docIri(e.document),
        identifier: e.identifier,
        context: e.context,
        line: e.line_id,
        page: `${e.page}`,
        ...box(e.box),
      }));
  if (query.startsWith("# documents-map: documents"))
    return trace.documents
      .filter((d) => named.has(docIri(d.name)))
      .map((d) => ({ doc: docIri(d.name), name: d.name, sha: d.sha256 }));
  if (query.startsWith("# documents-map: candidates")) {
    const literals = [...query.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(
      (m) => JSON.parse(`"${m[1]}"`) as string,
    );
    return instances.flatMap((i) =>
      literals.filter((v) => v === i.identifier || v === i.label).map((v) => ({ s: i.iri, v })),
    );
  }
  if (query.startsWith("# documents-map: details"))
    return instances
      .filter((i) => named.has(i.iri))
      .flatMap((i) => [
        { s: i.iri, p: map.RDF_TYPE, o: map.classIri(i.class) },
        { s: i.iri, p: map.RDFS_LABEL, o: i.label },
        ...(i.identifier ? [{ s: i.iri, p: map.propertyIri("identifier"), o: i.identifier }] : []),
      ]);
  if (query.startsWith("# documents-map: proposals"))
    return graph
      .ofType(map.FACT_PROPOSAL)
      .filter((e) => e.properties.proposed_by === PROPOSER)
      .map((e) => {
        const p = e.properties as Record<string, string | number>;
        return {
          x: e.iri,
          s: `${p.fact_subject}`,
          p: `${p.fact_predicate}`,
          o: `${p.fact_object}`,
          ...(p.fact_datatype ? { dt: `${p.fact_datatype}` } : {}),
          c: `${p.fact_confidence}`,
          ev: `${p.fact_evidence}`,
        };
      });
  throw new Error(`a query the mock does not know: ${query.slice(0, 40)}`);
}

// ---- the mock decision model -----------------------------------------------------------------

const answer = (choice: string, p: number, options: string[]): DecideAnswer => ({
  choice,
  confidence: p,
  probabilities: Object.fromEntries(
    options.map((o) => [o, o === choice ? p : (1 - p) / (options.length - 1)]),
  ),
});

/** The relation each object class takes in the samples' ontology. */
const RELATION_TO: Record<string, string> = {
  Equipment: "HAS_EQUIPMENT",
  "Spec section": "SPECIFIED_IN",
};

function decide(request: DecideRequest): Record<string, DecideAnswer> {
  const out: Record<string, DecideAnswer> = {};
  const state = request.state as Record<string, Record<string, Record<string, string>>>;
  for (const [id, q] of Object.entries(request.questions)) {
    const options = Object.keys(q.criteria);
    if (id.startsWith("g")) {
      const identifier = q.instructions.match(/entry "([^"]*)"/)![1]!;
      const named = options.find(
        (o) => /^c\d+$/.test(o) && q.criteria[o]!.split(" (")[0]!.includes(identifier),
      );
      out[id] = named ? answer(named, 0.93, options) : answer(map.NEW_INSTANCE, 0.9, options);
    } else if (id.startsWith("k")) {
      const [, identifier, document] = q.instructions.match(/entry "([^"]*)" of ([^,]+),/)!;
      const wanted = document!.startsWith("raumblaetter")
        ? "Room"
        : /^\d+\.\d+$/.test(identifier!)
          ? "SpecSection"
          : "Equipment";
      out[id] = options.includes(wanted)
        ? answer(wanted, 0.88, options)
        : answer(map.NO_CLASS, 0.8, options);
    } else {
      const object = state.instances![`o${id.slice(1)}`]!;
      const wanted = RELATION_TO[object.class!] ?? map.NO_FACT;
      out[id] = options.includes(wanted)
        ? answer(wanted, 0.95, options)
        : answer(map.MISSING_PROPERTY, 0.8, options);
    }
  }
  return out;
}

const SAMPLE_VIEW = viewOf([...traceOntology, ...ontology(), ...sampleOntology]);
const rules = (
  options: { trace?: SampleTrace; instances?: Instance[]; view?: Schemas["OntologyView"] } = {},
  more: MockRules = {},
): MockRules => ({
  pages: [PAGES],
  ontology: options.view ?? SAMPLE_VIEW,
  decide,
  sparql: (query, graph) => sparql(query, graph, options.trace ?? TRACE, options.instances ?? []),
  ...more,
});

const message = (trace: SampleTrace = TRACE) =>
  triggerMessage(WORKFLOW, trace.mentions.filter((m) => m.link).map(mentionIri));

// ---- reading the outcome -----------------------------------------------------------------------

/** The new instance of an entry of the answer key, as the workflow mints it. */
const minted = (document: string, identifier: string) => map.mintedIri(sha(document), identifier);
const byIri = new Map(
  EXPECTED.instances.map((i) => [minted(i.document, i.identifier), i.identifier]),
);

/** The proposals of the graph, as `subject predicate object` with identifiers for instances. */
function proposals(graph: MemoryGraph): { text: string; confidence: number; kind: string }[] {
  const name = (value: string) =>
    byIri.get(value) ??
    (value.startsWith(map.RELATION_NS) || value.startsWith(map.CLASS_NS)
      ? map.localName(value)
      : value === map.RDF_TYPE
        ? "a"
        : value === map.RDFS_LABEL
          ? "label"
          : value === map.propertyIri("identifier")
            ? "identifier"
            : value);
  return graph.ofType(map.FACT_PROPOSAL).map((e) => {
    const p = e.properties as Record<string, string | number>;
    return {
      text: `${name(`${p.fact_subject}`)} ${name(`${p.fact_predicate}`)} ${name(`${p.fact_object}`)}`,
      confidence: Number(p.fact_confidence),
      kind: (JSON.parse(`${p.fact_evidence}`) as { kind: string }).kind,
    };
  });
}

const factsOf = (graph: MemoryGraph) =>
  proposals(graph)
    .filter((p) => p.kind === "fact")
    .map((p) => p.text)
    .sort();
const expectedFacts = EXPECTED.facts
  .map((f) => `${f.subject} ${f.predicate.toLowerCase()} ${f.object}`)
  .sort();

// ---- the tests ---------------------------------------------------------------------------------------

test("the samples give the proposals of the answer key and none other", async () => {
  const lbb = new MockActivities(rules());
  const { state, turns } = await runMessage(createWorkflow(lbb), message());

  assert.deepEqual(factsOf(lbb.graph), expectedFacts);
  const all = proposals(lbb.graph);
  for (const i of EXPECTED.instances) {
    const types = all.filter((p) => p.text.startsWith(`${i.identifier} a `)).map((p) => p.text);
    assert.deepEqual(types, [`${i.identifier} a ${i.class.toLowerCase()}`], i.identifier);
    assert.ok(
      all.some((p) => p.text === `${i.identifier} identifier ${i.identifier}`),
      i.identifier,
    );
    assert.ok(all.some((p) => p.kind === "denotes" && p.text.endsWith(` denotes ${i.identifier}`)));
  }
  for (const out of EXPECTED.leave_out)
    assert.ok(!all.some((p) => p.text.includes(` ${out.identifier}`)), out.identifier);
  assert.equal(all.length, EXPECTED.facts.length + 4 * EXPECTED.instances.length);
  assert.deepEqual(state, {
    runs: 1,
    links: 15,
    entries: 15,
    proposals: 75,
    suggestions: 0,
    unmapped: 0,
    unmappedLinks: [],
  });
  assert.equal(lbb.reviews.size, 0);
  assert.equal(turns.length, 1);
  assert.ok(turns[0]!.keys.length <= 64);
});

test("a fact's confidence is the link's times the typing answer's, a room's DENOTES starts at its mention", async () => {
  const lbb = new MockActivities(rules());
  await runMessage(createWorkflow(lbb), message());
  const all = proposals(lbb.graph);
  // T1 is linked to T 1 with 0.9 (another spelling), typed with 0.95.
  assert.equal(all.find((p) => p.text === "0.12 has_equipment T 1")!.confidence, 0.855);
  // A new instance's type: the grounding answer's 0.9 times the class answer's 0.88.
  assert.equal(all.find((p) => p.text === "0.12 a room")!.confidence, 0.792);
  const room = lbb.graph
    .ofType(map.FACT_PROPOSAL)
    .find(
      (e) =>
        e.properties.fact_object === minted("raumblaetter.pdf", "0.12") &&
        e.properties.fact_predicate === map.relationIri(map.DENOTES),
    )!;
  const head = TRACE.mentions.find((m) => m.span === "0.12")!;
  assert.equal(room.properties.fact_subject, mentionIri(head));
  const label = lbb.graph
    .ofType(map.FACT_PROPOSAL)
    .find(
      (e) =>
        e.properties.fact_subject === minted("ausstattungsliste.pdf", "S 1.1") &&
        e.properties.fact_predicate === map.RDFS_LABEL,
    )!;
  assert.equal(
    label.properties.fact_object,
    "S 1.1 Waschtisch, Keramik, ca. 55x45 cm, mit Einhebelmischer",
  );
  assert.equal(label.properties.fact_datatype, map.XSD_STRING);
  // A page entry's description is its line without the span: the room is "0.12 Raum Klassenraum".
  const roomLabel = lbb.graph
    .ofType(map.FACT_PROPOSAL)
    .find(
      (e) =>
        e.properties.fact_subject === minted("raumblaetter.pdf", "0.12") &&
        e.properties.fact_predicate === map.RDFS_LABEL,
    )!;
  assert.equal(roomLabel.properties.fact_object, "0.12 Raum Klassenraum");
  // DENOTES is open on both sides: an entry or a page's head mention, any instance.
  assert.deepEqual(
    ontology().find((op) => op.op === "add_relation" && op.name === map.DENOTES),
    { op: "add_relation", name: "DENOTES", domain: [], range: [] },
  );
});

test("a second message asks every question from the effect cache and changes no proposal", async () => {
  const lbb = new MockActivities(rules());
  const workflow = createWorkflow(lbb);
  await runMessage(workflow, message());
  const asked = lbb.calls.length;
  const before = proposals(lbb.graph);
  const { state } = await runMessage(workflow, message(), { runs: 1 });
  const again = lbb.calls.slice(asked);
  assert.ok(again.length > 0);
  assert.ok(again.every((c) => c.cached));
  assert.deepEqual(proposals(lbb.graph), before);
  assert.equal(state.runs, 2);
});

test("a turn stopped part way runs again and pays for nothing twice", async () => {
  const lbb = new MockActivities(rules());
  const workflow = createWorkflow(lbb);
  const crashed = await runTurn(workflow, {}, message(), { crashAfter: 2 }).catch(
    (error: unknown) => error,
  );
  assert.ok(crashed instanceof Crash);
  await runTurn(workflow, {}, message(), { saved: crashed.turn });
  assert.equal(
    lbb.calls.filter((c) => !c.cached).length,
    new Set(lbb.calls.map((c) => c.effectId)).size,
  );
  assert.deepEqual(factsOf(lbb.graph), expectedFacts);
});

test("an entry the graph holds is grounded to its instance: DENOTES, and no new instance", async () => {
  const s11: Instance = {
    iri: iri("instance:S 1.1"),
    class: "Equipment",
    label: "S 1.1 Waschtisch",
    identifier: "S1.1",
  };
  const lbb = new MockActivities(rules({ instances: [s11] }));
  await runMessage(createWorkflow(lbb), message());
  const rows = lbb.graph.ofType(map.FACT_PROPOSAL).map((e) => e.properties);
  assert.ok(
    rows.some(
      (p) =>
        p.fact_subject === entryIri("ausstattungsliste.pdf", "S 1.1") &&
        p.fact_predicate === map.relationIri(map.DENOTES) &&
        p.fact_object === s11.iri,
    ),
  );
  assert.ok(!rows.some((p) => p.fact_subject === minted("ausstattungsliste.pdf", "S 1.1")));
  const facts = rows.filter(
    (p) => p.fact_object === s11.iri && p.fact_predicate === map.relationIri("HAS_EQUIPMENT"),
  );
  assert.deepEqual(
    facts.map((p) => p.fact_subject).sort(),
    [minted("raumblaetter.pdf", "0.12"), minted("raumblaetter.pdf", "0.14")].sort(),
  );
});

test("a class or a property the ontology lacks becomes one ontology suggestion per pattern", async () => {
  // No SpecSection: the sections of the specification fit no class.
  const noClass = sampleOntology.filter(
    (op) => !("name" in op) || (op.name !== "SpecSection" && op.name !== "SPECIFIED_IN"),
  );
  const first = new MockActivities(
    rules({ view: viewOf([...traceOntology, ...ontology(), ...noClass]) }),
  );
  const { state } = await runMessage(createWorkflow(first), message());
  assert.equal(state.suggestions, 1);
  const [item] = [...first.reviews.values()];
  // The title and the rationale name the entries, with what the model answered.
  assert.ok(
    item!.title.startsWith("Add a class for 2 entries of baubeschreibung.pdf: 3.1 Bodenbeläge"),
    item!.title,
  );
  assert.ok(item!.title.includes(", 3.2 Sanitärobjekte"), item!.title);
  assert.ok(
    item!.rationale!.startsWith(
      "The decision model found that no class of the ontology fits 2 entries of baubeschreibung.pdf (no class fits, up to 0.80): 3.1 Bodenbeläge",
    ),
    item!.rationale,
  );
  assert.ok(item!.rationale!.includes("The classes the model weighed got at most:"));
  assert.deepEqual(item!.change, [{ op: "add_entity_type", name: "BaubeschreibungItem" }]);
  assert.equal(item!.evidence!.records, 2);
  assert.equal(item!.workflow, WORKFLOW);
  // Each sample is where its entry is, with the answer.
  const [sample] = item!.evidence!.samples as Record<string, unknown>[];
  assert.equal(sample!.kind, "entry");
  assert.equal(sample!.document, "baubeschreibung.pdf");
  assert.equal(sample!.page, 1);
  assert.equal(sample!.answer, "no class fits");
  assert.equal(sample!.probability, 0.8);
  assert.equal((sample!.box as number[]).length, 4);
  // An entry no class fits proposes nothing: no type, label, identifier or trace. Its links
  // stay in the state as unmapped, with the reason.
  assert.ok(
    !first.graph
      .ofType(map.FACT_PROPOSAL)
      .some(
        (e) =>
          e.properties.fact_subject === minted("baubeschreibung.pdf", "3.1") ||
          e.properties.fact_object === minted("baubeschreibung.pdf", "3.1"),
      ),
  );
  const waiting = state.unmappedLinks.filter((l) => l.outcome === "unclassed");
  assert.deepEqual(waiting.map((l) => l.object).sort(), ["3.1", "3.2"]);
  assert.ok(String(waiting[0]!.reason).includes("waits for the class suggestion"));
  assert.equal(waiting[0]!.document, "raumblaetter.pdf");
  // SpecSection without SPECIFIED_IN: no property relates a room to a section.
  const noRelation = sampleOntology.filter((op) => !("name" in op) || op.name !== "SPECIFIED_IN");
  const second = new MockActivities(
    rules({ view: viewOf([...traceOntology, ...ontology(), ...noRelation]) }),
  );
  await runMessage(createWorkflow(second), message());
  const [relation] = [...second.reviews.values()];
  // Named from the words next to the span: "… siehe Baubeschreibung Kap. 3.1".
  assert.equal(relation!.title, "Add a relation from Room to SpecSection: SIEHE_KAP");
  assert.deepEqual(relation!.change, [
    { op: "add_relation", name: "SIEHE_KAP", domain: ["Room"], range: ["SpecSection"] },
  ]);
  assert.ok(
    relation!.rationale!.includes(
      'p. 1, "Bodenbelag Linoleum, siehe Baubeschreibung Kap. 3.1" (0.12 → 3.1, 0.80)',
    ),
    relation!.rationale,
  );
  assert.ok(!relation!.rationale!.includes("The ontology has"), relation!.rationale);
  const [line] = relation!.evidence!.samples as Record<string, unknown>[];
  assert.equal(line!.kind, "link");
  assert.equal(line!.answer, "a property the ontology lacks");
  assert.equal(line!.document, "raumblaetter.pdf");
  assert.ok(!factsOf(second.graph).some((f) => f.includes("3.1") || f.includes("3.2")));
});

test("a relation an existing relation fits needs 2 lines or one at 0.8, and says why it does not fit", () => {
  const ontology = map.MapOntology.fromView(SAMPLE_VIEW);
  const [room, equipment] = [map.classIri("Room"), map.classIri("Equipment")];
  const has = map.relationIri("HAS_EQUIPMENT");
  const line = "S1.1 Waschtisch, 1 Stück, darüber Spiegel S 2.1";
  const lack = (p: number, offered = true): map.Lack => ({
    kind: "property",
    subjectClass: room,
    objectClass: equipment,
    document: "raumblaetter.pdf",
    sample: { line, probability: p },
    p,
    options: { HAS_EQUIPMENT: (1 - p) * 0.8, missing_property: p, no_fact: (1 - p) * 0.2 },
    offered: offered ? { HAS_EQUIPMENT: has } : {},
    phrase: map.spanPhrase(line, "S 2.1", map.nameWords("S 2.1 Spiegel")),
    quote: `p. 1, "${line}" (0.12 → S 2.1, ${p.toFixed(2)})`,
  });
  const draft = (members: map.Lack[]) =>
    map.relationDraft(ontology, room, equipment, "raumblaetter.pdf", members);
  // One line at 0.59: nothing is filed; the line is unmapped, with the reason.
  const one = draft([lack(0.59)]);
  assert.ok("unmapped" in one);
  assert.equal(one.unmapped[0]!.outcome, "lacks");
  assert.ok(String(one.unmapped[0]!.reason).includes("HAS_EQUIPMENT fits Room → Equipment"));
  // One line at 0.85, or two lines: filed, named from the line, with the reason from the answer.
  const sure = draft([lack(0.85)]);
  assert.ok("draft" in sure);
  assert.equal(sure.draft.title, "Add a relation from Room to Equipment: STUECK_DARUEBER");
  assert.ok(
    sure.draft.rationale.includes(
      "The ontology has HAS_EQUIPMENT (has equipment), which fits Room → Equipment. On these lines the model gave it 0.12 at most",
    ),
    sure.draft.rationale,
  );
  assert.ok("draft" in draft([lack(0.6), lack(0.6)]));
  // A line whose question did not offer HAS_EQUIPMENT does not back it.
  const unweighed = draft([lack(0.6), lack(0.95, false)]);
  assert.ok("unmapped" in unweighed);
  assert.ok(String(unweighed.unmapped[1]!.reason).includes("did not offer HAS_EQUIPMENT"));
});

test("a class suggestion names the entries of its document written alike that got a class", () => {
  const ontology = map.MapOntology.fromView(SAMPLE_VIEW);
  const entry = (id: string, description: string, p: number): map.Lack => ({
    kind: "class",
    document: "baubeschreibung.pdf",
    sample: { identifier: id },
    p,
    options: { Equipment: 0.2, Room: 0.01, no_class: p },
    quote: `${id} ${description} (p. 1, ${p.toFixed(2)})`,
    entry: { name: map.newInstanceLabel(id, description), shape: map.codeShape(id) },
  });
  const classed = (document: string, id: string, description: string, p: number) => ({
    document,
    shape: map.codeShape(id),
    name: map.newInstanceLabel(id, description),
    classLabel: "Equipment",
    p,
  });
  const draft = map.classDraft(
    ontology,
    "baubeschreibung.pdf",
    [entry("3.1", "Bodenbeläge", 0.69)],
    [
      classed("baubeschreibung.pdf", "3.2", "Sanitärobjekte", 0.89),
      classed("baubeschreibung.pdf", "3.3", "Beleuchtung", 0.92),
      classed("baubeschreibung.pdf", "S 1.1", "Waschtisch", 0.95),
      classed("raumblaetter.pdf", "3.4", "Türen", 0.9),
    ],
  );
  assert.equal(draft.title, "Add a class for 3.1 Bodenbeläge");
  assert.ok(
    draft.rationale.includes(
      "got a class of the ontology: 3.2 Sanitärobjekte (Equipment, 0.89), 3.3 Beleuchtung (Equipment, 0.92). When they belong to the new class too, dismiss their types in the review.",
    ),
    draft.rationale,
  );
  assert.ok(
    draft.rationale.includes(
      "The classes the model weighed got at most: Equipment 0.20, Room 0.01.",
    ),
  );
  assert.ok(!draft.rationale.includes("Waschtisch") && !draft.rationale.includes("Türen"));
});

test("a withdrawn link withdraws the proposals that only it made", async () => {
  const lbb = new MockActivities(rules());
  const workflow = createWorkflow(lbb);
  await runMessage(workflow, message());
  // The room sheet no longer names W 1.
  const without: SampleTrace = {
    ...TRACE,
    mentions: TRACE.mentions.map((m) => (m.span === "W 1" ? { ...m, link: null } : m)),
  };
  lbb.rules.sparql = (query, graph) => sparql(query, graph, without, []);
  await runMessage(workflow, message(without), { runs: 1 });
  const all = proposals(lbb.graph).map((p) => p.text);
  assert.ok(!all.includes("0.12 has_equipment W 1"));
  assert.ok(!all.some((t) => t.startsWith("W 1 ")));
  assert.equal(all.length, 75 - 5);
  assert.deepEqual(
    factsOf(lbb.graph),
    expectedFacts.filter((f) => f !== "0.12 has_equipment W 1"),
  );
});

test("a refused request is asked in halves", async () => {
  const lbb = new MockActivities(
    rules(
      {},
      {
        refuses: (kind, request) =>
          kind === "decide" && Object.keys((request as DecideRequest).questions).length > 4,
      },
    ),
  );
  await runMessage(createWorkflow(lbb), message());
  assert.ok(lbb.calls.some((c) => c.refused));
  assert.deepEqual(factsOf(lbb.graph), expectedFacts);
});

test("a declared mapping types its links without a question", async () => {
  const settings: Settings = {
    mappings: [
      {
        from: { entry_class: "Room" },
        to: { entry_class: "Equipment" },
        property: "HAS_EQUIPMENT",
      },
    ],
  };
  const lbb = new MockActivities(rules());
  await runMessage(createWorkflow(lbb, settings), message());
  assert.deepEqual(factsOf(lbb.graph), expectedFacts);
  // The fact keeps the link's confidence: T1 to T 1 at 0.9.
  assert.equal(
    proposals(lbb.graph).find((p) => p.text === "0.12 has_equipment T 1")!.confidence,
    0.9,
  );
  const typing = lbb.calls.filter((c) => c.label?.endsWith("links"));
  assert.equal(typing.length, 2, "one request per page, for the two sections");
});

test("the subject of a mention: the anchor above it, or the page's head", () => {
  const own = (page: number, y: number, x: number, identifier: string): map.OwnEntry => ({
    entry: identifier,
    identifier,
    page,
    box: [x, y, x + 0.1, y + 0.01],
  });
  const mention = (
    page: number,
    y: number,
    x: number,
    span: string,
    target: string | null = null,
  ) => ({
    span,
    target,
    page,
    box: [x, y, x + 0.05, y + 0.01],
  });
  // A room sheet's number top right with a code the sheet defines lower down; a bill whose
  // positions run down the page, the last one onto the next page; a page with neither.
  const bill = map.subjects(
    [
      own(0, 0.1, 0.7, "Pos.-Nr. 1.1"),
      own(0, 0.5, 0.1, "IK 2.3"),
      own(1, 0.4, 0.1, "01.110"),
      own(1, 0.6, 0.1, "01.120"),
      own(2, 0.5, 0.1, "01.130"),
    ],
    [
      mention(0, 0.1, 0.2, "Lernatelier"),
      mention(0, 0.6, 0.3, "IK2.4"),
      mention(1, 0.45, 0.3, "S 38"),
      mention(1, 0.65, 0.3, "S 39"),
      mention(2, 0.2, 0.3, "S 40"),
      mention(3, 0.2, 0.3, "S 41"),
    ],
  );
  assert.deepEqual(bill, [
    { entry: "Pos.-Nr. 1.1" },
    { entry: "Pos.-Nr. 1.1" },
    { entry: "01.110" },
    { entry: "01.120" },
    { entry: "01.120" },
    null,
  ]);
  // Room sheets: the number in the head, linked to nothing on the first sheet and to a room
  // list's entry on the second, the codes below it (one of them an entry the sheet defines). A
  // third page continues the second. A page whose first mention is below an entry has no head.
  const sheets = map.subjects(
    [own(0, 0.35, 0.1, "M 7"), own(3, 0.1, 0.1, "S 1.1")],
    [
      mention(0, 0.08, 0.1, "0.12"),
      mention(0, 0.24, 0.1, "T1", "T 1"),
      mention(0, 0.26, 0.1, "S1.1"),
      mention(0, 0.35, 0.1, "M 7"),
      mention(1, 0.08, 0.1, "0.14", "0.14"),
      mention(1, 0.25, 0.1, "S 1.2"),
      mention(1, 0.27, 0.1, "L 3"),
      mention(2, 0.1, 0.1, "S 2.1"),
      mention(3, 0.12, 0.3, "S 2.1"),
      mention(3, 0.14, 0.1, "S 2.2"),
    ],
  );
  const room = { entry: "0.14" };
  assert.deepEqual(sheets, [
    null,
    { mention: 0 },
    { mention: 0 },
    { mention: 0 },
    null,
    room,
    room,
    room,
    { entry: "S 1.1" },
    { entry: "S 1.1" },
  ]);
});

test("names, keys and shapes", () => {
  assert.equal(map.humanize("HAS_EQUIPMENT"), "has equipment");
  assert.equal(map.humanize("hasEquipment"), "has equipment");
  assert.equal(map.classLabel("SpecSection"), "Spec section");
  assert.equal(map.identifierKey("S.2.2"), map.identifierKey("S 2.2"));
  assert.equal(map.codeShape("S 1.1"), "a9.9");
  assert.equal(map.codeShape("0.12"), "9.9");
  assert.equal(map.codeShape("440 DPM 008"), "9a9");
  assert.deepEqual(map.identifierVariants("S 38"), ["S 38", "S38"]);
  assert.deepEqual(map.identifierVariants("S38"), ["S38", "S 38"]);
  assert.equal(map.newInstanceLabel("F1", "Linoleum"), "F1 Linoleum");
  assert.equal(map.newInstanceLabel("F1", ""), "F1");
  assert.equal(map.pageEntryDescription("0.12", "Raum 0.12 Klassenraum"), "Raum Klassenraum");
  assert.equal(map.pageEntryDescription("0.12", "0.12"), "0.12");
  assert.equal(map.lackingRelationName("EquipmentType", new Set()), "HAS_EQUIPMENT_TYPE");
  // A taken name gets a number, whatever its case and separators.
  assert.equal(
    map.lackingRelationName("Equipment", new Set([map.nameKey("hasEquipment")])),
    "HAS_EQUIPMENT_2",
  );
  assert.equal(map.lackingClassName("B18_Equipment-schedule_main-site.pdf"), "EquipmentItem");
  assert.equal(
    map.lackingClassName("B18_Equipment.pdf", new Set([map.nameKey("Equipment item")])),
    "EquipmentItem2",
  );
  // A lacking relation is named from the words next to its span.
  const skip = map.nameWords("3.2 Sanitärobjekte baubeschreibung.pdf");
  const kap = map.spanPhrase("Sanitärobjekte siehe Baubeschreibung Kap. 3.2", "3.2", skip);
  assert.deepEqual(kap, ["siehe", "Kap"]);
  assert.deepEqual(map.spanPhrase("3.2 gilt für alle Räume", "3.2", new Set()), ["gilt", "für"]);
  assert.deepEqual(map.spanPhrase("S 2.1", "S 2.1", new Set()), []);
  assert.equal(map.relationNameFromLines([kap, kap, ["darüber"]], new Set()), "SIEHE_KAP");
  assert.equal(map.relationNameFromLines([["darüber"]], new Set()), "DARUEBER");
  assert.equal(map.relationNameFromLines([[]], new Set()), undefined);
});
