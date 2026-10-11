// The parts of documents-map that need no I/O: names, the ontology the
// questions offer, the subject of a mention, the decision model's questions,
// and the proposals. Adapted from the LBB-run `documents.map@v1`
// (database/crates/lbb-graph-query/src/documents/map.rs and map_store.rs).
import { createHash } from "node:crypto";
import {
  ENTITY_IRI_NAMESPACE,
  type DecideAnswer,
  type DecideQuestion,
  type DecideRequest,
  type Schemas,
} from "@littlebigbrain/client";

// ---- the vocabulary ----------------------------------------------------------------

export const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
export const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
export const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs";
export const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
/** The IRIs a records graph gives its classes, properties and relations. */
export const CLASS_NS = "https://littlebigbrain.com/class/";
export const PROPERTY_NS = "https://littlebigbrain.com/p/";
export const RELATION_NS = "https://littlebigbrain.com/r/";
/** The relation from an entry (or a mention that is a page's subject) to the instance it names. */
export const DENOTES = "DENOTES";

const segment = (name: string) =>
  encodeURIComponent(name.trim().toLowerCase().split(/\s+/).join(" "));
/** The IRI a records graph gives a class name. */
export const classIri = (name: string) => CLASS_NS + segment(name);
/** The IRI a records graph gives a property. */
export const propertyIri = (name: string) => PROPERTY_NS + segment(name);
/** The IRI a records graph gives a relation. */
export const relationIri = (name: string) => RELATION_NS + segment(name);

/** The class of the proposals, and the properties a proposer writes on each. */
export const FACT_PROPOSAL = "FactProposal";
export const PROPOSAL_FIELDS: Record<string, string> = {
  fact_subject: "keyword",
  fact_predicate: "keyword",
  fact_object: "text",
  fact_datatype: "keyword",
  fact_confidence: "f64",
  fact_evidence: "text",
  proposed_by: "keyword",
};

/** LBB's own trace: never offered as a class or a property. */
export const TRACE_CLASSES = ["Document", "DocEntry", "DocMention", FACT_PROPOSAL, "ValueSource"];
export const TRACE_RELATIONS = [
  "DEFINED_IN",
  "MENTIONED_IN",
  "REFERS_TO",
  "SAME_ITEM_AS",
  "HAS_VALUE_SOURCE",
  DENOTES,
];

/** The fixed options of the questions. */
export const SAME_ITEM = "same_item";
export const NO_FACT = "no_fact";
export const MISSING_PROPERTY = "missing_property";
export const NEW_INSTANCE = "new_instance";
export const NO_INSTANCE = "none";
export const NO_CLASS = "no_class";
const FIXED = [SAME_ITEM, NO_FACT, MISSING_PROPERTY, NEW_INSTANCE, NO_INSTANCE, NO_CLASS];

/** Candidates of one grounding question, classes of one class question, properties of one typing question. */
export const GROUND_CANDIDATES = 10;
export const CLASS_OPTIONS = 12;
export const PROPERTY_OPTIONS = 12;
/** "No class fits" and "a property the ontology lacks" with at least this probability file a suggestion. */
export const LACK_SUGGEST_AT = 0.5;
/** The top of a page, as a share of its height: a page's head. */
export const HEAD_BAND = 0.3;
/** Lines whose middles are this close (a share of the page height) are on one row. */
const ROW_TOLERANCE = 0.006;
const DESCRIPTION_CHARS = 160;
const FACT_CHARS = 80;
const CONTEXT_CHARS = 400;
/** Questions of one decide request, and its characters (well under the route's 200,000). */
const REQUEST_QUESTIONS = 32;
const REQUEST_CHARS = 60_000;

export const TYPING_TASK =
  "Each question is about one link that a document linker found: a span on a line of a document names an entry of another document. The subject is the instance the line belongs to (the room of a room sheet, or the entry of the table row); the object is the instance of the linked entry. The question asks which statement, in the terms of the ontology below, the line makes about the two.";
const TYPING_GUIDE =
  " Choose a property by its meaning (its comment in the ontology), not by its name alone. Choose 'a property the ontology lacks' when the line relates the two but no property means that relation. Choose 'no fact' when the line does not relate the two, for example when the span is the subject's own number or the linked entry is not what the span names.";
export const GROUND_TASK =
  "Each question is about one entry that a document defines: an identifier with its text. The candidates are instances of the graph, each with its class, label and facts. The question asks which instance of the graph the entry is.";
export const CLASS_TASK =
  "Each question is about one entry that a document defines and that is a new instance of the graph. The question asks which class of the graph's ontology the entry is an instance of.";

// ---- names ---------------------------------------------------------------------------

/** The text after the last `#` or `/` of an IRI. */
export function localName(iri: string): string {
  const trimmed = iri.replace(/[/#]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("#"), trimmed.lastIndexOf("/")) + 1);
}

/** A name as words: `hasEquipment` and `HAS_EQUIPMENT` read `has equipment`. */
export function humanize(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/(?<=[\p{Ll}\d])(?=\p{Lu})/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** A class name as people read it: `SpecSection` reads `Spec section`. */
export function classLabel(name: string): string {
  const words = humanize(name);
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** Whitespace collapsed, cut at `chars` with an ellipsis. */
export function clip(text: string, chars: number): string {
  const flat = text.split(/\s+/).filter(Boolean).join(" ");
  const all = [...flat];
  return all.length <= chars ? flat : `${all.slice(0, chars).join("")}…`;
}

/** The words of a text, lower case, at least three letters long. */
const words = (text: string) =>
  new Set(
    text
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => [...w].length >= 3)
      .map((w) => w.toLowerCase()),
  );
const overlap = (a: Set<string>, text: string) => [...words(text)].filter((w) => a.has(w)).length;

/**
 * The key an identifier matches by: no whitespace, lower case, and no dot
 * between leading letters and a digit (`S.2.2`, `s 2.2` and `S2.2` match).
 */
export function identifierKey(identifier: string): string {
  const squashed = identifier.replace(/\s+/g, "").toLowerCase();
  return squashed.replace(/^(\p{L}+)\.(?=\d)/u, "$1");
}

/**
 * The form of a code: each run of digits as `9`, each run of letters as `a`,
 * other characters as written; a space only between two runs of one kind
 * (`S 1.1` → `a9.9`, `0.12` → `9.9`).
 */
export function codeShape(text: string): string {
  let out = "";
  let space = false;
  for (const c of text.trim()) {
    if (/\s/.test(c)) {
      space = true;
      continue;
    }
    const kind = /\p{N}/u.test(c) ? "9" : /\p{L}/u.test(c) ? "a" : c;
    const last = out.at(-1);
    if (space && (kind === "9" || kind === "a") && last === kind) out += ` ${kind}`;
    else if (!((kind === "9" || kind === "a") && last === kind)) out += kind;
    space = false;
  }
  return out;
}

/** The ways an identifier may be written on an instance: as written, without spaces, with one space after its letters. */
export function identifierVariants(identifier: string): string[] {
  const trimmed = identifier.split(/\s+/).filter(Boolean).join(" ");
  const squashed = trimmed.replace(/\s+/g, "");
  const out = [trimmed, squashed];
  const letters = squashed.match(/^\p{L}+/u)?.[0].length ?? 0;
  if (letters > 0 && letters < squashed.length)
    out.push(`${squashed.slice(0, letters)} ${squashed.slice(letters).replace(/^\.+/, "")}`);
  return [...new Set(out.filter(Boolean))];
}

/** The description of a page entry: its line without the span (the whole line when nothing is left). */
export function pageEntryDescription(span: string, line: string): string {
  const rest = line.replace(span, " ").split(/\s+/).filter(Boolean).join(" ");
  return rest || line.trim();
}

/** The label of a new instance: its identifier and the start of its description. */
export function newInstanceLabel(identifier: string, description: string): string {
  const id = identifier.trim();
  let rest = description.trim();
  if (rest.startsWith(id)) rest = rest.slice(id.length).replace(/^[ :,-]+/, "");
  rest = clip(rest, 80);
  return !rest || identifierKey(rest) === identifierKey(id) ? id : `${id} ${rest}`;
}

/** A relation name for a property the ontology lacks: `HAS_<CLASS>`, else `RELATES_TO_<CLASS>`. */
export function lackingRelationName(objectClass: string, taken: Set<string>): string {
  const upper = humanize(objectClass).toUpperCase().replace(/ /g, "_");
  const free = (name: string) => !taken.has(name.toLowerCase());
  for (const name of [`HAS_${upper}`, `RELATES_TO_${upper}`]) if (free(name)) return name;
  for (let n = 2; ; n++) if (free(`RELATES_TO_${upper}_${n}`)) return `RELATES_TO_${upper}_${n}`;
}

/** A class name for entries no class fits: the longest word of the document's name and `Item`. */
export function lackingClassName(document: string): string {
  const stem = document.includes(".") ? document.slice(0, document.lastIndexOf(".")) : document;
  const word =
    stem
      .split(/[^\p{L}]+/u)
      .filter((w) => [...w].length >= 4)
      .sort((a, b) => [...b].length - [...a].length)[0] ?? "Document";
  return `${word[0]!.toUpperCase()}${word.slice(1)}Item`;
}

/** A SHA-256 of the parts, as hex. */
export const hash = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex");

/**
 * The IRI of the new instance an entry proposes: one per document and
 * identifier key, so the same entry always proposes the same instance and
 * finds it again once the review wrote it.
 */
export const mintedIri = (sha256: string, identifier: string) =>
  ENTITY_IRI_NAMESPACE + hash("lbb.map.instance", sha256, identifierKey(identifier)).slice(0, 32);

// ---- the ontology ----------------------------------------------------------------------

export interface MapClass {
  iri: string;
  /** The name an evolve operation takes. */
  name: string;
  /** Direct superclasses, by IRI. */
  supers: string[];
}

export interface MapProperty {
  iri: string;
  name: string;
  /** Class IRIs; empty: any class. */
  domain: string[];
  range: string[];
  symmetric: boolean;
  /** The inverse property, by IRI. */
  inverse?: string;
}

/** One property option of a typing question. */
export interface PropertyOption {
  /** The property's name, `<name>.reverse` for the other direction. */
  key: string;
  property: string;
  /** The statement runs from the object to the subject. */
  reverse: boolean;
  label: string;
}

/** An option key from a name: ASCII letters, digits and `_`. */
const optionKey = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");

/** Keys made unique (`name`, `name_2`, …), never one of the fixed options. */
function uniqueKeys(items: [string, string][]): Map<string, string> {
  const taken = new Set(FIXED);
  const out = new Map<string, string>();
  for (const [iri, key] of items) {
    let candidate = key;
    for (let n = 2; taken.has(candidate); n++) candidate = `${key}_${n}`;
    taken.add(candidate);
    out.set(iri, candidate);
  }
  return out;
}

/** The classes and relations of the graph's records ontology that a mapping offers. */
export class MapOntology {
  readonly classes: Map<string, MapClass>;

  constructor(
    classes: MapClass[],
    readonly properties: MapProperty[],
  ) {
    this.classes = new Map(classes.map((c) => [c.iri, c]));
  }

  /** The ontology of `GET /v1/ontology`, without LBB's own trace. */
  static fromView(view: Schemas["OntologyView"]): MapOntology {
    const types = (view.entity_type_defs ?? []).filter((t) => t.removed_version == null);
    const iriOf = new Map<string, string>();
    for (const t of types) {
      const iri = t.iri || classIri(t.name);
      iriOf.set(t.name.toLowerCase(), iri);
      if (t.stable_id) iriOf.set(t.stable_id.toLowerCase(), iri);
    }
    const trace = new Set(TRACE_CLASSES.map((c) => c.toLowerCase()));
    const classes = types
      .filter((t) => !trace.has(t.name.toLowerCase()))
      .map((t) => ({
        iri: iriOf.get(t.name.toLowerCase())!,
        name: t.name,
        supers: (t.super_types ?? []).flatMap((s) => iriOf.get(s.toLowerCase()) ?? []),
      }));
    const traceRelations = new Set(TRACE_RELATIONS.map((r) => r.toLowerCase()));
    const properties = (view.relation_defs ?? [])
      .filter((r) => r.removed_version == null && !traceRelations.has(r.name.toLowerCase()))
      .map((r) => ({
        iri: relationIri(r.name),
        name: r.name,
        domain: r.src_types.flatMap((n) => iriOf.get(n.toLowerCase()) ?? []),
        range: r.dst_types.flatMap((n) => iriOf.get(n.toLowerCase()) ?? []),
        symmetric: r.symmetric,
        ...(r.inverse_name?.trim() ? { inverse: relationIri(r.inverse_name) } : {}),
      }));
    // An inverse is mutual.
    for (const p of properties)
      if (p.inverse) {
        const other = properties.find((q) => q.iri === p.inverse);
        if (other && !other.inverse) Object.assign(other, { inverse: p.iri });
      }
    return new MapOntology(classes, properties);
  }

  /** A class and every superclass of it. */
  ancestors(iri: string): Set<string> {
    const out = new Set<string>();
    const queue = [iri];
    while (queue.length) {
      const next = queue.pop()!;
      if (out.has(next)) continue;
      out.add(next);
      queue.push(...(this.classes.get(next)?.supers ?? []));
    }
    return out;
  }

  classLabel(iri: string): string {
    return classLabel(this.classes.get(iri)?.name ?? localName(iri));
  }

  /** The key of each class in a class question: its name, made unique. */
  classKeys(): Map<string, string> {
    return uniqueKeys([...this.classes.values()].map((c) => [c.iri, optionKey(c.name) || "class"]));
  }

  /**
   * The property options of a link from an instance of `subject` to one of
   * `object`: each property whose domain fits one end and whose range fits
   * the other (through superclasses; an empty domain or range fits any
   * class), in both directions, the declared ones first, then those that
   * share the most words with the line, at most 12. A symmetric property
   * goes one way; the other direction of a property with an inverse is the
   * inverse.
   */
  propertyOptions(subject: string, object: string, line: string): PropertyOption[] {
    const [up, down] = [this.ancestors(subject), this.ancestors(object)];
    const fits = (declared: string[], classes: Set<string>) =>
      declared.length === 0 || declared.some((c) => classes.has(c));
    const keys = uniqueKeys(this.properties.map((p) => [p.iri, optionKey(p.name) || "property"]));
    const forward = new Set(
      this.properties.filter((p) => fits(p.domain, up) && fits(p.range, down)).map((p) => p.iri),
    );
    const lineWords = words(line);
    const found: { open: number; score: number; option: PropertyOption }[] = [];
    for (const p of this.properties) {
      const key = keys.get(p.iri)!;
      const label = humanize(p.name);
      const score = overlap(lineWords, `${label} ${p.name}`);
      const open = p.domain.length && p.range.length ? 0 : 1;
      if (forward.has(p.iri))
        found.push({ open, score, option: { key, property: p.iri, reverse: false, label } });
      const inverseOffered = p.inverse !== undefined && forward.has(p.inverse);
      if (fits(p.domain, down) && fits(p.range, up) && !p.symmetric && !inverseOffered)
        found.push({
          open,
          score,
          option: { key: `${key}.reverse`, property: p.iri, reverse: true, label },
        });
    }
    found.sort(
      (a, b) =>
        a.open - b.open ||
        b.score - a.score ||
        (a.option.key < b.option.key ? -1 : a.option.key > b.option.key ? 1 : 0),
    );
    return found.slice(0, PROPERTY_OPTIONS).map((f) => f.option);
  }

  /** The part of the ontology a typing request's state shows: the classes and properties, by name. */
  stateSubset(classes: Set<string>, properties: Set<string>): Record<string, unknown> {
    const name = (iri: string) => this.classes.get(iri)?.name ?? localName(iri);
    return {
      classes: Object.fromEntries(
        [...classes]
          .filter((iri) => this.classes.has(iri))
          .map((iri) => [name(iri), { label: this.classLabel(iri) }]),
      ),
      properties: Object.fromEntries(
        this.properties
          .filter((p) => properties.has(p.iri))
          .map((p) => [
            p.name,
            {
              label: humanize(p.name),
              domain: p.domain.map(name),
              range: p.range.map(name),
              symmetric: p.symmetric,
            },
          ]),
      ),
    };
  }
}

// ---- instances and entries ------------------------------------------------------------

/** An instance a question is about: one the graph holds, or a new one the mapping proposes. */
export interface MapInstance {
  iri: string;
  /** The class IRI, when the instance has a class of the ontology. */
  class?: string;
  classLabel: string;
  identifier?: string;
  label: string;
  description?: string;
  isNew: boolean;
}

/** How a question names an instance briefly: its identifier, else its label. */
export const short = (i: MapInstance) => i.identifier?.trim() || clip(i.label, 60);

/** How a question names an instance in full. */
export function long(i: MapInstance): string {
  const cls = i.classLabel.toLowerCase();
  if (i.identifier && i.description?.trim())
    return `${cls} ${i.identifier} ('${clip(i.description, DESCRIPTION_CHARS)}')`;
  if (i.identifier) return `${cls} ${i.identifier}`;
  return `${cls} '${clip(i.label, DESCRIPTION_CHARS)}'`;
}

/** An instance in a request's state. */
export const instanceState = (i: MapInstance) => ({
  class: i.classLabel,
  ...(i.identifier ? { identifier: i.identifier } : {}),
  name: clip(i.label, DESCRIPTION_CHARS),
  ...(i.description?.trim() ? { description: clip(i.description, DESCRIPTION_CHARS) } : {}),
});

/** What a grounding question shows of an entry. */
export interface EntryView {
  identifier: string;
  description: string;
  context: string;
  document: string;
  /** The page, from 1. */
  page: number;
}

const entryState = (e: EntryView) => ({
  identifier: e.identifier,
  description: clip(e.description, DESCRIPTION_CHARS),
  context: clip(e.context, CONTEXT_CHARS),
});

/** A candidate instance of a grounding question. */
export interface CandidateView {
  iri: string;
  class?: string;
  classLabel: string;
  label: string;
  /** `[property name, value]`, a few. */
  facts: [string, string][];
}

/** A decide question with its items in the request's state. */
export interface Member {
  id: string;
  question: DecideQuestion;
  items: Record<string, unknown>;
}

/** The grounding question of one entry (`g<id>`): its candidates, a new instance, or none. */
export function groundQuestion(id: string, entry: EntryView, candidates: CandidateView[]): Member {
  const criteria: Record<string, string> = {};
  const listed: Record<string, unknown> = {};
  candidates.forEach((c, n) => {
    criteria[`c${n}`] = `${clip(c.label, 80)} (${c.classLabel})`;
    listed[`c${n}`] = {
      class: c.classLabel,
      label: clip(c.label, DESCRIPTION_CHARS),
      facts: Object.fromEntries(c.facts.map(([p, v]) => [p, clip(v, FACT_CHARS)])),
    };
  });
  criteria[NEW_INSTANCE] =
    "A new instance: the entry is a thing of the graph's domain, and no candidate is that thing.";
  criteria[NO_INSTANCE] =
    "None: the entry is not a thing the graph holds (a section of the text, a note, a heading).";
  return {
    id: `g${id}`,
    question: {
      instructions: `Which instance of the graph is the entry "${entry.identifier}" of ${entry.document}, page ${entry.page}? The state gives the entry's text and each candidate's class, label and facts. Choose a candidate only when the entry describes that same thing. Choose 'a new instance' when the entry is a thing of the graph's domain that no candidate is, and 'none' when it is not.`,
      criteria,
    },
    items: { [`g${id}`]: { ...entryState(entry), candidates: listed } },
  };
}

/** The class question of one new instance (`k<id>`): `options` are class IRIs. */
export function classQuestion(
  id: string,
  entry: EntryView,
  options: string[],
  ontology: MapOntology,
  keys: Map<string, string>,
): Member {
  const criteria: Record<string, string> = {};
  for (const iri of options.slice(0, CLASS_OPTIONS)) {
    const key = keys.get(iri);
    if (key && ontology.classes.has(iri)) criteria[key] = ontology.classLabel(iri);
  }
  criteria[NO_CLASS] = "No class of the ontology fits this entry: a class the ontology lacks.";
  return {
    id: `k${id}`,
    question: {
      instructions: `The entry "${entry.identifier}" of ${entry.document}, page ${entry.page}, is a new instance of the graph: "${clip(entry.description, DESCRIPTION_CHARS)}". Which class of the ontology is it an instance of? Choose a class by its meaning (its comment), not by its name alone. Choose 'no class fits' when the entry is a kind of thing none of these classes means.`,
      criteria,
    },
    items: { [`k${id}`]: entryState(entry) },
  };
}

/** The classes a class question offers: the candidates' classes first, then by the words they share with the entry. */
export function classOptions(
  ontology: MapOntology,
  candidateClasses: string[],
  entryText: string,
): string[] {
  const out = [...new Set(candidateClasses.filter((c) => ontology.classes.has(c)))];
  const entryWords = words(entryText);
  const rest = [...ontology.classes.values()]
    .filter((c) => !out.includes(c.iri))
    .map((c) => ({ iri: c.iri, score: overlap(entryWords, `${c.name} ${classLabel(c.name)}`) }))
    .sort((a, b) => b.score - a.score || (a.iri < b.iri ? -1 : 1));
  return [...out, ...rest.map((c) => c.iri)].slice(0, CLASS_OPTIONS);
}

/** One link a typing question asks about. */
export interface TypingView {
  document: string;
  /** The page, from 1. */
  page: number;
  lineId: string;
  lineText: string;
  rowText: string;
  span: string;
  subject: MapInstance;
  object: MapInstance;
}

/** The typing question of one link (`t<id>`): its property options, same item, no fact, a property the ontology lacks. */
export function typingQuestion(id: string, view: TypingView, options: PropertyOption[]): Member {
  const [s, o] = [short(view.subject), short(view.object)];
  const criteria: Record<string, string> = {};
  for (const option of options) {
    const [from, to] = option.reverse ? [o, s] : [s, o];
    criteria[option.key] = `${from} ${option.label} ${to}.`;
  }
  criteria[SAME_ITEM] = `${s} and ${o} are the same item, described in two places.`;
  criteria[NO_FACT] = `The line states no fact that relates ${s} and ${o}.`;
  criteria[MISSING_PROPERTY] =
    `The line states a fact that relates ${s} and ${o}, but none of the ontology's properties expresses it: a property the ontology lacks.`;
  return {
    id: `t${id}`,
    question: {
      instructions: `Line ${view.lineId} of ${view.document} page ${view.page} reads: "${view.lineText}". Its row reads: "${view.rowText}". The span "${view.span}" in this line names ${long(view.object)} (instance o${id}). The line belongs to ${long(view.subject)} (instance s${id}). Which statement does this line make about ${s} and ${o}?${TYPING_GUIDE}`,
      criteria,
    },
    items: { [`s${id}`]: instanceState(view.subject), [`o${id}`]: instanceState(view.object) },
  };
}

/**
 * The decide requests of `members` around one state: at most 32 questions
 * and 60,000 characters each. `key` names the state's field for the items.
 */
export function packRequests(
  state: Record<string, unknown>,
  key: string,
  members: Member[],
): Member[][] {
  const out: Member[][] = [];
  let current: Member[] = [];
  for (const member of members) {
    const trial = [...current, member];
    const size = JSON.stringify(buildRequest(state, key, trial)).length;
    if (current.length && (trial.length > REQUEST_QUESTIONS || size > REQUEST_CHARS)) {
      out.push(current);
      current = [member];
    } else current = trial;
  }
  if (current.length) out.push(current);
  return out;
}

/** The decide request of `members`: the state with their items under `key`, and their questions. */
export function buildRequest(
  state: Record<string, unknown>,
  key: string,
  members: Member[],
): DecideRequest {
  return {
    state: { ...state, [key]: Object.assign({}, ...members.map((m) => m.items)) },
    questions: Object.fromEntries(members.map((m) => [m.id, m.question])),
  };
}

/** One answer, kept small: the choice, its probability, and the options of at least 0.001. */
export type Kept = [choice: string, p: number, options: Record<string, number>];

const round3 = (p: number) => Math.round(p * 1000) / 1000;

/** The answers of a decide call, kept small for a step's saved output. */
export function keep(answers: Record<string, DecideAnswer>): Record<string, Kept> {
  const out: Record<string, Kept> = {};
  for (const [id, a] of Object.entries(answers)) {
    if (!a.choice) continue;
    const p = a.probabilities?.[a.choice] ?? a.confidence ?? 0;
    const options = Object.fromEntries(
      Object.entries(a.probabilities ?? {})
        .filter(([, q]) => q >= 0.001)
        .map(([o, q]) => [o, round3(q)]),
    );
    out[id] = [a.choice, round3(Math.min(1, Math.max(0, p))), options];
  }
  return out;
}

// ---- the subject of a mention ------------------------------------------------------------

/** Something on a page, with its box `[x0, y0, x1, y1]` normalized to the page. */
export interface Placed {
  page: number;
  box: number[];
}

const middle = (b: number[]) => (b[1]! + b[3]!) / 2;
/** Whether `a` comes before or at `b` on one page: an earlier row, or the same row and not right of it. */
function atOrBefore(a: number[], b: number[]): boolean {
  const [ya, yb] = [middle(a), middle(b)];
  return Math.abs(ya - yb) <= ROW_TOLERANCE ? a[0]! <= b[0]! + 1e-9 : ya < yb;
}
const readingOrder = (a: Placed, b: Placed) =>
  atOrBefore(a.box, b.box) && !atOrBefore(b.box, a.box)
    ? -1
    : atOrBefore(b.box, a.box) && !atOrBefore(a.box, b.box)
      ? 1
      : 0;

/** An entry the mention's own document defines. */
export interface OwnEntry extends Placed {
  entry: string;
  identifier: string;
}

/** A mention of the document, with the entry its link names (or null). */
export interface PageMention extends Placed {
  span: string;
  target: string | null;
}

/** The subject of a mention: an entry, or a page entry made from a mention of the page's head. */
export type Subject = { entry: string } | { mention: number } | null;

/**
 * The subject of each mention's links, in the mention's own document.
 *
 * **A page head.** When the first mention of a page in reading order starts
 * in the page's head (the top 30%), lies below no entry the document defines
 * on the page, and is written unlike most of the page's other mentions (the
 * room number `0.12` above the codes `T1`, `S 1.1`), it names the page's
 * subject: the entry it links to, or else a page entry of its own. Every
 * other mention of the page belongs to it, and a following page with neither
 * a head nor an anchor continues it.
 *
 * **Anchors.** Otherwise the anchors of a page are its own entries written
 * like its first one (the positions of a bill, not the codes its table also
 * defines). A mention belongs to the last anchor at or before it. A mention
 * above the first anchor belongs to it when the anchor starts in the head,
 * else to the last anchor of the page before when that is written the same
 * way (a position that runs onto the next page). A page with neither gives
 * its mentions no subject.
 */
export function subjects(own: OwnEntry[], mentions: PageMention[]): Subject[] {
  const heads = new Map<number, { index: number; subject: Subject }>();
  for (const page of new Set(mentions.map((m) => m.page))) {
    const indices = mentions
      .map((m, index) => ({ m, index }))
      .filter(({ m }) => m.page === page)
      .sort((a, b) => readingOrder(a.m, b.m) || a.index - b.index);
    if (indices.length < 2) continue;
    const { m: head, index } = indices[0]!;
    if (head.box[1]! > HEAD_BAND) continue;
    // An entry the page defines on the head's row or above it heads the page itself.
    if (own.some((e) => e.page === page && middle(e.box) <= middle(head.box) + ROW_TOLERANCE))
      continue;
    const counts = new Map<string, number>();
    for (const { m } of indices.slice(1))
      counts.set(codeShape(m.span), (counts.get(codeShape(m.span)) ?? 0) + 1);
    const most = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    if (codeShape(head.span) === most) continue;
    heads.set(page, { index, subject: head.target ? { entry: head.target } : { mention: index } });
  }
  const anchors = new Map<number, { shape: string; list: OwnEntry[] }>();
  for (const page of new Set(own.map((e) => e.page))) {
    const entries = own
      .filter((e) => e.page === page)
      .sort((a, b) => readingOrder(a, b) || (a.identifier < b.identifier ? -1 : 1));
    const shape = codeShape(entries[0]!.identifier);
    anchors.set(page, { shape, list: entries.filter((e) => codeShape(e.identifier) === shape) });
  }
  return mentions.map((m, index) => {
    const head = heads.get(m.page);
    if (head) return head.index === index ? null : head.subject;
    const page = anchors.get(m.page);
    // Neither a head nor an anchor: the head of the page before continues onto it.
    if (!page) return heads.get(m.page - 1)?.subject ?? null;
    const found = page.list.filter((a) => atOrBefore(a.box, m.box)).at(-1);
    if (found) return { entry: found.entry };
    if (page.list[0]!.box[1]! <= HEAD_BAND) return { entry: page.list[0]!.entry };
    const previous = anchors.get(m.page - 1);
    return previous && previous.shape === page.shape
      ? { entry: previous.list.at(-1)!.entry }
      : null;
  });
}

// ---- proposals -------------------------------------------------------------------------------

/** One proposed statement: IRIs, or a literal object with its datatype. */
export interface Statement {
  subject: string;
  predicate: string;
  object: string;
  datatype?: string;
}

/** The key of a proposal: from its statement and its proposer, so the same proposal again names the same entity. */
export const proposalKey = (s: Statement, proposedBy: string) =>
  `proposal:${hash("fact_proposal_v1", s.subject, s.predicate, s.object, s.datatype ?? "", proposedBy).slice(0, 32)}`;

/** One proposal as a run assembles it. */
export interface Proposal {
  statement: Statement;
  /** `fact`, `same_item`, `instance` or `denotes`. */
  kind: string;
  /** The statement in words. */
  name: string;
  confidence: number;
  /** The evidence of each source, the most confident first, at most 8. */
  sources: { confidence: number; evidence: Record<string, unknown> }[];
}

/** Add a source to the proposal of its statement (a new proposal, or a source of one). */
export function addProposal(
  proposals: Map<string, Proposal>,
  proposedBy: string,
  proposal: Omit<Proposal, "sources"> & { evidence: Record<string, unknown> },
): void {
  const key = proposalKey(proposal.statement, proposedBy);
  const { evidence, ...rest } = proposal;
  const source = { confidence: round3(rest.confidence), evidence };
  const found = proposals.get(key);
  if (!found) {
    proposals.set(key, { ...rest, confidence: round3(rest.confidence), sources: [source] });
    return;
  }
  found.confidence = Math.max(found.confidence, source.confidence);
  found.sources = [...found.sources, source]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8);
}

/** The row a proposer commits for one proposal: the `FactProposal` entity and its fields. */
export function proposalRow(
  key: string,
  proposal: Proposal,
  proposedBy: string,
): Schemas["EntityPropertiesInput"] {
  const { statement: s } = proposal;
  return {
    type: FACT_PROPOSAL,
    name: key,
    key,
    properties: {
      fact_subject: s.subject,
      fact_predicate: s.predicate,
      fact_object: s.object,
      ...(s.datatype ? { fact_datatype: s.datatype } : {}),
      fact_confidence: proposal.confidence,
      fact_evidence: evidenceText(proposal),
      proposed_by: proposedBy,
    },
  };
}

/** A proposal's evidence, as JSON text. */
export const evidenceText = (p: Proposal) =>
  JSON.stringify({ kind: p.kind, name: p.name, sources: p.sources.map((s) => s.evidence) });

export { round3 };
