// documents-link: find the identifiers the documents of a graph define and the spans that mention
// them, and link each mention to its entry.
//
// A triggered workflow of the starter workflow `workflow` watches the class `Document` and its
// field `parse_status` (LBB's parse writes it), and sends the parsed documents here. The workflow
// reads each document in windows of pages, one window per turn:
//
// 1. Define: the reasoning model (`reason`) lists the identifiers each page defines; they are
//    written as `DocEntry` entities `DEFINED_IN` the document. Every defining window of a message
//    runs before its first link window, so the catalogue holds them all.
// 2. Link: the reasoning model lists the spans of each page that may be codes. Each span gets
//    candidates from the catalogue (every `DocEntry` of the graph) by characters and by meaning
//    (`embed`), and the decision model (`decide`) answers what the span is and which entry it
//    names. A mention is written as a `DocMention` `MENTIONED_IN` the document, with a
//    `REFERS_TO` link to its entry when the link's confidence reaches the gate; a link below the
//    gate becomes a review item.
//
// Each model call runs in a step and passes the step's effect id, so a turn that runs again after
// a crash pays for nothing twice.
import {
  entityRef,
  isActivityRefused,
  LbbError,
  splitInHalves,
  triggeredWorkflow,
  type DecideAnswer,
  type LbbActivities,
  type Schemas,
  type WorkflowContext,
  type WorkflowTriggerMessage,
} from "@littlebigbrain/client";
import * as link from "./link.js";

/** The part of a document: `defines` adds entries, `refers` has its mentions linked, `both` does both. */
export type Role = "defines" | "refers" | "both";

export interface Settings {
  /** A link below this confidence goes to review instead of the graph. */
  gate: number;
  /** The role of each document by file name. A document the map does not name is `both`. */
  roles: Record<string, Role>;
  /** Pages of one window, 1 to 20: one turn reads one window. */
  pagesPerWindow: number;
}

/** The settings: edit them for your documents. The roles are those of the samples. */
export const defaults: Settings = {
  gate: 0.8,
  roles: {
    "ausstattungsliste.pdf": "defines",
    "baubeschreibung.pdf": "defines",
    "raumblaetter.pdf": "refers",
  },
  pagesPerWindow: 12,
};

/** The workflow type and version the triggered workflow names. */
export const workflowType = { workflow_type: "documents-link", version: "v1" };

/** The triggered workflow that sends the documents here: `client.workflows.starters.use(trigger())`. */
export function trigger(): Schemas["TriggeredWorkflowRequest"] {
  return {
    starter: "workflow",
    name: "documents-link",
    watch: { class: "Document", fields: ["parse_status"] },
    workflow: workflowType,
    owns: {
      classes: ["DocEntry", "DocMention"],
      relations: ["DEFINED_IN", "MENTIONED_IN", "REFERS_TO"],
    },
    batch: 16,
  };
}

const FIELD_TYPES: Record<string, string> = { context: "text", line_text: "text", page: "i64" };

/** The classes, properties and relations the workflow writes: `lbb.evolve(ontology())`. */
export function ontology(): Schemas["OntologyEvolveOp"][] {
  const fields = [...new Set([...link.ENTRY_FIELDS, ...link.MENTION_FIELDS])];
  return [
    { op: "add_entity_type", name: "Document" },
    { op: "add_entity_type", name: "DocEntry" },
    { op: "add_entity_type", name: "DocMention" },
    ...fields.map((name) => ({
      op: "add_property" as const,
      name,
      value_type: FIELD_TYPES[name] ?? (/^[xy][01]$/.test(name) ? "f64" : "keyword"),
    })),
    { op: "add_relation", name: "DEFINED_IN", domain: ["DocEntry"], range: ["Document"] },
    { op: "add_relation", name: "MENTIONED_IN", domain: ["DocMention"], range: ["Document"] },
    { op: "add_relation", name: "REFERS_TO", domain: ["DocMention"], range: ["DocEntry"] },
  ];
}

/** What the workflow has written, over all its turns. */
export interface LinkState {
  entries: number;
  mentions: number;
  links: number;
  review: number;
}

/** A trigger message; a continued turn names the window it reads in `cursor`. */
type LinkMessage = WorkflowTriggerMessage & { cursor?: number };
interface Doc extends link.Doc {
  pages: number;
  parsed: boolean;
}
interface Window {
  stage: "define" | "link";
  doc: number;
  from: number;
  to: number;
}

const P = "PREFIX p: <https://littlebigbrain.com/p/>\nPREFIX r: <https://littlebigbrain.com/r/>\n";
const ENTRY_CLASS = "https://littlebigbrain.com/class/docentry";
const MENTION_CLASS = "https://littlebigbrain.com/class/docmention";
const values = (iris: string[]) =>
  iris
    .filter((iri) => /^[^\s<>"{}|\\^`]+$/.test(iri))
    .map((iri) => `<${iri}>`)
    .join(" ");
const label = (doc: Doc, page: number, what: string) =>
  `${doc.name.slice(0, 40)} p${page + 1} ${what}`;
/** The effect id of the `n`th call of one kind in a step: the step's own, then `.1`, `.2`, … */
const effect = (id: string, n: number) => (n === 0 ? id : `${id}.${n}`);

/** The workflow, for a `WorkflowWorker`. `lbb` is `lbbActivities(client)`, or a mock in a test. */
export function createWorkflow(lbb: LbbActivities, settings: Settings = defaults) {
  if (!(settings.pagesPerWindow >= 1 && settings.pagesPerWindow <= 20))
    throw new RangeError("pagesPerWindow is from 1 to 20: a turn holds 64 steps");
  return triggeredWorkflow<LinkState>({
    name: workflowType.workflow_type,
    version: workflowType.version,
    initialState: { entries: 0, mentions: 0, links: 0, review: 0 },
    async onInstances(ctx, message: LinkMessage, state) {
      const docs = await ctx.step("documents", () => readDocuments(lbb, message));
      if (message.cursor === undefined) {
        const gone = [...message.removed, ...docs.filter((d) => !d.parsed).map((d) => d.iri)];
        if (gone.length) await dropOutputs(ctx, lbb, gone);
      }
      const plan = windows(docs, settings);
      const at = message.cursor ?? 0;
      const w = plan[at];
      if (!w) return { state };
      const doc = docs[w.doc]!;
      const next =
        w.stage === "define"
          ? await define(ctx, lbb, doc, w, state)
          : await linkMentions(ctx, lbb, doc, w, state, settings, message.workflow);
      if (at + 1 === plan.length) return { state: next };
      return ctx.continue(next, { ...message, removed: [], cursor: at + 1 });
    },
  });
}

/** The windows of a message: every defining window first, so the catalogue is complete before a link. */
function windows(docs: Doc[], settings: Settings): Window[] {
  const roleOf = (doc: Doc) =>
    Object.entries(settings.roles).find(([name]) => name.normalize() === doc.name.normalize())?.[1];
  const of = (stage: Window["stage"], skip: Role) =>
    docs.flatMap((doc, i) => {
      if (!doc.parsed || roleOf(doc) === skip) return [];
      const out: Window[] = [];
      for (let from = 0; from < doc.pages; from += settings.pagesPerWindow)
        out.push({ stage, doc: i, from, to: Math.min(doc.pages, from + settings.pagesPerWindow) });
      return out;
    });
  return [...of("define", "refers"), ...of("link", "defines")];
}

/** The name, file and parse of each document, at the message's commit. */
async function readDocuments(lbb: LbbActivities, message: WorkflowTriggerMessage): Promise<Doc[]> {
  if (!message.instances.length) return [];
  const query = `# documents-link: documents\n${P}SELECT ?doc ?name ?sha ?status ?pages WHERE {
  VALUES ?doc { ${values(message.instances)} }
  OPTIONAL { ?doc p:name ?name } OPTIONAL { ?doc p:file_sha256 ?sha }
  OPTIONAL { ?doc p:parse_status ?status } OPTIONAL { ?doc p:page_count ?pages }
}`;
  const { rows } = await lbb.sparql({ query, as_of_commit_seq: message.as_of_commit_seq });
  return message.instances.map((iri) => {
    const row = rows.find((r) => r.doc === iri) ?? {};
    const parsed = row.status === "parsed" && Boolean(row.sha);
    return {
      iri,
      name: row.name ?? iri,
      sha256: row.sha ?? "",
      pages: Number(row.pages ?? 0),
      parsed,
    };
  });
}

/** Retract the entries and mentions of documents that left the class or lost their parse. */
async function dropOutputs(ctx: WorkflowContext, lbb: LbbActivities, gone: string[]) {
  const found = await ctx.step("drop-find", async () => {
    // Deleting a file retracts the edges to its Document: its entries and mentions are left without one.
    const query = `# documents-link: outputs\n${P}SELECT ?entity ?class WHERE {
  { VALUES ?doc { ${values(gone)} } ?entity r:defined_in|r:mentioned_in ?doc }
  UNION { ?entity a <${ENTRY_CLASS}> FILTER NOT EXISTS { ?entity r:defined_in ?any } }
  UNION { ?entity a <${MENTION_CLASS}> FILTER NOT EXISTS { ?entity r:mentioned_in ?any } }
  ?entity a ?class .
}`;
    const { rows } = await lbb.sparql(query, { consistency: "strong" });
    return rows
      .filter((r) => r.class === ENTRY_CLASS || r.class === MENTION_CLASS)
      .map((r) => ({ iri: r.entity!, type: r.class === ENTRY_CLASS ? "DocEntry" : "DocMention" }));
  });
  const retract = found.map((e) => entityRef(e.iri, e.type));
  if (retract.length)
    await lbb.writeOwned(ctx, "drop", { subjects: [], retract_entities: retract });
}

/** The pages of the window and the catalogue, read inside the steps that need them, once per attempt. */
function reader(lbb: LbbActivities, doc: Doc, w: Window) {
  let pages: Promise<link.FilePage[]> | undefined;
  let catalogue: Promise<link.Entry[]> | undefined;
  const query = `# documents-link: catalogue\n${P}SELECT ?identifier ?context ?line ?doc ?name ?sha WHERE {
  ?entry a <${ENTRY_CLASS}> ; p:identifier ?identifier ; r:defined_in ?doc .
  ?doc p:name ?name ; p:file_sha256 ?sha .
  OPTIONAL { ?entry p:context ?context } OPTIONAL { ?entry p:line_id ?line }
}`;
  const read = {
    pages: () => (pages ??= lbb.pages(doc.sha256, { from: w.from, to: w.to }).then((r) => r.pages)),
    page: async (page: number) => (await read.pages())[page - w.from]!,
    /** Every entry of the graph, this workflow's own writes included, in a stable order. */
    catalogue: () =>
      (catalogue ??= lbb.sparql(query, { consistency: "strong" }).then(({ rows }) =>
        rows
          .map((r) => ({
            identifier: r.identifier!,
            context: r.context ?? r.identifier!,
            line: r.line ?? "",
            document: r.doc!,
            documentName: r.name!,
            sha256: r.sha!,
          }))
          .sort((a, b) => link.order(a).localeCompare(link.order(b))),
      )),
  };
  return read;
}

/** A define window: each page's definitions, then the window's entries, owned per entry. */
async function define(
  ctx: WorkflowContext,
  lbb: LbbActivities,
  doc: Doc,
  w: Window,
  state: LinkState,
): Promise<LinkState> {
  const read = reader(lbb, doc, w);
  const found: link.Definition[] = [];
  for (let page = w.from; page < w.to; page++) {
    const kept = await ctx.step(`define-p${page + 1}`, async (s) => {
      const p = await read.page(page);
      const answer = await lbb.reason(link.definitionsRequest(p), {
        effectId: s.effectId,
        label: label(doc, page, "definitions"),
      });
      return link.checkDefinitions(answer.value, p);
    });
    found.push(...kept);
  }
  // A commit names at most 1,000 entities: the entries go in parts of at most 900.
  const count = new Set(found.map((d) => d.identifier)).size;
  for (let n = 0; n * link.PART < count; n++)
    await lbb.writeOwned(ctx, `entries-${n}`, async () =>
      link.part(link.entriesWrite(doc, await read.pages(), found), n),
    );
  return { ...state, entries: state.entries + count };
}

/** A link window: each page's mentions, their candidates and answers, the gate, the writes. */
async function linkMentions(
  ctx: WorkflowContext,
  lbb: LbbActivities,
  doc: Doc,
  w: Window,
  state: LinkState,
  settings: Settings,
  workflow: string,
): Promise<LinkState> {
  const read = reader(lbb, doc, w);
  const pages = Array.from({ length: w.to - w.from }, (_, n) => w.from + n);
  const mentions: link.Mention[][] = [];
  for (const page of pages) {
    const kept = await ctx.step(`mention-p${page + 1}`, async (s) => {
      const p = await read.page(page);
      const answer = await lbb.reason(link.mentionsRequest(p), {
        effectId: s.effectId,
        label: label(doc, page, "mentions"),
      });
      return link.checkMentions(answer.value, p);
    });
    mentions.push(kept);
  }
  const byMeaning = await ctx.step("meaning", (s) => meaning(s.effectId, lbb, doc, read, mentions));
  const resolved: link.Resolved[][] = [];
  for (const [n, page] of pages.entries()) {
    const answers = await ctx.step(`decide-p${page + 1}`, (s) =>
      decidePage(s.effectId, lbb, doc, read, page, mentions[n]!, byMeaning[n]!),
    );
    resolved.push(answers);
  }

  // The link rule, then the gate: written, or a review item, or no link.
  const all = mentions.flatMap((list, n) =>
    list.map((m, k) => ({
      m,
      page: pages[n]!,
      ...link.linkRule(resolved[n]![k]!),
      r: resolved[n]![k]!,
    })),
  );
  const written = all.filter((x) => x.target !== null && x.confidence >= settings.gate);
  const below = all.filter((x) => x.target !== null && x.confidence < settings.gate);
  await ctx.step("review", async () => {
    const catalogue = await read.catalogue();
    // One item per span and entry: S1.1 on two pages is one item with two links.
    const groups = new Map<string, typeof below>();
    for (const x of below) {
      const key = `${link.identifierKey(x.m.span)}\u0000${x.target}`;
      groups.set(key, [...(groups.get(key) ?? []), x]);
    }
    // An item holds at most 100 links, so its facts stay within the 64 KiB a suggestion takes.
    const items = [...groups.values()].flatMap((group) =>
      Array.from({ length: Math.ceil(group.length / 100) }, (_, n) => ({
        n,
        group: group.slice(n * 100, (n + 1) * 100),
      })),
    );
    for (const { n, group } of items) {
      const entry = catalogue[group[0]!.target!]!;
      const span = group[0]!.m.span;
      const lowest = Math.min(...group.map((x) => x.confidence));
      const pages = await read.pages();
      const triplets = group.map((x) => link.refersTo(doc, pages, x.m, entry, x.confidence));
      await lbb.review({
        workflow,
        key: `starter:${workflow}:link:${doc.sha256.slice(0, 16)}:${link.keyPart(span)}:${entry.sha256.slice(0, 16)}:${link.keyPart(entry.identifier)}:${n}`,
        title: `Link "${span}" in ${doc.name} to ${entry.identifier}`.slice(0, 200),
        rationale: `${group.length} mentions of "${span}" in ${doc.name} name the entry ${entry.identifier} with a confidence below the gate ${settings.gate} (lowest ${lowest}).`,
        facts: {
          triplets,
          summary: `${triplets.length} REFERS_TO links from "${span}" to ${entry.identifier}`,
        },
        evidence: {
          records: group.length,
          samples: group
            .slice(0, 20)
            .map((x) => ({ page: x.page, line_id: x.m.line, confidence: x.confidence })),
        },
      });
    }
    return items.length;
  });
  for (let n = 0; n * link.PART < all.length; n++)
    await lbb.writeOwned(ctx, `mentions-${n}`, async () => {
      const [pages, catalogue] = [await read.pages(), await read.catalogue()];
      const links = written.map((x) => ({ ...x, entry: catalogue[x.target!]! }));
      return link.part(link.mentionsWrite(doc, pages, all, links), n);
    });
  return {
    entries: state.entries,
    mentions: state.mentions + all.length,
    links: state.links + written.length,
    review: state.review + below.length,
  };
}

/** The catalogue's entries closest in meaning to each mention (`span — row`), per page. */
async function meaning(
  effectId: string,
  lbb: LbbActivities,
  doc: Doc,
  read: ReturnType<typeof reader>,
  mentions: link.Mention[][],
): Promise<number[][][]> {
  const none = () => mentions.map((list) => list.map(() => []));
  const catalogue = await read.catalogue();
  const queries: string[] = [];
  for (const list of mentions)
    for (const m of list)
      queries.push(
        `${m.span} — ${link.rowOf(
          (await read.pages()).flatMap((p) => p.lines),
          m.line,
        )}`,
      );
  if (!catalogue.length || !queries.length) return none();
  const texts = [...catalogue.map((e) => `${e.identifier}: ${e.context}`), ...queries].map((t) =>
    t.slice(0, 8_000),
  );
  const vectors: number[][] = [];
  try {
    for (let n = 0; n * 256 < texts.length; n++) {
      const chunk = texts.slice(n * 256, (n + 1) * 256);
      const embedded = await lbb.embed(
        { texts: chunk },
        { effectId: effect(effectId, n), label: `${doc.name.slice(0, 40)} meaning` },
      );
      vectors.push(...embedded.vectors);
    }
  } catch (error) {
    // Without an embedding model the candidates come by characters only.
    if (error instanceof LbbError && error.code === "activity_model_unavailable") return none();
    throw error;
  }
  const entries = vectors.slice(0, catalogue.length);
  let next = catalogue.length;
  return mentions.map((list) => list.map(() => link.nearest(vectors[next++]!, entries)));
}

/** The decision model's answers for one page's mentions: a refused request is split in halves. */
async function decidePage(
  effectId: string,
  lbb: LbbActivities,
  doc: Doc,
  read: ReturnType<typeof reader>,
  page: number,
  mentions: link.Mention[],
  byMeaning: number[][],
): Promise<link.Resolved[]> {
  if (!mentions.length) return [];
  const catalogue = await read.catalogue();
  const p = await read.page(page);
  const asked = mentions.map((mention, position) => ({
    position,
    mention,
    lineText: p.lines.find((l) => l.id === mention.line)!.text,
    candidates: link.candidatesFor(mention, doc.iri, catalogue, byMeaning[position]!),
  }));
  const state = link.pageState(doc.name, p, catalogue);
  const answers: Record<string, DecideAnswer> = {};
  const ask = async (part: link.Asked[], id: string): Promise<void> => {
    try {
      const request = link.decideRequest(state, part, catalogue);
      const answered = await lbb.decide(request, {
        effectId: id,
        label: label(doc, page, "resolve"),
      });
      Object.assign(answers, answered.answers);
    } catch (error) {
      if (!isActivityRefused(error)) throw error;
      // Too large for the model: ask each half. One mention the model refuses stays unanswered.
      const halves = splitInHalves(part);
      if (halves) for (const [n, half] of halves.entries()) await ask(half, `${id}.${n}`);
    }
  };
  const requests = link.packRequests(state, asked, catalogue);
  for (const [n, part] of requests.entries()) await ask(part, effect(effectId, n));
  return asked.map(({ position }) =>
    link.resolve(answers[`m${position}-kind`], answers[`m${position}-names`]),
  );
}
