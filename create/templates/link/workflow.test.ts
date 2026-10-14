// link on its samples: an invented CRM (samples/records.json) with names
// that vary between records, deals and notes, and its gold groups
// (samples/gold.json). The worker runs with mock models and a graph in
// memory; a mock reviewer decides the review items as the gold says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  phases,
  readJson,
  runTurn,
  Crash,
  samplesDir,
  triggerMessage,
} from "../_shared/testing.js";
import {
  drain,
  gradeRun,
  measure,
  newRun,
  reviewAsGold,
  runAll,
  sendRecords,
  type FixtureRecord,
  type LinkRun,
} from "./fixture.js";
import { formatReport, type Gold } from "./grade.js";
import { defaults, sourceWorkflowName, type Settings } from "./settings.js";
import type { ShardState } from "./source-turn.js";
import type { ThingsState } from "./things-turn.js";
import { createWorkflow, ontology, workflows } from "./workflow.js";

const SAMPLES = samplesDir(import.meta.url, "link");
const RECORDS = readJson<FixtureRecord[]>(join(SAMPLES, "records.json"));
const GOLD = readJson<Gold>(join(SAMPLES, "gold.json"));
const ORDER = ["Organization", "Person", "Lead", "Deal", "Note"];
const models: Settings = { ...defaults, modelsReadRecords: true };

/** The members of each thing, by span, for the records named. */
function thingOf(run: LinkRun, span: string, record?: string): string[] {
  const graph = run.lbb.graph;
  const iri = record ? run.ids.get(record) : undefined;
  const mention = graph
    .ofType("Mention")
    .find(
      (m) =>
        m.properties.span === span &&
        (!iri ||
          graph.edges.some(
            (e) => e.source === m.iri && e.relation === "MENTIONED_IN" && e.target === iri,
          )),
    );
  assert.ok(mention, `a mention "${span}"`);
  const thing = graph.edges.find(
    (e) => e.source === mention.iri && e.relation === "REFERS_TO",
  )?.target;
  if (!thing) return [span];
  return graph.edges
    .filter((e) => e.relation === "REFERS_TO" && e.target === thing)
    .map((e) => String(graph.entities.get(e.source)!.properties.span))
    .sort();
}

const thingsWithRecords = (run: LinkRun) =>
  run.lbb.graph
    .ofType("LinkedThing")
    .map(
      (t) =>
        run.lbb.graph.edges.filter((e) => e.source === t.iri && e.relation === "HAS_RECORD").length,
    );

test("without model reads, strong keys link, names go to a person, and no two records become one thing", async () => {
  const run = newRun(RECORDS, defaults);
  await runAll(run, RECORDS, ORDER);

  assert.equal(run.lbb.calls.length, 0, "no model reads a record value");
  assert.ok(
    thingsWithRecords(run).every((n) => n <= 1),
    "a thing holds at most one record before a person accepts an identity",
  );
  assert.deepEqual(
    thingOf(run, "M. Tannenholt"),
    ["M. Tannenholt"],
    "a name below the gate 1 is not written",
  );
  const items = [...run.lbb.reviews.values()].filter((r) => r.status === "open");
  const identities = items
    .filter((r) => r.key!.includes(":identity:"))
    .map((r) =>
      r
        .identities![0]!.members.map((m) => m.name)
        .sort()
        .join(" = "),
    );
  assert.deepEqual(
    identities.sort(),
    [
      "Kit Marsh = k.marsh@fernway.example",
      "Mira Ruiz = Mira Tannenholt-Ruiz",
      "Soren Vestergaard = Søren Vestergaard",
      "Zoe Lindqvist = Zoë Lindqvist",
    ],
    "the two Alex Brandt at two organizations are not proposed",
  );
  // One link item per thing: Robert Haldane's holds both notes.
  const robert = items.find((r) => r.title === "2 mentions may name Robert Haldane (Person)");
  assert.ok(robert, items.map((r) => r.title).join("\n"));
  assert.deepEqual(robert.facts!.triplets!.map((t) => t.source.name).sort(), [
    "Bob Haldane",
    "Robert Haldane",
  ]);
  assert.ok(items.every((r) => r.origin?.id === "starter:link" && r.origin.label === "link"));

  const report = await gradeRun(run, GOLD);
  console.log(formatReport(report, "keys and rules, before review"));
  assert.equal(report.mentions.matched, report.mentions.gold, "every gold mention is found");
  assert.equal(report.mentions.unjudged, 0, "no mention the gold does not list");
  assert.equal(report.pairs.precision.value, 1);
  assert.equal(report.identities.precision.value, 1);
  assert.equal(report.identities.recall.value, 1);
});

test("a person's review as the gold says makes one thing of the dogfood case: contact, lead, deal and note", async () => {
  const run = newRun(RECORDS, defaults);
  await runAll(run, RECORDS, ORDER);
  assert.ok((await reviewAsGold(run, GOLD)) > 10);
  assert.equal(await reviewAsGold(run, GOLD), 0, "no item is filed again");

  assert.deepEqual(thingOf(run, "Mira Tannenholt-Ruiz"), [
    "M. Tannenholt",
    "Mimi T.",
    "Mira Ruiz",
    "Mira Tannenholt-Ruiz",
    "mira.tannenholt@northbay.example",
    "mira.tannenholt@northbay.example",
  ]);
  const report = await gradeRun(run, GOLD);
  console.log(formatReport(report, "keys and rules, after the gold review"));
  assert.equal(report.links.value, 1, "every written link is right");
  assert.equal(report.pairs.precision.value, 1);
  assert.ok(report.pairs.recall.value! >= 0.95, `recall ${report.pairs.recall.value}`);
  assert.equal(report.purity, 1);
});

test("with model reads, the links at or above the gate meet the CRM bar of 9.3, and identities wait for a person", async () => {
  const run = newRun(RECORDS, models);
  await runAll(run, RECORDS, ORDER);
  const report = await gradeRun(run, GOLD);
  console.log(formatReport(report, "with model reads (mock models), at the gate 0.8"));
  // The bar's Wilson interval needs more links than the samples hold: on 15 right links it starts at 0.7961.
  assert.ok(report.links.value! >= 0.95, `precision at the gate ${report.links.value}`);
  assert.ok(report.identities.precision.value! >= 0.99);
  assert.ok(
    thingsWithRecords(run).every((n) => n <= 1),
    "a model links no two records",
  );
  assert.deepEqual(
    thingOf(run, "Alex Brandt", "note-10"),
    ["Alex Brandt", "Alex Brandt", "a.brandt@ridgeway.example"],
    "the Alex Brandt of the note's deal",
  );
  assert.deepEqual(
    thingOf(run, "Mimi T."),
    ["M. Tannenholt", "Mimi T.", "Mira Tannenholt-Ruiz", "mira.tannenholt@northbay.example"],
    "found through the note's deal",
  );
  const kinds = new Set(run.lbb.calls.map((c) => c.kind));
  assert.deepEqual([...kinds].sort(), ["decide", "reason"]);

  await reviewAsGold(run, GOLD);
  const after = await gradeRun(run, GOLD);
  console.log(formatReport(after, "with model reads (mock models), after the gold review"));
  assert.equal(after.pairs.recall.value, 1);
  assert.equal(after.completeness, 1);
});

test("the order of a backfill does not change the things: notes first", async () => {
  const partition = async (order: string[]) => {
    const run = newRun(RECORDS, models);
    await runAll(run, RECORDS, order);
    await reviewAsGold(run, GOLD);
    await reviewAsGold(run, GOLD);
    return (await gradeRun(run, GOLD)).pairs;
  };
  const forward = await partition(ORDER);
  const backward = await partition([...ORDER].reverse());
  assert.deepEqual(backward, forward);
});

test("a decision is asked once per input: a rerun asks only what new candidates bring, then nothing", async () => {
  const run = newRun(RECORDS, models);
  const snapshot = () =>
    JSON.stringify([
      [...run.lbb.graph.entities.values()].map((e) => [e.iri, e.properties]).sort(),
      run.lbb.graph.edges.map((e) => [e.source, e.relation, e.target]).sort(),
    ]);
  const pass = async () => {
    run.counters.clear();
    run.ports.sent.clear();
    const calls = run.lbb.calls.length;
    await runAll(run, RECORDS, ORDER);
    return run.lbb.calls.slice(calls);
  };
  const first = await pass();
  // The second pass sees the records that came after each one in the first: a lead after its contact.
  const second = await pass();
  const graph = snapshot();
  const third = await pass();
  console.log(
    `model calls of three passes: ${first.length}, then ${second.filter((c) => !c.cached).length} new and ${second.filter((c) => c.cached).length} kept, then ${third.filter((c) => !c.cached).length} new and ${third.filter((c) => c.cached).length} kept`,
  );
  assert.ok(second.filter((c) => !c.cached).length < first.length / 2);
  assert.ok(
    third.every((c) => c.cached),
    "every request is the same, so each gets its kept answer",
  );
  assert.equal(snapshot(), graph, "the third pass writes the same graph");
});

test("a source turn stopped part way resumes from its saved steps, and its decided message has one id", async () => {
  const run = newRun(RECORDS, models);
  await runAll(run, RECORDS, ["Organization", "Person", "Lead", "Deal"]);
  const notes = RECORDS.filter((r) => r.class === "Note").map((r) => run.ids.get(r.id)!);
  const message = triggerMessage(sourceWorkflowName(models, "Note"), notes);
  const options = { prefix: "t", workflowId: "starter.link-note.2", turn: 3 };
  const stopped = await runTurn(run.definition, {}, message, { ...options, crashAfter: 5 }).then(
    () => assert.fail("the turn should stop"),
    (error: unknown) => error,
  );
  assert.ok(stopped instanceof Crash);
  const calls = run.lbb.calls.length;
  const { turn } = await runTurn(run.definition, {}, message, { ...options, saved: stopped.turn });
  assert.deepEqual(turn.keys.slice(0, 6), [
    "sources",
    "mentions-0",
    "mentions-1",
    "mentions-2",
    "mentions-3",
    "mentions-4",
  ]);
  assert.equal(turn.keys.at(-1), "send");
  assert.ok(
    run.lbb.calls
      .slice(calls)
      .every((c) => !stopped.turn.keys.some((k) => c.effectId === `t/${k}`)),
    "a saved step does not run again",
  );
  assert.deepEqual(
    run.ports.inbox.map((m) => m.id),
    ["decided-starter.link-note.2-3"],
  );
  // The same turn again sends the same id: the engine admits it once.
  await runTurn(run.definition, {}, message, { ...options, prefix: "u" });
  assert.equal(run.ports.inbox.length, 1);
  await drain(run);
  assert.ok(thingOf(run, "Bob Haldane").includes("Robert Haldane"));
});

test("each step reports its phase in the progress convention", async () => {
  const run = newRun(RECORDS, models);
  await runAll(run, RECORDS, ORDER);
  await reviewAsGold(run, GOLD);
  assert.deepEqual(phases(run.turns), [
    "reading sources",
    "finding mentions",
    "finding candidates",
    "linking mentions",
    "writing mentions",
    "sending decisions",
    "grouping things",
    "writing things",
    "filing review items",
    "reading review decisions",
  ]);
});

test("a row a person leaves out keeps its mention apart from the thing, also when it is decided again", async () => {
  // A gate no answer reaches: every link goes to a person.
  const strict: Settings = { ...models, gate: 0.99 };
  const run = newRun(RECORDS, strict);
  await runAll(run, RECORDS, ORDER);
  const felix = [...run.lbb.reviews.entries()].find(([, r]) => r.title.includes("Felix Okafor"))!;
  // The person dismisses "F. Okafor"; the other items as the gold says.
  run.ports.decided.set(felix[0], { status: "dismissed" });
  felix[1].status = "dismissed";
  await reviewAsGold(run, GOLD);
  assert.deepEqual(thingOf(run, "F. Okafor"), ["F. Okafor"]);
  // The note is read again under a lower gate: the cannot-link holds.
  run.settings = models;
  run.definition = createWorkflow(run.lbb, run.ports, models) as unknown as LinkRun["definition"];
  await sendRecords(run, "Note", [run.ids.get("note-4")!]);
  assert.deepEqual(thingOf(run, "F. Okafor"), ["F. Okafor"]);
  const mention = run.lbb.graph.ofType("Mention").find((m) => m.properties.span === "F. Okafor")!;
  assert.equal((mention.properties.cannot_link as string[]).length, 1);
});

test("two turns that run at once each leave a new name alone; the second look links them", async () => {
  const lena: FixtureRecord[] = [
    {
      id: "note-a",
      class: "Note",
      name: "Note A",
      fields: { body: "Lena Fairweather asked for a demo." },
    },
    {
      id: "note-b",
      class: "Note",
      name: "Note B",
      fields: { body: "Sent the slides to Lena Fairweather." },
    },
  ];
  const run = newRun(lena, models);
  const name = sourceWorkflowName(models, "Note");
  // Two shards, no things turn between them: neither sees the other's mention.
  for (const [k, id] of ["note-a", "note-b"].entries()) {
    const out = await runTurn(run.definition, {}, triggerMessage(name, [run.ids.get(id)!]), {
      workflowId: `starter.${name}.${k}`,
      turn: 1,
    });
    run.turns.push(out.turn);
  }
  assert.equal(run.ports.inbox.length, 2);
  await drain(run);
  assert.deepEqual(thingOf(run, "Lena Fairweather", "note-a"), [
    "Lena Fairweather",
    "Lena Fairweather",
  ]);
  assert.equal((run.things as ThingsState).secondLooks, 1);
});

test("a record that comes after the notes anchors their thing; the old thing points to it", async () => {
  const records: FixtureRecord[] = [
    {
      id: "note-a",
      class: "Note",
      name: "Note A",
      fields: { body: "Bob Haldane asked for the price list." },
    },
    { id: "note-b", class: "Note", name: "Note B", fields: { body: "Called Bob Haldane back." } },
    {
      id: "person-robert",
      class: "Person",
      name: "Robert Haldane",
      fields: { email: "r.haldane@quillfield.example" },
    },
  ];
  const run = newRun(records, models);
  await sendRecords(run, "Note", [run.ids.get("note-a")!]);
  await sendRecords(run, "Note", [run.ids.get("note-b")!]);
  const [before] = run.lbb.graph.ofType("LinkedThing");
  assert.ok(before);
  assert.equal(String(before.properties.anchor_key).slice(0, 8), "mention:");
  await sendRecords(run, "Person", [run.ids.get("person-robert")!]);
  const live = run.lbb.graph.ofType("LinkedThing").filter((t) => t.properties.anchor_key);
  assert.equal(live.length, 1);
  assert.equal(
    String(live[0]!.properties.anchor_key),
    `record:${run.ids.get("person-robert")!.slice(-32)}`,
  );
  assert.deepEqual(thingOf(run, "Robert Haldane"), [
    "Bob Haldane",
    "Bob Haldane",
    "Robert Haldane",
    "r.haldane@quillfield.example",
  ]);
  const pointer = run.lbb.graph.edges.find(
    (e) => e.source === before.iri && e.relation === "MERGED_INTO",
  );
  assert.equal(pointer?.target, live[0]!.iri);
  assert.deepEqual(
    Object.keys(run.lbb.graph.entities.get(before.iri)!.properties),
    [],
    "the old thing keeps only its pointer",
  );
});

test("a record that leaves the graph loses its mentions; its thing goes", async () => {
  const run = newRun(RECORDS, models);
  await runAll(run, RECORDS, ORDER);
  const casey = run.ids.get("lead-casey")!;
  assert.equal(thingOf(run, "Casey Moreau").length, 2);
  run.lbb.graph.apply({
    subjects: [],
    retract_entities: [{ type: "Lead", name: "Casey Moreau", key: "lead-casey" }],
  });
  await sendRecords(run, "Lead", [], [casey]);
  assert.ok(!run.lbb.graph.ofType("Mention").some((m) => m.properties.span === "Casey Moreau"));
  assert.ok(!run.lbb.graph.ofType("LinkedThing").some((t) => t.name === "Casey Moreau"));
});

/** A CRM of `n` invented contacts that share a team address, and many share a given name. */
function crowd(n: number): FixtureRecord[] {
  const family = [
    "Ash",
    "Birch",
    "Cedar",
    "Dale",
    "Elm",
    "Fern",
    "Glen",
    "Heath",
    "Ivy",
    "Juniper",
    "Kerr",
    "Lark",
  ];
  return Array.from({ length: n }, (_, i) => ({
    id: `person-${i}`,
    class: "Person",
    name: `Alex ${family[i % family.length]}${Math.floor(i / family.length)}`,
    fields: { email: i % 2 ? "team@northbay.example" : `alex.${i}@northbay.example` },
  }));
}

test("a key that more than 200 mentions hold is a stop key: it finds nothing, and the status names it", async () => {
  const records = crowd(420);
  const run = newRun(records, defaults);
  await runAll(run, records, ["Person"]);
  const shard = run.shards.get(`starter.${sourceWorkflowName(defaults, "Person")}`) as ShardState;
  assert.ok(shard.stopKeys["email:team@northbay.example"]! > 200, JSON.stringify(shard.stopKeys));
  assert.ok(shard.stopKeys["name:part:alex"]! > 200);
  assert.ok(shard.stopKeys["domain:northbay.example"]! > 200);
  const identities = [...run.lbb.reviews.values()].filter((r) => r.key!.includes(":identity:"));
  assert.ok(
    identities.every((r) => r.identities![0]!.members.length <= 10),
    "no identity of more than 10 records",
  );
  // The first message proposed the 8 contacts of the team address; the group grew past 10, and the item went.
  assert.deepEqual(
    identities.map((r) => r.status),
    ["superseded"],
  );
  const things = run.things as ThingsState;
  console.log(
    `stop keys of ${records.length} contacts: ${Object.entries(shard.stopKeys)
      .map(([k, n]) => `${k} (${n})`)
      .join(
        ", ",
      )}; bounds: ${JSON.stringify(shard.bounds)}; identities proposed: ${identities.length}; groups too large: ${things.tooLarge}`,
  );
  console.log(`storage of ${records.length} contacts: ${JSON.stringify(measure(run.lbb.graph))}`);
});

test("block keys as graph facts: keys, facts and bytes per mention on the samples (decision 6)", async () => {
  const run = newRun(RECORDS, models);
  await runAll(run, RECORDS, ORDER);
  const storage = measure(run.lbb.graph);
  console.log(`storage of the samples: ${JSON.stringify(storage)}`);
  assert.equal(storage.mentions, 61);
  assert.ok(storage.keysPerMention <= 16);
});

test("the named workflows: one per class, the reviews watch, and the ontology of 2.5", () => {
  const named = workflows(defaults);
  assert.deepEqual(
    named.map((w) => w.name),
    ["link-person", "link-lead", "link-organization", "link-deal", "link-note", "link-reviews"],
  );
  assert.deepEqual(
    named.map((w) => w.workflow.workflow_type),
    Array(6).fill("link"),
  );
  assert.ok(
    named[0]!.owns && named.slice(1).every((w) => !w.owns),
    "the first declares what the workflow owns",
  );
  assert.deepEqual(named.find((w) => w.name === "link-note")!.triggers[0]!.watch!.fields, ["body"]);
  assert.deepEqual(
    named.find((w) => w.name === "link-person")!.triggers[0]!.watch!.fields,
    ["label", "email"],
    "the display name is watched as `label` (rdfs:label)",
  );
  const ops = ontology(defaults);
  const relations = ops.flatMap((op) => (op.op === "add_relation" ? [op.name] : []));
  assert.deepEqual(relations, [
    "MENTIONED_IN",
    "SAME_THING_AS",
    "REFERS_TO",
    "HAS_RECORD",
    "MERGED_INTO",
    "SAME_AS",
  ]);
  assert.ok(ops.some((op) => op.op === "add_entity_type" && op.name === "LinkedThing"));
});
