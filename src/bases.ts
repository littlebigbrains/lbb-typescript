// The terms of a developer's base ontology, with the IRIs SPARQL uses for them.
//
// A base lives in the environment, not in the SDK, so its constants come from
// its stored document: `client.ontology.bases.terms("acme")`. The shape is that
// of a built-in starter (`starters.crm`): terms keyed by their local names,
// with `name`, `superTypes`, `domain`, `range` and `inverse` holding the
// qualified names (`acme.Agreement`) and `iri` the IRI of the qualified name.
// database/scripts/gen-starter-terms.mjs writes the same terms as a file with
// literal keys, which the compiler checks. One fixed document pins both forms
// (contracts/ontology-bases/acme.json).

import type { StarterTerms } from "./starters.js";
import type { Schemas } from "./types.js";

const CLASS_NS = "https://littlebigbrain.com/class/";
const PROPERTY_NS = "https://littlebigbrain.com/p/";
const RELATION_NS = "https://littlebigbrain.com/r/";

/**
 * The IRI local part the RDF projection mints for a name: trimmed, lowercased,
 * inner whitespace collapsed, and every byte outside `A-Z a-z 0-9 - _ . ~`
 * percent-encoded.
 */
export function iriSegment(name: string): string {
  const normalized = name.trim().toLowerCase().split(/\s+/).join(" ");
  let out = "";
  for (const byte of new TextEncoder().encode(normalized)) {
    const char = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-_.~]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The qualified name of a base's term: `acme.Agreement`. */
export function qualifiedName(prefix: string, local: string): string {
  return `${prefix}.${local}`;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The terms of a base document as the stored document holds it (local names).
 * The document's `id` is the prefix.
 */
export function baseTerms(
  document: Schemas["OntologyStarterDocument"],
): StarterTerms {
  const prefix = document.id;
  const q = (local: string) => qualifiedName(prefix, local);
  const classes: Mutable<StarterTerms["classes"]> = {};
  for (const cls of document.classes) {
    classes[cls.name] = {
      name: q(cls.name),
      iri: CLASS_NS + iriSegment(q(cls.name)),
      superTypes: (cls.superTypes ?? []).map(q),
    };
  }
  const properties: Mutable<StarterTerms["properties"]> = {};
  for (const property of document.properties) {
    properties[property.name] = {
      name: q(property.name),
      iri: PROPERTY_NS + iriSegment(q(property.name)),
      valueType: property.type,
    };
  }
  const relations: Mutable<StarterTerms["relations"]> = {};
  for (const relation of document.relations) {
    relations[relation.name] = {
      name: q(relation.name),
      iri: RELATION_NS + iriSegment(q(relation.name)),
      domain: relation.domain.map(q),
      range: relation.range.map(q),
      cardinality: relation.cardinality,
      inverse: relation.inverse ? q(relation.inverse) : null,
      inverseIri: relation.inverse
        ? RELATION_NS + iriSegment(q(relation.inverse))
        : null,
    };
  }
  return {
    id: document.id,
    version: document.version,
    label: document.label,
    classes,
    properties,
    relations,
    questions: document.questions.map((question) => ({
      id: question.id,
      text: question.text,
      sparql: question.sparql ?? null,
    })),
  };
}
