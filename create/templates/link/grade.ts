// Grade a run of the link workflow against a gold file (general linking 9.2):
// link precision at the gate and recall, pairwise over things, cluster
// purity and completeness (B-cubed), the review share, and identity
// precision. Pure functions, and the reads that take a run from a graph.
//
// The gold file (`lbb.link.gold.v1`):
//
//   {
//     "format": "lbb.link.gold.v1",
//     "complete": true,                       // optional: a mention the gold does not list is a thing of its own
//     "records": { "person-mira": "https://littlebigbrain.com/e/…" },  // optional names for record IRIs
//     "groups": [
//       { "id": "mira", "kind": "person", "mentions": [
//         { "record": "person-mira", "field": "name", "span": "Mira Tannenholt-Ruiz" },
//         { "record": "<a record IRI>", "field": "body", "span": "Mimi T.", "occurrence": 0 }
//       ] }
//     ]
//   }
//
// A gold mention names its record (an IRI, or a name of `records`), the
// field (the property name; `first_name+last_name` for a name joined from a
// given and a family field), the span as the field writes it, and which
// equal span of the field it is (`occurrence`, default 0). Without
// `complete`, a mention the gold does not list is unjudged: a link to it
// counts apart.
import type { LbbActivities, Schemas } from "@littlebigbrain/client";
import { CLASS_IRI, P, PROPERTY_IRI } from "./candidates.js";
import { iriOfRef, itemKind } from "./items.js";
import { fold } from "./names.js";

export interface GoldMention {
  record: string;
  field: string;
  span: string;
  occurrence?: number;
}
export interface Gold {
  format: "lbb.link.gold.v1";
  about?: string;
  complete?: boolean;
  records?: Record<string, string>;
  groups: { id: string; kind?: string; mentions: GoldMention[] }[];
}

/** A mention of a run, as the graph holds it. */
export interface RunMention {
  iri: string;
  record: string;
  field: string;
  span: string;
  role: string;
  thing: string | null;
}
/** A `SAME_THING_AS` of the graph: a written link. */
export interface RunLink {
  a: string;
  b: string;
  confidence: number | null;
}
/** A row of an open review item: a link a person decides. */
export interface RunReview {
  a: string;
  b: string;
  confidence: number;
  kind: "link" | "nolink";
}
export interface RunIdentity {
  records: string[];
  confidence: number;
}
export interface Run {
  mentions: RunMention[];
  links: RunLink[];
  review: RunReview[];
  identities: RunIdentity[];
}

export interface Ratio {
  right: number;
  total: number;
  value: number | null;
  /** The lower end of the 95% Wilson interval. */
  wilsonLow: number | null;
}

export interface Report {
  mentions: { run: number; gold: number; matched: number; unjudged: number };
  /** Written links (edges): right over written; unjudged ones count apart. */
  links: Ratio & { unjudged: number };
  /** Pairs of mentions in one thing: precision and recall against the gold groups. */
  pairs: { precision: Ratio; recall: Ratio };
  /** B-cubed over the gold mentions. */
  purity: number | null;
  completeness: number | null;
  /** Mentions with an open review row over the linkable mentions. */
  reviewShare: Ratio;
  /** Proposed record pairs that the gold puts in one group. */
  identities: { precision: Ratio; recall: Ratio };
}

/** The lower end of the 95% Wilson interval of `right` out of `total`. */
export function wilsonLow(right: number, total: number, z = 1.96): number | null {
  if (!total) return null;
  const p = right / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return Math.max(0, round((center - margin) / (1 + (z * z) / total))) || 0;
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;
const ratio = (right: number, total: number): Ratio => ({
  right,
  total,
  value: total ? round(right / total) : null,
  wilsonLow: wilsonLow(right, total),
});

/** The local name of a field: the end of a property IRI, or the name as it is. */
const fieldName = (field: string) =>
  field.startsWith(PROPERTY_IRI) ? decodeURIComponent(field.slice(PROPERTY_IRI.length)) : field;
const spanKey = (span: string) => fold(span).replace(/\s+/g, " ").trim();
const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** Grade a run against the gold. */
export function grade(gold: Gold, run: Run): Report {
  const recordOf = (ref: string) => gold.records?.[ref] ?? ref;
  // Match each gold mention to a run mention: record, field, span, occurrence.
  const byPlace = new Map<string, RunMention[]>();
  for (const m of run.mentions) {
    const key = `${m.record}\u0000${fieldName(m.field)}\u0000${spanKey(m.span)}`;
    (byPlace.get(key) ?? byPlace.set(key, []).get(key)!).push(m);
  }
  for (const list of byPlace.values()) list.sort((a, b) => (a.iri < b.iri ? -1 : 1));
  const groupOf = new Map<string, string>();
  const goldMentions: { group: string; iri: string | null }[] = [];
  for (const g of gold.groups)
    for (const m of g.mentions) {
      const list =
        byPlace.get(`${recordOf(m.record)}\u0000${m.field}\u0000${spanKey(m.span)}`) ?? [];
      const found = list.find((r) => !groupOf.has(r.iri) && list.indexOf(r) >= (m.occurrence ?? 0));
      if (found) groupOf.set(found.iri, g.id);
      goldMentions.push({ group: g.id, iri: found?.iri ?? null });
    }
  const known = (iri: string) => groupOf.has(iri) || gold.complete === true;
  const goldGroup = (iri: string) => groupOf.get(iri) ?? `alone:${iri}`;
  const unjudged = run.mentions.filter((m) => !groupOf.has(m.iri)).length;

  // Written links.
  let right = 0;
  let wrong = 0;
  let open = 0;
  const edges = new Set<string>();
  for (const l of run.links) {
    const key = pairKey(l.a, l.b);
    if (l.a === l.b || edges.has(key)) continue;
    edges.add(key);
    if (!known(l.a) || !known(l.b)) open += 1;
    else if (goldGroup(l.a) === goldGroup(l.b)) right += 1;
    else wrong += 1;
  }

  // Pairs in one thing: the run's clusters are its things, and each mention without a thing alone.
  const clusterOf = new Map(run.mentions.map((m) => [m.iri, m.thing ?? `alone:${m.iri}`]));
  const judged = run.mentions.filter((m) => known(m.iri));
  const clusters = new Map<string, string[]>();
  for (const m of judged) {
    const c = clusterOf.get(m.iri)!;
    (clusters.get(c) ?? clusters.set(c, []).get(c)!).push(m.iri);
  }
  let runPairs = 0;
  let rightPairs = 0;
  for (const members of clusters.values())
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++) {
        runPairs += 1;
        if (goldGroup(members[i]!) === goldGroup(members[j]!)) rightPairs += 1;
      }
  const sizes = new Map<string, number>();
  for (const g of goldMentions) sizes.set(g.group, (sizes.get(g.group) ?? 0) + 1);
  const goldPairs = [...sizes.values()].reduce((sum, n) => sum + (n * (n - 1)) / 2, 0);

  // B-cubed over the gold mentions.
  let purity = 0;
  let completeness = 0;
  for (const g of goldMentions) {
    const size = sizes.get(g.group)!;
    if (!g.iri) {
      purity += 1;
      completeness += 1 / size;
      continue;
    }
    const members = clusters.get(clusterOf.get(g.iri)!) ?? [g.iri];
    const same = members.filter((m) => goldGroup(m) === g.group).length;
    purity += same / members.length;
    completeness += same / size;
  }

  // The review share: mentions with an open row, over the mentions the gold links to another.
  const linkable = new Set(
    run.mentions
      .filter((m) => groupOf.has(m.iri) && (sizes.get(groupOf.get(m.iri)!) ?? 0) > 1)
      .map((m) => m.iri),
  );
  const reviewed = new Set(run.review.map((r) => r.a).filter((a) => linkable.has(a)));

  // Identities: proposed record pairs, and the gold's record pairs.
  const recordGroups = new Map<string, Set<string>>();
  for (const m of run.mentions)
    if (m.role === "self" && groupOf.has(m.iri))
      (recordGroups.get(m.record) ?? recordGroups.set(m.record, new Set()).get(m.record)!).add(
        groupOf.get(m.iri)!,
      );
  const sameRecord = (a: string, b: string) =>
    [...(recordGroups.get(a) ?? [])].some((g) => recordGroups.get(b)?.has(g));
  const proposed = new Set<string>();
  for (const identity of run.identities)
    for (let i = 0; i < identity.records.length; i++)
      for (let j = i + 1; j < identity.records.length; j++)
        proposed.add(pairKey(identity.records[i]!, identity.records[j]!));
  const proposedRight = [...proposed].filter((p) => {
    const [a, b] = p.split("\u0000") as [string, string];
    return sameRecord(a, b);
  }).length;
  const records = [...recordGroups.keys()].sort();
  let goldRecordPairs = 0;
  let foundRecordPairs = 0;
  for (let i = 0; i < records.length; i++)
    for (let j = i + 1; j < records.length; j++)
      if (sameRecord(records[i]!, records[j]!)) {
        goldRecordPairs += 1;
        if (proposed.has(pairKey(records[i]!, records[j]!))) foundRecordPairs += 1;
      }

  return {
    mentions: {
      run: run.mentions.length,
      gold: goldMentions.length,
      matched: goldMentions.filter((g) => g.iri).length,
      unjudged,
    },
    links: { ...ratio(right, right + wrong), unjudged: open },
    pairs: { precision: ratio(rightPairs, runPairs), recall: ratio(rightPairs, goldPairs) },
    purity: goldMentions.length ? round(purity / goldMentions.length) : null,
    completeness: goldMentions.length ? round(completeness / goldMentions.length) : null,
    reviewShare: ratio(reviewed.size, linkable.size),
    identities: {
      precision: ratio(proposedRight, proposed.size),
      recall: ratio(foundRecordPairs, goldRecordPairs),
    },
  };
}

/** The report as lines of text. */
export function formatReport(report: Report, title = "link run"): string {
  const show = (r: Ratio) =>
    r.value === null
      ? "n/a (0 of 0)"
      : `${r.value} (${r.right} of ${r.total}, Wilson low ${r.wilsonLow})`;
  return [
    `# ${title}`,
    `mentions: ${report.mentions.run} in the run, ${report.mentions.matched} of ${report.mentions.gold} gold mentions found, ${report.mentions.unjudged} not in the gold`,
    `link precision at the gate: ${show(report.links)}${report.links.unjudged ? `, ${report.links.unjudged} unjudged` : ""}`,
    `pairwise precision: ${show(report.pairs.precision)}`,
    `pairwise recall: ${show(report.pairs.recall)}`,
    `cluster purity (B-cubed precision): ${report.purity}`,
    `cluster completeness (B-cubed recall): ${report.completeness}`,
    `review share: ${show(report.reviewShare)}`,
    `identity precision: ${show(report.identities.precision)}`,
    `identity recall: ${show(report.identities.recall)}`,
  ].join("\n");
}

// ---- a run from a graph ---------------------------------------------------------

/** Every mention of the graph with its source, field, span, role, thing and links. */
export const RUN_QUERY = `# link: grade\n${P}PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX lbb: <https://littlebigbrain.com/ns#>
SELECT ?m ?src ?field ?span ?role ?thing ?same ?c WHERE {
  ?m a <${CLASS_IRI}mention> ; p:span ?span ; p:role ?role ; p:field ?field ; r:mentioned_in ?src .
  OPTIONAL { ?m r:refers_to ?thing }
  OPTIONAL {
    ?m r:same_thing_as ?same
    OPTIONAL { ?st rdf:subject ?m ; rdf:predicate r:same_thing_as ; rdf:object ?same ; lbb:confidence ?c }
  }
} LIMIT 200000`;

/** The mentions and written links of a graph. */
export async function readGraphRun(
  lbb: Pick<LbbActivities, "sparql">,
): Promise<Pick<Run, "mentions" | "links">> {
  const { rows } = await lbb.sparql(RUN_QUERY, { consistency: "strong" });
  const mentions = new Map<string, RunMention>();
  const links: RunLink[] = [];
  for (const r of rows) {
    if (!r.m || !r.src) continue;
    if (!mentions.has(r.m))
      mentions.set(r.m, {
        iri: r.m,
        record: r.src,
        field: r.field ?? "",
        span: r.span ?? "",
        role: r.role ?? "refers",
        thing: r.thing ?? null,
      });
    if (r.same)
      links.push({ a: r.m, b: r.same, confidence: r.c !== undefined ? Number(r.c) : null });
  }
  return { mentions: [...mentions.values()], links };
}

/** The open review rows, and the identities filed (open or decided), of the workflow's items. */
export function reviewOfItems(
  items: Schemas["OntologyChangeSuggestion"][],
): Pick<Run, "review" | "identities"> {
  const review: RunReview[] = [];
  const identities: RunIdentity[] = [];
  for (const item of items) {
    const kind = itemKind(item.key);
    // An identity counts once filed, open or decided; a review row only while it is open.
    if (kind === "identity" && item.status !== "superseded") {
      for (const identity of item.proposed_identities ?? item.identities ?? [])
        identities.push({
          records: identity.members.map((m) => iriOfRef(m) ?? m.key),
          confidence: identity.confidence,
        });
      continue;
    }
    if (item.status !== "open" || (kind !== "link" && kind !== "nolink")) continue;
    for (const t of item.facts?.triplets ?? []) {
      const [a, b] = [iriOfRef(t.source), iriOfRef(t.target)];
      if (a && b) review.push({ a, b, confidence: t.confidence ?? 0, kind });
    }
  }
  return { review, identities };
}
