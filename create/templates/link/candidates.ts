// The candidates of a mention (general linking 4.3) and their bounds (4.4).
// The queries are built here and run by the workflow; the scoring is pure.
//
// Block keys are graph facts: `block_key` values on each `Mention`. One read
// counts the mentions per key, so a key that more than 200 mentions hold is
// a stop key and finds nothing. A second read returns the mentions of the
// other keys, with the thing each one belongs to. The neighbours are the
// things of the records within two hops of the mention's source.
import { KEY_KINDS, keyKind, keyWeight, nameSimilarity, type KeyKind } from "./names.js";

/** The bounds of the candidate sources and of a mention (4.4). */
export const BOUNDS = {
  /** Candidates with an equal strong key, per mention. */
  strong: 10,
  /** Candidates that share a medium or weak key, per mention. */
  other: 10,
  /** Candidates among the neighbours, per mention. */
  neighbours: 10,
  /** Records the neighbours read reads, per source turn. */
  neighbourRecords: 50,
  /** Hops from a mention's source to its neighbours. */
  hops: 2,
  /** Candidates of one mention, from every source. */
  total: 30,
  /** A key that more mentions hold is a stop key. */
  stopKey: 200,
  /** Mentions one text value gives. */
  textMentions: 100,
  /** Rows one key read returns. */
  keyRows: 4_000,
  /** Keys one read asks about. */
  keysPerRead: 500,
};

/** The lowest score a candidate found by a medium or weak key keeps. */
export const MIN_SCORE = 0.55;
/** The lowest name similarity a neighbour keeps. */
export const MIN_NEIGHBOUR_SIMILARITY = 0.6;

export const P =
  "PREFIX p: <https://littlebigbrain.com/p/>\nPREFIX r: <https://littlebigbrain.com/r/>\nPREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n";
/** A record's display name, and an entity's name, in the published RDF. */
export const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
export const RELATION_IRI = "https://littlebigbrain.com/r/";
export const PROPERTY_IRI = "https://littlebigbrain.com/p/";
export const CLASS_IRI = "https://littlebigbrain.com/class/";

/** The local part of a class, property or relation IRI, normalized and escaped as the server mints it. */
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

export const classIri = (name: string) => `${CLASS_IRI}${iriSegment(name)}`;
export const propertyIri = (name: string) => `${PROPERTY_IRI}${iriSegment(name)}`;
export const relationIri = (name: string) => `${RELATION_IRI}${iriSegment(name)}`;

/** IRIs as a VALUES list; an IRI a query cannot hold is left out. */
export const iris = (list: string[]) =>
  list
    .filter((iri) => /^[^\s<>"{}|\\^`]+$/.test(iri))
    .map((iri) => `<${iri}>`)
    .join(" ");

/** Strings as a VALUES list of literals. */
export const literals = (list: string[]) => list.map((s) => JSON.stringify(s)).join(" ");

/** The relations of the link vocabulary: a neighbour is never found through them. */
export const LINK_RELATIONS = [
  "mentioned_in",
  "refers_to",
  "same_thing_as",
  "has_record",
  "merged_into",
];

// ---- the reads ------------------------------------------------------------------

/** How many mentions hold each key. */
export function keyCountsQuery(keys: string[]): string {
  return `# link: key counts\n${P}SELECT ?key (COUNT(?m) AS ?n) WHERE {
  VALUES ?key { ${literals(keys)} }
  ?m p:block_key ?key .
} GROUP BY ?key`;
}

export function parseCounts(rows: Record<string, string>[]): Map<string, number> {
  return new Map(rows.map((r) => [r.key!, Number(r.n ?? 0)]));
}

/** The keys that more than `limit` mentions hold. */
export function stopKeys(counts: Map<string, number>, limit = BOUNDS.stopKey): string[] {
  return [...counts]
    .filter(([, n]) => n > limit)
    .map(([key]) => key)
    .sort();
}

/** The mentions that hold the keys, with what they belong to. */
export function keyHitsQuery(keys: string[]): string {
  return `# link: keys\n${P}SELECT ?key ?m ?role ?span ?src ?kind ?window ?thing ?label WHERE {
  VALUES ?key { ${literals(keys)} }
  ?m p:block_key ?key ; p:role ?role ; p:span ?span ; r:mentioned_in ?src .
  OPTIONAL { ?m p:kind ?kind } OPTIONAL { ?m p:window ?window }
  OPTIONAL { ?m r:refers_to ?thing . OPTIONAL { ?thing rdfs:label ?label } }
} LIMIT ${BOUNDS.keyRows}`;
}

/** A mention that holds a looked-up key. */
export interface KeyHit {
  key: string;
  mention: string;
  role: string;
  span: string;
  source: string;
  kind: string | null;
  window: string | null;
  thing: string | null;
  label: string | null;
}

export function parseHits(rows: Record<string, string>[]): KeyHit[] {
  return rows
    .filter((r) => r.key && r.m && r.src)
    .map((r) => ({
      key: r.key!,
      mention: r.m!,
      role: r.role ?? "refers",
      span: r.span ?? "",
      source: r.src!,
      kind: r.kind ?? null,
      window: r.window ?? null,
      thing: r.thing ?? null,
      label: r.label ?? null,
    }));
}

/** One hop of relations from records, both ways, without the link vocabulary. */
export function hopQuery(records: string[]): string {
  const skip = LINK_RELATIONS.map((r) => `r:${r}`).join(", ");
  return `# link: hop\n${P}SELECT ?a ?r ?b ?dir ?name ?class WHERE {
  VALUES ?a { ${iris(records)} }
  { ?a ?r ?b BIND("out" AS ?dir) } UNION { ?b ?r ?a BIND("in" AS ?dir) }
  FILTER(STRSTARTS(STR(?r), "${RELATION_IRI}") && ?r NOT IN (${skip}))
  OPTIONAL { ?b rdfs:label ?name } OPTIONAL { ?b a ?class }
} LIMIT 500`;
}

/** A relation from a record to a neighbour. */
export interface Hop {
  from: string;
  relation: string;
  to: string;
  dir: "out" | "in";
  name: string;
  class: string;
}

const local = (iri: string, base: string) =>
  iri.startsWith(base) ? decodeURIComponent(iri.slice(base.length)) : iri;

export function parseHops(rows: Record<string, string>[]): Hop[] {
  const seen = new Set<string>();
  const out: Hop[] = [];
  for (const r of rows) {
    if (!r.a || !r.r || !r.b) continue;
    const key = `${r.a}\u0000${r.r}\u0000${r.b}\u0000${r.dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      from: r.a,
      relation: local(r.r, RELATION_IRI).toUpperCase(),
      to: r.b,
      dir: r.dir === "in" ? "in" : "out",
      name: r.name ?? "",
      class: r.class ? local(r.class, CLASS_IRI) : "",
    });
  }
  return out;
}

/** The mentions of the neighbour records, with the things they belong to. */
export function neighbourMentionsQuery(records: string[]): string {
  return `# link: neighbour mentions\n${P}SELECT ?n ?m ?role ?span ?thing ?label WHERE {
  VALUES ?n { ${iris(records)} }
  ?m r:mentioned_in ?n ; p:role ?role ; p:span ?span .
  OPTIONAL { ?m r:refers_to ?thing . OPTIONAL { ?thing rdfs:label ?label } }
} LIMIT 2000`;
}

/** A mention of a neighbour record, and how the neighbour is reached from the source. */
export interface NeighbourMention {
  record: string;
  mention: string;
  role: string;
  span: string;
  thing: string | null;
  label: string | null;
}

export function parseNeighbourMentions(rows: Record<string, string>[]): NeighbourMention[] {
  return rows
    .filter((r) => r.n && r.m)
    .map((r) => ({
      record: r.n!,
      mention: r.m!,
      role: r.role ?? "refers",
      span: r.span ?? "",
      thing: r.thing ?? null,
      label: r.label ?? null,
    }));
}

/**
 * The records within `hops` of each source, and how each is reached: a
 * breadth-first walk over `hops` (one read per hop), at most `limit`
 * records. A neighbour's path reads `ABOUT → Deal "…" → INVOLVES`.
 */
export function neighbourPaths(
  sources: string[],
  hopsByLevel: Hop[][],
  limit = BOUNDS.neighbourRecords,
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let total = 0;
  for (const source of sources) {
    const reached = new Map<string, string>([[source, ""]]);
    let frontier = [source];
    for (const level of hopsByLevel) {
      const next: string[] = [];
      for (const hop of level) {
        if (!frontier.includes(hop.from) || reached.has(hop.to) || total >= limit) continue;
        const before = reached.get(hop.from)!;
        const step = `${hop.relation}${hop.dir === "in" ? " (from)" : ""} → ${hop.class || "record"} "${hop.name.slice(0, 60)}"`;
        reached.set(hop.to, before ? `${before} → ${step}` : step);
        next.push(hop.to);
        total += 1;
      }
      frontier = next;
    }
    reached.delete(source);
    out.set(source, reached);
  }
  return out;
}

// ---- candidates -------------------------------------------------------------------

/** A mention whose candidates are wanted. */
export interface MentionInput {
  iri: string;
  source: string;
  role: "self" | "refers";
  span: string;
  keys: string[];
  /** Mentions a person keeps apart from this one. */
  cannot: string[];
  /** The thing the mention is in now: for a self mention, what it holds is no candidate (it is linked already). */
  thing?: string | null;
}

/** One candidate of a mention: a thing, or a lone mention. */
export interface Candidate {
  /** The mention a link pairs with: the one that matched, or a member of the neighbour thing. */
  target: string;
  /** The thing the target belongs to; null for a lone mention. */
  thing: string | null;
  label: string;
  /** Up to three spans of the candidate's members that the reads returned. */
  spans: string[];
  /** The records whose self mentions are among those members. */
  records: string[];
  score: number;
  /** The key kind that found it, or `neighbour`. */
  found: KeyKind | "neighbour";
  strong: boolean;
  /** For a neighbour: how it is reached from the mention's source. */
  via?: string;
  /** For a lone mention of text: its sentence. */
  window?: string;
}

/** Group key of a hit: its thing, else the mention itself. */
const groupOf = (thing: string | null, mention: string) => thing ?? mention;

/**
 * The candidates of a mention: the things and lone mentions with an equal
 * strong key (up to 10), the ones that share a medium or weak key, scored
 * by the key weights and the name similarity (up to 10), and the things of
 * the neighbours that are named alike (up to 10); at most 30, the strong
 * ones first. The mention itself, the other self mentions of its record,
 * and what a person keeps apart from it are left out.
 */
export function candidatesFor(
  m: MentionInput,
  hits: KeyHit[],
  stop: Set<string>,
  neighbours: { mention: NeighbourMention; via: string }[] = [],
): Candidate[] {
  const own = new Set(m.keys.filter((k) => !stop.has(k)));
  const banned = new Set(m.cannot);
  const groups = new Map<
    string,
    {
      target: string;
      thing: string | null;
      label: string;
      spans: Set<string>;
      records: Set<string>;
      keys: Set<string>;
      window?: string;
      via?: string;
    }
  >();
  const entry = (thing: string | null, mention: string, label: string) => {
    const key = groupOf(thing, mention);
    let g = groups.get(key);
    if (!g) {
      g = { target: mention, thing, label, spans: new Set(), records: new Set(), keys: new Set() };
      groups.set(key, g);
    }
    return g;
  };
  const skip = (mention: string, source: string, role: string) =>
    mention === m.iri ||
    banned.has(mention) ||
    (m.role === "self" && role === "self" && source === m.source);
  for (const hit of hits) {
    if (!own.has(hit.key) || skip(hit.mention, hit.source, hit.role)) continue;
    if (hit.thing && (banned.has(hit.thing) || (m.role === "self" && hit.thing === m.thing)))
      continue;
    const g = entry(hit.thing, hit.mention, hit.label ?? hit.span);
    g.keys.add(hit.key);
    g.spans.add(hit.span);
    if (hit.role === "self") g.records.add(hit.source);
    if (!hit.thing && hit.window) g.window = hit.window;
    // A strong key names its target: the member that holds it.
    if ([...g.keys].some((k) => keyWeight(k) === "strong") && keyWeight(hit.key) === "strong")
      g.target = hit.mention;
  }
  const scored: Candidate[] = [];
  for (const g of groups.values()) {
    const strongKey = [...g.keys].find((k) => keyWeight(k) === "strong");
    const similarity = Math.max(0, ...[...g.spans].map((s) => nameSimilarity(m.span, s)));
    const keyScore = Math.min(
      1,
      [...g.keys].reduce((sum, k) => sum + KEY_KINDS[keyKind(k)!].value, 0),
    );
    const best = [...g.keys].sort(
      (a, b) => KEY_KINDS[keyKind(b)!].value - KEY_KINDS[keyKind(a)!].value,
    )[0]!;
    scored.push({
      target: g.target,
      thing: g.thing,
      label: g.label,
      spans: [...g.spans].slice(0, 3),
      records: [...g.records].sort(),
      score: strongKey ? 1 : round(0.5 * keyScore + 0.5 * similarity),
      found: keyKind(strongKey ?? best)!,
      strong: Boolean(strongKey),
      ...(g.window ? { window: g.window } : {}),
    });
  }
  const strong = scored
    .filter((c) => c.strong)
    .sort(byScore)
    .slice(0, BOUNDS.strong);
  const other = scored
    .filter((c) => !c.strong && c.score >= MIN_SCORE)
    .sort(byScore)
    .slice(0, BOUNDS.other);

  // The neighbours: the things (and lone mentions) of the records near the source.
  const near = new Map<string, Candidate>();
  for (const { mention: n, via } of neighbours) {
    if (
      skip(n.mention, n.record, n.role) ||
      (n.thing && (banned.has(n.thing) || (m.role === "self" && n.thing === m.thing)))
    )
      continue;
    if (n.record === m.source) continue;
    const key = groupOf(n.thing, n.mention);
    const similarity = nameSimilarity(m.span, n.span);
    if (similarity < MIN_NEIGHBOUR_SIMILARITY) continue;
    const before = near.get(key);
    const score = round(0.3 + 0.5 * similarity);
    if (before && before.score >= score) continue;
    near.set(key, {
      target: n.mention,
      thing: n.thing,
      label: n.label ?? n.span,
      spans: [n.span],
      records: n.role === "self" ? [n.record] : [],
      score,
      found: "neighbour",
      strong: false,
      via: n.role === "self" ? via : `named in ${via}`,
    });
  }
  const out: Candidate[] = [];
  const taken = new Map<string, Candidate>();
  for (const c of [...strong, ...other]) {
    out.push(c);
    taken.set(groupOf(c.thing, c.target), c);
  }
  for (const c of [...near.values()].sort(byScore).slice(0, BOUNDS.neighbours)) {
    const key = groupOf(c.thing, c.target);
    const found = taken.get(key);
    if (found) {
      // Found by a key and near the source: both count.
      found.via ??= c.via;
      if (!found.strong) found.score = round(Math.min(1, found.score + 0.05));
      continue;
    }
    out.push(c);
  }
  return [...out.filter((c) => c.strong), ...out.filter((c) => !c.strong).sort(byScore)].slice(
    0,
    BOUNDS.total,
  );
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const byScore = (a: Candidate, b: Candidate) =>
  b.score - a.score || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0);
