// The parts of review that need no I/O: what a proposal's statement is in the graph's records
// ontology, the decision (write, a person, or refused), and the facts that write it. Adapted
// from the LBB-run `review@v1` (database/crates/lbb-graph-query/src/review.rs).
import { ENTITY_ID_KEY_SENTINEL, ENTITY_IRI_NAMESPACE, type Schemas } from "@littlebigbrain/client";

export const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
export const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
export const CLASS_NS = "https://littlebigbrain.com/class/";
export const PROPERTY_NS = "https://littlebigbrain.com/p/";
export const RELATION_NS = "https://littlebigbrain.com/r/";
const segment = (name: string) =>
  encodeURIComponent(name.trim().toLowerCase().split(/\s+/).join(" "));
/** The IRIs a records graph gives a class, a property and a relation. */
export const classIri = (name: string) => CLASS_NS + segment(name);
export const propertyIri = (name: string) => PROPERTY_NS + segment(name);
export const relationIri = (name: string) => RELATION_NS + segment(name);

/** The properties a proposer writes on a proposal. */
export const PROPOSAL_FIELDS: Record<string, string> = {
  fact_subject: "keyword",
  fact_predicate: "keyword",
  fact_object: "text",
  fact_datatype: "keyword",
  fact_confidence: "f64",
  fact_evidence: "text",
  proposed_by: "keyword",
};
/** The properties the review writes: a proposal's status and why, and on a new instance the proposal that made it. */
export const REVIEW_FIELDS: Record<string, string> = {
  fact_status: "keyword",
  review_note: "text",
  proposed_in: "keyword",
};
/** The rule that sends every statement about a new instance to a person. */
export const NEW_INSTANCE = "new_instance";

/** One proposed statement: IRIs, or a literal object with its datatype. */
export interface Statement {
  subject: string;
  predicate: string;
  object: string;
  datatype?: string;
}

/** What the review knows of one entity a statement names. */
export interface Known {
  iri: string;
  /** The class name; absent for an instance the graph does not have and no proposal types. */
  class?: string;
  label?: string;
  /** The graph has the instance. */
  exists: boolean;
}

/** The graph's records ontology as the review reads it. */
export interface Ontology {
  /** Class name by class IRI. */
  classes: Map<string, string>;
  /** Each class name with its superclasses (names), itself included. */
  ancestors: Map<string, Set<string>>;
  /** Relation by predicate IRI: its name, domain and range (class names; empty: any). */
  relations: Map<string, { name: string; domain: string[]; range: string[] }>;
  /** Property by predicate IRI: its name and value type. */
  properties: Map<string, { name: string; type: string }>;
}

/** The ontology of `GET /v1/ontology`. */
export function readOntology(view: Schemas["OntologyView"]): Ontology {
  const types = (view.entity_type_defs ?? []).filter((t) => t.removed_version == null);
  const nameOf = new Map<string, string>();
  for (const t of types) {
    nameOf.set(t.name.toLowerCase(), t.name);
    if (t.stable_id) nameOf.set(t.stable_id.toLowerCase(), t.name);
  }
  const ancestors = new Map<string, Set<string>>();
  for (const t of types) {
    const out = new Set<string>();
    const queue = [t.name];
    while (queue.length) {
      const next = queue.pop()!;
      if (out.has(next)) continue;
      out.add(next);
      const def = types.find((d) => d.name === next);
      queue.push(...(def?.super_types ?? []).flatMap((s) => nameOf.get(s.toLowerCase()) ?? []));
    }
    ancestors.set(t.name, out);
  }
  const names = (list: string[]) => list.map((n) => nameOf.get(n.toLowerCase()) ?? n);
  return {
    classes: new Map(types.map((t) => [t.iri || classIri(t.name), t.name])),
    ancestors,
    relations: new Map(
      (view.relation_defs ?? [])
        .filter((r) => r.removed_version == null)
        .map((r) => [
          relationIri(r.name),
          { name: r.name, domain: names(r.src_types), range: names(r.dst_types) },
        ]),
    ),
    properties: new Map(
      (view.property_defs ?? []).map((p) => [
        propertyIri(p.name),
        { name: p.name, type: p.value_type },
      ]),
    ),
  };
}

/** What a statement is in this graph: a relation, a property, a type, a label, or refused. */
export type Terms =
  | { kind: "relation"; relation: string; subject: Known; object: Known }
  | {
      kind: "property";
      field: string;
      type: string;
      subject: Known;
      value: string | number | boolean;
      current: string[];
    }
  | { kind: "type"; class: string; subject: Known; holds: boolean }
  | { kind: "label"; label: string; subject: Known }
  | { kind: "refused"; why: string };

const ENTITY = /^https:\/\/littlebigbrain\.com\/e\/[0-9a-f]{32}$/;
/** Whether an IRI names an instance of a records graph. */
export const isEntity = (iri: string) => ENTITY.test(iri.trim());

/** A value in its property's type, or null when it does not take the type. */
export function coerce(raw: string, type: string): string | number | boolean | null {
  const text = raw.trim();
  if (!text) return null;
  const number = Number(text);
  switch (type) {
    case "i64":
      return Number.isInteger(number) ? number : null;
    case "f64":
      return Number.isFinite(number) ? number : null;
    case "bool":
      return text === "true" ? true : text === "false" ? false : null;
    case "date_time":
      return Number.isNaN(Date.parse(text)) ? null : text;
    default:
      return text;
  }
}

/** Everything `classify` reads about a statement's entities and values. */
export interface Seen {
  /** The entities the statement names, by IRI. */
  entities: Map<string, Known>;
  /** The values the subject has now for a property statement. */
  current?: string[];
}

/**
 * The terms of a statement in a records graph, or why it cannot hold it:
 * `rdf:type` of a class, `rdfs:label`, a relation between two instances, a
 * property value. `proposalClass` is the class of the proposals: the review
 * writes no statement about a proposal.
 */
export function classify(
  s: Statement,
  ontology: Ontology,
  seen: Seen,
  proposalClass: string,
): Terms {
  const refused = (why: string): Terms => ({ kind: "refused", why });
  if (!isEntity(s.subject))
    return refused(`The subject <${s.subject}> is not an instance IRI of this graph.`);
  const known = (iri: string): Known => seen.entities.get(iri) ?? { iri, exists: false };
  const subject = known(s.subject);
  if (subject.class === proposalClass)
    return refused("The review writes no statement about a proposal.");
  const untyped = (e: Known) =>
    `<${e.iri}> is not an instance of the graph, and no proposal of its rdf:type gives its class.`;
  const fits = (cls: string | undefined, allowed: string[]) =>
    !allowed.length || allowed.some((a) => ontology.ancestors.get(cls ?? "")?.has(a));
  if (s.predicate === RDF_TYPE) {
    const cls = ontology.classes.get(s.object.trim());
    if (!cls) return refused(`<${s.object}> is not a class of the graph's ontology.`);
    if (!subject.exists) return { kind: "type", class: cls, subject, holds: false };
    const holds = ontology.ancestors.get(subject.class ?? "")?.has(cls) ?? false;
    if (!holds)
      return refused(
        `<${s.subject}> is an instance of ${subject.class} already; a records graph gives an instance one class.`,
      );
    return { kind: "type", class: cls, subject, holds };
  }
  if (s.predicate === RDFS_LABEL) {
    if (!s.datatype || !s.object.trim())
      return refused("A label is a text; the object is an IRI or empty.");
    if (!subject.class) return refused(untyped(subject));
    return { kind: "label", label: s.object.trim(), subject };
  }
  const relation = ontology.relations.get(s.predicate);
  if (relation) {
    if (s.datatype || !isEntity(s.object))
      return refused(
        `The relation ${relation.name} links two instances; the object is not an instance IRI.`,
      );
    const object = known(s.object.trim());
    for (const end of [subject, object]) if (!end.class) return refused(untyped(end));
    if (!fits(subject.class, relation.domain))
      return refused(
        `The relation ${relation.name} starts at ${relation.domain.join(", ")}; <${s.subject}> is a ${subject.class}.`,
      );
    if (!fits(object.class, relation.range))
      return refused(
        `The relation ${relation.name} points to ${relation.range.join(", ")}; <${s.object}> is a ${object.class}.`,
      );
    return { kind: "relation", relation: relation.name, subject, object };
  }
  const property = ontology.properties.get(s.predicate);
  if (property) {
    if (!subject.class) return refused(untyped(subject));
    const value = coerce(s.object, property.type);
    if (value === null)
      return refused(`"${s.object}" is not a value of ${property.name} (${property.type}).`);
    return {
      kind: "property",
      field: property.name,
      type: property.type,
      subject,
      value,
      current: seen.current ?? [],
    };
  }
  return refused(
    `<${s.predicate}> is not a relation or a property of the graph's records ontology (nor rdf:type or rdfs:label). The template writes with POST /v1/graph/commit, which takes those only.`,
  );
}

/** The settings of the decision. */
export interface Rules {
  gate: number;
  /** `new_instance`, and predicate IRIs whose statements always go to a person. */
  alwaysReview: string[];
}

/** The decision about one proposal: write it, give it to a person (and why), or refuse it (why). */
export type Decision =
  | { status: "written"; holds: boolean }
  | { status: "in_review"; why: string }
  | { status: "refused"; why: string };

/** Whether a statement names a new instance: its subject or object is not in the graph yet. */
export function namesNewInstance(t: Terms): boolean {
  switch (t.kind) {
    case "relation":
      return !t.subject.exists || !t.object.exists;
    case "type":
      return !t.subject.exists || !t.holds;
    case "property":
    case "label":
      return !t.subject.exists;
    default:
      return false;
  }
}

/** Whether the graph holds the statement already. */
export function holds(t: Terms, edgeHolds: boolean): boolean {
  switch (t.kind) {
    case "relation":
      return edgeHolds;
    case "type":
      return t.holds;
    case "property":
      return t.current.includes(String(t.value));
    case "label":
      return t.subject.exists && t.subject.label === t.label;
    default:
      return false;
  }
}

/**
 * Refused when the graph cannot hold the statement; to a person when a rule
 * names it, when it would replace another writer's value or name, or when its
 * confidence is below the gate; else written.
 */
export function decide(
  t: Terms,
  predicate: string,
  confidence: number,
  rules: Rules,
  edgeHolds = false,
): Decision {
  if (t.kind === "refused") return { status: "refused", why: t.why };
  if (rules.alwaysReview.includes(NEW_INSTANCE) && namesNewInstance(t))
    return {
      status: "in_review",
      why: "A new instance: every statement about a new instance goes to a person (rule new_instance).",
    };
  if (rules.alwaysReview.includes(predicate))
    return {
      status: "in_review",
      why: `Every statement of <${predicate}> goes to a person (rule).`,
    };
  if (t.kind === "property" && t.current.length && !t.current.includes(String(t.value)))
    return {
      status: "in_review",
      why: `The subject's ${t.field} is ${t.current.join(", ")} already: writing ${t.value} would replace it.`,
    };
  if (t.kind === "label" && t.subject.exists && t.subject.label && t.subject.label !== t.label)
    return {
      status: "in_review",
      why: `The subject is named ${t.subject.label} already: writing ${t.label} would rename it (a records entity has one name).`,
    };
  if (!Number.isFinite(confidence) || confidence < rules.gate)
    return {
      status: "in_review",
      why: `The confidence ${(Number.isFinite(confidence) ? confidence : 0).toFixed(2)} is below the gate ${rules.gate}.`,
    };
  return { status: "written", holds: holds(t, edgeHolds) };
}

/** The commit reference of an entity the review writes: by its id, with its class and name. */
export function ref(e: Known): Schemas["NamedEntityInput"] {
  const id = e.iri.slice(ENTITY_IRI_NAMESPACE.length);
  return { type: e.class!, name: e.label?.trim() || id, key: `${ENTITY_ID_KEY_SENTINEL}${id}` };
}

/** The facts that write a statement: an edge whose evidence names the proposal, or an entity row. */
export interface Facts {
  triplets: Schemas["TripletInput"][];
  entity_properties: Schemas["EntityPropertiesInput"][];
}

export function factsOf(
  t: Exclude<Terms, { kind: "refused" }>,
  proposal: string,
  confidence: number,
  evidence: string | undefined,
): Facts {
  switch (t.kind) {
    case "relation":
      return {
        triplets: [
          {
            source: ref(t.subject),
            relation: t.relation,
            target: ref(t.object),
            confidence: Math.min(1, Math.max(0, confidence)),
            evidence: {
              text: clip(evidence || "A fact proposal the review workflow wrote", 500),
              source_id: proposal,
            },
          },
        ],
        entity_properties: [],
      };
    case "property":
      return {
        triplets: [],
        entity_properties: [{ ...ref(t.subject), properties: { [t.field]: t.value } }],
      };
    case "type":
      // A records graph holds an instance through its facts: the proposal that made it.
      return {
        triplets: [],
        entity_properties: [
          { ...ref({ ...t.subject, class: t.class }), properties: { proposed_in: proposal } },
        ],
      };
    case "label":
      return {
        triplets: [],
        entity_properties: [{ ...ref({ ...t.subject, label: t.label }), properties: {} }],
      };
  }
}

/** The statement in words, for a review item: `R 0.12 · HAS_EQUIPMENT · T 1`. */
export function shown(t: Terms, s: Statement): string {
  const name = (e: Known) => e.label?.trim() || e.iri.slice(e.iri.lastIndexOf("/") + 1);
  switch (t.kind) {
    case "relation":
      return `${name(t.subject)} · ${t.relation} · ${name(t.object)}`;
    case "property":
      return `${name(t.subject)} · ${t.field} · ${t.value}`;
    case "type":
      return `${name(t.subject)} · is a · ${t.class}`;
    case "label":
      return `${name(t.subject)} · label · ${t.label}`;
    default:
      return `${s.subject} · ${s.predicate} · ${s.object}`;
  }
}

/** The trace from a document entry to its instance: `lbb:denotes`, or the records relation `DENOTES`. */
export const isTrace = (predicate: string) =>
  predicate.trim() === "https://littlebigbrain.com/ns#denotes" ||
  predicate.trim() === relationIri("DENOTES");

/**
 * The instance a proposal's review item is about: the object of the trace, the object of a link
 * whose subject the graph has and whose object is new, else the subject. Null when refused.
 */
export function groupOf(t: Terms, s: Statement): string | null {
  switch (t.kind) {
    case "refused":
      return null;
    case "relation":
      return isTrace(s.predicate) || (t.subject.exists && !t.object.exists)
        ? t.object.iri
        : t.subject.iri;
    default:
      return t.subject.iri;
  }
}

/** One fact of a review item, as the item shows it. */
export interface Shown {
  /** `type`, `label`, `value`, `link` or `source` (the trace). */
  kind: string;
  /** The fact in words, seen from its instance: `is a Room`, `HAS_EQUIPMENT → T 1`. */
  text: string;
}

/** What an item shows of a fact about the instance `group`. */
export function shownOf(
  t: Exclude<Terms, { kind: "refused" }>,
  s: Statement,
  group: string,
): Shown {
  const name = (e: Known) => e.label?.trim() || e.iri.slice(e.iri.lastIndexOf("/") + 1);
  switch (t.kind) {
    case "type":
      return { kind: "type", text: `is a ${t.class}` };
    case "label":
      return { kind: "label", text: `label · ${t.label}` };
    case "property":
      return { kind: "value", text: `${t.field} · ${t.value}` };
    case "relation":
      if (isTrace(s.predicate)) return { kind: "source", text: name(t.subject) };
      return t.object.iri === group && t.subject.iri !== group
        ? { kind: "link", text: `${t.relation} ← ${name(t.subject)}` }
        : { kind: "link", text: `${t.relation} → ${name(t.object)}` };
  }
}

/** The order of the kinds in an item: the type, the label, values, links, the trace. */
export const KIND_ORDER = ["type", "label", "value", "link", "source"];

/**
 * Where a proposal's evidence comes from, for a person: `document`, `page`, `line` and `box` of
 * its first source (the JSON of documents-map, or any object with those fields), else its text as
 * the line. Null without evidence.
 */
export function place(evidence: string | undefined): Record<string, unknown> | null {
  const raw = evidence?.trim();
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { line: clip(raw, 160) };
  }
  const object = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const sources = object(value) && Array.isArray(value.sources) ? value.sources : null;
  const source = sources?.[0] ?? value;
  if (!object(source)) return { line: clip(raw, 160) };
  const text = (k: string) => (typeof source[k] === "string" ? (source[k] as string).trim() : "");
  const line =
    text("line") ||
    [text("identifier"), text("description")].filter(Boolean).join(" ") ||
    text("context");
  const out: Record<string, unknown> = {};
  if (text("document")) out.document = clip(text("document"), 160);
  if (Number.isSafeInteger(source.page)) out.page = source.page;
  if (line) out.line = clip(line, 160);
  if (Array.isArray(source.box) && source.box.length === 4 && source.box.every(Number.isFinite))
    out.box = source.box;
  return Object.keys(out).length ? out : null;
}

/** Whitespace kept, cut at `chars` with an ellipsis. */
export function clip(text: string, chars: number): string {
  const all = [...text];
  return all.length <= chars ? text : `${all.slice(0, chars - 1).join("")}…`;
}
