// The field roles of records (general linking 3.2) and how mentions are found
// in their fields (3.3). Pure functions: the workflow reads the records and
// asks the graph which keys exist.
//
// A `name` or `key:*` field gives one `self` mention per value: the value is
// the span. A `text` field gives `refers` mentions: first the gazetteer pass,
// which keeps each span whose name or key a mention of the graph already
// has; then the spans written like a name or a key (`M. Tannenholt`,
// `Bob Haldane`, an email, a code), which a later record can find by its
// keys. Only a field that opts in (`{ role: "text", extract: true }`), on a
// workflow whose models may read record values, goes to the reasoning model.
import type { ReasonRequest } from "@littlebigbrain/client";
import { blockKeys, fold, keyWeight, looksLike, type SpanKind } from "../names.js";

/** The role of a field. `context` is read for the decisions and gives no mention. */
export type FieldRole =
  | "name"
  | "name:given"
  | "name:family"
  | "key:email"
  | "key:phone"
  | "key:web"
  | "key:handle"
  | "key:code"
  | "text"
  | "context";

/** A field's role, and for a `text` field whether the reasoning model may read it. */
export type FieldSpec = FieldRole | { role: FieldRole; extract?: boolean };

export const roleOf = (spec: FieldSpec): FieldRole => (typeof spec === "string" ? spec : spec.role);
export const extracts = (spec: FieldSpec): boolean =>
  typeof spec !== "string" && spec.role === "text" && spec.extract === true;

/** A record as the workflow reads it: its class, display name and the values of its fields. */
export interface SourceRecord {
  iri: string;
  /** The watched class the record came in as. */
  class: string;
  name: string;
  /** The values of each field the settings name. */
  values: Record<string, string[]>;
}

export type MentionRole = "self" | "refers";

/** A mention found in a field of a record, before it has an IRI. */
export interface FoundMention {
  /** The field: a property name, or `given+family` for a name joined from two fields. */
  field: string;
  role: MentionRole;
  /** What the span is: a name, a key of one kind, or a span of text. */
  kind: SpanKind;
  span: string;
  /** The value of the field the span is in (a field can hold several). */
  value: number;
  /** Where the span starts in that value, in UTF-16 code units, and its length. */
  offset: number;
  length: number;
  /** The span's place among the equal spans of the field: 0 for the first. */
  occurrence: number;
  /** For a span of text, the sentence that holds it, at most 300 characters. */
  window?: string;
  found: "field" | "gazetteer" | "shape" | "model";
}

const KEY_ROLES: Record<string, SpanKind> = {
  "key:email": "email",
  "key:phone": "phone",
  "key:web": "web",
  "key:handle": "handle",
  "key:code": "code",
};

/** The `self` mentions of a record: each name and key value, and a name joined from given and family fields. */
export function selfMentions(
  record: SourceRecord,
  fields: Record<string, FieldSpec>,
): FoundMention[] {
  const out: FoundMention[] = [];
  const counts = new Map<string, number>();
  const push = (field: string, kind: SpanKind, span: string, value: number) => {
    const text = span.trim();
    if (!text || text.length > 200) return;
    if (kind !== "name" && !blockKeys(text, kind).length) return;
    const seen = counts.get(`${field}\u0000${text}`) ?? 0;
    counts.set(`${field}\u0000${text}`, seen + 1);
    out.push({
      field,
      role: "self",
      kind,
      span: text,
      value,
      offset: 0,
      length: text.length,
      occurrence: seen,
      found: "field",
    });
  };
  let given: string | undefined;
  let family: string | undefined;
  for (const [field, spec] of Object.entries(fields)) {
    const role = roleOf(spec);
    const values = record.values[field] ?? [];
    if (role === "name") values.forEach((v, i) => push(field, "name", v, i));
    else if (role === "name:given") given ??= field;
    else if (role === "name:family") family ??= field;
    else if (KEY_ROLES[role]) values.forEach((v, i) => push(field, KEY_ROLES[role]!, v, i));
  }
  const first = (field?: string) => (field ? (record.values[field]?.[0] ?? "").trim() : "");
  const joined = [first(given), first(family)].filter(Boolean).join(" ");
  if (joined) push(`${given ?? family}+${family ?? given}`, "name", joined, 0);
  return out;
}

// ---- spans of text ---------------------------------------------------------------

/** One token of a text: a word, or an email, a web address or a phone number written as one. */
interface Token {
  text: string;
  start: number;
  end: number;
  /** A comma, a parenthesis or another break stands between it and the token before. */
  comma: boolean;
  /** A break stronger than a comma (a sentence end, a colon, a bracket) stands before it. */
  stop: boolean;
}

const TOKEN =
  /[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[A-Za-z0-9-]{2,}|(?:https?:\/\/|www\.)[^\s<>()"]+|\+\d[\d ()./-]{6,}\d|[\p{L}\p{N}][\p{L}\p{N}'’\-‐‑./]*/gu;

/** The tokens of a text, with what stands between them. An initial keeps its dot (`M.`). */
export function tokens(text: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index;
    // A word ends before trailing dots and joiners, except the dot of an initial.
    const trimmed = match[0].replace(/[.\-‐‑'’/]+$/u, "") || match[0];
    const initial = /^\p{L}$/u.test(trimmed) && match[0].startsWith(`${trimmed}.`);
    const word = initial ? `${trimmed}.` : trimmed;
    const between = text.slice(last, start);
    out.push({
      text: word,
      start,
      end: start + word.length,
      comma: between.includes(","),
      stop: /[.!?;:()[\]"|\n]|\s[-–—]\s/.test(between),
    });
    last = start + word.length;
  }
  return out;
}

const capitalized = (word: string) => /^\p{Lu}/u.test(word);
const isInitial = (word: string) => /^\p{L}\.?$/u.test(word);
const isLetterWord = (word: string) => /^[\p{L}'’\-‐‑.]+$/u.test(word);

/** A span of text with its place, and the tokens it spans. */
export interface TextSpan {
  span: string;
  offset: number;
  length: number;
  words: number;
}

/** Lower-case words a name can hold between its capitalized words (`Lena van Dijk`). */
const PARTICLES = new Set([
  "van",
  "von",
  "de",
  "der",
  "den",
  "da",
  "di",
  "du",
  "la",
  "le",
  "del",
  "della",
  "ten",
  "ter",
  "zu",
]);

/**
 * The spans the gazetteer looks up in a text: one to four tokens within a
 * sentence, the first written with a capital or as a key, the others with
 * a capital, as an initial or as a name particle. Two capitalized words may
 * stand on either side of one comma (`Wren, Tobias`).
 */
export function textSpans(text: string): TextSpan[] {
  const words = tokens(text);
  const out: TextSpan[] = [];
  for (let i = 0; i < words.length; i++) {
    const first = words[i]!;
    const key = keyShaped(first.text);
    if (!key && !capitalized(first.text)) continue;
    let comma = false;
    for (let n = 1; n <= 4 && i + n <= words.length; n++) {
      const last = words[i + n - 1]!;
      if (n > 1) {
        if (key || comma || last.stop) break;
        if (!capitalized(last.text) && !isInitial(last.text) && !PARTICLES.has(last.text)) break;
        if (last.comma) {
          if (n !== 2 || !capitalized(first.text) || !capitalized(last.text)) break;
          comma = true;
        }
      }
      out.push({
        span: text.slice(first.start, last.end),
        offset: first.start,
        length: last.end - first.start,
        words: n,
      });
    }
  }
  return out;
}

/** A token written as an email, a web address, a phone number or a code. */
const keyShaped = (token: string): SpanKind | null =>
  (["email", "web", "phone", "code"] as const).find((k) => looksLike(token, k)) ?? null;

/**
 * Words that start a sentence of a note with a capital, and start no name:
 * a span written like a name does not start with one (`Met Kim Oak` is
 * `Kim Oak`). English and German.
 */
export const SENTENCE_WORDS = new Set(
  (
    "a an the and but or so then also if when while after before with without from to for of on in at by " +
    "met meet call called calls spoke speak talked talk sent send emailed email asked ask told tell wrote write " +
    "forwarded forward discussed discuss confirmed confirm agreed agree reached reach left visited visit see saw " +
    "he she they we i you it his her their our my your this that these those there here per re fyi note notes " +
    "der die das ein eine und oder mit von zu für am im bei nach vor er sie wir ich es"
  ).split(" "),
);

/**
 * Whether a span is written like a name or a key, so it is kept as a
 * mention when the gazetteer finds nothing: an email, a web address or a
 * phone number; or two to four words of letters, each with a capital or an
 * initial (a name particle between them), at least one a full word.
 */
export function nameShaped(span: string): boolean {
  const parts = tokens(span).map((t) => t.text);
  if (parts.length === 1) return keyShaped(parts[0]!) !== null && keyShaped(parts[0]!) !== "code";
  if (parts.length < 2 || parts.length > 4) return false;
  if (SENTENCE_WORDS.has(parts[0]!.toLowerCase())) return false;
  const inner = (i: number) => i > 0 && i < parts.length - 1;
  return (
    parts.every(
      (p, i) =>
        isLetterWord(p) && (capitalized(p) || isInitial(p) || (inner(i) && PARTICLES.has(p))),
    ) && parts.some((p) => !isInitial(p) && [...p.replace(/\./g, "")].length >= 2)
  );
}

/**
 * The keys of a span that the gazetteer looks up: its strong keys, its
 * whole name (`name:`), and for a span of two words its initials forms.
 * The initials forms of a longer span would match names it only holds part of.
 */
export function lookupKeys(span: string): string[] {
  const words = tokens(span).length;
  return blockKeys(span, "text").filter(
    (key) =>
      keyWeight(key) === "strong" ||
      (key.startsWith("name:") &&
        keyWeight(key) === "medium" &&
        (words === 2 || !key.startsWith("name:initial:"))),
  );
}

/**
 * The sentence that holds a span, at most 300 characters: the span and the
 * text around it, cut at sentence ends.
 */
export function windowOf(text: string, offset: number, length: number): string {
  const before = text.slice(0, offset);
  const after = text.slice(offset + length);
  const start = Math.max(before.search(/[.!?\n][^.!?\n]*$/) + 1, 0);
  const endMatch = after.search(/[.!?\n](\s|$)/);
  const end = offset + length + (endMatch < 0 ? after.length : endMatch + 1);
  let from = start;
  let to = end;
  if (to - from > 300) {
    from = Math.max(from, offset - 150 + Math.floor(length / 2));
    to = Math.min(to, from + 300);
  }
  return text.slice(from, to).trim();
}

/**
 * The `refers` mentions of one text value: the gazetteer hits (spans with a
 * key in `known`), then the spans written like a name or a key. The longest
 * span wins where two overlap; at most `max` per value (4.4).
 */
export function textMentions(
  field: string,
  value: number,
  text: string,
  known: Set<string>,
  max = 100,
): FoundMention[] {
  const spans = textSpans(text);
  const hits = spans.filter((s) => lookupKeys(s.span).some((k) => known.has(k)));
  const shaped = spans.filter((s) => nameShaped(s.span));
  const chosen: { span: TextSpan; found: FoundMention["found"] }[] = [];
  const free = (s: TextSpan) =>
    chosen.every(
      ({ span: c }) => s.offset + s.length <= c.offset || c.offset + c.length <= s.offset,
    );
  const longestFirst = (a: TextSpan, b: TextSpan) => b.length - a.length || a.offset - b.offset;
  for (const s of [...hits].sort(longestFirst))
    if (free(s)) chosen.push({ span: s, found: "gazetteer" });
  for (const s of [...shaped].sort(longestFirst))
    if (free(s)) chosen.push({ span: s, found: "shape" });
  chosen.sort((a, b) => a.span.offset - b.span.offset);
  const counts = new Map<string, number>();
  return chosen.slice(0, max).map(({ span: s, found }) => {
    const seen = counts.get(s.span) ?? 0;
    counts.set(s.span, seen + 1);
    return {
      field,
      role: "refers" as const,
      kind: keyShaped(s.span) ?? "text",
      span: s.span,
      value,
      offset: s.offset,
      length: s.length,
      occurrence: seen,
      window: windowOf(text, s.offset, s.length),
      found,
    };
  });
}

/** The keys the gazetteer asks the graph about for these texts, each once. */
export function gazetteerKeys(texts: string[]): string[] {
  const keys = new Set<string>();
  for (const text of texts)
    for (const s of textSpans(text)) lookupKeys(s.span).forEach((k) => keys.add(k));
  return [...keys];
}

// ---- the reasoning model, for the fields that opt in -----------------------------

const EXTRACT_PROMPT =
  "Below is the text of one field of a record. List every span that names a person, an organization, a product, a place, a document or a code. Copy each span exactly as the text writes it. Give each name once per place it is written. Do not list pronouns, plain numbers, prices, dates or common words.";

/** The model pass of one text value, for a field that opts in. */
export function extractRequest(record: SourceRecord, field: string, text: string): ReasonRequest {
  return {
    system: "You read records of a knowledge graph and find the names of things in their text.",
    prompt: `${EXTRACT_PROMPT}\n\nRecord: ${record.class} "${record.name}", field ${field}.\n\n${text}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["spans"],
      properties: {
        spans: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["span", "kind"],
            properties: {
              span: { type: "string" },
              kind: {
                type: "string",
                enum: ["person", "organization", "product", "place", "document", "code"],
              },
            },
          },
        },
      },
    },
    max_tokens: 4_000,
  };
}

/**
 * The spans of a model answer that the text holds, at places the found
 * mentions do not take yet. Each span is placed at its next free
 * occurrence in the text.
 */
export function checkExtracted(
  answer: unknown,
  field: string,
  value: number,
  text: string,
  taken: FoundMention[],
  max = 100,
): FoundMention[] {
  const list = (answer as { spans?: unknown } | null)?.spans;
  if (!Array.isArray(list)) return [];
  const out: FoundMention[] = [];
  const overlaps = (offset: number, length: number) =>
    [...taken, ...out].some((m) => offset < m.offset + m.length && m.offset < offset + length);
  for (const item of list) {
    const span = typeof item?.span === "string" ? item.span.normalize("NFC").trim() : "";
    if (!span || span.length > 200) continue;
    let at = text.indexOf(span);
    while (at >= 0 && overlaps(at, span.length)) at = text.indexOf(span, at + 1);
    if (at < 0) continue;
    const occurrence = [...text.slice(0, at).matchAll(new RegExp(escape(span), "g"))].length;
    out.push({
      field,
      role: "refers",
      kind: keyShaped(span) ?? "text",
      span,
      value,
      offset: at,
      length: span.length,
      occurrence,
      window: windowOf(text, at, span.length),
      found: "model",
    });
    if (out.length + taken.length >= max) break;
  }
  return out;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Two spans the same after folding: the gazetteer compares spans this way. */
export const sameSpan = (a: string, b: string) => fold(a).trim() === fold(b).trim();
