// The parts of documents-link that need no I/O: the page listing the models
// read, the prompts and their checks, the candidates of a mention, the
// decision model's questions, the link rule, and the facts the workflow
// writes. Adapted from the LBB-run `documents.link@v1`
// (database/crates/lbb-graph-query/src/documents/link.rs and link_store.rs).
import {
  entityRef,
  type DecideAnswer,
  type DecideQuestion,
  type DecideRequest,
  type FilePages,
  type OwnedWrite,
  type ReasonRequest,
  type Schemas,
} from "@littlebigbrain/client";

export type FilePage = FilePages["pages"][number];
export type FileLine = FilePage["lines"][number];

/** An identifier a page defines, on the line that holds it. */
export interface Definition {
  line: string;
  identifier: string;
}

/** A span of a line that is, or may be, a code. */
export interface Mention {
  line: string;
  span: string;
}

/** One entry of the catalogue: an identifier a document defines. */
export interface Entry {
  identifier: string;
  context: string;
  line: string;
  document: string;
  documentName: string;
  sha256: string;
}

/** What the decision model answered about one mention, kept small. */
export interface Resolved {
  kind: string | null;
  /** The probability that the span can link at all. */
  pLink: number;
  /** The catalogue index of the entry the names answer chose. */
  target: number | null;
  confidence: number;
}

/** A code or a span longer than this is no code. */
const CODE_MAX_CHARS = 200;
/** Characters of an entry's context. */
export const CONTEXT_CHARS = 700;
const CANDIDATES_BY_CHARACTERS = 30;
const CANDIDATES_BY_CONTEXT = 10;
/** Mentions of one decide request: two questions each, 64 at most. */
const REQUEST_MENTIONS = 32;
/** Characters of one decide request (state and questions), well under the route's 200,000. */
const REQUEST_CHARS = 60_000;

// ---- the page as the models read it ---------------------------------------

/** The lines of a page grouped by baseline, top to bottom, each row left to right. */
export function layoutRows(lines: FileLine[]): FileLine[][] {
  const rows: { top: number; bottom: number; lines: FileLine[] }[] = [];
  const sorted = [...lines].sort((a, b) => a.box[1]! - b.box[1]! || a.box[0]! - b.box[0]!);
  for (const line of sorted) {
    const middle = (line.box[1]! + line.box[3]!) / 2;
    const row = rows.find((r) => r.top <= middle && middle <= r.bottom);
    if (row) row.lines.push(line);
    else rows.push({ top: line.box[1]!, bottom: line.box[3]!, lines: [line] });
  }
  return rows.map((row) => row.lines.sort((a, b) => a.box[0]! - b.box[0]!));
}

export const rowText = (row: FileLine[]): string => row.map((line) => line.text).join(" | ");

/** The text of the row that holds a line. */
export const rowOf = (lines: FileLine[], id: string): string =>
  rowText(layoutRows(lines).find((row) => row.some((line) => line.id === id)) ?? []);

/** A page as the models read it: one row per text line, `[line id] text | [line id] text`. */
export function listing(lines: FileLine[]): string {
  return layoutRows(lines)
    .map((row) => row.map((line) => `[${line.id}] ${line.text}`).join(" | "))
    .join("\n");
}

// ---- the reasoning model's calls ------------------------------------------

const DEFINITIONS_PROMPT =
  "Below are the text lines of one page, each with a line id. Lines that share a baseline on the page are on one row, separated by ' | '. Some entries define an identifier: a short code that other documents use to refer to this entry, followed by its description, which can wrap onto the next lines. List every identifier that is defined. row_id is the id of the line that holds the identifier. Copy the identifier exactly as it is written. The description is the entry's text, joined across its lines, at most 200 characters. An identifier can be defined in a table, a list, a numbered heading, or inside a sentence (for example 'Item-Type 07 - a cabinet for …'). Do not list the entries of a table of contents, local list markers such as 'a)' or '1.', page numbers, or references to definitions that are made in other documents.";
const MENTIONS_PROMPT =
  "Below are the text lines of one page, each with a line id. Lines that share a baseline on the page are on one row, separated by ' | '. List every span that is, or might be, a reference code: a short identifier that points to a definition elsewhere (for example an item, product, position, class or annex code). Copy each span exactly as it is written. Give one code per entry: split lists such as 'A1, A2' into separate entries. When you are not sure whether a span is a code, list it. Do not list plain numbers, prices, dates or page numbers.";

const listOf = (key: string, fields: Record<string, { type: string }>) => ({
  type: "object",
  additionalProperties: false,
  required: [key],
  properties: {
    [key]: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(fields),
        properties: fields,
      },
    },
  },
});

/** The definitions call of one page. */
export function definitionsRequest(page: FilePage): ReasonRequest {
  return {
    system: "You read documents and find the entries that define identifiers.",
    prompt: `${DEFINITIONS_PROMPT}\n\n${listing(page.lines)}`,
    schema: listOf("definitions", {
      row_id: { type: "string" },
      identifier: { type: "string" },
      description: { type: "string" },
    }),
    max_tokens: 16_000,
  };
}

/** The mentions call of one page. */
export function mentionsRequest(page: FilePage): ReasonRequest {
  return {
    system: "You read document pages and find reference codes.",
    prompt: `${MENTIONS_PROMPT}\n\n${listing(page.lines)}`,
    schema: listOf("mentions", { line_id: { type: "string" }, span: { type: "string" } }),
    max_tokens: 16_000,
  };
}

const items = (answer: unknown, key: string): Record<string, unknown>[] => {
  const list = (answer as Record<string, unknown> | null)?.[key];
  return Array.isArray(list) ? list.filter((item) => item && typeof item === "object") : [];
};
const text = (value: unknown): string => (typeof value === "string" ? value.normalize("NFC") : "");

/** A code is kept only when the line the model cited holds it. */
function inLine(page: FilePage, line: string, code: string): boolean {
  if (!code.trim() || code.length > CODE_MAX_CHARS) return false;
  return page.lines.some((l) => l.id === line && l.text.includes(code));
}

/** The definitions of an answer whose identifier is in the line they cite. */
export function checkDefinitions(answer: unknown, page: FilePage): Definition[] {
  return items(answer, "definitions")
    .map((item) => ({ line: text(item.row_id), identifier: text(item.identifier) }))
    .filter((d) => inLine(page, d.line, d.identifier));
}

/** The mentions of an answer whose span is in the line they cite. */
export function checkMentions(answer: unknown, page: FilePage): Mention[] {
  const seen = new Set<string>();
  return items(answer, "mentions")
    .map((item) => ({ line: text(item.line_id), span: text(item.span) }))
    .filter(
      (m) =>
        inLine(page, m.line, m.span) &&
        !seen.has(`${m.line}\u0000${m.span}`) &&
        seen.add(`${m.line}\u0000${m.span}`),
    );
}

// ---- entries ---------------------------------------------------------------

/**
 * The key an identifier matches by: no whitespace, lower case, and no dot
 * between leading letters and a digit (`S.4.1`, `s 4.1` and `S4.1` match).
 */
export function identifierKey(identifier: string): string {
  const squashed = identifier.replace(/\s+/g, "").toLowerCase();
  return squashed.replace(/^(\p{L}+)\.(?=\d)/u, "$1");
}

/**
 * The context of each definition: the text of its row up to the row of the
 * next definition, at most 700 characters.
 */
export function contextsFor(pages: FilePage[], definitions: Definition[]): string[] {
  const rows: string[] = [];
  const rowOf = new Map<string, number>();
  for (const page of pages)
    for (const row of layoutRows(page.lines)) {
      for (const line of row) rowOf.set(line.id, rows.length);
      rows.push(rowText(row));
    }
  const starts = [...new Set(definitions.map((d) => rowOf.get(d.line) ?? -1))].sort(
    (a, b) => a - b,
  );
  return definitions.map((d) => {
    const start = rowOf.get(d.line);
    if (start === undefined) return d.identifier;
    const end = starts.find((at) => at > start) ?? rows.length;
    return rows.slice(start, end).join(" ").slice(0, CONTEXT_CHARS);
  });
}

/** A stable order of the catalogue: by document, line (`p2-l10` after `p2-l9`) and identifier. */
export const order = (e: Entry): string =>
  [e.documentName, e.sha256, e.line.replace(/\d+/g, (n) => n.padStart(6, "0")), e.identifier].join(
    "\u0000",
  );

/** A part of a review item's key: lowercase letters, digits and dots, other runs as one dash. */
export const keyPart = (text: string): string =>
  identifierKey(text)
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "x";

// ---- candidates ------------------------------------------------------------

function levenshtein(a: string[], b: string[]): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length]!;
}

/** 1 for equal strings, 0 for strings with nothing in common (case folded). */
function similarity(a: string, b: string): number {
  const [x, y] = [[...a.toLowerCase()], [...b.toLowerCase()]];
  const longest = Math.max(x.length, y.length);
  return longest === 0 ? 1 : 1 - levenshtein(x, y) / longest;
}

/** Whether `text` holds `span` as a word (case folded). */
export function holdsAsWord(text: string, span: string): boolean {
  const escaped = span.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}_.])${escaped}(?![\\p{L}\\p{N}_]|\\.\\d)`, "u").test(
    text.toLowerCase(),
  );
}

/**
 * The candidates of a mention, as catalogue indexes: the 30 entries closest
 * in characters (an entry with the span's identifier key first, then by
 * normalized Levenshtein), up to 10 whose context holds the span as a word,
 * then the ones closest in meaning. A mention never links to the entry its
 * own line defines.
 */
export function candidatesFor(
  mention: Mention,
  document: string,
  catalogue: Entry[],
  byMeaning: number[],
): number[] {
  const key = identifierKey(mention.span);
  const scored = catalogue.map((entry, index) => ({
    index,
    score: identifierKey(entry.identifier) === key ? 2 : similarity(mention.span, entry.identifier),
  }));
  scored.sort((a, b) => b.score - a.score || b.index - a.index);
  const out = scored.slice(0, CANDIDATES_BY_CHARACTERS).map((s) => s.index);
  const limit = CANDIDATES_BY_CHARACTERS + CANDIDATES_BY_CONTEXT;
  catalogue.forEach((entry, index) => {
    if (out.length < limit && !out.includes(index) && holdsAsWord(entry.context, mention.span))
      out.push(index);
  });
  for (const index of byMeaning) if (!out.includes(index)) out.push(index);
  return out.filter(
    (i) => !(catalogue[i]!.document === document && catalogue[i]!.line === mention.line),
  );
}

/** The `k` entries whose unit vectors are closest to `query`. */
export function nearest(query: number[], vectors: number[][], k = 10): number[] {
  const unit = (v: number[]) => {
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  const q = unit(query);
  return vectors
    .map((v, index) => ({ index, score: unit(v).reduce((sum, x, i) => sum + x * (q[i] ?? 0), 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, k)
    .map((s) => s.index);
}

// ---- the decision model's questions -----------------------------------------

/** The kind question's options. */
export const KINDS: Record<string, string> = {
  identifier:
    "An identifier or code that a project document defines, in any spelling. The line points to that entry.",
  abbreviation: "An abbreviation of a term, a system or a group name. It is not a code.",
  value: "A value or property of something: a class, a rating, a dimension, a quantity or a grade.",
  own_number:
    "The number of the entry that this page or row is about, for example its own position number.",
  external:
    "A reference to an annex, a standard, a law or another document that is outside the project's definitions.",
};
/** The kinds that link. The LBB-run version also links own numbers, through a same-item question. */
const LINKABLE = ["identifier", "abbreviation"];

/** One mention a decide request asks about. */
export interface Asked {
  position: number;
  mention: Mention;
  lineText: string;
  candidates: number[];
}

/** The tag of each document in the catalogue: `D1`, `D2`, … */
export const tags = (catalogue: Entry[]): Map<string, string> =>
  new Map([...new Set(catalogue.map((e) => e.document))].map((doc, i) => [doc, `D${i + 1}`]));

/** The state of a page's decide requests: the document, the page's rows and the catalogue's documents. */
export function pageState(
  name: string,
  page: FilePage,
  catalogue: Entry[],
): Record<string, unknown> {
  const names = [...tags(catalogue)].map(
    ([doc, tag]) => `[${tag}] ${catalogue.find((e) => e.document === doc)!.documentName}`,
  );
  return {
    document: `${name}, one page. Each row holds the lines that share a baseline, left to right, as '[line id] text'.`,
    page: page.page + 1,
    rows: listing(page.lines).split("\n"),
    catalogue: `Each candidate entry is defined in a document of the project: ${names.join(", ")}.`,
  };
}

/** One decide request: the kind and names questions of `asked`, with the candidates' contexts in the state. */
export function decideRequest(
  state: Record<string, unknown>,
  asked: Asked[],
  catalogue: Entry[],
): DecideRequest {
  const tag = tags(catalogue);
  const entries: Record<string, string> = {};
  const questions: Record<string, DecideQuestion> = {};
  for (const { position, mention, lineText, candidates } of asked) {
    const line = `Line ${mention.line} reads: "${lineText}".`;
    questions[`m${position}-kind`] = {
      instructions: `${line} What is the span "${mention.span}" in this line?`,
      criteria: KINDS,
    };
    if (!candidates.length) continue;
    const options: Record<string, string> = {};
    for (const index of candidates) {
      const entry = catalogue[index]!;
      options[`e${index}`] =
        `[${tag.get(entry.document)}] ${entry.identifier}: ${entry.context.slice(0, 120)}`;
      entries[`e${index}`] = entry.context;
    }
    options.none_of_these = "The span is not a name for any of these entries.";
    questions[`m${position}-names`] = {
      instructions: `${line} Which entry is the span "${mention.span}" a name for? The state's entries give each candidate's full text. Choose an entry only when the span is that entry's identifier, in any spelling, an abbreviation that the entry defines or is titled by, or the number that the entry's text says it describes. An entry whose text only contains the span, uses the same value, or cites it (for example 'see annex X') is not a match.`,
      criteria: options,
    };
  }
  return { state: { ...state, entries }, questions };
}

/** The mentions of a page in requests of at most 32 mentions and 60,000 characters. */
export function packRequests(
  state: Record<string, unknown>,
  asked: Asked[],
  catalogue: Entry[],
): Asked[][] {
  const out: Asked[][] = [];
  let current: Asked[] = [];
  for (const one of asked) {
    const trial = [...current, one];
    const size = JSON.stringify(decideRequest(state, trial, catalogue)).length;
    if (current.length && (trial.length > REQUEST_MENTIONS || size > REQUEST_CHARS)) {
      out.push(current);
      current = [one];
    } else current = trial;
  }
  if (current.length) out.push(current);
  return out;
}

// ---- the link rule -------------------------------------------------------------

const entryOf = (option: string | null | undefined): number | null =>
  option && /^e\d+$/.test(option) ? Number(option.slice(1)) : null;

/** The kind and names answers of one mention, kept small. */
export function resolve(kind: DecideAnswer | undefined, names: DecideAnswer | undefined): Resolved {
  const probabilities = kind?.probabilities ?? {};
  const pLink = Object.keys(probabilities).length
    ? LINKABLE.reduce((sum, id) => sum + (probabilities[id] ?? 0), 0)
    : LINKABLE.includes(kind?.choice ?? "")
      ? (kind?.confidence ?? 0)
      : 1 - (kind?.confidence ?? 1);
  return {
    kind: kind?.choice ?? null,
    pLink: Math.round(pLink * 1000) / 1000,
    target: entryOf(names?.choice),
    confidence: names?.confidence ?? 0,
  };
}

/**
 * A mention links when its linkable kinds have a probability of at least 0.5
 * and the names answer chose an entry; the confidence is the smaller of the
 * two. Otherwise the confidence is that of no link.
 */
export function linkRule(r: Resolved): { target: number | null; confidence: number } {
  if (r.target !== null && r.pLink >= 0.5)
    return { target: r.target, confidence: Math.min(r.pLink, r.confidence) };
  return { target: null, confidence: Math.max(1 - r.pLink, r.target === null ? r.confidence : 0) };
}

/** The box of a span on its line: the fewest words whose joined text holds it, else the line's box. */
export function spanBox(line: FileLine, span: string): number[] {
  const joined = (from: number, to: number) =>
    line.words
      .slice(from, to + 1)
      .map((w) => w.text)
      .join(" ");
  for (let end = 0; end < line.words.length; end++) {
    if (!joined(0, end).includes(span)) continue;
    let start = end;
    while (start > 0 && !joined(start, end).includes(span)) start--;
    const boxes = line.words.slice(start, end + 1).map((w) => w.box);
    const edge = (i: number, pick: (...v: number[]) => number) => pick(...boxes.map((b) => b[i]!));
    return [edge(0, Math.min), edge(1, Math.min), edge(2, Math.max), edge(3, Math.max)];
  }
  return line.box;
}

// ---- the facts ---------------------------------------------------------------

/** A document as the facts name it. */
export interface Doc {
  iri: string;
  name: string;
  sha256: string;
}

/** The fields of an entry and of a mention, owned by the workflow. */
export const ENTRY_FIELDS = ["identifier", "context", "line_id", "page", "x0", "y0", "x1", "y1"];
export const MENTION_FIELDS = [
  "span",
  "kind",
  "line_id",
  "line_text",
  "page",
  "x0",
  "y0",
  "x1",
  "y1",
];

const boxOf = (page: number, box: number[]) => ({
  page,
  x0: box[0]!,
  y0: box[1]!,
  x1: box[2]!,
  y1: box[3]!,
});
const entryRef = (sha256: string, identifier: string) => ({
  type: "DocEntry",
  name: identifier,
  key: `entry:${sha256}:${identifier}`,
});
const mentionRef = (doc: Doc, m: Mention) => ({
  type: "DocMention",
  name: m.span,
  key: `mention:${doc.sha256}:${m.line}:${m.span}`,
});
const lineOf = (pages: FilePage[], id: string) => {
  const page = pages.find((p) => p.lines.some((l) => l.id === id))!;
  return { page, line: page.lines.find((l) => l.id === id)! };
};

/** The window's entries `DEFINED_IN` the document, one per identifier with the longest context. */
export function entriesWrite(doc: Doc, pages: FilePage[], found: Definition[]): OwnedWrite {
  const contexts = contextsFor(pages, found);
  const entries = new Map<string, Schemas["EntityPropertiesInput"]>();
  found.forEach((d, i) => {
    const before = entries.get(d.identifier)?.properties as { context?: string } | undefined;
    if ((before?.context?.length ?? -1) >= contexts[i]!.length) return;
    const { page, line } = lineOf(pages, d.line);
    const fields = { identifier: d.identifier, context: contexts[i]!, line_id: d.line };
    entries.set(d.identifier, {
      ...entryRef(doc.sha256, d.identifier),
      properties: { ...fields, ...boxOf(page.page, line.box) },
    });
  });
  const subjects = [...entries.keys()].map((identifier) => entryRef(doc.sha256, identifier));
  const target = entityRef(doc.iri, "Document", doc.name);
  return {
    subjects,
    relations: ["DEFINED_IN"],
    properties: ENTRY_FIELDS,
    entity_properties: [...entries.values()],
    triplets: subjects.map((source) => ({ source, relation: "DEFINED_IN", target })),
  };
}

/** A mention's link to an entry: the line is the evidence, the span's box its region. */
export function refersTo(
  doc: Doc,
  pages: FilePage[],
  m: Mention,
  entry: Entry,
  confidence: number,
): Schemas["TripletInput"] {
  const { page, line } = lineOf(pages, m.line);
  const region = { ...boxOf(page.page, spanBox(line, m.span)), confidence };
  return {
    source: mentionRef(doc, m),
    relation: "REFERS_TO",
    target: entryRef(entry.sha256, entry.identifier),
    confidence,
    evidence: { text: line.text, source_id: doc.name, region },
  };
}

/** The window's mentions `MENTIONED_IN` the document, with their kind, box and written links. */
export function mentionsWrite(
  doc: Doc,
  pages: FilePage[],
  mentions: { m: Mention; r: Resolved }[],
  links: { m: Mention; entry: Entry; confidence: number }[],
): OwnedWrite {
  const target = entityRef(doc.iri, "Document", doc.name);
  const rows = new Map<string, Schemas["EntityPropertiesInput"]>();
  for (const { m, r } of mentions) {
    const { page, line } = lineOf(pages, m.line);
    const fields = {
      span: m.span,
      line_id: m.line,
      line_text: line.text,
      ...(r.kind ? { kind: r.kind } : {}),
    };
    rows.set(m.line + m.span, {
      ...mentionRef(doc, m),
      properties: { ...fields, ...boxOf(page.page, spanBox(line, m.span)) },
    });
  }
  const subjects = [...rows.values()].map(({ type, name, key }) => ({ type, name, key: key! }));
  return {
    subjects,
    relations: ["MENTIONED_IN", "REFERS_TO"],
    properties: MENTION_FIELDS,
    entity_properties: [...rows.values()],
    triplets: [
      ...subjects.map((source) => ({ source, relation: "MENTIONED_IN", target })),
      ...links.map((l) => refersTo(doc, pages, l.m, l.entry, l.confidence)),
    ],
  };
}

/** The entities one commit of the workflow names at most: the route takes 1,000. */
export const PART = 900;

/** Part `n` of a write: its subjects `n * PART` to `(n + 1) * PART`, with their fields and edges. */
export function part(write: OwnedWrite, n: number): OwnedWrite {
  const subjects = write.subjects.slice(n * PART, (n + 1) * PART);
  const keys = new Set(subjects.map((s) => s.key));
  return {
    ...write,
    subjects,
    entity_properties: write.entity_properties?.filter((e) => keys.has(e.key)),
    triplets: write.triplets?.filter((t) => keys.has(t.source.key)),
  };
}
