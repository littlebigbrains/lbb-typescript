// Test support of the link template: the invented CRM on a graph in memory,
// an answer to each `# link:` query from that graph, mock ports and mock
// models, a driver that runs the source and things turns in order, a
// reviewer that decides the review items as a gold file says, and the
// storage measurement of decision 6 (keys, facts and bytes per mention).
import {
  LbbError,
  type DecideAnswer,
  type DecideRequest,
  type Schemas,
  type WorkflowDefinition,
  type WorkflowTriggerMessage,
} from "@littlebigbrain/client";
import {
  MockActivities,
  runMessage,
  triggerMessage,
  type MemoryGraph,
  type MockRules,
  type Turn,
} from "../_shared/testing.js";
import {
  CLASS_IRI,
  LINK_RELATIONS,
  PROPERTY_IRI,
  RDFS_LABEL,
  RELATION_IRI,
  iriSegment,
} from "./candidates.js";
import { grade, readGraphRun, reviewOfItems, type Gold, type Report, type Run } from "./grade.js";
import { iriOfRef, itemKind } from "./items.js";
import { nameSimilarity, normalName } from "./names.js";
import {
  reviewsWorkflowName,
  sourceWorkflowName,
  thingsId,
  type DecidedMessage,
  type LinkPorts,
  type Settings,
} from "./settings.js";
import { nameShaped, textSpans } from "./sources/records.js";
import { createWorkflow, type LinkState } from "./workflow.js";

/** One record of the fixture: its class, display name, field values and relations by record id. */
export interface FixtureRecord {
  id: string;
  class: string;
  name: string;
  fields?: Record<string, string>;
  relations?: Record<string, string[]>;
}

/** Put the records on the graph; returns each record id's IRI. */
export function loadFixture(graph: MemoryGraph, records: FixtureRecord[]): Map<string, string> {
  const ref = (r: FixtureRecord) => ({ type: r.class, name: r.name, key: r.id });
  const byId = new Map(records.map((r) => [r.id, r]));
  graph.apply({
    subjects: [],
    entity_properties: records.map((r) => ({ ...ref(r), properties: { ...(r.fields ?? {}) } })),
    triplets: records.flatMap((r) =>
      Object.entries(r.relations ?? {}).flatMap(([relation, targets]) =>
        targets.map((t) => ({ source: ref(r), relation, target: ref(byId.get(t)!) })),
      ),
    ),
  });
  return new Map(records.map((r) => [r.id, graph.iriOf(ref(r))]));
}

// ---- the queries, answered from the graph ---------------------------------------

const relationIri = (relation: string) => RELATION_IRI + iriSegment(relation);
const propertyIri = (field: string) => PROPERTY_IRI + iriSegment(field);
const classIri = (type: string) => CLASS_IRI + iriSegment(type);

/** The values of `VALUES ?<name> { … }`: IRIs and string literals. */
function valuesOf(query: string, name: string): string[] {
  const block = query.match(new RegExp(`VALUES \\?${name} \\{([^}]*)\\}`))?.[1] ?? "";
  return [...block.matchAll(/<([^>]+)>|("(?:[^"\\]|\\.)*")/g)].map(
    (m) => m[1] ?? (JSON.parse(m[2]!) as string),
  );
}

/** The predicates a FILTER(?p IN (…)) names. */
const predicatesOf = (query: string) =>
  [...(query.match(/IN \(([^)]*)\)/)?.[1] ?? "").matchAll(/<([^>]+)>/g)].map((m) => m[1]!);

const list = (value: unknown): string[] =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value.map(String)
      : [String(value)];

/** Answer one query of the link workflow from the graph in memory. */
export function memorySparql(query: string, graph: MemoryGraph): Record<string, string>[] {
  const head = query.split("\n", 1)[0]!;
  const edgesFrom = (iri: string, relation: string) =>
    graph.edges.filter((e) => e.source === iri && e.relation === relation);
  const mentionOf = (m: string) => edgesFrom(m, "MENTIONED_IN")[0]?.target;
  const thingOf = (m: string) => edgesFrom(m, "REFERS_TO")[0]?.target;
  const mentions = () => graph.ofType("Mention");
  const linkRelation = (relation: string) => LINK_RELATIONS.includes(relation.toLowerCase());
  switch (head) {
    case "# link: sources": {
      const wanted = predicatesOf(query);
      return valuesOf(query, "s").flatMap((s) => {
        const e = graph.entities.get(s);
        if (!e) return [];
        const rows: Record<string, string>[] = [];
        // A record's display name is rdfs:label, as the published RDF holds it.
        if (wanted.includes(RDFS_LABEL)) rows.push({ s, p: RDFS_LABEL, v: e.name });
        for (const [field, value] of Object.entries(e.properties))
          if (wanted.includes(propertyIri(field)))
            for (const v of list(value)) rows.push({ s, p: propertyIri(field), v });
        return rows;
      });
    }
    case "# link: source mentions":
      return valuesOf(query, "s").flatMap((s) =>
        mentions()
          .filter((m) => mentionOf(m.iri) === s)
          .flatMap((m) => {
            const cannot = list(m.properties.cannot_link);
            const base = { s, m: m.iri, ...(thingOf(m.iri) ? { thing: thingOf(m.iri)! } : {}) };
            return cannot.length ? cannot.map((c) => ({ ...base, c })) : [base];
          }),
      );
    case "# link: key counts":
      return valuesOf(query, "key").flatMap((key) => {
        const n = mentions().filter((m) => list(m.properties.block_key).includes(key)).length;
        return n ? [{ key, n: String(n) }] : [];
      });
    case "# link: keys":
      return valuesOf(query, "key").flatMap((key) =>
        mentions()
          .filter((m) => list(m.properties.block_key).includes(key) && mentionOf(m.iri))
          .map((m) => {
            const thing = thingOf(m.iri);
            const p = m.properties as Record<string, unknown>;
            return {
              key,
              m: m.iri,
              role: String(p.role),
              span: String(p.span),
              src: mentionOf(m.iri)!,
              ...(p.kind ? { kind: String(p.kind) } : {}),
              ...(p.window ? { window: String(p.window) } : {}),
              ...(thing ? { thing, label: graph.entities.get(thing)?.name ?? "" } : {}),
            };
          }),
      );
    case "# link: hop":
      return valuesOf(query, "a").flatMap((a) =>
        [
          ...graph.edges
            .filter((e) => e.source === a && !linkRelation(e.relation))
            .map((e) => ({ e, other: e.target, dir: "out" })),
          ...graph.edges
            .filter((e) => e.target === a && !linkRelation(e.relation))
            .map((e) => ({ e, other: e.source, dir: "in" })),
        ].flatMap(({ e, other, dir }) => {
          const o = graph.entities.get(other);
          return o
            ? [
                {
                  a,
                  r: relationIri(e.relation),
                  b: other,
                  dir,
                  name: o.name,
                  class: classIri(o.type),
                },
              ]
            : [];
        }),
      );
    case "# link: neighbour mentions":
      return valuesOf(query, "n").flatMap((n) =>
        mentions()
          .filter((m) => mentionOf(m.iri) === n)
          .map((m) => {
            const thing = thingOf(m.iri);
            return {
              n,
              m: m.iri,
              role: String(m.properties.role),
              span: String(m.properties.span),
              ...(thing ? { thing, label: graph.entities.get(thing)?.name ?? "" } : {}),
            };
          }),
      );
    case "# link: mention facts":
      return valuesOf(query, "m").flatMap((m) => {
        const e = graph.entities.get(m);
        if (!e || e.type !== "Mention") return [];
        const rows: Record<string, string>[] = [];
        for (const field of [
          "role",
          "span",
          "kind",
          "field",
          "window",
          "block_key",
          "linked_to",
          "must_link",
          "cannot_link",
        ])
          for (const v of list(e.properties[field])) rows.push({ m, p: propertyIri(field), v });
        for (const relation of ["MENTIONED_IN", "REFERS_TO"])
          for (const edge of edgesFrom(m, relation))
            rows.push({ m, p: relationIri(relation), v: edge.target });
        for (const edge of edgesFrom(m, "SAME_THING_AS"))
          rows.push({
            m,
            p: relationIri("SAME_THING_AS"),
            v: edge.target,
            ...(edge.confidence !== null && edge.confidence !== undefined
              ? { c: String(edge.confidence) }
              : {}),
          });
        return rows;
      });
    case "# link: thing members":
      return valuesOf(query, "t").flatMap((t) =>
        graph.edges
          .filter((e) => e.relation === "REFERS_TO" && e.target === t)
          .map((e) => ({ t, x: e.source })),
      );
    case "# link: records":
      return valuesOf(query, "s").flatMap((s) => {
        const e = graph.entities.get(s);
        return e ? [{ s, name: e.name, class: classIri(e.type) }] : [];
      });
    case "# link: thing facts":
      return valuesOf(query, "t").flatMap((t) => {
        const e = graph.entities.get(t);
        if (!e) return [];
        return [
          ...(e.properties.anchor_key
            ? [{ t, p: propertyIri("anchor_key"), v: String(e.properties.anchor_key) }]
            : []),
          { t, p: RDFS_LABEL, v: e.name },
          ...edgesFrom(t, "MERGED_INTO").map((edge) => ({
            t,
            p: relationIri("MERGED_INTO"),
            v: edge.target,
          })),
        ];
      });
    case "# link: same as":
      return valuesOf(query, "a").flatMap((a) =>
        graph.edges
          .filter((e) => e.relation === "SAME_AS" && (e.source === a || e.target === a))
          .map((e) => ({ a, b: e.source === a ? e.target : e.source })),
      );
    case "# link: orphan mentions":
      return mentions()
        .filter((m) => !mentionOf(m.iri))
        .map((m) => ({ m: m.iri, ...(thingOf(m.iri) ? { thing: thingOf(m.iri)! } : {}) }));
    case "# link: grade":
      return mentions().flatMap((m) => {
        const p = m.properties as Record<string, unknown>;
        const thing = thingOf(m.iri);
        const base = {
          m: m.iri,
          src: mentionOf(m.iri) ?? "",
          field: String(p.field),
          span: String(p.span),
          role: String(p.role),
          ...(thing ? { thing } : {}),
        };
        const same = edgesFrom(m.iri, "SAME_THING_AS");
        return same.length
          ? same.map((e) => ({
              ...base,
              same: e.target,
              ...(e.confidence != null ? { c: String(e.confidence) } : {}),
            }))
          : [base];
      });
  }
  throw new Error(`a query the mock does not know: ${head}`);
}

// ---- the mock models ---------------------------------------------------------------

const answer = (choice: string, p: number, options: string[]): DecideAnswer => ({
  choice,
  confidence: p,
  probabilities: Object.fromEntries(
    options.map((o) => [
      o,
      o === choice ? p : Math.round(((1 - p) / Math.max(1, options.length - 1)) * 1000) / 1000,
    ]),
  ),
});
const quoted = (text: string) => [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);

/**
 * The decision model, by fixed rules. A kind question: a span written like
 * a name is a person. A names question: the candidate named most alike,
 * with the one near the source first; at least 0.95 alike links at 0.96, at
 * least 0.75 alike and near the source at 0.9, at least 0.8 alike at 0.85;
 * else a new thing. A same-record question: the same when the two names
 * are equal and the records share a related name; for a span, when the
 * names are alike.
 */
export function mockDecide(request: DecideRequest): Record<string, DecideAnswer> {
  const out: Record<string, DecideAnswer> = {};
  for (const [id, q] of Object.entries(request.questions)) {
    const options = Object.keys(q.criteria);
    if (id.endsWith("-kind")) {
      const span = q.instructions.match(/span "([^"]*)"/)?.[1] ?? "";
      out[id] = nameShaped(span) ? answer("person", 0.92, options) : answer("other", 0.7, options);
      continue;
    }
    if (id.endsWith("-names")) {
      const span = q.instructions.match(/span "([^"]*)"/)?.[1] ?? "";
      let best = { option: "new_thing", score: 0, near: false };
      for (const option of options.filter((o) => /^c\d+$/.test(o))) {
        const text = q.criteria[option]!;
        const names = [
          text.split("; ")[0]!,
          ...(text.match(/names: ([^;]*)/)?.[1]?.split(", ") ?? []),
        ];
        const score = Math.max(...names.map((n) => nameSimilarity(span, n)));
        const near = text.includes("→");
        if (score + (near ? 0.05 : 0) > best.score + (best.near ? 0.05 : 0))
          best = { option, score, near };
      }
      const p =
        best.score >= 0.95
          ? 0.96
          : best.score >= 0.75 && best.near
            ? 0.9
            : best.score >= 0.8
              ? 0.85
              : 0;
      out[id] = p ? answer(best.option, p, options) : answer("new_thing", 0.7, options);
      continue;
    }
    if (id.endsWith("-same")) {
      const [a, b] = q.instructions.split(" Record B: ");
      const [nameA, nameB] = [quoted(a ?? "")[0] ?? "", quoted(b ?? "")[0] ?? ""];
      const related = (text: string) =>
        new Set(text.match(/\(related: ([^)]*)\)/)?.[1]?.split(", ") ?? []);
      if ((a ?? "").includes("the span")) {
        // Alike names are the same; a sentence that names a related record of it makes it surer.
        const sentence = normalName(quoted(a ?? "")[1] ?? "");
        const named = [...related(b ?? "")].some((n) =>
          n.split(" ").some((w) => w.length > 3 && sentence.split(" ").includes(w)),
        );
        out[id] =
          nameSimilarity(nameA, nameB) >= 0.75
            ? answer("same", named ? 0.95 : 0.9, options)
            : answer("different", 0.8, options);
        continue;
      }
      const [x, y] = [related(a ?? ""), related(b ?? "")];
      const shared = [...x].some((n) => y.has(n));
      out[id] =
        normalName(nameA) === normalName(nameB) && shared
          ? answer("same", 0.95, options)
          : answer("different", 0.8, options);
    }
  }
  return out;
}

/** The reasoning model, by a fixed rule: every span of the text written like a name. */
export function mockReason(request: { prompt: string }): unknown {
  const text = request.prompt.slice(request.prompt.lastIndexOf("\n\n") + 2);
  return {
    spans: textSpans(text)
      .filter((s) => nameShaped(s.span))
      .map((s) => ({ span: s.span, kind: s.span.includes("@") ? "code" : "person" })),
  };
}

// ---- the ports ---------------------------------------------------------------------

/** The decision a person made on an item: its status and what the accept kept. */
interface Decided {
  status: "accepted" | "dismissed" | "superseded";
  facts?: Schemas["SuggestedFacts"];
  identities?: Schemas["SuggestedIdentity"][];
}

/** The ports in memory: an inbox of the sent messages (each id once), and the items of the mock activities. */
export class MockPorts implements LinkPorts {
  readonly inbox: { id: string; message: DecidedMessage }[] = [];
  readonly sent = new Set<string>();
  readonly decided = new Map<string, Decided>();
  constructor(readonly lbb: MockActivities) {}

  async send(_workflowId: string, message: DecidedMessage, options: { id: string }) {
    if (this.sent.has(options.id)) return;
    this.sent.add(options.id);
    this.inbox.push({
      id: options.id,
      message: JSON.parse(JSON.stringify(message)) as DecidedMessage,
    });
  }

  async suggestion(id: string): Promise<Schemas["OntologyChangeSuggestion"]> {
    const filed = this.lbb.reviews.get(id);
    if (!filed) throw new LbbError(404, "{}", { code: "not_found", message: id });
    const decided = this.decided.get(id);
    const status = decided?.status ?? (filed.status as Decided["status"] | "open");
    return {
      suggestion_id: id,
      key: filed.key ?? id,
      status,
      facts: decided?.facts ?? filed.facts ?? null,
      proposed_facts: decided?.facts ? (filed.facts ?? null) : null,
      identities: decided?.identities ?? filed.identities ?? [],
      proposed_identities: decided?.identities ? (filed.identities ?? null) : null,
      mapping: filed.mapping ?? null,
    } as unknown as Schemas["OntologyChangeSuggestion"];
  }

  async supersede(id: string) {
    const filed = this.lbb.reviews.get(id);
    if (filed && filed.status === "open") filed.status = "superseded";
  }
}

// ---- the driver ------------------------------------------------------------------

/** A run of the workflow on the fixture. */
export interface LinkRun {
  lbb: MockActivities;
  ports: MockPorts;
  settings: Settings;
  ids: Map<string, string>;
  turns: Turn[];
  shards: Map<string, unknown>;
  things: unknown;
  counters: Map<string, number>;
  definition: WorkflowDefinition<LinkState, WorkflowTriggerMessage>;
}

/** The mock rules of a run: the graph's queries, the mock models. */
export const linkRules = (more: MockRules = {}): MockRules => ({
  sparql: (query, graph) => memorySparql(query, graph),
  decide: mockDecide,
  reason: (request) => mockReason(request),
  ...more,
});

/** A new run: the fixture on a graph in memory, nothing sent yet. */
export function newRun(
  records: FixtureRecord[],
  settings: Settings,
  more: MockRules = {},
): LinkRun {
  const lbb = new MockActivities(linkRules(more));
  const ports = new MockPorts(lbb);
  return {
    lbb,
    ports,
    settings,
    ids: loadFixture(lbb.graph, records),
    turns: [],
    shards: new Map(),
    things: {},
    counters: new Map(),
    definition: createWorkflow(lbb, ports, settings) as unknown as WorkflowDefinition<
      LinkState,
      WorkflowTriggerMessage
    >,
  };
}

async function runAs(run: LinkRun, id: string, message: WorkflowTriggerMessage, state: unknown) {
  const turn = (run.counters.get(id) ?? 0) + 1;
  const out = await runMessage(run.definition, message, state, { workflowId: id, turn });
  run.counters.set(id, turn + out.turns.length - 1);
  run.turns.push(...out.turns);
  return out.state;
}

/** Run the things turns of every message in the inbox. */
export async function drain(run: LinkRun) {
  while (run.ports.inbox.length) {
    const { message } = run.ports.inbox.shift()!;
    run.things = await runAs(
      run,
      thingsId(run.settings),
      message as unknown as WorkflowTriggerMessage,
      run.things,
    );
  }
}

/** Send records of a class to their named workflow's shard, then run the things turns. */
export async function sendRecords(
  run: LinkRun,
  cls: string,
  iris: string[],
  removed: string[] = [],
) {
  const name = sourceWorkflowName(run.settings, cls);
  const id = `starter.${name}`;
  run.shards.set(
    id,
    await runAs(run, id, triggerMessage(name, iris, removed), run.shards.get(id) ?? {}),
  );
  await drain(run);
}

/** Send every record of the fixture, class by class in `order`, in batches of the settings. */
export async function runAll(run: LinkRun, records: FixtureRecord[], order: string[]) {
  for (const cls of order) {
    const iris = records.filter((r) => r.class === cls).map((r) => run.ids.get(r.id)!);
    for (let n = 0; n < iris.length; n += run.settings.sourcesPerTurn)
      await sendRecords(run, cls, iris.slice(n, n + run.settings.sourcesPerTurn));
  }
}

// ---- reading and grading ---------------------------------------------------------------

/** The run as the grader reads it: the graph's mentions and links, and the open items. */
export async function readRun(run: LinkRun): Promise<Run> {
  const graphRun = await readGraphRun(run.lbb);
  const items = await Promise.all(
    [...run.lbb.reviews.keys()].map((key) => run.ports.suggestion(key)),
  );
  return { ...graphRun, ...reviewOfItems(items) };
}

/** The gold of the fixture with its record ids as IRIs. */
export const goldOf = (gold: Gold, ids: Map<string, string>): Gold => ({
  ...gold,
  records: Object.fromEntries(ids),
});

export async function gradeRun(run: LinkRun, gold: Gold): Promise<Report> {
  return grade(goldOf(gold, run.ids), await readRun(run));
}

// ---- a person's review -----------------------------------------------------------------

/**
 * Decide every open item as the gold says: keep the rows whose two mentions
 * the gold puts in one group, accept with them or dismiss when none is
 * right; accept an identity with the records of its largest group in the
 * gold. An accept writes its facts and identities to the graph as the
 * server does; then the reviews workflow is sent the mentions whose
 * `same_thing_as` changed, with the accept's request id. Returns the number
 * of items decided.
 */
export async function reviewAsGold(run: LinkRun, gold: Gold): Promise<number> {
  const g = goldOf(gold, run.ids);
  const { mentions } = await readGraphRun(run.lbb);
  const groupOf = new Map<string, string>();
  const spanKey = (s: string) => s.normalize("NFC").trim();
  for (const group of g.groups)
    for (const m of group.mentions) {
      const found = mentions.find(
        (x) =>
          x.record === (g.records?.[m.record] ?? m.record) &&
          x.field === m.field &&
          spanKey(x.span) === spanKey(m.span) &&
          !groupOf.has(x.iri),
      );
      if (found) groupOf.set(found.iri, group.id);
    }
  const same = (a: string | null, b: string | null) =>
    !!a && !!b && groupOf.has(a) && groupOf.get(a) === groupOf.get(b);
  const touched = new Set<string>();
  const requests: string[] = [];
  let decided = 0;
  for (const [key, filed] of run.lbb.reviews) {
    if (filed.status !== "open" || run.ports.decided.has(key)) continue;
    decided += 1;
    const kind = itemKind(key);
    if (kind === "identity") {
      const members = filed.identities?.[0]?.members ?? [];
      const selves =
        (filed.mapping as { identity?: { selves?: Record<string, string> } }).identity?.selves ??
        {};
      const byGroup = new Map<string, typeof members>();
      for (const member of members) {
        const record = iriOfRef(member)!;
        const group = groupOf.get(selves[record] ?? "") ?? `alone:${record}`;
        byGroup.set(group, [...(byGroup.get(group) ?? []), member]);
      }
      const keep = [...byGroup.values()].sort((a, b) => b.length - a.length)[0] ?? [];
      if (keep.length < 2) {
        run.ports.decided.set(key, { status: "dismissed" });
        continue;
      }
      const identity = { ...filed.identities![0]!, members: keep };
      const keptRecords = new Set(keep.map((m) => iriOfRef(m)));
      const facts = (filed.facts?.triplets ?? []).filter((t) => {
        const [a, b] = [iriOfRef(t.source), iriOfRef(t.target)];
        return (
          [...keptRecords].some((r) => selves[r!] === a) &&
          [...keptRecords].some((r) => selves[r!] === b)
        );
      });
      run.ports.decided.set(key, {
        status: "accepted",
        identities: [identity],
        facts: { triplets: facts },
      });
      run.lbb.graph.apply({
        subjects: [],
        triplets: [
          ...keep.slice(1).map((m) => ({ source: m, relation: "SAME_AS", target: keep[0]! })),
          ...facts,
        ],
      });
      for (const t of facts) touched.add(iriOfRef(t.source)!);
      requests.push(`ontology-suggestion:${key}:facts:1`);
      continue;
    }
    const rows = filed.facts?.triplets ?? [];
    const kept = rows.filter((t) => same(iriOfRef(t.source), iriOfRef(t.target)));
    if (!kept.length) {
      run.ports.decided.set(key, { status: "dismissed" });
      continue;
    }
    run.ports.decided.set(key, { status: "accepted", facts: { ...filed.facts, triplets: kept } });
    run.lbb.graph.apply({ subjects: [], triplets: kept });
    for (const t of kept) touched.add(iriOfRef(t.source)!);
    requests.push(`ontology-suggestion:${key}:facts:1`);
  }
  for (const [key, d] of run.ports.decided) {
    const filed = run.lbb.reviews.get(key);
    if (filed && filed.status === "open") filed.status = d.status;
  }
  if (touched.size) {
    const name = reviewsWorkflowName(run.settings);
    const id = `starter.${name}`;
    const message = {
      ...triggerMessage(name, [...touched]),
      reason: "changed",
      origin: { kind: "commit", trigger: "accepts", requests },
    } as WorkflowTriggerMessage;
    run.shards.set(id, await runAs(run, id, message, run.shards.get(id) ?? {}));
    await drain(run);
  }
  return decided;
}

// ---- storage (decision 6) ---------------------------------------------------------------

/** The statements of the graph in N-Triples, one per value and edge: how block keys cost. */
export interface Storage {
  mentions: number;
  things: number;
  keys: number;
  keysPerMention: number;
  factsPerMention: number;
  bytesPerMention: number;
  keyFactsShare: number;
  keyBytesShare: number;
  thingFacts: number;
  thingBytes: number;
}

const nt = (s: string, p: string, o: string) => `<${s}> <${p}> ${o} .\n`.length;
const literal = (v: unknown) => JSON.stringify(String(v));

/** Keys, facts and bytes per mention, and of the things, as N-Triples statements. */
export function measure(graph: MemoryGraph): Storage {
  const mentions = graph.ofType("Mention");
  const things = graph.ofType("LinkedThing");
  let facts = 0;
  let bytes = 0;
  let keyFacts = 0;
  let keyBytes = 0;
  const statements = (
    iri: string,
    type: string,
    name: string,
    properties: Record<string, unknown>,
  ) => {
    let n = 2;
    let b =
      nt(iri, "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", `<${classIri(type)}>`) +
      nt(iri, RDFS_LABEL, literal(name));
    for (const [field, value] of Object.entries(properties))
      for (const v of list(value)) {
        n += 1;
        const size = nt(iri, propertyIri(field), literal(v));
        b += size;
        if (field === "block_key") {
          keyFacts += 1;
          keyBytes += size;
        }
      }
    for (const e of graph.edges.filter((x) => x.source === iri)) {
      n += 1;
      b += nt(iri, relationIri(e.relation), `<${e.target}>`);
    }
    return { n, b };
  };
  for (const m of mentions) {
    const s = statements(m.iri, m.type, m.name, m.properties);
    facts += s.n;
    bytes += s.b;
  }
  let thingFacts = 0;
  let thingBytes = 0;
  for (const t of things) {
    const s = statements(t.iri, t.type, t.name, t.properties);
    thingFacts += s.n;
    thingBytes += s.b;
  }
  const keys = mentions.reduce((sum, m) => sum + list(m.properties.block_key).length, 0);
  const per = (x: number) => (mentions.length ? Math.round((x / mentions.length) * 100) / 100 : 0);
  return {
    mentions: mentions.length,
    things: things.length,
    keys,
    keysPerMention: per(keys),
    factsPerMention: per(facts),
    bytesPerMention: per(bytes),
    keyFactsShare: facts ? Math.round((keyFacts / facts) * 1000) / 1000 : 0,
    keyBytesShare: bytes ? Math.round((keyBytes / bytes) * 1000) / 1000 : 0,
    thingFacts,
    thingBytes,
  };
}
