// The review items of the link workflow (general linking 5.5): one link
// item per thing, one no-link item per thing of the best candidate, and one
// identity item per group of records. Pure functions.
//
// Every item has the origin `starter:<name>` with the label `link`, the
// producer the inbox labels and patterns read
// (`lbb-server/src/calibration/labels.rs`). A key names the kind and the
// thing, and ends in a hash of the rows: new rows file a new item, and the
// workflow sets the item it replaces to `superseded`.
import { ENTITY_ID_KEY_SENTINEL, type ReviewRequest, type Schemas } from "@littlebigbrain/client";
import { shortId, type Decision } from "./decide.js";
import { hash, idOf, type IdentityProposal } from "./things.js";

/** The producer id of the items: the catalog id of the workflow (general linking 12, decision 5). */
export const PRODUCER = "link";

/** Rows of one item, at most: its facts stay within the 200 rows and 64 KiB of a suggestion. */
export const ITEM_ROWS = 50;

/** A mention as an item shows it. */
export interface MentionView {
  iri: string;
  span: string;
  /** The sentence of a span of text; the field's value for a self mention. */
  line: string;
  source: string;
  sourceName: string;
  sourceClass: string;
  field: string;
}

/** What an item is about: a thing, or a lone mention. */
export interface TargetView {
  /** The thing's IRI, or the lone mention's. */
  iri: string;
  /** The mention the rows pair with: the thing's anchor, or the lone mention. */
  anchor: MentionView;
  label: string;
  kind: string;
}

/** A decision below the gate, with the mention and the thing it may name. */
export interface Row {
  decision: Decision;
  mention: MentionView;
}

/** The commit reference of a mention: its IRI, by id, with its span as the name. */
export const mentionRef = (m: { iri: string; span: string }): Schemas["NamedEntityInput"] => ({
  type: "Mention",
  name: m.span.slice(0, 200) || idOf(m.iri),
  key: `${ENTITY_ID_KEY_SENTINEL}${idOf(m.iri)}`,
});

/** The origin of every item. */
export const origin = (name: string): Schemas["SuggestionOrigin"] => ({
  kind: "agent",
  id: `starter:${name}`,
  label: PRODUCER,
});

const where = (m: MentionView) => `${m.sourceClass} "${m.sourceName.slice(0, 80)}"`;

/** The `SAME_THING_AS` fact of a row, with the row's line as its evidence. */
export function rowFact(row: Row, target: TargetView, confidence: number): Schemas["TripletInput"] {
  return {
    source: mentionRef(row.mention),
    relation: "SAME_THING_AS",
    target: mentionRef(target.anchor),
    confidence,
    evidence: {
      text: row.mention.line.slice(0, 1_000),
      source_id: row.mention.sourceName.slice(0, 200),
    },
  };
}

const sample = (row: Row) => ({
  mention: row.mention.span,
  source: where(row.mention),
  field: row.mention.field,
  line: row.mention.line.slice(0, 300),
  confidence: row.decision.confidence,
  found: row.decision.found,
  ...(row.decision.options
    ? { best_probability: Math.max(0, ...Object.values(row.decision.options)) }
    : {}),
});

/** The key part of a set of rows: a hash of each row's mention, target and value. */
const rowsHash = (rows: Row[]) =>
  hash(
    ...rows
      .map(
        (r) =>
          `${r.mention.iri}|${r.decision.target}|${r.decision.confidence}|${r.decision.outcome}`,
      )
      .sort(),
  ).slice(0, 12);

/**
 * The link and no-link items of one thing: the rows below the gate that
 * may name it, across every source, one item per 100 rows. Accepting an
 * item writes the kept rows as `SAME_THING_AS` facts; a row left out, or a
 * dismissed item, keeps its mention apart from the thing.
 */
export function thingItems(
  name: string,
  gate: number,
  target: TargetView,
  rows: Row[],
): ReviewRequest[] {
  const out: ReviewRequest[] = [];
  for (const kind of ["link", "nolink"] as const) {
    const list = rows
      .filter((r) =>
        kind === "link" ? r.decision.outcome === "review" : r.decision.outcome === "nolink",
      )
      .sort(
        (a, b) =>
          a.decision.confidence - b.decision.confidence || (a.mention.iri < b.mention.iri ? -1 : 1),
      );
    for (let n = 0; n * ITEM_ROWS < list.length; n++) {
      const part = list.slice(n * ITEM_ROWS, (n + 1) * ITEM_ROWS);
      const sources = [...new Set(part.map((r) => r.mention.sourceClass))].sort();
      const found = [...new Set(part.map((r) => r.decision.found ?? "none"))].sort();
      // A no-link row offers the best candidate at its probability; its gate compared the no-link answer.
      const triplets = part.map((r) =>
        rowFact(r, target, kind === "link" ? r.decision.confidence : bestProbability(r)),
      );
      const lowest = Math.min(...part.map((r) => r.decision.confidence));
      out.push({
        key: `starter:${name}:${kind}:${idOf(target.iri)}:${rowsHash(part)}${n ? `:${n}` : ""}`,
        title: (kind === "link"
          ? `${part.length} ${part.length === 1 ? "mention" : "mentions"} may name ${target.label} (${target.kind})`
          : `${part.length} ${part.length === 1 ? "mention" : "mentions"} may name ${target.label} (${target.kind}): the model chose no thing`
        ).slice(0, 200),
        rationale: (kind === "link"
          ? `The link of each row is below the gate ${gate} (lowest ${lowest}). Keep the rows that name ${target.label}; a row left out stays apart from it.`
          : `For each row the decision model chose no thing, below the gate ${gate}. Keep the rows that name ${target.label} after all.`
        ).slice(0, 4_000),
        origin: origin(name),
        facts: {
          triplets,
          summary: `${triplets.length} SAME_THING_AS links to ${target.label}`.slice(0, 500),
        },
        mapping: {
          link: {
            answer: kind === "link" ? "link" : "no_entry",
            thing: target.iri,
            kind: target.kind,
            target: target.anchor.iri,
            gate,
            sources,
            found,
            ...(kind === "nolink" ? { gate_values: part.map((r) => r.decision.confidence) } : {}),
            rows: part.map((r) => ({
              mention: r.mention.iri,
              source: r.mention.source,
              class: r.mention.sourceClass,
              field: r.mention.field,
              value: r.decision.confidence,
              found: r.decision.found,
              ...(r.decision.options ? { options: r.decision.options } : {}),
            })),
          },
        },
        evidence: { records: part.length, samples: part.slice(0, 20).map(sample) },
      });
    }
  }
  return out;
}

const bestProbability = (row: Row) =>
  row.decision.options?.[shortId(row.decision.target ?? "")] ??
  Math.max(0, ...Object.values(row.decision.options ?? {}));

/** A record as an identity item shows it. */
export interface RecordView {
  iri: string;
  name: string;
  class: string;
  /** Its first self mention: the identity's fact pairs these. */
  self?: { iri: string; span: string };
}

/**
 * The identity item of one group of records: 2 to 10 records side by side,
 * with what matched. A person always accepts an identity (decision 2):
 * `identityGate` only orders and groups the items (`mapping.identity.above_gate`).
 * Accepting it writes `SAME_AS` between the records, as an identity of an
 * integration does, and a `SAME_THING_AS` fact between their self mentions,
 * so the link workflow sees the accept.
 */
export function identityItem(
  name: string,
  identityGate: number,
  proposal: IdentityProposal,
  records: Map<string, RecordView>,
): ReviewRequest | null {
  const views = proposal.records.map((r) => records.get(r)).filter((r): r is RecordView => !!r);
  if (views.length < 2) return null;
  const members = views.map((r) => ({
    type: r.class,
    name: r.name.slice(0, 200) || idOf(r.iri),
    key: `${ENTITY_ID_KEY_SENTINEL}${idOf(r.iri)}`,
    source: r.class,
  }));
  const reason = [...new Set(proposal.pairs.map((p) => p.reason))].join("; ").slice(0, 200);
  const first = views[0]!;
  const triplets = views
    .slice(1)
    .filter((r) => r.self && first.self)
    .map((r) => ({
      source: mentionRef(r.self!),
      relation: "SAME_THING_AS",
      target: mentionRef(first.self!),
      confidence: proposal.confidence,
      evidence: { text: reason || "an identity of records", source_id: r.name.slice(0, 200) },
    }));
  const kind = [...new Set(views.map((r) => r.class))].sort().join(", ");
  return {
    key: `starter:${name}:identity:${hash(...proposal.records).slice(0, 24)}`,
    title: `${views.length} records may be one: ${views.map((r) => r.name).join(", ")}`.slice(
      0,
      200,
    ),
    rationale:
      `Their self mentions match (${reason}). A person accepts every identity; the identity gate ${identityGate} only orders the items.`.slice(
        0,
        4_000,
      ),
    origin: origin(name),
    identities: [
      { members, reason: reason || "matching names and keys", confidence: proposal.confidence },
    ],
    ...(triplets.length
      ? {
          facts: {
            triplets,
            summary: `${triplets.length} SAME_THING_AS links between the records' names`,
          },
        }
      : {}),
    mapping: {
      identity: {
        gate: identityGate,
        above_gate: proposal.confidence >= identityGate,
        classes: kind,
        selves: Object.fromEntries(views.filter((r) => r.self).map((r) => [r.iri, r.self!.iri])),
        pairs: proposal.pairs.map((p) => ({
          a: p.a,
          b: p.b,
          confidence: p.confidence,
          reason: p.reason,
        })),
      },
    },
    evidence: {
      records: views.length,
      samples: proposal.pairs.slice(0, 20).map((p) => ({
        a: records.get(p.a)?.name ?? p.a,
        b: records.get(p.b)?.name ?? p.b,
        confidence: p.confidence,
        reason: p.reason,
      })),
    },
  };
}

/** The kind of an item by its key: `link`, `nolink` or `identity`. */
export function itemKind(key: string): "link" | "nolink" | "identity" | null {
  const match = key.match(/^starter:[^:]+:(link|nolink|identity):/);
  return (match?.[1] as "link" | "nolink" | "identity" | undefined) ?? null;
}

/** The IRI a mention reference of an item names. */
export const iriOfRef = (ref: { key?: string | null }) =>
  ref.key?.startsWith(ENTITY_ID_KEY_SENTINEL)
    ? `https://littlebigbrain.com/e/${ref.key.slice(ENTITY_ID_KEY_SENTINEL.length)}`
    : null;

/**
 * The rows of a link or no-link item the workflow filed, read back: its
 * facts and the rows of its mapping. A row the item does not describe in
 * full is left out.
 */
export function rowsOfItem(item: Schemas["OntologyChangeSuggestion"]): Row[] {
  const kind = itemKind(item.key);
  if (kind !== "link" && kind !== "nolink") return [];
  const facts = item.proposed_facts ?? item.facts;
  const mapping = (
    item.mapping as { link?: { rows?: Record<string, unknown>[]; thing?: string } } | null
  )?.link;
  const described = new Map((mapping?.rows ?? []).map((r) => [String(r.mention), r]));
  const out: Row[] = [];
  for (const t of facts?.triplets ?? []) {
    const mention = iriOfRef(t.source);
    const target = iriOfRef(t.target);
    const row = mention ? described.get(mention) : undefined;
    if (!mention || !target || !row) continue;
    const evidence = (t.evidence ?? null) as {
      text?: string | null;
      source_id?: string | null;
    } | null;
    out.push({
      decision: {
        mention,
        outcome: kind === "link" ? "review" : "nolink",
        target,
        thing: mapping?.thing ?? null,
        confidence: Number(row.value ?? t.confidence ?? 0),
        by: "model",
        found: typeof row.found === "string" ? row.found : null,
        kind: null,
        ...(row.options && typeof row.options === "object"
          ? { options: row.options as Record<string, number> }
          : {}),
      },
      mention: {
        iri: mention,
        span: t.source.name,
        line: evidence?.text ?? t.source.name,
        source: String(row.source ?? ""),
        sourceName: evidence?.source_id ?? "",
        sourceClass: String(row.class ?? ""),
        field: String(row.field ?? ""),
      },
    });
  }
  return out;
}
