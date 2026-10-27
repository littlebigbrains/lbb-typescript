// documents-check: the differences between documents, as review items.
//
// The shapes of `shapes.ttl` run on the graph's extracted values after each
// publication, and the conformance report lists the documents that break a
// rule. A named workflow watches every field of the class `BusinessDocument`
// (a changed value, or the removal of a document) and the answers to its own
// review items. Each message runs one check:
//
// 1. read the conformance report. For a message about a commit, wait until the
//    report covers that commit. `ctx.sleep` releases the worker between reads.
//    A report that is still behind after one turn's waits does not fail the
//    turn: the turn ends with a continuation, which is a new turn with fresh
//    steps. A turn's saved steps are kept for its retries, so a turn that threw
//    after saving "not ready" would throw again at once, for good;
// 2. in one step, read the documents the results name at the report's commit,
//    drop the results that have a review item already (open or answered), find
//    the quotes of the first `candidatesPerTurn` in their files' parsed pages,
//    and build their review items. The step returns the requests and the keys
//    only, so its output stays under the engine's 64 KiB. What the cap leaves
//    over goes to the next turn, by a continuation;
// 3. file one `choice` review item per result, with the quotes of both
//    documents as its evidence. The key holds a hash of the quotes: the same
//    difference is the same item, and a difference with other quotes is a new
//    item;
// 4. withdraw the open items whose difference the report does not list any
//    more (a person corrected a value, or a file changed). Only a turn that read
//    the whole report and could name the key of every result withdraws.
//
// The workflow writes no fact. It makes no payment, approval or compliance
// decision. Each item is a candidate for a person to check.
import {
  LbbError,
  stableHashHex,
  triggeredWorkflow,
  type LbbActivities,
  type LbbClient,
  type ReviewItemRequest,
  type Schemas,
  type WorkflowContext,
  type WorkflowTriggerMessage,
} from "@littlebigbrain/client";
import { CLASS_IRI, checkOfShape, checks, type Check, type Doc } from "./checks.js";
import { DOCUMENT_CLASS, sparqlAt, type PageOf } from "./texts.js";

/** The workflow type and version the named workflow names. */
export const checkType = { workflow_type: "documents-check", version: "v1" };
export const CHECK_NAME = "documents-check";

/** The numbers among the extracted properties: the rest are text. */
const NUMBERS = new Set(["quantity", "price", "total"]);

/** Results of the report one turn reads: with their keys, a step keeps at most 64 KiB. */
const REPORT_RESULTS = 150;

/** What the review requests of one turn may weigh, in UTF-8 bytes: the engine's step limit is 64 KiB, and the keys share it. */
const ITEMS_BYTES = 40 * 1024;

/** The waits of one turn for a report that does not cover its commit yet: 60 s over 6 reads. */
const WAITS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
const TURN_WAIT_MS = WAITS_MS.reduce((sum, wait) => sum + wait, 0);

/** The most a message waits for the report, over all its turns. After it the message ends as not checked. */
const MAX_WAIT_MS = 30 * 60_000;

/** Turns one message may add to file what `candidatesPerTurn` left over. */
const MAX_ROUNDS = 20;

/** The UTF-8 size of a value as JSON: the engine counts bytes. */
const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export interface Settings {
  /** Review items one turn builds and files, 1 to 40. A report with more new results files the rest in later turns. */
  candidatesPerTurn: number;
}

/** The settings: edit them for your documents. */
export const defaults: Settings = { candidatesPerTurn: 25 };

/** The options of a `choice` item: what a person says about a difference. */
export const OPTIONS = [
  { id: "discrepancy", label: "A real difference: follow it up" },
  { id: "misread", label: "A value was read wrongly: correct it" },
  { id: "acceptable", label: "Acceptable: no action" },
];

/**
 * The named workflow: the documents (a change of any field, or the removal of
 * one) and the answers to its items. It watches every field of the documents'
 * common class, so the removal of a document, which changes no `ValueSource`,
 * wakes it too.
 *
 * `on_exhausted: skip` is a safety net. A turn that failed for good would
 * otherwise hold the inbox of the only shard until a person retries it, and the
 * next message re-runs the whole check anyway.
 */
export function checkWorkflow(): Schemas["NamedWorkflowRequest"] {
  return {
    name: CHECK_NAME,
    workflow: checkType,
    shards: 1,
    batch: 64,
    on_exhausted: "skip",
    triggers: [
      { id: "documents", watch: { class: DOCUMENT_CLASS } },
      { id: "review", review: {} },
    ],
  };
}

/** What a client reads for the workflow beside the activities. An `LbbClient` has both. */
export interface CheckPorts {
  /** The published SHACL conformance report: the latest one, which may cover an earlier commit. */
  conformance(): Promise<Schemas["SchemaAuditReport"]>;
  /** The open review items this workflow filed, with their keys. */
  openItems(): Promise<{ id: string; key: string }[]>;
  /** Withdraw an item as its producer. */
  withdraw(id: string, reason: string): Promise<unknown>;
}

export function checkPorts(client: LbbClient): CheckPorts {
  return {
    conformance: () => client.ontology.conformance({ consistency: "eventual", limit: 500 }),
    openItems: async () => {
      const items: { id: string; key: string }[] = [];
      for await (const item of client.reviews.all({
        originId: `starter:${CHECK_NAME}`,
        status: "open",
        kind: "choice",
        limit: 500,
      }))
        items.push({ id: item.id, key: item.key });
      return items;
    },
    withdraw: (id, reason) => client.reviews.withdraw(id, reason),
  };
}

/** What the workflow has done, over all its turns. */
export interface CheckState {
  /** Differences the last report listed. */
  candidates: number;
  /** Review items filed or updated. */
  filed: number;
  /** Open items withdrawn because the difference is gone. */
  withdrawn: number;
  /** Differences left out: a result past the report window, a document the check could not read, or a missing quote. */
  skipped: number;
  /** Messages that ended as not checked: the report did not cover their commit within the wait cap. Nothing was filed or withdrawn. */
  unchecked: number;
}

/** A trigger message; a continued message carries the wait so far and the rounds so far. */
export type CheckMessage = WorkflowTriggerMessage & { waited_ms?: number; rounds?: number };

/** A result of the report, for one of this template's shapes. */
interface Found {
  check: string;
  focus: string;
  /** The document the rule compared with, when the result's value is one. */
  other?: string;
}

/** An evidence quote of a review item. */
type Evidence = Schemas["ReviewEvidence"];

const P = "PREFIX p: <https://littlebigbrain.com/p/>\nPREFIX r: <https://littlebigbrain.com/r/>\n";
const RDF =
  "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\nPREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n";
const LBB = "PREFIX lbb: <https://littlebigbrain.com/ns#>\n";

/** The IRI in an N-Triples term (`<iri>`), or undefined for a literal or a blank node. */
function iriOf(term: string | null | undefined): string | undefined {
  return term?.startsWith("<") && term.endsWith(">") ? term.slice(1, -1) : undefined;
}

/** The results of the report that belong to this template's shapes. */
export function foundIn(report: Schemas["SchemaAuditReport"]): Found[] {
  const out: Found[] = [];
  for (const result of report.results ?? []) {
    const check = checkOfShape(iriOf(result.source_node_shape) ?? "");
    const focus = iriOf(result.focus_node);
    if (!check || !focus) continue;
    out.push({
      check: check.id,
      focus,
      ...(iriOf(result.value) ? { other: iriOf(result.value) } : {}),
    });
  }
  // A stable order: the files and the keys do not depend on the report's.
  return out.sort((a, b) =>
    `${a.check} ${a.focus} ${a.other}`.localeCompare(`${b.check} ${b.focus} ${b.other}`),
  );
}

/** The documents the results name, with their values and quotes, at commit `seq` (the report's). */
async function readDocs(
  lbb: LbbActivities,
  found: Found[],
  seq: number | undefined,
): Promise<Doc[]> {
  const named = [...new Set(found.flatMap((f) => [f.focus, ...(f.other ? [f.other] : [])]))];
  if (!named.length) return [];
  const classes = Object.values(CLASS_IRI)
    .map((iri) => `<${iri}>`)
    .join(" ");
  const query = `# documents-check: documents\n${P}${RDF}${LBB}SELECT ?doc ?class ?name ?file ?sha ?property ?value ?quote ?commit WHERE {
  VALUES ?doc { ${named.map((iri) => `<${iri}>`).join(" ")} } VALUES ?class { ${classes} }
  ?doc a ?class ; rdfs:label ?name .
  OPTIONAL { ?doc r:text_of ?file . ?file p:file_sha256 ?sha }
  OPTIONAL {
    ?doc r:has_value_source ?source . ?source p:property ?property ; p:value ?value .
    OPTIONAL { ?statement rdf:subject ?doc ; rdf:predicate r:has_value_source ; rdf:object ?source ; lbb:evidenceText ?quote . OPTIONAL { ?statement lbb:commit ?commit } }
  }
}`;
  const { rows } = await sparqlAt(lbb, query, seq);
  const docs = new Map<string, Doc>();
  // A value that changed keeps its older quotes as evidence, one statement per commit: the newest one states the value in force.
  const newest = new Map<string, number>();
  for (const row of rows) {
    if (!row.doc || !row.class) continue;
    const className = Object.entries(CLASS_IRI).find(([, iri]) => iri === row.class)?.[0];
    if (!className) continue;
    let doc = docs.get(row.doc);
    if (!doc) {
      doc = {
        iri: row.doc,
        className,
        name: row.name ?? row.doc,
        ...(row.file && row.sha ? { file: { iri: row.file, sha256: row.sha } } : {}),
        values: {},
      };
      docs.set(row.doc, doc);
    }
    if (!row.property || row.value === undefined) continue;
    const at = `${row.doc} ${row.property}`;
    const commit = Number(row.commit ?? -1);
    if (doc.values[row.property] && commit < (newest.get(at) ?? -1)) continue;
    newest.set(at, commit);
    doc.values[row.property] = {
      value: NUMBERS.has(row.property) ? Number(row.value) : row.value,
      ...(row.quote ? { quote: row.quote } : {}),
    };
  }
  return [...docs.values()];
}

/** Whitespace as single spaces. */
const squash = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

/** Where a quote is in a file: its page (0-based) and the box of its line, normalized to the page. */
export interface Place {
  page: number;
  box: number[];
}

/** The page and box of the first line that holds `quote`, or undefined. */
export function locate(pages: readonly PageOf[], quote: string): Place | undefined {
  const wanted = squash(quote);
  if (!wanted) return undefined;
  for (const page of pages)
    for (const line of page.lines)
      if (squash(line.text).includes(wanted)) return { page: page.page, box: line.box };
  return undefined;
}

/** The place of each quote that a file's pages hold. */
export function placesOf(
  pages: readonly PageOf[],
  quotes: readonly string[],
): Record<string, Place> {
  const out: Record<string, Place> = {};
  for (const quote of quotes) {
    const at = locate(pages, quote);
    if (at) out[quote] = at;
  }
  return out;
}

/** The places of the quotes of each file, by the file's SHA-256. */
export type Places = ReadonlyMap<string, Record<string, Place>>;

/** The evidence of one quote: where it is, as far as the file's pages say. */
function evidenceOf(doc: Doc, quote: string, places: Places): Evidence {
  const at = doc.file ? places.get(doc.file.sha256)?.[quote] : undefined;
  const source = doc.file ? doc.file.iri : doc.name;
  if (!at) return { quote, source_id: source };
  const [x0, y0, x1, y1] = at.box as [number, number, number, number];
  return {
    quote,
    source_id: `${source}#page=${at.page + 1}`,
    region: { page: at.page, x0, y0, x1, y1, confidence: 1 },
  };
}

/** The quotes a result's item shows, in order, or undefined when a document or a quote is missing. */
function quotesOf(check: Check, focus: Doc, other: Doc | undefined) {
  const out: { doc: Doc; quote: string }[] = [];
  for (const wanted of check.evidence) {
    const doc = wanted.side === "focus" ? focus : other;
    const quote = doc?.values[wanted.property]?.quote;
    if (!doc || !quote) return undefined;
    out.push({ doc, quote });
  }
  return out;
}

/** The key of a result's review item: the same difference is the same item. */
function keyOf(
  workflow: string,
  check: Check,
  focus: Doc,
  other: Doc | undefined,
  quotes: readonly { quote: string }[],
): string {
  const hash = stableHashHex([focus.iri, other?.iri ?? "", ...quotes.map((q) => q.quote)]).slice(
    0,
    24,
  );
  return `starter:${workflow}:${check.id}:${hash}`;
}

/** A review item to file: the request, and the key that makes a repeat the same item. */
export interface Candidate {
  key: string;
  request: ReviewItemRequest;
}

/** The review item of a result, or undefined when a document or a quote is missing. */
export function candidateOf(
  workflow: string,
  check: Check,
  focus: Doc,
  other: Doc | undefined,
  places: Places,
): Candidate | undefined {
  const quotes = quotesOf(check, focus, other);
  if (!quotes) return undefined;
  const key = keyOf(workflow, check, focus, other, quotes);
  return {
    key,
    request: {
      kind: "choice",
      key,
      title: check.title(focus, other).slice(0, 200),
      rationale:
        `Rule: ${check.rule} ` +
        "The check found a difference between values that were read from the documents. " +
        "It makes no payment, approval or compliance decision. A person decides what the difference means.",
      subject: { iri: focus.iri, type: focus.className, name: focus.name },
      question: { options: OPTIONS, proposed: "discrepancy" },
      evidence: quotes.map(({ doc, quote }) => evidenceOf(doc, quote, places)),
      workflow,
    },
  };
}

/** What the candidates step returns: the requests to file and the keys of every result, never a document or a page. */
interface Built {
  candidates: Candidate[];
  /** The key of every result the step could name: an open item under another key is stale. */
  keys: string[];
  /** Results with no key: a document or a quote is missing. */
  unreadable: number;
  /** New results past the turn's share: the next turn files them. */
  remaining: number;
}

/** Keys one read of `reviewItems` names, at most. */
const KEYS_PER_READ = 100;

/**
 * One step's work. Read the documents the results name at the report's commit,
 * leave out the results whose item exists (open or answered: an item answered
 * "Acceptable" stays in the report, and must not push new differences out), take
 * the first `candidatesPerTurn`, find their quotes in the files' pages, and build
 * the requests. A withdrawn item with the same key is filed again: the
 * difference is back.
 */
async function buildCandidates(
  lbb: LbbActivities,
  workflow: string,
  found: Found[],
  settings: Settings,
  seq: number | undefined,
): Promise<Built> {
  const docs = await readDocs(lbb, found, seq);
  const planned: { key: string; check: Check; focus: Doc; other: Doc | undefined }[] = [];
  let unreadable = 0;
  for (const result of found) {
    const check = checks.find((c) => c.id === result.check)!;
    const focus = docs.find((d) => d.iri === result.focus);
    const other = result.other ? docs.find((d) => d.iri === result.other) : undefined;
    const quotes = focus && (!result.other || other) ? quotesOf(check, focus, other) : undefined;
    if (!focus || !quotes) unreadable += 1;
    else planned.push({ key: keyOf(workflow, check, focus, other, quotes), check, focus, other });
  }
  const keys = [...new Set(planned.map((p) => p.key))];

  const existing = new Set<string>();
  for (let from = 0; from < keys.length; from += KEYS_PER_READ)
    for (const item of await lbb.reviewItems(keys.slice(from, from + KEYS_PER_READ)))
      if (item.status !== "withdrawn") existing.add(item.key);
  const fresh = planned.filter((p) => !existing.has(p.key));
  const chosen = fresh.slice(0, settings.candidatesPerTurn);

  // Where each quote is in its file: the pages of the chosen results' files are read once, here, and never saved.
  const wanted = new Map<string, string[]>();
  for (const p of chosen)
    for (const { doc, quote } of quotesOf(p.check, p.focus, p.other) ?? [])
      if (doc.file) wanted.set(doc.file.sha256, [...(wanted.get(doc.file.sha256) ?? []), quote]);
  const places = new Map<string, Record<string, Place>>();
  for (const [sha256, quotes] of wanted) {
    try {
      places.set(sha256, placesOf((await lbb.pages(sha256)).pages as PageOf[], quotes));
    } catch (error) {
      // A file with no pages: its quotes have no page, and the evidence names the file.
      if (!(error instanceof LbbError)) throw error;
    }
  }
  const candidates: Candidate[] = [];
  let bytes = 0;
  let cut = 0;
  for (const p of chosen) {
    const candidate = candidateOf(workflow, p.check, p.focus, p.other, places)!;
    const size = bytesOf(candidate);
    if (bytes + size > ITEMS_BYTES) cut += 1;
    else {
      candidates.push(candidate);
      bytes += size;
    }
  }
  return { candidates, keys, unreadable, remaining: fresh.length - chosen.length + cut };
}

/** A report that covers the commit, or a wait. */
type ReportRead =
  | { ready: false }
  | { ready: true; found: Found[]; total: number; truncated: boolean; seq?: number };

/**
 * The conformance report at or after commit `need` (any report when `need` is
 * undefined), or `{ ready: false }` when it is still behind after one turn's
 * waits. `ctx.sleep` is a durable timer, so no worker is held. It never throws
 * for a report that is not ready: the saved steps of a turn are kept for its
 * retries, and a throw would repeat for good.
 */
async function readReport(
  ctx: WorkflowContext,
  ports: CheckPorts,
  need: number | undefined,
): Promise<ReportRead> {
  for (let attempt = 0; attempt <= WAITS_MS.length; attempt++) {
    const read = await ctx.step(`report-${attempt}`, async (): Promise<ReportRead> => {
      let report: Schemas["SchemaAuditReport"];
      try {
        report = await ports.conformance();
      } catch (error) {
        // 429: no report covers the head yet.
        if (error instanceof LbbError && error.status === 429) return { ready: false };
        throw error;
      }
      const seq =
        report.validated_at_seq === undefined ? undefined : Number(report.validated_at_seq);
      if (need !== undefined && (seq ?? -1) < need) return { ready: false };
      const found = foundIn(report);
      return {
        ready: true,
        found: found.slice(0, REPORT_RESULTS),
        total: found.length,
        truncated: Boolean(report.truncated) || found.length > REPORT_RESULTS,
        ...(seq === undefined ? {} : { seq }),
      };
    });
    if (read.ready) return read;
    const wait = WAITS_MS[attempt];
    if (wait === undefined) return read;
    await ctx.sleep(`wait-${attempt}`, wait);
  }
  return { ready: false };
}

/** What a check turn did, and the continuation it asks for, if any. */
interface Turn {
  state: CheckState;
  next?: { waited_ms: number; rounds: number };
}

/**
 * The check, for a message of either trigger. `need` is the commit the report
 * must cover, if any. `message` is the trigger message of an instances message,
 * which can continue: an answer to an item cannot, and it changes no fact, so a
 * report that is not there is not worth a wait.
 */
async function runChecks(
  ctx: WorkflowContext,
  lbb: LbbActivities,
  ports: CheckPorts,
  settings: Settings,
  workflow: string,
  message: { need?: number; waitedMs: number; rounds: number; canContinue: boolean },
  state: CheckState,
): Promise<Turn> {
  const report = await readReport(ctx, ports, message.need);
  if (!report.ready) {
    // Not checked yet. A message that can continue waits in a new turn, up to the cap.
    const waited = message.waitedMs + TURN_WAIT_MS;
    if (message.canContinue && waited < MAX_WAIT_MS)
      return { state, next: { waited_ms: waited, rounds: message.rounds } };
    return { state: { ...state, unchecked: state.unchecked + 1 } };
  }

  const built = await ctx.step("candidates", () =>
    buildCandidates(lbb, workflow, report.found, settings, report.seq),
  );
  await ctx.step("file", async () => {
    for (const candidate of built.candidates) await lbb.review(candidate.request);
    return built.candidates.length;
  });

  // An open item whose difference is gone. Only a whole report whose every result has a key says so.
  let withdrawn = 0;
  if (!report.truncated && built.unreadable === 0) {
    const keys = new Set(built.keys);
    // One step lists and withdraws, so a replay never acts on a list that is out of date. An item
    // that a person answered since the list refuses the withdrawal (400, 404 or 409): it stays.
    withdrawn = await ctx.step("withdraw", async () => {
      let count = 0;
      for (const item of await ports.openItems()) {
        if (keys.has(item.key)) continue;
        try {
          await ports.withdraw(item.id, "The check no longer finds this difference.");
          count += 1;
        } catch (error) {
          if (!(error instanceof LbbError && [400, 404, 409].includes(error.status))) throw error;
        }
      }
      return count;
    });
  }
  // The results past this turn's share: a later turn files them, up to the cap on rounds.
  const more = built.remaining > 0 && message.canContinue && message.rounds < MAX_ROUNDS;
  const left = more ? 0 : built.remaining;
  // What the first turn of a message finds out of reach counts once: the continuations read the same report.
  const first = message.rounds === 0;
  const unreached = first
    ? built.unreadable + (report.truncated ? report.total - report.found.length : 0)
    : 0;
  const next = {
    state: {
      candidates: report.total,
      filed: state.filed + built.candidates.length,
      withdrawn: state.withdrawn + withdrawn,
      skipped: state.skipped + unreached + left,
      unchecked: state.unchecked,
    },
  };
  return more ? { ...next, next: { waited_ms: 0, rounds: message.rounds + 1 } } : next;
}

/** The workflow, for a `WorkflowWorker`. `lbb` is `lbbActivities(client)` and `ports` is `checkPorts(client)`, or mocks in a test. */
export function createCheckWorkflow(
  lbb: LbbActivities,
  ports: CheckPorts,
  settings: Settings = defaults,
) {
  if (!(settings.candidatesPerTurn >= 1 && settings.candidatesPerTurn <= 40))
    throw new RangeError("candidatesPerTurn is from 1 to 40");
  return triggeredWorkflow<CheckState>({
    name: checkType.workflow_type,
    version: checkType.version,
    initialState: { candidates: 0, filed: 0, withdrawn: 0, skipped: 0, unchecked: 0 },
    async onInstances(ctx, message: CheckMessage, state) {
      const turn = await runChecks(
        ctx,
        lbb,
        ports,
        settings,
        message.workflow,
        {
          need: message.as_of_commit_seq,
          waitedMs: message.waited_ms ?? 0,
          rounds: message.rounds ?? 0,
          canContinue: true,
        },
        state,
      );
      // A new turn has fresh steps: the same message, with what it has waited and filed so far.
      return turn.next
        ? ctx.continue(turn.state, { ...message, ...turn.next })
        : { state: turn.state };
    },
    async onReviewAnswered(ctx, message, state) {
      // An answer changes no fact: any report will do, and none is not worth a wait.
      const turn = await runChecks(
        ctx,
        lbb,
        ports,
        settings,
        message.workflow,
        { waitedMs: 0, rounds: 0, canContinue: false },
        state,
      );
      return { state: turn.state };
    },
  });
}
