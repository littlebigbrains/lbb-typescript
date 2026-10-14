// A turn of the things identity (general linking 5.4, 8.1, 8.2): the decided
// pairs of one `decided` message, grouped into things. Its steps:
//
// 1. `harvest`: the review items it filed that a person decided since: a
//    kept row is a must-link, a row left out or a dismissed item a
//    cannot-link (2.4, rule 2);
// 2. `group`: the things the message touches, read from the graph; a second
//    look at the mentions left alone; the grouping with its constraints;
//    the anchors and IRIs, merges and splits; what changed;
// 3. `mentions-<n>` and `things-<n>`: the owned writes of what changed;
// 4. `file`: the link, no-link and identity items.
//
// The graph holds the state: each mention keeps the targets of its machine
// links (`linked_to`) and a person's constraints (`must_link`,
// `cannot_link`). A `SAME_THING_AS` that neither names is a row a person
// kept in an accept, so it becomes a must-link.
import {
  ENTITY_ID_KEY_SENTINEL,
  LbbError,
  entityRef,
  isActivityRefused,
  splitInHalves,
  type DecideAnswer,
  type DecideRequest,
  type LbbActivities,
  type OwnedWrite,
  type Schemas,
  type WorkflowContext,
  type WorkflowStepContext,
} from "@littlebigbrain/client";
import {
  BOUNDS,
  candidatesFor,
  keyCountsQuery,
  keyHitsQuery,
  parseCounts,
  parseHits,
  stopKeys,
} from "./candidates.js";
import {
  decideRequest,
  effectIdOf,
  linkRule,
  packRequests,
  rulesDecisions,
  sourceState,
  type Asked,
  type Decision,
} from "./decide.js";
import {
  identityItem,
  iriOfRef,
  itemKind,
  rowsOfItem,
  thingItems,
  type MentionView,
  type RecordView,
  type Row,
  type TargetView,
} from "./items.js";
import { keyWeight } from "./names.js";
import {
  LINK_FIELDS,
  MEMBER_ROWS,
  THING_FIELDS,
  mentionFactsQuery,
  parseMentionFacts,
  parseRecords,
  parseSameAs,
  parseSourceMentions,
  parseThingFacts,
  parseThingMembers,
  parts,
  recordsQuery,
  sameAsQuery,
  sourceMentionsQuery,
  thingFactsQuery,
  thingMembersQuery,
  type MentionFacts,
} from "./reads.js";
import { idIn, iriOf, type DecidedMessage, type LinkPorts, type Settings } from "./settings.js";
import {
  group,
  nameThings,
  type IdentityPair,
  type IdentityProposal,
  type Member,
  type Pair,
  type PreviousThing,
} from "./things.js";

/** What the things identity has done, and the review items it waits on. */
export interface ThingsState {
  turns: number;
  things: number;
  merged: number;
  written: number;
  review: number;
  identities: number;
  secondLooks: number;
  blockedByPerson: number;
  blockedByRecords: number;
  tooLarge: number;
  bounds: Record<string, number>;
  /**
   * The open review items, by `<kind>:<thing or mention IRI>` or
   * `identity:<key>`: what the harvest reads. An identity keeps the short
   * ids of its records.
   */
  open: Record<string, { id: string; key: string; records?: string[] }>;
}

export const emptyThings = (): ThingsState => ({
  turns: 0,
  things: 0,
  merged: 0,
  written: 0,
  review: 0,
  identities: 0,
  secondLooks: 0,
  blockedByPerson: 0,
  blockedByRecords: 0,
  tooLarge: 0,
  bounds: {},
  open: {},
});

/** Review items one harvest reads, at most. */
export const HARVEST = 40;
/** Mentions one turn reads to group, at most. */
export const MAX_MEMBERS = 2_000;
/** Mentions one turn writes, at most; the rest is written in a continued turn. */
export const PLAN_MEMBERS = 250;
/** Review rows one turn files, at most. */
export const PLAN_ROWS = 80;
/** Mentions one second look reads again, at most. */
export const SECOND_LOOK = 32;
/** Open items the state keeps, at most. */
export const MAX_OPEN = 500;
/** Entities of one owned write. */
const WRITE_PART = 900;

const strong = { consistency: "strong" as const };
/** The kinds of a span that is a key, no name. */
const KEY_KINDS_OF_SPANS = new Set(["email", "web", "phone", "handle", "code"]);

/** A changed mention: its thing, its links and its constraints, as it is written. */
interface MentionPlan {
  iri: string;
  span: string;
  thing: string | null;
  thingLabel: string;
  links: {
    target: string;
    span: string;
    confidence: number;
    evidence?: { text: string; source_id: string };
  }[];
  linked: string[];
  must: string[];
  cannot: string[];
}

interface ThingPlan {
  iri: string;
  label: string;
  kind: string;
  anchorKey: string;
  aliases: string[];
  records: { iri: string; class: string; name: string }[];
}

/** What the `group` step saves for the steps after it. */
interface Plan {
  mentions: MentionPlan[];
  things: ThingPlan[];
  merged: { from: string; label: string; into: string; intoLabel: string }[];
  gone: string[];
  rows: { target: TargetView; rows: Row[] }[];
  identities: { proposal: IdentityProposal; records: RecordView[] }[];
  /** Open identity items whose records are now in a group of more than 10: they go. */
  supersede: string[];
  /** The mentions of each row, and the thing each is in now. */
  thingOf: Record<string, string | null>;
  counts: {
    things: number;
    merged: number;
    secondLooks: number;
    blockedByPerson: number;
    blockedByRecords: number;
    tooLarge: number;
  };
  bounds: Record<string, number>;
  more: boolean;
}

/** One turn of the things identity. */
export async function thingsTurn(
  ctx: WorkflowContext,
  lbb: LbbActivities,
  ports: LinkPorts,
  settings: Settings,
  message: DecidedMessage & { must?: [string, string][]; cannot?: [string, string][] },
  state: ThingsState,
): Promise<{ state: ThingsState; next?: DecidedMessage }> {
  const gate = settings.modelsReadRecords ? settings.gate : 1;
  const harvested = await ctx.step("harvest", (s) => harvest(s, ports, state.open));
  const constraints = {
    must: [...(message.must ?? []), ...harvested.must],
    cannot: [...(message.cannot ?? []), ...harvested.cannot],
  };
  const plan = await ctx.step("group", (s) =>
    groupStep(s, lbb, settings, gate, message, constraints, state.open),
  );

  for (let n = 0; n * WRITE_PART < plan.mentions.length; n++)
    await lbb.writeOwned(
      ctx,
      `mentions-${n}`,
      (s) => {
        s.progress("writing things", {
          done: n * WRITE_PART,
          total: plan.mentions.length,
          unit: "mentions",
        });
        return mentionsWrite(plan.mentions.slice(n * WRITE_PART, (n + 1) * WRITE_PART));
      },
      { graph: message.graph },
    );
  const thingCount = plan.things.length + plan.merged.length + plan.gone.length;
  for (let n = 0; n * WRITE_PART < thingCount; n++)
    await lbb.writeOwned(
      ctx,
      `things-${n}`,
      (s) => {
        s.progress("writing things", { done: n * WRITE_PART, total: thingCount, unit: "items" });
        return thingsWrite(plan, n);
      },
      { graph: message.graph },
    );

  const open = { ...state.open };
  for (const key of harvested.closed) delete open[key];
  const filed = await ctx.step("file", (s) => fileItems(s, lbb, ports, settings, gate, plan, open));

  const next: ThingsState = {
    turns: state.turns + 1,
    things: state.things + plan.counts.things,
    merged: state.merged + plan.counts.merged,
    written: state.written + plan.mentions.length,
    review: state.review + filed.rows,
    identities: state.identities + filed.identities,
    secondLooks: state.secondLooks + plan.counts.secondLooks,
    blockedByPerson: state.blockedByPerson + plan.counts.blockedByPerson,
    blockedByRecords: state.blockedByRecords + plan.counts.blockedByRecords,
    tooLarge: state.tooLarge + plan.counts.tooLarge,
    bounds: { ...state.bounds },
    open: filed.open,
  };
  for (const [bound, n] of Object.entries(plan.bounds))
    next.bounds[bound] = (next.bounds[bound] ?? 0) + n;
  if (plan.more)
    return {
      state: next,
      next: { ...message, round: (message.round ?? 0) + 1, ...constraints } as DecidedMessage,
    };
  return { state: next };
}

// ---- harvest -----------------------------------------------------------------------

/** The decisions a person made on the open items: must-links and cannot-links, and the items that closed. */
async function harvest(
  s: WorkflowStepContext,
  ports: LinkPorts,
  open: ThingsState["open"],
): Promise<{ must: [string, string][]; cannot: [string, string][]; closed: string[] }> {
  const out = {
    must: [] as [string, string][],
    cannot: [] as [string, string][],
    closed: [] as string[],
  };
  const keys = Object.keys(open).slice(0, HARVEST);
  for (const [k, key] of keys.entries()) {
    s.progress("reading review decisions", { done: k, total: keys.length, unit: "items" });
    let item: Schemas["OntologyChangeSuggestion"];
    try {
      item = await ports.suggestion(open[key]!.id);
    } catch (error) {
      if (error instanceof LbbError && error.status === 404) {
        out.closed.push(key);
        continue;
      }
      throw error;
    }
    if (item.status === "open") continue;
    out.closed.push(key);
    if (item.status === "superseded") continue;
    const accepted = item.status === "accepted";
    if (itemKind(item.key) === "identity") {
      const selves = ((item.mapping as { identity?: { selves?: Record<string, string> } } | null)
        ?.identity?.selves ?? {}) as Record<string, string>;
      const recordOf = (key: string) =>
        key.startsWith(ENTITY_ID_KEY_SENTINEL)
          ? iriOf(key.slice(ENTITY_ID_KEY_SENTINEL.length))
          : null;
      for (const identity of item.proposed_identities ?? item.identities ?? []) {
        const kept = new Set(
          accepted
            ? (item.identities ?? [])
                .flatMap((i) => i.members.map((m) => m.key))
                .filter((key) => identity.members.some((m) => m.key === key))
            : [],
        );
        const first = identity.members.find((m) => kept.has(m.key)) ?? identity.members[0];
        if (!first) continue;
        const firstSelf = selves[recordOf(first.key) ?? ""];
        for (const member of identity.members) {
          if (member === first || kept.has(member.key)) continue;
          const self = selves[recordOf(member.key) ?? ""];
          if (self && firstSelf) out.cannot.push([self, firstSelf]);
        }
      }
      continue;
    }
    const proposed = (item.proposed_facts ?? item.facts)?.triplets ?? [];
    const kept = accepted ? (item.facts?.triplets ?? []) : [];
    const same = (a: Schemas["TripletInput"], b: Schemas["TripletInput"]) =>
      a.source.key === b.source.key && a.target.key === b.target.key;
    for (const row of proposed) {
      const pair = [iriOfRef(row.source), iriOfRef(row.target)];
      if (!pair[0] || !pair[1]) continue;
      (kept.some((k) => same(k, row)) ? out.must : out.cannot).push(pair as [string, string]);
    }
  }
  return out;
}

// ---- group --------------------------------------------------------------------------

/** The touched mentions and everything their things hold, read until no new mention comes, within the bound. */
async function readComponent(
  lbb: LbbActivities,
  start: Set<string>,
  things: Set<string>,
  bound: (name: string) => void,
) {
  const facts = new Map<string, MentionFacts>();
  const membersOf = new Map<string, Set<string>>();
  const readThings = new Set<string>();
  let frontier = new Set(start);
  const pendingThings = new Set(things);
  for (let round = 0; round < 4 && (frontier.size || pendingThings.size); round++) {
    const next = new Set<string>();
    for (const part of parts([...frontier]))
      for (const [iri, f] of parseMentionFacts(
        (await lbb.sparql(mentionFactsQuery(part), strong)).rows,
      ))
        facts.set(iri, f);
    for (const iri of frontier) {
      const f = facts.get(iri);
      if (!f) continue;
      if (f.thing && !readThings.has(f.thing)) pendingThings.add(f.thing);
      for (const t of [...f.same.map((x) => x.target), ...f.must, ...f.linkedTo])
        if (!facts.has(t)) next.add(t);
    }
    const newThings = [...pendingThings].filter((t) => !readThings.has(t));
    pendingThings.clear();
    for (const part of parts(newThings)) {
      const rows = (await lbb.sparql(thingMembersQuery(part), strong)).rows;
      if (rows.length >= MEMBER_ROWS) bound("thing_members");
      for (const [t, members] of parseThingMembers(rows)) membersOf.set(t, members);
    }
    for (const t of newThings) {
      readThings.add(t);
      for (const x of membersOf.get(t) ?? []) if (!facts.has(x)) next.add(x);
    }
    for (const x of [...next]) if (facts.has(x)) next.delete(x);
    if (facts.size + next.size > MAX_MEMBERS) {
      bound("members");
      break;
    }
    frontier = next;
  }
  return { facts, membersOf, things: readThings };
}

async function groupStep(
  s: WorkflowStepContext,
  lbb: LbbActivities,
  settings: Settings,
  gate: number,
  message: DecidedMessage,
  constraints: { must: [string, string][]; cannot: [string, string][] },
  open: ThingsState["open"],
): Promise<Plan> {
  const bounds: Record<string, number> = {};
  const bound = (name: string) => (bounds[name] = (bounds[name] ?? 0) + 1);
  const decisions: Decision[] = message.decisions.map((d) => ({
    ...d,
    mention: iriOf(d.mention),
    target: d.target ? iriOf(d.target) : null,
    thing: d.thing ? iriOf(d.thing) : null,
  }));
  s.progress("grouping things", { done: 0, total: decisions.length, unit: "links" });
  const removed = new Set(message.removed.map(iriOf));
  const start = new Set<string>([
    ...message.mentions.map(iriOf),
    ...decisions.flatMap((d) => [d.mention, ...(d.target ? [d.target] : [])]),
    ...constraints.must.flat(),
    ...constraints.cannot.flat(),
  ]);
  // An identity names records: their mentions join the read.
  const identityRecords = [...new Set(message.identities.flatMap((p) => [iriOf(p.a), iriOf(p.b)]))];
  for (const part of parts(identityRecords))
    for (const list of parseSourceMentions(
      (await lbb.sparql(sourceMentionsQuery(part), strong)).rows,
    ).values())
      for (const w of list) start.add(w.mention);
  for (const r of removed) start.delete(r);
  const component = await readComponent(lbb, start, new Set(message.things.map(iriOf)), bound);
  const facts = component.facts;

  // The second look: mentions left alone that another mention of the same time may name.
  const second = await secondLook(s, lbb, settings, gate, decisions, facts);
  for (const d of second)
    for (const t of [d.target]) if (t && !facts.has(t)) bound("second_look_target");
  const all = [...decisions, ...second.filter((d) => d.target && facts.has(d.target))];

  const sources = [...new Set([...facts.values()].map((f) => f.source))];
  const records = [
    ...new Set([...facts.values()].filter((f) => f.role === "self").map((f) => f.source)),
  ];
  const recordFacts = new Map<string, { name: string; class: string }>();
  for (const part of parts(sources))
    for (const [iri, r] of parseRecords(
      (await lbb.sparql(recordsQuery(part), strong)).rows,
      Object.keys(settings.fields),
    ))
      recordFacts.set(iri, r);
  const thingFacts = new Map<
    string,
    { anchorKey: string; label: string; mergedInto: string | null }
  >();
  for (const part of parts([...component.things]))
    for (const [iri, t] of parseThingFacts((await lbb.sparql(thingFactsQuery(part), strong)).rows))
      thingFacts.set(iri, t);
  const sameAs: [string, string][] = [];
  for (const part of parts(records))
    sameAs.push(...parseSameAs((await lbb.sparql(sameAsQuery(part), strong)).rows));

  // The machine links: a mention this message decided gets the links of its decisions; the others keep theirs.
  const decided = new Set(all.map((d) => d.mention));
  const linked = new Map<string, Map<string, { confidence: number; by: Pair["by"] }>>();
  for (const f of facts.values()) {
    if (decided.has(f.iri)) continue;
    const entry = new Map<string, { confidence: number; by: Pair["by"] }>();
    for (const t of f.linkedTo)
      entry.set(t, {
        confidence: f.same.find((x) => x.target === t)?.confidence ?? 1,
        by: "model",
      });
    linked.set(f.iri, entry);
  }
  // A refers mention has one answer: its latest decision replaces its link. A self mention's
  // decisions only add: what its own thing holds is no candidate of it, so it is not asked again.
  for (const d of all) {
    let entry = linked.get(d.mention);
    if (!entry) {
      entry = new Map();
      const f = facts.get(d.mention);
      if (f?.role === "self")
        for (const t of f.linkedTo)
          entry.set(t, {
            confidence: f.same.find((x) => x.target === t)?.confidence ?? 1,
            by: "model",
          });
      linked.set(d.mention, entry);
    }
    if (d.outcome === "link" && d.target)
      entry.set(d.target, { confidence: d.confidence, by: d.by });
  }
  // A person's constraints: the stored ones, the edges an accept wrote, the harvested ones (newest wins).
  const must = new Map<string, Set<string>>();
  const cannot = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, a: string, b: string) =>
    (map.get(a) ?? map.set(a, new Set()).get(a)!).add(b);
  const drop = (map: Map<string, Set<string>>, a: string, b: string) => {
    map.get(a)?.delete(b);
    map.get(b)?.delete(a);
  };
  for (const f of facts.values()) {
    for (const t of f.must) add(must, f.iri, t);
    for (const t of f.cannot) add(cannot, f.iri, t);
    for (const { target } of f.same)
      if (!f.linkedTo.includes(target) && !f.must.includes(target)) add(must, f.iri, target);
  }
  for (const [a, b] of constraints.cannot) {
    drop(must, a, b);
    add(cannot, a, b);
    add(cannot, b, a);
  }
  for (const [a, b] of constraints.must) {
    drop(cannot, a, b);
    add(must, a, b);
  }
  // A cannot-link also drops the machine link between the two.
  for (const [a, set] of cannot) for (const b of set) linked.get(a)?.delete(b);

  const members = new Map<string, Member>();
  for (const f of facts.values())
    members.set(f.iri, {
      iri: f.iri,
      role: f.role,
      record: f.role === "self" ? f.source : null,
      span: f.span,
      kind: f.role === "self" ? recordFacts.get(f.source)?.class || "record" : f.kind || "name",
      keyed: KEY_KINDS_OF_SPANS.has(f.kind),
    });
  const pairs: Pair[] = [];
  for (const [a, entry] of linked)
    for (const [b, x] of entry) pairs.push({ a, b, confidence: x.confidence, by: x.by });
  for (const [a, set] of must)
    for (const b of set) pairs.push({ a, b, confidence: 1, by: "person" });
  const cannotPairs: [string, string][] = [];
  for (const [a, set] of cannot) for (const b of set) if (a < b) cannotPairs.push([a, b]);
  const identities: IdentityPair[] = message.identities.map((p) => ({
    ...p,
    a: iriOf(p.a),
    b: iriOf(p.b),
  }));
  const grouping = group({
    members: [...members.values()],
    pairs,
    cannot: cannotPairs,
    sameAs,
    identities,
  });

  const previous: PreviousThing[] = [...component.things]
    .filter((t) => !thingFacts.get(t)?.mergedInto)
    .map((t) => ({
      iri: t,
      anchorKey: thingFacts.get(t)?.anchorKey ?? "",
      members: [...(component.membersOf.get(t) ?? [])],
    }));
  const naming = nameThings(message.graph, grouping.groups, members, previous);
  const thingOf = new Map<string, (typeof naming.things)[number]>();
  for (const t of naming.things) for (const m of t.members) thingOf.set(m, t);

  // What changed, per mention.
  const sameSet = (a: Iterable<string>, b: Iterable<string>) => {
    const [x, y] = [new Set(a), new Set(b)];
    return x.size === y.size && [...x].every((v) => y.has(v));
  };
  const nameOf = (iri: string) => recordFacts.get(iri)?.name ?? "";
  const plans: MentionPlan[] = [];
  for (const f of facts.values()) {
    const thing = thingOf.get(f.iri) ?? null;
    const links = linked.get(f.iri) ?? new Map();
    const mustOf = [...(must.get(f.iri) ?? [])].filter((t) => facts.has(t));
    const cannotOf = [...(cannot.get(f.iri) ?? [])];
    const targets = [...new Set([...links.keys(), ...mustOf])].filter((t) => facts.has(t));
    const changed =
      (thing?.iri ?? null) !== f.thing ||
      !sameSet(links.keys(), f.linkedTo) ||
      !sameSet(mustOf, f.must) ||
      !sameSet(cannotOf, f.cannot) ||
      !sameSet(
        targets,
        f.same.map((x) => x.target),
      );
    if (!changed) continue;
    plans.push({
      iri: f.iri,
      span: f.span,
      thing: thing?.iri ?? null,
      thingLabel: thing?.label ?? "",
      links: targets.map((t) => {
        const known = f.same.some((x) => x.target === t);
        return {
          target: t,
          span: facts.get(t)!.span,
          confidence: links.get(t)?.confidence ?? 1,
          ...(known
            ? {}
            : {
                evidence: {
                  text: (f.window ?? f.span).slice(0, 1_000),
                  source_id: nameOf(f.source).slice(0, 200) || "record",
                },
              }),
        };
      }),
      linked: [...links.keys()].filter((t) => facts.has(t)),
      must: mustOf,
      cannot: cannotOf,
    });
  }
  const more = plans.length > PLAN_MEMBERS;
  if (more) bound("plan_members");

  const view = (iri: string): MentionView => {
    const f = facts.get(iri)!;
    return {
      iri,
      span: f.span,
      line: (f.window ?? f.span).slice(0, 300),
      source: f.source,
      sourceName: nameOf(f.source).slice(0, 80),
      sourceClass: recordFacts.get(f.source)?.class ?? "",
      field: f.field,
    };
  };
  // The review rows, by the thing (or lone mention) their best candidate is in now.
  const byTarget = new Map<string, { target: TargetView; rows: Row[] }>();
  let rows = 0;
  for (const d of all) {
    if ((d.outcome !== "review" && d.outcome !== "nolink") || !d.target) continue;
    if (!facts.has(d.mention) || !facts.has(d.target)) continue;
    const thing = thingOf.get(d.target);
    if (thing && thingOf.get(d.mention) === thing) continue;
    if (rows >= PLAN_ROWS) {
      bound("plan_rows");
      break;
    }
    const key = thing?.iri ?? d.target;
    const target: TargetView = thing
      ? { iri: thing.iri, anchor: view(thing.anchor), label: thing.label, kind: thing.kind }
      : {
          iri: d.target,
          anchor: view(d.target),
          label: facts.get(d.target)!.span,
          kind: members.get(d.target)!.kind,
        };
    const entry = byTarget.get(key) ?? { target, rows: [] };
    entry.rows.push({ decision: { ...d, thing: thing?.iri ?? null }, mention: view(d.mention) });
    byTarget.set(key, entry);
    rows += 1;
  }
  const recordView = (iri: string): RecordView => {
    const self = [...facts.values()]
      .filter((f) => f.role === "self" && f.source === iri)
      .sort(
        (a, b) => Number(a.kind !== "name") - Number(b.kind !== "name") || (a.iri < b.iri ? -1 : 1),
      )[0];
    return {
      iri,
      name: nameOf(iri) || self?.span || "",
      class: recordFacts.get(iri)?.class || "record",
      ...(self ? { self: { iri: self.iri, span: self.span } } : {}),
    };
  };
  const rowMentions = [...byTarget.values()].flatMap((e) => e.rows.map((r) => r.mention.iri));
  // An identity proposed when fewer records shared its keys: the group has grown past 10.
  const short = (iri: string) => idIn(iri).slice(0, 12);
  const crowded = new Set(grouping.tooLargeGroups.flat().map(short));
  const supersede = Object.values(open)
    .filter((entry) => entry.records?.some((r) => crowded.has(r)))
    .map((entry) => entry.id);
  return {
    mentions: plans.slice(0, PLAN_MEMBERS),
    things: naming.things.map((t) => ({
      iri: t.iri,
      label: t.label.slice(0, 200),
      kind: t.kind,
      anchorKey: t.anchorKey,
      aliases: t.aliases,
      records: t.records.map((r) => ({
        iri: r,
        class: recordFacts.get(r)?.class || "record",
        name: nameOf(r),
      })),
    })),
    merged: naming.merged.map((m) => ({
      from: m.from,
      label: thingFacts.get(m.from)?.label ?? "",
      into: m.into,
      intoLabel: naming.things.find((t) => t.iri === m.into)!.label.slice(0, 200),
    })),
    gone: naming.gone,
    rows: [...byTarget.values()],
    identities: grouping.proposals.map((proposal) => ({
      proposal,
      records: proposal.records.map(recordView),
    })),
    supersede,
    thingOf: Object.fromEntries(rowMentions.map((m) => [m, thingOf.get(m)?.iri ?? null])),
    counts: {
      things: naming.things.length,
      merged: naming.merged.length,
      secondLooks: second.length,
      blockedByPerson: grouping.blockedByPerson,
      blockedByRecords: grouping.blockedByRecords,
      tooLarge: grouping.tooLarge,
    },
    bounds,
    more,
  };
}

/**
 * The second look (5.4): two turns that ran at once can each leave a new
 * mention alone that names the other's. For each mention this message left
 * alone, the mentions alone that share a medium or strong key with it and
 * that its turn did not compare it with are decided again, once.
 */
async function secondLook(
  s: WorkflowStepContext,
  lbb: LbbActivities,
  settings: Settings,
  gate: number,
  decisions: Decision[],
  facts: Map<string, MentionFacts>,
): Promise<Decision[]> {
  const alone = decisions
    .filter(
      (d) =>
        (d.outcome === "none" || d.outcome === "nolink") && facts.get(d.mention)?.role === "refers",
    )
    .slice(0, SECOND_LOOK);
  if (!alone.length) return [];
  const keysOf = (f: MentionFacts) => f.keys.filter((k) => keyWeight(k) !== "weak");
  const keys = [...new Set(alone.flatMap((d) => keysOf(facts.get(d.mention)!)))];
  if (!keys.length) return [];
  const counts = new Map<string, number>();
  for (const part of parts(keys, BOUNDS.keysPerRead))
    for (const [k, n] of parseCounts((await lbb.sparql(keyCountsQuery(part), strong)).rows))
      counts.set(k, n);
  const stop = new Set(stopKeys(counts, BOUNDS.stopKey));
  const wanted = keys.filter((k) => !stop.has(k) && (counts.get(k) ?? 0) > 1);
  if (!wanted.length) return [];
  const hits = [];
  for (const part of parts(wanted, BOUNDS.keysPerRead))
    hits.push(...parseHits((await lbb.sparql(keyHitsQuery(part), strong)).rows));
  const out: Decision[] = [];
  const asked: { asked: Asked; mention: string }[] = [];
  for (const d of alone) {
    const f = facts.get(d.mention)!;
    const seen = new Set(d.seen ?? []);
    const fresh = hits.filter(
      (h) =>
        !h.thing &&
        h.mention !== f.iri &&
        h.role === "refers" &&
        !seen.has(idIn(h.mention).slice(0, 12)),
    );
    const candidates = candidatesFor(
      {
        iri: f.iri,
        source: f.source,
        role: "refers",
        span: f.span,
        keys: keysOf(f),
        cannot: f.cannot,
      },
      fresh,
      stop,
    );
    if (!candidates.length) continue;
    if (!settings.modelsReadRecords) {
      out.push(
        ...rulesDecisions({ iri: f.iri, role: "refers", record: null }, candidates).decisions,
      );
      continue;
    }
    asked.push({
      mention: f.iri,
      asked: {
        position: asked.length,
        span: f.span,
        context: `"${f.window ?? f.span}".`,
        kind: false,
        candidates,
      },
    });
  }
  if (asked.length) {
    s.progress("second look", { done: 0, total: asked.length, unit: "mentions" });
    const state = sourceState("A second look: mentions written at the same time", []);
    const answers: Record<string, DecideAnswer> = {};
    const ask = async (group: Asked[]): Promise<void> => {
      const request: DecideRequest = decideRequest(state, group);
      try {
        Object.assign(
          answers,
          (await lbb.decide(request, { effectId: effectIdOf(request), label: "link second look" }))
            .answers,
        );
      } catch (error) {
        if (!isActivityRefused(error)) throw error;
        const halves = splitInHalves(group);
        if (halves) for (const half of halves) await ask(half);
      }
    };
    for (const group of packRequests(
      state,
      asked.map((a) => a.asked),
    ))
      await ask(group);
    for (const { mention, asked: a } of asked)
      out.push(linkRule(mention, a, undefined, answers[`m${a.position}-names`], gate));
  }
  return out.filter((d) => d.outcome !== "none");
}

// ---- writes ---------------------------------------------------------------------------

const mentionRef = (iri: string, span: string) => ({
  type: "Mention",
  name: span.slice(0, 200) || idIn(iri),
  key: `${ENTITY_ID_KEY_SENTINEL}${idIn(iri)}`,
});
const thingRef = (iri: string, label: string) => ({
  type: "LinkedThing",
  name: label.slice(0, 200) || idIn(iri),
  key: `${ENTITY_ID_KEY_SENTINEL}${idIn(iri)}`,
});

/** The owned write of changed mentions: their thing, their links and their constraints. */
function mentionsWrite(plans: MentionPlan[]): OwnedWrite {
  return {
    subjects: plans.map((p) => mentionRef(p.iri, p.span)),
    relations: ["SAME_THING_AS", "REFERS_TO"],
    properties: LINK_FIELDS,
    entity_properties: plans
      .filter((p) => p.linked.length || p.must.length || p.cannot.length)
      .map((p) => ({
        ...mentionRef(p.iri, p.span),
        properties: {
          ...(p.linked.length ? { linked_to: p.linked } : {}),
          ...(p.must.length ? { must_link: p.must } : {}),
          ...(p.cannot.length ? { cannot_link: p.cannot } : {}),
        },
      })),
    triplets: plans.flatMap((p) => [
      ...p.links.map((l) => ({
        source: mentionRef(p.iri, p.span),
        relation: "SAME_THING_AS",
        target: mentionRef(l.target, l.span),
        confidence: l.confidence,
        ...(l.evidence ? { evidence: l.evidence } : {}),
      })),
      ...(p.thing
        ? [
            {
              source: mentionRef(p.iri, p.span),
              relation: "REFERS_TO",
              target: thingRef(p.thing, p.thingLabel),
            },
          ]
        : []),
    ]),
  };
}

/** Part `n` of the owned write of the things: the live ones, the merged ones with their pointer, the gone ones retracted. */
function thingsWrite(plan: Plan, n: number): OwnedWrite {
  const all = [
    ...plan.things.map((t) => ({ kind: "live" as const, t })),
    ...plan.merged.map((m) => ({ kind: "merged" as const, m })),
    ...plan.gone.map((g) => ({ kind: "gone" as const, g })),
  ].slice(n * WRITE_PART, (n + 1) * WRITE_PART);
  const live = all.flatMap((x) => (x.kind === "live" ? [x.t] : []));
  const merged = all.flatMap((x) => (x.kind === "merged" ? [x.m] : []));
  const gone = all.flatMap((x) => (x.kind === "gone" ? [x.g] : []));
  return {
    subjects: [
      ...live.map((t) => thingRef(t.iri, t.label)),
      ...merged.map((m) => thingRef(m.from, m.label)),
    ],
    relations: ["HAS_RECORD", "MERGED_INTO"],
    properties: THING_FIELDS,
    retract_entities: gone.map((g) => thingRef(g, "")),
    entity_properties: live.map((t) => ({
      ...thingRef(t.iri, t.label),
      properties: {
        anchor_key: t.anchorKey,
        kind: t.kind,
        ...(t.aliases.length ? { alias: t.aliases } : {}),
      },
    })),
    triplets: [
      ...live.flatMap((t) =>
        t.records.map((r) => ({
          source: thingRef(t.iri, t.label),
          relation: "HAS_RECORD",
          target: entityRef(r.iri, r.class, r.name || undefined),
        })),
      ),
      ...merged.map((m) => ({
        source: thingRef(m.from, m.label),
        relation: "MERGED_INTO",
        target: thingRef(m.into, m.intoLabel),
      })),
    ],
  };
}

// ---- review items -------------------------------------------------------------------

/** File the items of the plan: per thing its link and no-link items with the rows still open, and the identities. */
async function fileItems(
  s: WorkflowStepContext,
  lbb: LbbActivities,
  ports: LinkPorts,
  settings: Settings,
  gate: number,
  plan: Plan,
  open: ThingsState["open"],
): Promise<{ open: ThingsState["open"]; rows: number; identities: number }> {
  const next = { ...open };
  let rows = 0;
  let identities = 0;
  const total = plan.rows.length * 2 + plan.identities.length;
  let done = 0;
  for (const { target, rows: fresh } of plan.rows) {
    for (const kind of ["link", "nolink"] as const) {
      s.progress("filing review items", { done: done++, total, unit: "items" });
      const outcome = kind === "link" ? "review" : "nolink";
      const now = fresh.filter((r) => r.decision.outcome === outcome);
      const openKey = `${kind}:${target.iri}`;
      const before = next[openKey];
      let kept: Row[] = [];
      if (before) {
        const item = await ports.suggestion(before.id).catch((error: unknown) => {
          if (error instanceof LbbError && error.status === 404) return null;
          throw error;
        });
        if (item?.status === "open")
          kept = rowsOfItem(item).filter(
            (r) =>
              !fresh.some((f) => f.mention.iri === r.mention.iri) &&
              (plan.thingOf[r.mention.iri] ?? null) !== target.iri,
          );
        else delete next[openKey];
      }
      const all = [...now, ...kept];
      if (!all.length) continue;
      const requests = thingItems(settings.name, gate, target, all);
      for (const request of requests) {
        const filed = await lbb.review(request);
        if (request === requests[0]) next[openKey] = { id: filed.suggestion_id, key: request.key! };
      }
      if (before && next[openKey]?.key !== before.key && open[openKey])
        await ports
          .supersede(before.id, `The rows changed: the item ${requests[0]!.key} holds them now.`)
          .catch((error: unknown) => {
            if (!(error instanceof LbbError && (error.status === 404 || error.status === 409)))
              throw error;
          });
      rows += now.length;
    }
  }
  for (const { proposal, records } of plan.identities) {
    s.progress("filing review items", { done: done++, total, unit: "items" });
    const request = identityItem(
      settings.name,
      settings.identityGate,
      proposal,
      new Map(records.map((r) => [r.iri, r])),
    );
    if (!request) continue;
    const filed = await lbb.review(request);
    next[`identity:${request.key}`] = {
      id: filed.suggestion_id,
      key: request.key!,
      records: proposal.records.map((r) => idIn(r).slice(0, 12)),
    };
    identities += 1;
  }
  for (const id of plan.supersede) {
    await ports
      .supersede(id, "More than 10 records share these keys now: no identity of them is proposed.")
      .catch((error: unknown) => {
        if (!(error instanceof LbbError && (error.status === 404 || error.status === 409)))
          throw error;
      });
    for (const [key, entry] of Object.entries(next)) if (entry.id === id) delete next[key];
  }
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_OPEN))) delete next[key];
  return { open: next, rows, identities };
}
