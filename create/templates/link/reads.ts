// The reads of the link workflow: records, the mentions it wrote, and the
// things they belong to. Each query starts with a `# link: <name>` line, so
// the call log and a test's mock can tell them apart.
import {
  CLASS_IRI,
  P,
  PROPERTY_IRI,
  RDFS_LABEL,
  RELATION_IRI,
  iriSegment,
  iris,
  propertyIri,
} from "./candidates.js";
import type { SourceRecord } from "./sources/records.js";

/** The properties of a mention that the workflow writes, by name. */
export const MENTION_FIELDS = [
  "span",
  "role",
  "kind",
  "field",
  "offset",
  "length",
  "block_key",
  "window",
];
/** The properties of a mention that the things identity writes: its links and a person's constraints. */
export const LINK_FIELDS = ["linked_to", "must_link", "cannot_link"];
/** The properties of a thing. */
export const THING_FIELDS = ["anchor_key", "kind", "alias"];

/** Records one read names, at most. */
export const PER_READ = 400;

/** A field named `name` or `label` is the record's display name: `rdfs:label`. */
export const isDisplayName = (field: string) => field === "name" || field === "label";
/** The predicate of a field: `rdfs:label` for the display name, else the property. */
export const fieldIri = (field: string) => (isDisplayName(field) ? RDFS_LABEL : propertyIri(field));

/** The values of the fields of records, and their names. */
export function sourcesQuery(records: string[], fields: string[]): string {
  const predicates = [...new Set([RDFS_LABEL, ...fields.map(fieldIri)])]
    .map((iri) => `<${iri}>`)
    .join(", ");
  return `# link: sources\n${P}SELECT ?s ?p ?v WHERE {
  VALUES ?s { ${iris(records)} }
  ?s ?p ?v FILTER(?p IN (${predicates}))
}`;
}

/** The records of a read: each field's values in the order the rows give them. */
export function parseSources(
  rows: Record<string, string>[],
  records: string[],
  cls: string,
  fields: string[],
): Map<string, SourceRecord> {
  const out = new Map<string, SourceRecord>();
  const byIri = new Map(fields.map((f) => [fieldIri(f), f]));
  for (const iri of records) out.set(iri, { iri, class: cls, name: "", values: {} });
  const found = new Set<string>();
  for (const r of rows) {
    const record = out.get(r.s ?? "");
    if (!record || r.v === undefined) continue;
    found.add(record.iri);
    if (r.p === RDFS_LABEL) record.name ||= r.v;
    const field = byIri.get(r.p ?? "");
    if (!field) continue;
    const values = (record.values[field] ??= []);
    if (!values.includes(r.v)) values.push(r.v);
  }
  for (const iri of records) if (!found.has(iri)) out.delete(iri);
  return out;
}

/** The mentions the workflow wrote for records, with the thing each is in and its cannot-links. */
export function sourceMentionsQuery(records: string[]): string {
  return `# link: source mentions\n${P}SELECT ?s ?m ?thing ?c WHERE {
  VALUES ?s { ${iris(records)} }
  ?m r:mentioned_in ?s .
  OPTIONAL { ?m r:refers_to ?thing } OPTIONAL { ?m p:cannot_link ?c }
} LIMIT 5000`;
}

/** Mentions of the workflow whose source is gone: deleting a record retracts the edges to it. */
export function orphanMentionsQuery(): string {
  return `# link: orphan mentions\n${P}SELECT ?m ?thing WHERE {
  ?m a <${CLASS_IRI}mention> .
  FILTER NOT EXISTS { ?m r:mentioned_in ?any }
  OPTIONAL { ?m r:refers_to ?thing }
} LIMIT 900`;
}

export interface WrittenMention {
  mention: string;
  thing: string | null;
  cannot: string[];
}

export function parseSourceMentions(rows: Record<string, string>[]): Map<string, WrittenMention[]> {
  const out = new Map<string, Map<string, WrittenMention>>();
  for (const r of rows) {
    if (!r.s || !r.m) continue;
    const byMention = out.get(r.s) ?? out.set(r.s, new Map()).get(r.s)!;
    const m = byMention.get(r.m) ?? { mention: r.m, thing: null, cannot: [] };
    if (r.thing) m.thing = r.thing;
    if (r.c && !m.cannot.includes(r.c)) m.cannot.push(r.c);
    byMention.set(r.m, m);
  }
  return new Map([...out].map(([s, ms]) => [s, [...ms.values()]]));
}

/** Rows of one read of the members of things, at most: a larger thing is read in part (the supernode bound). */
export const MEMBER_ROWS = 5_000;

/** The members of things. */
export function thingMembersQuery(things: string[]): string {
  return `# link: thing members\n${P}SELECT ?t ?x WHERE {
  VALUES ?t { ${iris(things)} }
  ?x r:refers_to ?t .
} LIMIT ${MEMBER_ROWS}`;
}

export function parseThingMembers(rows: Record<string, string>[]): Map<string, Set<string>> {
  const members = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.t || !r.x) continue;
    (members.get(r.t) ?? members.set(r.t, new Set()).get(r.t)!).add(r.x);
  }
  return members;
}

/** The facts of mentions: their properties, their source, their thing and their links with the confidence of each. */
export function mentionFactsQuery(mentions: string[]): string {
  const props = ["role", "span", "kind", "field", "window", "block_key", ...LINK_FIELDS]
    .map((f) => `p:${f}`)
    .join(", ");
  return `# link: mention facts\n${P}PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX lbb: <https://littlebigbrain.com/ns#>
SELECT ?m ?p ?v ?c WHERE {
  VALUES ?m { ${iris(mentions)} }
  { ?m ?p ?v FILTER(?p IN (${props}, r:mentioned_in, r:refers_to)) }
  UNION {
    ?m r:same_thing_as ?v BIND(r:same_thing_as AS ?p)
    OPTIONAL { ?st rdf:subject ?m ; rdf:predicate r:same_thing_as ; rdf:object ?v ; lbb:confidence ?c }
  }
}`;
}

/** A mention as the graph holds it. */
export interface MentionFacts {
  iri: string;
  role: "self" | "refers" | "defines";
  span: string;
  kind: string;
  field: string;
  window: string | null;
  source: string;
  thing: string | null;
  keys: string[];
  linkedTo: string[];
  must: string[];
  cannot: string[];
  /** Its `SAME_THING_AS` targets, with the confidence of each. */
  same: { target: string; confidence: number | null }[];
}

export function parseMentionFacts(rows: Record<string, string>[]): Map<string, MentionFacts> {
  const out = new Map<string, MentionFacts>();
  const get = (iri: string) => {
    let m = out.get(iri);
    if (!m) {
      m = {
        iri,
        role: "refers",
        span: "",
        kind: "",
        field: "",
        window: null,
        source: "",
        thing: null,
        keys: [],
        linkedTo: [],
        must: [],
        cannot: [],
        same: [],
      };
      out.set(iri, m);
    }
    return m;
  };
  const add = (list: string[], v: string) => {
    if (!list.includes(v)) list.push(v);
  };
  for (const r of rows) {
    if (!r.m || !r.p || r.v === undefined) continue;
    const m = get(r.m);
    const p = r.p.startsWith(PROPERTY_IRI)
      ? `p:${decodeURIComponent(r.p.slice(PROPERTY_IRI.length))}`
      : `r:${decodeURIComponent(r.p.slice(RELATION_IRI.length))}`;
    if (p === "p:role") m.role = r.v === "self" || r.v === "defines" ? r.v : "refers";
    else if (p === "p:span") m.span = r.v;
    else if (p === "p:kind") m.kind = r.v;
    else if (p === "p:field") m.field = r.v;
    else if (p === "p:window") m.window = r.v;
    else if (p === "p:block_key") add(m.keys, r.v);
    else if (p === "p:linked_to") add(m.linkedTo, r.v);
    else if (p === "p:must_link") add(m.must, r.v);
    else if (p === "p:cannot_link") add(m.cannot, r.v);
    else if (p === "r:mentioned_in") m.source = r.v;
    else if (p === "r:refers_to") m.thing = r.v;
    else if (p === "r:same_thing_as" && !m.same.some((s) => s.target === r.v))
      m.same.push({ target: r.v, confidence: r.c !== undefined ? Number(r.c) : null });
  }
  // A mention without a span or a source is gone, or no mention of this workflow.
  for (const [iri, m] of out) if (!m.span || !m.source) out.delete(iri);
  return out;
}

/** The names and classes of records. */
export function recordsQuery(records: string[]): string {
  return `# link: records\n${P}SELECT ?s ?name ?class WHERE {
  VALUES ?s { ${iris(records)} }
  OPTIONAL { ?s rdfs:label ?name } OPTIONAL { ?s a ?class }
}`;
}

export interface RecordFacts {
  name: string;
  /** The class as the settings name it, else the local name of its IRI. */
  class: string;
}

export function parseRecords(
  rows: Record<string, string>[],
  classes: string[],
): Map<string, RecordFacts> {
  const bySegment = new Map(classes.map((c) => [iriSegment(c), c]));
  const out = new Map<string, RecordFacts>();
  for (const r of rows) {
    if (!r.s) continue;
    const entry = out.get(r.s) ?? { name: "", class: "" };
    if (r.name && !entry.name) entry.name = r.name;
    if (r.class?.startsWith(CLASS_IRI)) {
      const segment = r.class.slice(CLASS_IRI.length);
      const named = bySegment.get(segment);
      if (named || !entry.class) entry.class = named ?? decodeURIComponent(segment);
    }
    out.set(r.s, entry);
  }
  return out;
}

/** The anchor keys and labels of things, and where a merged thing points. */
export function thingFactsQuery(things: string[]): string {
  return `# link: thing facts\n${P}SELECT ?t ?p ?v WHERE {
  VALUES ?t { ${iris(things)} }
  ?t ?p ?v FILTER(?p IN (p:anchor_key, rdfs:label, r:merged_into))
}`;
}

export function parseThingFacts(rows: Record<string, string>[]) {
  const out = new Map<string, { anchorKey: string; label: string; mergedInto: string | null }>();
  for (const r of rows) {
    if (!r.t || r.v === undefined) continue;
    const entry = out.get(r.t) ?? { anchorKey: "", label: "", mergedInto: null };
    if (r.p === propertyIri("anchor_key")) entry.anchorKey = r.v;
    else if (r.p === RDFS_LABEL) entry.label = r.v;
    else entry.mergedInto = r.v;
    out.set(r.t, entry);
  }
  return out;
}

/** The accepted identities (`SAME_AS`) of records, both ways. */
export function sameAsQuery(records: string[]): string {
  return `# link: same as\n${P}SELECT ?a ?b WHERE {
  VALUES ?a { ${iris(records)} }
  { ?a r:same_as ?b } UNION { ?b r:same_as ?a }
}`;
}

export function parseSameAs(rows: Record<string, string>[]): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const r of rows) {
    if (!r.a || !r.b || r.a === r.b) continue;
    const pair = [r.a, r.b].sort() as [string, string];
    const key = pair.join("\u0000");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(pair);
    }
  }
  return out;
}

/** `list` in parts of at most `size`. */
export const parts = <T>(list: T[], size = PER_READ): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, n) =>
    list.slice(n * size, (n + 1) * size),
  );
