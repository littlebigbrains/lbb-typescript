// documents-map: map the links of documents-link into the graph's own ontology, as proposals.
//
// A triggered workflow of the starter workflow `workflow` watches the class `DocMention` and its
// links `REFERS_TO` and `SAME_ITEM_AS` (documents.link, or the documents-link template, writes
// them). A message is a signal: each one maps every link of the graph again, in one turn.
//
// 1. Ground the entries. Each entry a link points to, and each entry a mention's line belongs to
//    (the item a page is about), gets candidates: the instances whose identifier or label is the
//    entry's identifier. The decision model (`decide`) answers which instance the entry is: a
//    candidate, a new instance, or none. A new instance gets a second question: its class.
// 2. Type the links. For a link whose two ends are instances with a class, the decision model
//    answers which statement the line makes: a property whose domain and range fit the two
//    classes (either way round), the same item, no fact, or a property the ontology lacks.
// 3. Propose. Each statement becomes a `FactProposal` (written with `writeOwned`): a typed link
//    with the link's confidence times the answer's probability, an entry's `DENOTES` link to its
//    instance, and a new instance's type, label and identifier. "No class fits" and "a property
//    the ontology lacks" become ontology suggestions, one per pattern.
//
// A `review` workflow (LBB's, or the review template) decides which proposals become facts.
//
// The questions are asked under an effect id made from their content, so a question asked again
// in a later message gets its first answer at no cost: only new or changed questions cost.
import {
  entityRef,
  isActivityRefused,
  LbbError,
  splitInHalves,
  triggeredWorkflow,
  WorkflowError,
  type DecideRequest,
  type FilePages,
  type LbbActivities,
  type Schemas,
  type WorkflowContext,
  type WorkflowTriggerMessage,
} from "@littlebigbrain/client";
import * as map from "./map.js";

/** A declared mapping: a link from an instance of `from` to one of `to` states `property`, and no model is asked. */
export interface Mapping {
  /** `document` limits it to the links of one referring document. */
  from: { document?: string; entry_class: string };
  to: { entry_class: string };
  property: string;
}

export interface Settings {
  /** Declared mappings, by class and relation name. */
  mappings: Mapping[];
}

/** The settings: edit them for your graph. The samples need no declared mapping. */
export const defaults: Settings = { mappings: [] };

/** The workflow type and version the triggered workflow names. */
export const workflowType = { workflow_type: "documents-map", version: "v1" };

/** The triggered workflow that sends the changed links here: `client.workflows.starters.use(trigger())`. */
export function trigger(): Schemas["TriggeredWorkflowRequest"] {
  return {
    starter: "workflow",
    name: "documents-map",
    watch: { class: "DocMention", fields: ["REFERS_TO", "SAME_ITEM_AS"] },
    workflow: workflowType,
    owns: { classes: [map.FACT_PROPOSAL], properties: Object.keys(map.PROPOSAL_FIELDS) },
    batch: 64,
  };
}

/** The classes, properties and relation the workflow and the review need: `lbb.evolve(ontology())`. */
export function ontology(): Schemas["OntologyEvolveOp"][] {
  return [
    { op: "add_entity_type", name: "DocEntry" },
    { op: "add_entity_type", name: "DocMention" },
    { op: "add_entity_type", name: map.FACT_PROPOSAL },
    ...Object.entries({ ...map.PROPOSAL_FIELDS, identifier: "keyword" }).map(
      ([name, value_type]) => ({ op: "add_property" as const, name, value_type }),
    ),
    // The trace from an entry (or a page's head mention) to its instance: open on both sides.
    { op: "add_relation", name: map.DENOTES, domain: [], range: [] },
  ];
}

/** What the last run found, and the runs so far. */
export interface MapState {
  runs: number;
  links: number;
  entries: number;
  proposals: number;
  suggestions: number;
  /** Links that made no proposal and back no filed suggestion. */
  unmapped: number;
  /**
   * The first 50 of them, by document, page and line: each with its `document`, `page`,
   * `line_id`, `line`, `box`, `span`, `subject`, `object`, `outcome`, `reason`, and the typing
   * answer (`choice`, `answer`, `probability`, `options`) when it has one.
   */
  unmappedLinks: Record<string, unknown>[];
}

/** Unmapped links the state lists, at most. */
const UNMAPPED_MAX = 50;

/** Links one message maps at most: one turn holds the answers. The LBB version maps any number. */
const MAX_LINKS = 1_000;
/** Proposals one commit names at most: the route takes 1,000 entities. */
const PART = 900;
const P =
  "PREFIX p: <https://littlebigbrain.com/p/>\nPREFIX r: <https://littlebigbrain.com/r/>\n" +
  "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\nPREFIX lbb: <https://littlebigbrain.com/ns#>\n";
const PLAIN_IRI = /^[^\s<>"{}|\\^`]+$/;
const values = (iris: Iterable<string>) =>
  [...iris]
    .filter((iri) => PLAIN_IRI.test(iri))
    .map((iri) => `<${iri}>`)
    .join(" ");
const num = (text: string | undefined, fallback = 0) => {
  const n = Number(text);
  return text !== undefined && Number.isFinite(n) ? n : fallback;
};

// ---- the trace ---------------------------------------------------------------------------

interface Doc {
  iri: string;
  name: string;
  sha256: string;
}
interface Entry extends map.Placed {
  iri: string;
  doc: string;
  identifier: string;
  context: string;
  line: string;
}
interface Link {
  relation: "REFERS_TO" | "SAME_ITEM_AS";
  entry: string;
  confidence: number;
}
interface Mention extends map.Placed {
  iri: string;
  doc: string;
  span: string;
  line: string;
  text: string;
  links: Link[];
}
/** One link to map: its mention, the entry it names, and the key of its subject. */
interface Unit {
  mention: Mention;
  link: Link;
  /** An entry IRI, or a mention IRI for a page entry made from a mention. */
  subject: string;
}
/** An end of a link: an entry, or a page entry made from a mention of the page's head. */
interface End {
  key: string;
  doc: Doc;
  view: map.EntryView;
  line: string;
  box: number[];
  mint: string;
}
interface Trace {
  docs: Map<string, Doc>;
  units: Unit[];
  ends: Map<string, End>;
  /** The links whose mention has no subject: no entry of the page or the line. */
  noSubject: { mention: Mention; link: Link }[];
}

const box = (row: Record<string, string>) => ["x0", "y0", "x1", "y1"].map((k) => num(row[k]));

/** The links of the graph, the mentions and entries of their documents, at the message's commit. */
async function readTrace(lbb: LbbActivities, message: WorkflowTriggerMessage): Promise<Trace> {
  const at = { as_of_commit_seq: message.as_of_commit_seq };
  const linked = await lbb.sparql({
    ...at,
    query: `# documents-map: links\n${P}SELECT ?mention ?relation ?entry ?doc ?confidence WHERE {
  VALUES ?relation { r:refers_to r:same_item_as }
  ?mention ?relation ?entry ; r:mentioned_in ?doc .
  OPTIONAL { ?st rdf:subject ?mention ; rdf:predicate ?relation ; rdf:object ?entry ; lbb:confidence ?confidence }
}`,
  });
  const links = new Map<string, Link[]>();
  for (const row of linked.rows) {
    const relation = row.relation!.endsWith("/same_item_as") ? "SAME_ITEM_AS" : "REFERS_TO";
    const list = links.get(row.mention!) ?? [];
    const found = list.find((l) => l.relation === relation && l.entry === row.entry);
    const confidence = num(row.confidence, 1);
    if (found) found.confidence = Math.max(found.confidence, confidence);
    else list.push({ relation, entry: row.entry!, confidence });
    links.set(row.mention!, list);
  }
  if (links.size > MAX_LINKS)
    throw new WorkflowError(
      `The graph has links from ${links.size} mentions; the template maps at most ${MAX_LINKS} in one turn. Use the LBB-run documents.map.`,
    );
  const referring = new Set(linked.rows.map((r) => r.doc!));
  const targets = new Set(linked.rows.map((r) => r.entry!));
  if (!links.size) return { docs: new Map(), units: [], ends: new Map(), noSubject: [] };
  const { rows: mentionRows } = await lbb.sparql({
    ...at,
    query: `# documents-map: mentions\n${P}SELECT ?mention ?doc ?span ?line ?text ?page ?x0 ?y0 ?x1 ?y1 WHERE {
  VALUES ?doc { ${values(referring)} }
  ?mention r:mentioned_in ?doc ; p:span ?span ; p:page ?page .
  OPTIONAL { ?mention p:line_id ?line } OPTIONAL { ?mention p:line_text ?text }
  OPTIONAL { ?mention p:x0 ?x0 ; p:y0 ?y0 ; p:x1 ?x1 ; p:y1 ?y1 }
}`,
  });
  const { rows: entryRows } = await lbb.sparql({
    ...at,
    query: `# documents-map: entries\n${P}SELECT ?entry ?doc ?identifier ?context ?line ?page ?x0 ?y0 ?x1 ?y1 WHERE {
  { VALUES ?doc { ${values(referring)} } ?entry r:defined_in ?doc }
  UNION { VALUES ?entry { ${values(targets)} } ?entry r:defined_in ?doc }
  ?entry p:identifier ?identifier .
  OPTIONAL { ?entry p:context ?context } OPTIONAL { ?entry p:line_id ?line } OPTIONAL { ?entry p:page ?page }
  OPTIONAL { ?entry p:x0 ?x0 ; p:y0 ?y0 ; p:x1 ?x1 ; p:y1 ?y1 }
}`,
  });
  const entries = new Map<string, Entry>();
  for (const r of entryRows)
    entries.set(r.entry!, {
      iri: r.entry!,
      doc: r.doc!,
      identifier: r.identifier!,
      context: r.context ?? r.identifier!,
      line: r.line ?? "",
      page: num(r.page),
      box: box(r),
    });
  const { rows: docRows } = await lbb.sparql({
    ...at,
    query: `# documents-map: documents\n${P}SELECT ?doc ?name ?sha WHERE {
  VALUES ?doc { ${values(new Set([...referring, ...[...entries.values()].map((e) => e.doc)]))} }
  OPTIONAL { ?doc p:name ?name } OPTIONAL { ?doc p:file_sha256 ?sha }
}`,
  });
  const docs = new Map<string, Doc>(
    docRows.map((r) => [r.doc!, { iri: r.doc!, name: r.name ?? r.doc!, sha256: r.sha ?? r.doc! }]),
  );
  const doc = (iri: string) => docs.get(iri) ?? { iri, name: iri, sha256: iri };

  // The subject of each mention's links, per referring document.
  const units: Unit[] = [];
  const ends = new Map<string, End>();
  const noSubject: Trace["noSubject"] = [];
  const entryEnd = (e: Entry): End => ({
    key: e.iri,
    doc: doc(e.doc),
    view: {
      identifier: e.identifier,
      description: map.clip(e.context, 200),
      context: e.context,
      document: doc(e.doc).name,
      page: e.page + 1,
    },
    line: e.line,
    box: e.box,
    mint: map.mintedIri(doc(e.doc).sha256, e.identifier),
  });
  for (const d of [...referring].sort()) {
    const mentions: Mention[] = mentionRows
      .filter((r) => r.doc === d)
      .map((r) => ({
        iri: r.mention!,
        doc: d,
        span: r.span!,
        line: r.line ?? "",
        text: r.text ?? r.span!,
        page: num(r.page),
        box: box(r),
        links: links.get(r.mention!) ?? [],
      }))
      .sort((a, b) => a.page - b.page || a.box[1]! - b.box[1]! || a.box[0]! - b.box[0]!);
    const own = [...entries.values()]
      .filter((e) => e.doc === d)
      .map((e) => ({ entry: e.iri, identifier: e.identifier, page: e.page, box: e.box }));
    const subjects = map.subjects(
      own,
      mentions.map((m) => ({ ...m, target: m.links[0]?.entry ?? null })),
    );
    mentions.forEach((m, n) => {
      const s = subjects[n];
      if (!s) {
        noSubject.push(...m.links.map((link) => ({ mention: m, link })));
        return;
      }
      let end: End;
      if ("entry" in s) {
        const entry = entries.get(s.entry);
        if (!entry) {
          noSubject.push(...m.links.map((link) => ({ mention: m, link })));
          return;
        }
        end = entryEnd(entry);
      } else {
        // A page entry made from the mention of the page's head: its span the identifier, the
        // rest of its line the description.
        const head = mentions[s.mention]!;
        end = {
          key: head.iri,
          doc: doc(d),
          view: {
            identifier: head.span.trim(),
            description: map.pageEntryDescription(head.span, head.text),
            context: head.text,
            document: doc(d).name,
            page: head.page + 1,
          },
          line: head.line,
          box: head.box,
          mint: map.mintedIri(doc(d).sha256, head.span),
        };
      }
      for (const link of m.links) {
        const entry = entries.get(link.entry);
        if (!entry || entry.iri === end.key) continue;
        ends.set(end.key, end);
        ends.set(entry.iri, entryEnd(entry));
        units.push({ mention: m, link, subject: end.key });
      }
    });
  }
  return { docs, units, ends, noSubject };
}

// ---- candidates ------------------------------------------------------------------------------

const IDENTIFYING = [
  "https://littlebigbrain.com/p/identifier",
  map.RDFS_LABEL,
  "http://www.w3.org/2004/02/skos/core#notation",
  "http://www.w3.org/2004/02/skos/core#prefLabel",
  "http://schema.org/identifier",
  "https://schema.org/identifier",
  "http://purl.org/dc/terms/identifier",
];

/** Each end's candidates: the instances whose identifier, label or notation is the end's identifier as written. */
async function findCandidates(
  lbb: LbbActivities,
  message: WorkflowTriggerMessage,
  ends: End[],
  onto: map.MapOntology,
): Promise<Map<string, map.CandidateView[]>> {
  const at = { as_of_commit_seq: message.as_of_commit_seq };
  const found = new Map<string, Set<string>>(ends.map((e) => [e.key, new Set<string>()]));
  for (let n = 0; n < ends.length; n += 64) {
    const part = ends.slice(n, n + 64);
    const literals = new Set(part.flatMap((e) => map.identifierVariants(e.view.identifier)));
    if (!literals.size) continue;
    const { rows } = await lbb.sparql({
      ...at,
      query: `# documents-map: candidates\nSELECT DISTINCT ?s ?v WHERE {
  VALUES ?v { ${[...literals].map((l) => JSON.stringify(l)).join(" ")} }
  VALUES ?p { ${values(IDENTIFYING)} }
  ?s ?p ?v .
}`,
    });
    for (const row of rows)
      for (const e of part)
        if (map.identifierKey(row.v!) === map.identifierKey(e.view.identifier) && row.s !== e.mint)
          found.get(e.key)!.add(row.s!);
  }
  const iris = new Set([...found.values()].flatMap((s) => [...s]));
  const details = new Map<string, map.CandidateView>();
  const trace = new Set(map.TRACE_CLASSES.map((c) => map.classIri(c)));
  const list = [...iris].filter((iri) => PLAIN_IRI.test(iri)).sort();
  for (let n = 0; n < list.length; n += 64) {
    const { rows } = await lbb.sparql({
      ...at,
      query: `# documents-map: details\nSELECT ?s ?p ?o WHERE {
  VALUES ?s { ${values(list.slice(n, n + 64))} }
  ?s ?p ?o FILTER(?p = <${map.RDF_TYPE}> || isLiteral(?o))
}`,
    });
    const types = new Map<string, string[]>();
    const literals = new Map<string, [string, string][]>();
    for (const r of rows) {
      if (r.p === map.RDF_TYPE) types.set(r.s!, [...(types.get(r.s!) ?? []), r.o!]);
      else literals.set(r.s!, [...(literals.get(r.s!) ?? []), [r.p!, r.o!]]);
    }
    for (const [iri, classes] of types) {
      // An instance of LBB's own trace (an entry, a mention) is no candidate.
      if (classes.some((c) => trace.has(c))) continue;
      const facts = (literals.get(iri) ?? []).sort((a, b) => (a.join() < b.join() ? -1 : 1));
      const label =
        facts.find(([p]) => p === map.RDFS_LABEL)?.[1] ??
        facts.find(([p]) => /name|label|title/i.test(map.localName(p)))?.[1] ??
        map.localName(iri);
      const cls = classes.sort().find((c) => onto.classes.has(c));
      details.set(iri, {
        iri,
        ...(cls ? { class: cls } : {}),
        classLabel: cls ? onto.classLabel(cls) : "thing",
        label,
        facts: facts
          .filter(([p, v]) => p !== map.RDFS_LABEL && v !== label)
          .slice(0, 4)
          .map(([p, v]) => [map.localName(p), v]),
      });
    }
  }
  return new Map(
    ends.map((e) => [
      e.key,
      [...found.get(e.key)!]
        .sort()
        .flatMap((iri) => details.get(iri) ?? [])
        .slice(0, map.GROUND_CANDIDATES),
    ]),
  );
}

// ---- the page rows -----------------------------------------------------------------------------

type FileLine = FilePages["pages"][number]["lines"][number];

/** The lines of a page by baseline, top to bottom, each row left to right. */
function layoutRows(lines: FileLine[]): FileLine[][] {
  const rows: { top: number; bottom: number; lines: FileLine[] }[] = [];
  for (const line of [...lines].sort((a, b) => a.box[1]! - b.box[1]! || a.box[0]! - b.box[0]!)) {
    const middle = (line.box[1]! + line.box[3]!) / 2;
    const row = rows.find((r) => r.top <= middle && middle <= r.bottom);
    if (row) row.lines.push(line);
    else rows.push({ top: line.box[1]!, bottom: line.box[3]!, lines: [line] });
  }
  return rows.map((r) => r.lines.sort((a, b) => a.box[0]! - b.box[0]!));
}

/** The rows of one page of a referring document, as `[line id] text | …`; without a parse, the mentions' lines. */
function pageReader(lbb: LbbActivities, trace: Trace) {
  const read = new Map<string, Promise<FileLine[]>>();
  return async (doc: Doc, page: number) => {
    const key = `${doc.sha256}\u0000${page}`;
    if (!read.has(key))
      read.set(
        key,
        lbb.pages(doc.sha256, { from: page, to: page + 1 }).then(
          (pages) => pages.pages[0]?.lines ?? [],
          (error: unknown) => {
            if (!(error instanceof LbbError && error.status === 404)) throw error;
            const seen = new Map<string, FileLine>();
            for (const u of trace.units)
              if (u.mention.doc === doc.iri && u.mention.page === page)
                seen.set(u.mention.line, {
                  id: u.mention.line,
                  text: u.mention.text,
                  box: u.mention.box,
                  words: [],
                } as FileLine);
            return [...seen.values()];
          },
        ),
      );
    const lines = await read.get(key)!;
    const rows = layoutRows(lines);
    return {
      rows: rows.map((row) => row.map((l) => `[${l.id}] ${l.text}`).join(" | ")),
      rowOf: (id: string) =>
        (rows.find((row) => row.some((l) => l.id === id)) ?? []).map((l) => l.text).join(" | "),
    };
  };
}

// ---- asking ----------------------------------------------------------------------------------------

/** One decide plan: questions that share a state, and the label of their calls. */
interface Plan {
  label: string;
  state: Record<string, unknown>;
  key: string;
  members: map.Member[];
}

/** The requests of the plans, in order. */
const requestsOf = (plans: Plan[]) =>
  plans.flatMap((plan) =>
    map.packRequests(plan.state, plan.key, plan.members).map((members) => ({ plan, members })),
  );

/**
 * Ask one request under an effect id made from its content: the same request
 * in any later message gets its kept answer at no cost. A refused request is
 * asked in halves; a question the model refuses alone stays unanswered.
 */
async function ask(
  lbb: LbbActivities,
  plan: Plan,
  members: map.Member[],
): Promise<Record<string, map.Kept>> {
  const request: DecideRequest = map.buildRequest(plan.state, plan.key, members);
  const effectId = `documents-map/m1/${map.hash(JSON.stringify(request)).slice(0, 48)}`;
  try {
    const { answers } = await lbb.decide(request, { effectId, label: plan.label.slice(0, 64) });
    return map.keep(answers);
  } catch (error) {
    if (!isActivityRefused(error)) throw error;
    const halves = splitInHalves(members);
    if (!halves) return {};
    return { ...(await ask(lbb, plan, halves[0])), ...(await ask(lbb, plan, halves[1])) };
  }
}

/** The phase each stage reports, the words of the LBB-run documents.map. */
const STAGE_PHASE: Record<string, string> = {
  ground: "grounding entries",
  class: "choosing classes",
  type: "typing links",
};

/** The steps of one stage, one per request: `<stage>-<n>`. Throws when the turn cannot hold them. */
async function askStage(
  ctx: WorkflowContext,
  lbb: LbbActivities,
  stage: string,
  plans: Plan[],
  steps: { used: number },
): Promise<Record<string, map.Kept>> {
  const requests = requestsOf(plans);
  // A turn holds 64 steps; keep room for the suggestions and the writes.
  if (steps.used + requests.length > 56)
    throw new WorkflowError(
      `The ${stage} questions need ${requests.length} requests, more than one turn of the template holds. Use the LBB-run documents.map.`,
    );
  const answers: Record<string, map.Kept> = {};
  for (const [n, { plan, members }] of requests.entries()) {
    steps.used += 1;
    Object.assign(
      answers,
      await ctx.step(`${stage}-${n}`, (s) => {
        s.progress(STAGE_PHASE[stage] ?? stage, {
          done: n,
          total: requests.length,
          unit: "questions",
        });
        return ask(lbb, plan, members);
      }),
    );
  }
  return answers;
}

// ---- the workflow ---------------------------------------------------------------------------------

/** How an end was grounded. */
interface Grounded {
  kind: "existing" | "new" | "none" | "unanswered";
  iri?: string;
  class?: string;
  p: number;
  options: Record<string, number>;
  candidates: map.CandidateView[];
  classP?: number;
  classOptions?: Record<string, number>;
  noClass?: number;
}

/** The id of a question about an end or a link: from its key, so it stays the same from run to run. */
const qid = (key: string) => map.hash(key).slice(0, 12);

/** Where a link is: its mention on its line and the two ends it names (a review item's sample shape). */
const mentionSample = (doc: Doc, mention: Mention, subject: string, object: string) => ({
  kind: "link",
  document: doc.name,
  page: mention.page + 1,
  line_id: mention.line,
  line: map.clip(mention.text, 200),
  box: mention.box,
  span: mention.span,
  subject,
  object,
});

/** Why an end has no instance, or no class, in words. */
function endState(id: string, g: Grounded | undefined): string {
  if (!g) return `${id} was not grounded`;
  if (g.kind === "unanswered") return `${id} got no grounding answer`;
  if (g.kind === "none")
    return `the decision model found that ${id} is no thing of the graph (none, ${g.p.toFixed(2)})`;
  if (g.kind === "new" && !g.class) {
    if (g.noClass === undefined) return `${id} has no class: its class question got no answer`;
    return g.noClass >= map.LACK_SUGGEST_AT
      ? `${id} has no class: no class of the ontology fits it (${g.noClass.toFixed(2)}), and it waits for the class suggestion`
      : `${id} has no class: no class fits it (${g.noClass.toFixed(2)}), below ${map.LACK_SUGGEST_AT}`;
  }
  if (g.kind === "existing" && !g.class)
    return `${id} is an instance with no class of the ontology`;
  return `${id} is grounded`;
}

/** The workflow, for a `WorkflowWorker`. `lbb` is `lbbActivities(client)`, or a mock in a test. */
export function createWorkflow(lbb: LbbActivities, settings: Settings = defaults) {
  return triggeredWorkflow<MapState>({
    name: workflowType.workflow_type,
    version: workflowType.version,
    initialState: {
      runs: 0,
      links: 0,
      entries: 0,
      proposals: 0,
      suggestions: 0,
      unmapped: 0,
      unmappedLinks: [],
    },
    async onInstances(ctx, message, state) {
      const proposedBy = `workflow/${message.workflow}`;
      const steps = { used: 0 };
      const onto = await ctx.step("ontology", async () => {
        const read = map.MapOntology.fromView(await lbb.ontology());
        return { classes: [...read.classes.values()], properties: read.properties };
      });
      steps.used += 1;
      const ontology = new map.MapOntology(onto.classes, onto.properties);
      const trace = await readTrace(lbb, message);
      const ends = [...trace.ends.values()].sort((a, b) => (a.key < b.key ? -1 : 1));

      // 1. Ground the ends: which instance is each entry?
      const candidates = await findCandidates(lbb, message, ends, ontology);
      const byDoc = <T>(list: T[], docOf: (item: T) => Doc) => {
        const out = new Map<string, T[]>();
        for (const item of list)
          out.set(docOf(item).iri, [...(out.get(docOf(item).iri) ?? []), item]);
        return [...out.values()];
      };
      const groundPlans: Plan[] = byDoc(ends, (e) => e.doc).map((list) => ({
        label: `${list[0]!.doc.name.slice(0, 40)} entries`,
        state: {
          task: map.GROUND_TASK,
          document: `${list[0]!.doc.name}, the document that defines the entries.`,
        },
        key: "entries",
        members: list.map((e) => map.groundQuestion(qid(e.key), e.view, candidates.get(e.key)!)),
      }));
      const groundAnswers = await askStage(ctx, lbb, "ground", groundPlans, steps);
      const grounded = new Map<string, Grounded>();
      for (const e of ends) {
        const list = candidates.get(e.key)!;
        const answer = groundAnswers[`g${qid(e.key)}`];
        const [choice, p, options] = answer ?? ["", 0, {}];
        const picked = /^c\d+$/.test(choice) ? list[Number(choice.slice(1))] : undefined;
        grounded.set(e.key, {
          kind: !answer
            ? "unanswered"
            : choice === map.NEW_INSTANCE
              ? "new"
              : picked
                ? "existing"
                : choice === map.NO_INSTANCE
                  ? "none"
                  : "unanswered",
          ...(picked ? { iri: picked.iri, ...(picked.class ? { class: picked.class } : {}) } : {}),
          ...(choice === map.NEW_INSTANCE ? { iri: e.mint } : {}),
          p,
          options,
          candidates: list,
        });
      }

      // The class of each new instance.
      const keys = ontology.classKeys();
      const fresh = ends.filter((e) => grounded.get(e.key)!.kind === "new");
      const classPlans: Plan[] = ontology.classes.size
        ? byDoc(fresh, (e) => e.doc).map((list) => ({
            label: `${list[0]!.doc.name.slice(0, 40)} classes`,
            state: {
              task: map.CLASS_TASK,
              document: `${list[0]!.doc.name}, the document that defines the entries.`,
            },
            key: "entries",
            members: list.map((e) => {
              const g = grounded.get(e.key)!;
              const options = map.classOptions(
                ontology,
                g.candidates.flatMap((c) => c.class ?? []),
                `${e.view.identifier} ${e.view.description} ${e.view.context}`,
              );
              return map.classQuestion(qid(e.key), e.view, options, ontology, keys);
            }),
          }))
        : [];
      const classAnswers = await askStage(ctx, lbb, "class", classPlans, steps);
      const classOfKey = new Map([...keys].map(([iri, key]) => [key, iri]));
      for (const e of fresh) {
        const g = grounded.get(e.key)!;
        const answer = classAnswers[`k${qid(e.key)}`];
        if (!answer) continue;
        g.classOptions = answer[2];
        if (answer[0] === map.NO_CLASS) g.noClass = answer[1];
        else if (classOfKey.has(answer[0])) {
          g.class = classOfKey.get(answer[0])!;
          g.classP = answer[1];
        }
      }
      const instanceOf = (key: string): map.MapInstance | undefined => {
        const [e, g] = [trace.ends.get(key)!, grounded.get(key)!];
        if (g.kind === "existing") {
          const c = g.candidates.find((c) => c.iri === g.iri);
          return {
            iri: g.iri!,
            ...(g.class ? { class: g.class } : {}),
            classLabel: g.class ? ontology.classLabel(g.class) : "thing",
            identifier: e.view.identifier,
            label: c?.label ?? e.view.identifier,
            description: e.view.description,
            isNew: false,
          };
        }
        if (g.kind !== "new") return undefined;
        return {
          iri: g.iri!,
          ...(g.class ? { class: g.class } : {}),
          classLabel: g.class ? ontology.classLabel(g.class) : "thing",
          identifier: e.view.identifier,
          label: map.newInstanceLabel(e.view.identifier, e.view.description),
          description: e.view.description,
          isNew: true,
        };
      };

      // 2. Type the links whose two ends are instances with a class.
      const rows = pageReader(lbb, trace);
      const typed: {
        unit: Unit;
        subject: map.MapInstance;
        object: map.MapInstance;
        options: map.PropertyOption[];
        declared?: string;
        id: string;
      }[] = [];
      // The links that make no proposal and back no filed suggestion stay in the state.
      const unmapped: Record<string, unknown>[] = trace.noSubject.map(({ mention, link }) => ({
        ...mentionSample(
          trace.docs.get(mention.doc)!,
          mention,
          "",
          trace.ends.get(link.entry)?.view.identifier ?? "",
        ),
        outcome: "no_subject",
        reason: "no entry of its page or line is the subject of the link",
      }));
      for (const unit of trace.units) {
        const [subject, object] = [instanceOf(unit.subject), instanceOf(unit.link.entry)];
        const doc = trace.docs.get(unit.mention.doc)!;
        const [s, o] = [trace.ends.get(unit.subject)!, trace.ends.get(unit.link.entry)!];
        if (!subject || !object || !subject.class || !object.class || subject.iri === object.iri) {
          const why = (end: End) => endState(end.view.identifier, grounded.get(end.key));
          const [outcome, reason] =
            !subject || !object
              ? ["ungrounded", why(subject ? o : s)]
              : subject.iri === object.iri
                ? ["same_instance", `its two ends are one instance, ${map.short(subject)}`]
                : ["unclassed", why(subject.class ? o : s)];
          unmapped.push({
            ...mentionSample(doc, unit.mention, s.view.identifier, o.view.identifier),
            outcome,
            reason,
          });
          continue;
        }
        const id = qid(`${unit.mention.iri}\u0000${unit.link.relation}\u0000${unit.link.entry}`);
        const [up, down] = [ontology.ancestors(subject.class), ontology.ancestors(object.class)];
        const declared = settings.mappings.find(
          (m) =>
            (!m.from.document || m.from.document.normalize() === doc.name.normalize()) &&
            up.has(classNamed(ontology, m.from.entry_class) ?? "") &&
            down.has(classNamed(ontology, m.to.entry_class) ?? ""),
        );
        const property =
          declared &&
          ontology.properties.find(
            (p) =>
              p.iri === declared.property ||
              p.name.toLowerCase() === declared.property.toLowerCase(),
          );
        if (property) {
          typed.push({ unit, subject, object, options: [], declared: property.iri, id });
          continue;
        }
        const options = ontology.propertyOptions(subject.class, object.class, unit.mention.text);
        typed.push({ unit, subject, object, options, id });
      }
      const typePlans: Plan[] = [];
      const asked = typed.filter((t) => !t.declared);
      for (const docIri of [...new Set(asked.map((t) => t.unit.mention.doc))].sort()) {
        const doc = trace.docs.get(docIri)!;
        const onDoc = asked.filter((t) => t.unit.mention.doc === docIri);
        for (const page of [...new Set(onDoc.map((t) => t.unit.mention.page))].sort(
          (a, b) => a - b,
        )) {
          const list = onDoc.filter((t) => t.unit.mention.page === page);
          const listing = await rows(doc, page);
          const classes = new Set(
            list.flatMap((t) => [
              ...ontology.ancestors(t.subject.class!),
              ...ontology.ancestors(t.object.class!),
            ]),
          );
          const properties = new Set(list.flatMap((t) => t.options.map((o) => o.property)));
          typePlans.push({
            label: `${doc.name.slice(0, 40)} p${page + 1} links`,
            state: {
              task: map.TYPING_TASK,
              ontology: ontology.stateSubset(classes, properties),
              document: `${doc.name}. One page. Each row holds the lines that share a baseline, left to right, as '[line id] text'.`,
              page: page + 1,
              rows: listing.rows,
            },
            key: "instances",
            members: list.map((t) =>
              map.typingQuestion(
                t.id,
                {
                  document: doc.name,
                  page: page + 1,
                  lineId: t.unit.mention.line,
                  lineText: t.unit.mention.text,
                  rowText: listing.rowOf(t.unit.mention.line) || t.unit.mention.text,
                  span: t.unit.mention.span,
                  subject: t.subject,
                  object: t.object,
                },
                t.options,
              ),
            ),
          });
        }
      }
      const typeAnswers = await askStage(ctx, lbb, "type", typePlans, steps);

      // 3. The proposals and the patterns the ontology lacks.
      const proposals = new Map<string, map.Proposal>();
      const lacks: map.Lack[] = [];
      const classed: map.ClassedEntry[] = [];
      let links = 0;
      for (const t of typed) {
        const { unit, subject, object } = t;
        const answer: map.Kept | undefined = t.declared
          ? ["declared", 1, {}]
          : typeAnswers[`t${t.id}`];
        const doc = trace.docs.get(unit.mention.doc)!;
        const sample = mentionSample(doc, unit.mention, map.short(subject), map.short(object));
        if (!answer) {
          unmapped.push({
            ...sample,
            outcome: "unanswered",
            reason: "its typing question got no answer",
          });
          continue;
        }
        const [choice, p, options] = answer;
        const option = t.options.find((o) => o.key === choice);
        const property = t.declared ?? option?.property;
        const answered = {
          ...sample,
          choice,
          answer: map.answerWords(choice, property),
          probability: p,
          options,
        };
        const evidence = {
          mention: unit.mention.iri,
          document: doc.name,
          document_iri: doc.iri,
          page: unit.mention.page + 1,
          line_id: unit.mention.line,
          span: unit.mention.span,
          line: unit.mention.text,
          box: unit.mention.box,
          link: {
            relation: unit.link.relation,
            confidence: unit.link.confidence,
            subject_entry: trace.ends.get(unit.subject)!.view.identifier,
            object_entry: trace.ends.get(unit.link.entry)!.view.identifier,
            object_document: trace.ends.get(unit.link.entry)!.doc.name,
          },
          subject: map.short(subject),
          object: map.short(object),
          choice,
          p,
          options,
        };
        const confidence = unit.link.confidence * p;
        if (property) {
          links += 1;
          const reverse = option?.reverse ?? false;
          map.addProposal(proposals, proposedBy, {
            statement: reverse
              ? { subject: object.iri, predicate: property, object: subject.iri }
              : { subject: subject.iri, predicate: property, object: object.iri },
            kind: "fact",
            name: `${map.short(subject)} · ${map.humanize(map.localName(property))} · ${map.short(object)}`,
            confidence,
            evidence,
          });
        } else if (choice === map.SAME_ITEM) {
          links += 1;
          map.addProposal(proposals, proposedBy, {
            statement: { subject: subject.iri, predicate: map.OWL_SAME_AS, object: object.iri },
            kind: "same_item",
            name: `${map.short(subject)} · same as · ${map.short(object)}`,
            confidence,
            evidence,
          });
        } else if (choice === map.MISSING_PROPERTY && p >= map.LACK_SUGGEST_AT) {
          // The words of the two ends and of the object's document name the ends, not the relation.
          const skip = new Set(
            [trace.ends.get(unit.link.entry)!.doc.name, subject, object].flatMap((end) =>
              typeof end === "string"
                ? [...map.nameWords(end)]
                : [end.identifier ?? "", end.label, end.description ?? ""].flatMap((text) => [
                    ...map.nameWords(text),
                  ]),
            ),
          );
          lacks.push({
            kind: "property",
            subjectClass: subject.class!,
            objectClass: object.class!,
            document: doc.name,
            sample: answered,
            p,
            options,
            offered: Object.fromEntries(t.options.map((o) => [o.key, o.property])),
            phrase: map.spanPhrase(unit.mention.text, unit.mention.span, skip),
            quote: `p. ${unit.mention.page + 1}, "${map.clip(unit.mention.text, 120)}" (${map.short(subject)} → ${map.short(object)}, ${p.toFixed(2)})`,
          });
        } else
          unmapped.push({
            ...answered,
            outcome: choice === map.MISSING_PROPERTY ? "lacks" : "no_fact",
            reason:
              choice === map.MISSING_PROPERTY
                ? `the decision model chose a property the ontology lacks at ${p.toFixed(2)}, below ${map.LACK_SUGGEST_AT}: no suggestion`
                : "the decision model found that the line states no fact about the two",
          });
      }
      // The groundings' own proposals: DENOTES, and a new instance's type, label and identifier.
      for (const e of ends) {
        const g = grounded.get(e.key)!;
        const evidence = {
          entry: e.key,
          document: e.doc.name,
          page: e.view.page,
          line_id: e.line,
          identifier: e.view.identifier,
          description: map.clip(e.view.description, 200),
          box: e.box,
          p: g.p,
          options: g.options,
          candidates: Object.fromEntries(
            g.candidates.map((c, n) => [`c${n}`, { iri: c.iri, label: c.label }]),
          ),
          ...(g.classOptions ? { class_p: g.classP ?? null, class_options: g.classOptions } : {}),
        };
        const id = e.view.identifier;
        const denotes = map.relationIri(map.DENOTES);
        if (g.kind === "existing")
          map.addProposal(proposals, proposedBy, {
            statement: { subject: e.key, predicate: denotes, object: g.iri! },
            kind: "denotes",
            name: `${id} · denotes · ${map.localName(g.iri!)}`,
            confidence: g.p,
            evidence,
          });
        else if (g.kind === "new" && g.class) {
          const label = map.newInstanceLabel(id, e.view.description);
          const literal = { datatype: map.XSD_STRING };
          classed.push({
            document: e.doc.name,
            shape: map.codeShape(id),
            name: label,
            classLabel: ontology.classLabel(g.class),
            p: g.classP ?? 0,
          });
          for (const proposal of [
            {
              statement: { subject: g.iri!, predicate: map.RDF_TYPE, object: g.class },
              name: `${id} · a · ${ontology.classLabel(g.class)}`,
              confidence: g.p * (g.classP ?? 0),
              kind: "instance",
            },
            {
              statement: { subject: g.iri!, predicate: map.RDFS_LABEL, object: label, ...literal },
              name: `${id} · label · ${label}`,
              confidence: g.p,
              kind: "instance",
            },
            {
              statement: {
                subject: g.iri!,
                predicate: map.propertyIri("identifier"),
                object: id,
                ...literal,
              },
              name: `${id} · identifier · ${id}`,
              confidence: g.p,
              kind: "instance",
            },
            {
              statement: { subject: e.key, predicate: denotes, object: g.iri! },
              name: `${id} · denotes · ${id}`,
              confidence: g.p,
              kind: "denotes",
            },
          ])
            map.addProposal(proposals, proposedBy, { ...proposal, evidence });
        } else if (g.kind === "new" && (g.noClass ?? 0) >= map.LACK_SUGGEST_AT) {
          // No class fits: the entry proposes nothing (no type, label, identifier or trace) until
          // a class exists; it backs a class suggestion.
          const name = map.newInstanceLabel(id, e.view.description);
          lacks.push({
            kind: "class",
            document: e.doc.name,
            sample: {
              kind: "entry",
              document: e.doc.name,
              page: e.view.page,
              line_id: e.line,
              line: map.clip(e.view.context || `${id} ${e.view.description}`, 200),
              box: e.box,
              identifier: id,
              description: map.clip(e.view.description, 160),
              choice: map.NO_CLASS,
              answer: map.answerWords(map.NO_CLASS),
              probability: g.noClass!,
              options: g.classOptions ?? {},
            },
            p: g.noClass!,
            options: g.classOptions ?? {},
            quote: `${map.clip(name, 80)} (p. ${e.view.page}, ${g.noClass!.toFixed(2)})`,
            entry: { name, shape: map.codeShape(id) },
          });
        }
      }

      // Ontology suggestions, one per pattern; then the writes, in parts of 900 proposals.
      const current = [...proposals.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
      if (steps.used + 3 + Math.ceil(current.length / PART) > 64)
        throw new WorkflowError(
          `${current.length} proposals need more steps than one turn of the template holds. Use the LBB-run documents.map.`,
        );
      const filed = await ctx.step("lacks", (s) =>
        suggest(lbb, message.workflow, ontology, lacks, classed, (done, total) =>
          s.progress("filing review items", { done, total, unit: "items" }),
        ),
      );
      const left = [...unmapped, ...filed.unmapped].sort(
        (a, b) =>
          String(a.document).localeCompare(String(b.document)) ||
          Number(a.page) - Number(b.page) ||
          String(a.line_id).localeCompare(String(b.line_id)),
      );
      // The proposals: write what changed, retract what this workflow no longer proposes.
      const existing = proposalReader(lbb, proposedBy);
      const stale = await ctx.step("stale", async () => {
        const have = await existing();
        return [...have.keys()].filter((key) => !proposals.has(key)).length;
      });
      for (let n = 0; n * PART < current.length; n++)
        await lbb.writeOwned(ctx, `write-${n}`, async (s) => {
          s.progress("writing proposals", {
            done: n * PART,
            total: current.length,
            unit: "proposals",
          });
          const have = await existing();
          const changed = current
            .slice(n * PART, (n + 1) * PART)
            .filter(([key, p]) => have.get(key)?.content !== content(p))
            .map(([key, p]) => map.proposalRow(key, p, proposedBy));
          return {
            subjects: changed.map(({ type, name, key }) => ({ type, name, key })),
            properties: Object.keys(map.PROPOSAL_FIELDS),
            entity_properties: changed,
          };
        });
      for (let n = 0; n * PART < stale; n++)
        await lbb.writeOwned(ctx, `retract-${n}`, async (s) => {
          s.progress("writing proposals", { done: n * PART, total: stale, unit: "proposals" });
          const have = await existing();
          const gone = [...have.entries()].filter(([key]) => !proposals.has(key)).slice(0, PART);
          return {
            subjects: [],
            retract_entities: gone.map(([, p]) => entityRef(p.iri, map.FACT_PROPOSAL)),
          };
        });
      return {
        state: {
          runs: state.runs + 1,
          links,
          entries: [...grounded.values()].filter((g) => g.kind === "existing" || g.kind === "new")
            .length,
          proposals: proposals.size,
          suggestions: filed.suggestions,
          unmapped: left.length,
          unmappedLinks: left.slice(0, UNMAPPED_MAX),
        },
      };
    },
  });
}

/** The class an ontology name or IRI names. */
function classNamed(ontology: map.MapOntology, name: string): string | undefined {
  if (ontology.classes.has(name)) return name;
  return [...ontology.classes.values()].find(
    (c) => c.name.toLowerCase() === name.trim().toLowerCase(),
  )?.iri;
}

/** What a proposal's fields hold, to tell a changed proposal from one the graph has already. */
const content = (p: map.Proposal) => JSON.stringify([p.confidence, map.evidenceText(p)]);

/** This workflow's proposals in the graph, by key, read with the commits not yet published. */
function proposalReader(lbb: LbbActivities, proposedBy: string) {
  return async () => {
    const { rows } = await lbb.sparql(
      `# documents-map: proposals\n${P}SELECT ?x ?s ?p ?o ?dt ?c ?ev WHERE {
  ?x a <${map.classIri(map.FACT_PROPOSAL)}> ; p:proposed_by ${JSON.stringify(proposedBy)} ;
     p:fact_subject ?s ; p:fact_predicate ?p ; p:fact_object ?o .
  OPTIONAL { ?x p:fact_datatype ?dt } OPTIONAL { ?x p:fact_confidence ?c } OPTIONAL { ?x p:fact_evidence ?ev }
}`,
      { consistency: "strong" },
    );
    const out = new Map<string, { iri: string; content: string }>();
    for (const r of rows) {
      const statement = {
        subject: r.s!,
        predicate: r.p!,
        object: r.o!,
        ...(r.dt ? { datatype: r.dt } : {}),
      };
      out.set(map.proposalKey(statement, proposedBy), {
        iri: r.x!,
        content: JSON.stringify([num(r.c), r.ev ?? ""]),
      });
    }
    return out;
  };
}

/**
 * File one ontology suggestion per pattern the ontology lacks (`map.relationDraft`,
 * `map.classDraft`). Returns how many it filed, and the lines no suggestion backs as unmapped
 * links.
 */
async function suggest(
  lbb: LbbActivities,
  workflow: string,
  ontology: map.MapOntology,
  lacks: map.Lack[],
  classed: map.ClassedEntry[],
  report: (done: number, total: number) => void = () => {},
): Promise<{ suggestions: number; unmapped: Record<string, unknown>[] }> {
  const patterns = new Map<string, map.Lack[]>();
  for (const lack of lacks) {
    const key = [lack.kind, lack.subjectClass ?? "", lack.objectClass ?? "", lack.document].join(
      "\u0000",
    );
    patterns.set(key, [...(patterns.get(key) ?? []), lack]);
  }
  let suggestions = 0;
  const unmapped: Record<string, unknown>[] = [];
  for (const [n, [key, list]] of [...patterns].entries()) {
    report(n, patterns.size);
    const members = [...list].sort(
      (a, b) => b.p - a.p || (a.quote < b.quote ? -1 : a.quote > b.quote ? 1 : 0),
    );
    const first = members[0]!;
    let draft: map.SuggestionDraft;
    if (first.kind === "property") {
      const drafted = map.relationDraft(
        ontology,
        first.subjectClass!,
        first.objectClass!,
        first.document,
        members,
      );
      if ("unmapped" in drafted) {
        unmapped.push(...drafted.unmapped);
        continue;
      }
      draft = drafted.draft;
    } else draft = map.classDraft(ontology, first.document, members, classed);
    await lbb.review({
      workflow,
      key: `starter:${workflow}:lack:${map.hash(key).slice(0, 24)}`,
      title: draft.title.slice(0, 200),
      rationale: draft.rationale.slice(0, 4_000),
      change: draft.change,
      evidence: { records: draft.records, samples: draft.samples },
    });
    suggestions += 1;
  }
  return { suggestions, unmapped };
}
