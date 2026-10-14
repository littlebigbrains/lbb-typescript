// Things: the groups of mentions that name the same real thing (general
// linking 2.1 to 2.4, 5.4). Pure functions: the grouping with must-links and
// cannot-links, the identity proposals, the anchors, the IRIs, and the merges
// and splits from one grouping to the next.
//
// The rules that keep a thing stable:
//
// - A person's decision is a constraint: a kept link is a must-link, a link
//   left out or dismissed is a cannot-link. No model answer joins what a
//   cannot-link keeps apart.
// - The things of two records are never joined without an accepted identity
//   (`SAME_AS`). A pair that would join them becomes an identity proposal.
// - The anchor names the thing: a record's self mention first, then a
//   definition, then a page's self mention, then any other mention; inside
//   a rank the smallest stable key. The thing's IRI is a hash of the graph
//   and the anchor's key, so the same inputs give the same IRIs.
// - A thing whose anchor changed, or that merged into another, keeps one
//   statement: `MERGED_INTO` the thing that holds its members now.
import { createHash } from "node:crypto";
import { ENTITY_IRI_NAMESPACE } from "@littlebigbrain/client";
import { normalName } from "./names.js";

/** A SHA-256 of the parts, as hex. */
export const hash = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex");

/** The 32-hex id of an entity IRI. */
export const idOf = (iri: string) =>
  iri.startsWith(ENTITY_IRI_NAMESPACE)
    ? iri.slice(ENTITY_IRI_NAMESPACE.length)
    : hash(iri).slice(0, 32);

/**
 * The IRI of a mention: a hash of the graph, its source, its field, its
 * span and which equal span of the field it is. A mention keeps its IRI
 * while that text stays, also when text before it changes.
 */
export function mentionIri(
  graph: string,
  source: string,
  field: string,
  span: string,
  occurrence: number,
): string {
  return (
    ENTITY_IRI_NAMESPACE +
    hash("lbb.link.mention.v1", graph, idOf(source), field, span, String(occurrence)).slice(0, 32)
  );
}

/** The IRI of a thing: a hash of the graph and its anchor's key. */
export function thingIri(graph: string, anchorKey: string): string {
  return ENTITY_IRI_NAMESPACE + hash("lbb.link.thing.v1", graph, anchorKey).slice(0, 32);
}

/** A mention as the grouping sees it. */
export interface Member {
  iri: string;
  role: "self" | "refers" | "defines";
  /** The record whose self mention this is. */
  record: string | null;
  span: string;
  /** What the thing is called by its kind: the record's class, or the mention's kind. */
  kind: string;
  /** The span is a key (an email, a web address, a phone number, a handle, a code), no name. */
  keyed?: boolean;
}

/** The rank of a member as an anchor: a record's self mention, a definition, a page's self mention, any other. */
export const rankOf = (m: Member): number =>
  m.role === "self" && m.record ? 0 : m.role === "defines" ? 1 : m.role === "self" ? 2 : 3;

/** The stable key a member anchors a thing by: its record's id, else its own id. */
export const anchorKeyOf = (m: Member): string =>
  rankOf(m) === 0 ? `record:${idOf(m.record!)}` : `mention:${idOf(m.iri)}`;

/** Who made a pair. A person's pairs and the identities join first, then the others by confidence. */
export type PairBy = "person" | "strong" | "model" | "rule";

/** A decided or kept pair: the two mentions name the same thing. */
export interface Pair {
  a: string;
  b: string;
  confidence: number;
  by: PairBy;
}

/** Two records a decision proposes as one identity, with why. */
export interface IdentityPair {
  a: string;
  b: string;
  confidence: number;
  reason: string;
}

export interface GroupInput {
  members: Member[];
  pairs: Pair[];
  /** Pairs of mentions a person keeps apart. */
  cannot: [string, string][];
  /** Pairs of records a person accepted as one identity (`SAME_AS`). */
  sameAs: [string, string][];
  /** Identities the decisions propose between records. */
  identities?: IdentityPair[];
}

/** Records proposed as one identity: 2 to 10 of them, with the pairs that matched. */
export interface IdentityProposal {
  records: string[];
  confidence: number;
  pairs: IdentityPair[];
}

export interface Grouping {
  /** The groups of mention IRIs, each sorted, ordered by their first member. */
  groups: string[][];
  proposals: IdentityProposal[];
  /** Pairs a cannot-link kept apart. */
  blockedByPerson: number;
  /** Pairs that would have joined the things of two records without an accepted identity. */
  blockedByRecords: number;
  /** Identity groups of more than 10 records: not proposed. */
  tooLarge: number;
  /** The records of each identity group of more than 10. */
  tooLargeGroups: string[][];
}

/** Records of one identity, at most: the server's limit. */
export const MAX_IDENTITY = 10;

const ORDER: Record<PairBy, number> = { person: 0, strong: 1, model: 2, rule: 3 };

/**
 * Group the members by their pairs. The self mentions of one record join
 * first, then the records of each accepted identity, then a person's pairs,
 * then the other pairs from the highest confidence down. A join that a
 * cannot-link forbids is skipped. A join of two groups that both hold a
 * record and no accepted identity is skipped and proposed as an identity.
 */
export function group(input: GroupInput): Grouping {
  const members = new Map(input.members.map((m) => [m.iri, m]));
  const parent = new Map<string, string>();
  const sets = new Map<string, { members: Set<string>; records: Set<string> }>();
  for (const m of members.values()) {
    parent.set(m.iri, m.iri);
    sets.set(m.iri, { members: new Set([m.iri]), records: new Set(m.record ? [m.record] : []) });
  }
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let at = x; parent.get(at) !== root;) {
      const next = parent.get(at)!;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  const cannot = new Map<string, Set<string>>();
  for (const [a, b] of input.cannot) {
    if (a === b) continue;
    (cannot.get(a) ?? cannot.set(a, new Set()).get(a)!).add(b);
    (cannot.get(b) ?? cannot.set(b, new Set()).get(b)!).add(a);
  }
  const kept = (ra: string, rb: string) => {
    const [small, large] = [sets.get(ra)!, sets.get(rb)!].sort(
      (x, y) => x.members.size - y.members.size,
    );
    for (const m of small!.members)
      for (const other of cannot.get(m) ?? []) if (large!.members.has(other)) return true;
    return false;
  };
  const union = (ra: string, rb: string) => {
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    parent.set(drop, keep);
    const into = sets.get(keep)!;
    for (const m of sets.get(drop)!.members) into.members.add(m);
    for (const r of sets.get(drop)!.records) into.records.add(r);
    sets.delete(drop);
  };
  const out: Grouping = {
    groups: [],
    proposals: [],
    blockedByPerson: 0,
    blockedByRecords: 0,
    tooLarge: 0,
    tooLargeGroups: [],
  };
  const proposed: IdentityPair[] = [...(input.identities ?? [])];

  // The self mentions of one record name the record.
  const selfOf = new Map<string, string>();
  for (const m of [...members.values()].sort((x, y) => (x.iri < y.iri ? -1 : 1))) {
    if (!m.record || m.role !== "self") continue;
    const first = selfOf.get(m.record);
    if (first === undefined) selfOf.set(m.record, m.iri);
    else if (find(first) !== find(m.iri)) union(find(first), find(m.iri));
  }
  // An accepted identity joins its records.
  for (const [a, b] of [...input.sameAs].sort()) {
    const [x, y] = [selfOf.get(a), selfOf.get(b)];
    if (x && y && find(x) !== find(y)) union(find(x), find(y));
  }
  const pairs = input.pairs
    .filter((p) => p.a !== p.b && members.has(p.a) && members.has(p.b))
    .sort(
      (x, y) =>
        (x.by === "person" ? 0 : 1) - (y.by === "person" ? 0 : 1) ||
        y.confidence - x.confidence ||
        ORDER[x.by] - ORDER[y.by] ||
        (x.a + x.b < y.a + y.b ? -1 : x.a + x.b > y.a + y.b ? 1 : 0),
    );
  for (const pair of pairs) {
    const [ra, rb] = [find(pair.a), find(pair.b)];
    if (ra === rb) continue;
    if (kept(ra, rb)) {
      out.blockedByPerson += 1;
      continue;
    }
    const [x, y] = [sets.get(ra)!.records, sets.get(rb)!.records];
    if (x.size && y.size) {
      out.blockedByRecords += 1;
      const [first, second] = [[...x].sort()[0]!, [...y].sort()[0]!];
      proposed.push({
        a: first,
        b: second,
        confidence: pair.confidence,
        reason: `a mention links ${members.get(pair.a)!.span} and ${members.get(pair.b)!.span}`,
      });
      continue;
    }
    union(ra, rb);
  }

  out.groups = [...sets.values()]
    .map((s) => [...s.members].sort())
    .sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
  out.proposals = proposals(proposed, find, selfOf, cannot, sets, out);
  return out;
}

/** The identity proposals of the pairs: components over records, without the pairs already joined or kept apart. */
function proposals(
  pairs: IdentityPair[],
  find: (x: string) => string,
  selfOf: Map<string, string>,
  cannot: Map<string, Set<string>>,
  sets: Map<string, { members: Set<string>; records: Set<string> }>,
  out: Grouping,
): IdentityProposal[] {
  const groupOf = (record: string) => {
    const self = selfOf.get(record);
    return self ? find(self) : `record:${record}`;
  };
  const recordsOf = (record: string) => {
    const self = selfOf.get(record);
    return self ? [...sets.get(find(self))!.records] : [record];
  };
  const apart = (a: string, b: string) => {
    const left = sets.get(groupOf(a))?.members ?? new Set<string>();
    const right = sets.get(groupOf(b))?.members ?? new Set<string>();
    for (const m of left)
      for (const other of cannot.get(m) ?? []) if (right.has(other)) return true;
    return false;
  };
  const parent = new Map<string, string>();
  const find2 = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const kept: IdentityPair[] = [];
  for (const pair of pairs) {
    if (pair.a === pair.b || groupOf(pair.a) === groupOf(pair.b) || apart(pair.a, pair.b)) continue;
    kept.push(pair);
    const [x, y] = [find2(groupOf(pair.a)), find2(groupOf(pair.b))];
    if (x !== y) parent.set(x < y ? y : x, x < y ? x : y);
  }
  const components = new Map<string, { groups: Set<string>; pairs: IdentityPair[] }>();
  for (const pair of kept) {
    const root = find2(groupOf(pair.a));
    const entry = components.get(root) ?? { groups: new Set<string>(), pairs: [] };
    entry.groups.add(groupOf(pair.a)).add(groupOf(pair.b));
    entry.pairs.push(pair);
    components.set(root, entry);
  }
  const result: IdentityProposal[] = [];
  for (const { pairs: matched } of components.values()) {
    const records = [
      ...new Set(matched.flatMap((p) => [...recordsOf(p.a), ...recordsOf(p.b)])),
    ].sort();
    if (records.length > MAX_IDENTITY) {
      out.tooLarge += 1;
      out.tooLargeGroups.push(records);
      continue;
    }
    if (records.length < 2) continue;
    const best = new Map<string, IdentityPair>();
    for (const p of matched) {
      const key = [p.a, p.b].sort().join("\u0000");
      if ((best.get(key)?.confidence ?? -1) < p.confidence) best.set(key, p);
    }
    const unique = [...best.values()].sort((x, y) => y.confidence - x.confidence);
    result.push({
      records,
      confidence: Math.min(...unique.map((p) => p.confidence)),
      pairs: unique,
    });
  }
  return result.sort((a, b) => (a.records[0]! < b.records[0]! ? -1 : 1));
}

// ---- naming ----------------------------------------------------------------------

/** A thing as the graph held it before this grouping. */
export interface PreviousThing {
  iri: string;
  anchorKey: string;
  members: string[];
}

/** A thing as this grouping names it. */
export interface NamedThing {
  iri: string;
  anchorKey: string;
  anchor: string;
  label: string;
  kind: string;
  members: string[];
  records: string[];
  /** The other names its members use, in their normal form. */
  aliases: string[];
}

export interface Naming {
  things: NamedThing[];
  /** Things of before whose members another thing holds now: `from` keeps `MERGED_INTO` `into`. */
  merged: { from: string; into: string }[];
  /** Things of before whose members no thing holds now. */
  gone: string[];
  /** Mentions in no thing: alone, and anchoring nothing. */
  lone: string[];
}

/** The aliases a thing keeps, at most. */
export const MAX_ALIASES = 16;

/** The anchor of a group: the best rank, then the smallest key. */
export function anchorOf(members: Member[]): Member {
  return [...members].sort(
    (a, b) =>
      rankOf(a) - rankOf(b) ||
      (anchorKeyOf(a) < anchorKeyOf(b) ? -1 : anchorKeyOf(a) > anchorKeyOf(b) ? 1 : 0) ||
      // The self mentions of one record share a key: a name before a key.
      Number(Boolean(a.keyed)) - Number(Boolean(b.keyed)) ||
      (a.iri < b.iri ? -1 : 1),
  )[0]!;
}

/**
 * Name the groups. A group of two or more members, or with a record's self
 * mention or a definition, is a thing with the IRI of its anchor; the other
 * groups are lone mentions. A thing of before that this grouping does not
 * name again points to the thing that holds its anchor now, else to the
 * one that holds most of its members, else it is gone.
 */
export function nameThings(
  graph: string,
  groups: string[][],
  members: Map<string, Member>,
  previous: PreviousThing[] = [],
): Naming {
  const naming: Naming = { things: [], merged: [], gone: [], lone: [] };
  for (const iris of groups) {
    const list = iris.map((iri) => members.get(iri)!).filter(Boolean);
    if (!list.length) continue;
    const anchor = anchorOf(list);
    if (list.length < 2 && rankOf(anchor) > 1) {
      naming.lone.push(anchor.iri);
      continue;
    }
    const anchorKey = anchorKeyOf(anchor);
    // The label is the anchor's name; an anchor that is a key (a lead known by its email) takes the best name of its thing.
    const names = list.filter((m) => !m.keyed);
    const label = anchor.keyed && names.length ? anchorOf(names).span : anchor.span;
    const aliases = [
      ...new Set(
        list
          .filter((m) => !m.keyed)
          .map((m) => normalName(m.span))
          .filter((name) => name && name !== normalName(label)),
      ),
    ]
      .sort()
      .slice(0, MAX_ALIASES);
    naming.things.push({
      iri: thingIri(graph, anchorKey),
      anchorKey,
      anchor: anchor.iri,
      label,
      kind: anchor.kind,
      members: [...iris],
      records: [...new Set(list.map((m) => m.record).filter((r): r is string => !!r))].sort(),
      aliases,
    });
  }
  const live = new Map(naming.things.map((t) => [t.iri, t]));
  for (const before of previous) {
    if (live.has(before.iri)) continue;
    const holding = naming.things.find((t) =>
      t.members.some((m) => {
        const member = members.get(m);
        return member !== undefined && anchorKeyOf(member) === before.anchorKey;
      }),
    );
    const most = [...naming.things]
      .map((t) => ({ t, n: t.members.filter((m) => before.members.includes(m)).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n || (a.t.iri < b.t.iri ? -1 : 1))[0]?.t;
    const into = holding ?? most;
    if (into) naming.merged.push({ from: before.iri, into: into.iri });
    else naming.gone.push(before.iri);
  }
  return naming;
}
