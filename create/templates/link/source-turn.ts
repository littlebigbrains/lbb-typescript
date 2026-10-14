// A turn of a source shard (general linking 8.1, 8.2): a window of records
// of one class. Its steps:
//
// 1. `sources`: the records of the window, read at the message's commit,
//    and the mentions the workflow wrote for them before;
// 2. `mentions-<k>`: the mentions of record k: its names and keys, and the
//    spans of its text fields (the gazetteer pass, then the spans written
//    like a name or a key; the reasoning model only for a field that opts in);
// 3. `link-<n>`: the candidates of 40 mentions and their decisions;
// 4. `write-<k>`: one owned write per record: its mentions and their keys;
// 5. `send`: the `decided` message to the things identity.
//
// Each step saves what the next steps need, so a turn that runs again after
// a crash reads and asks nothing twice.
import {
  ENTITY_ID_KEY_SENTINEL,
  entityRef,
  isActivityRefused,
  splitInHalves,
  type DecideAnswer,
  type DecideRequest,
  type LbbActivities,
  type OwnedWrite,
  type WorkflowContext,
  type WorkflowStepContext,
} from "@littlebigbrain/client";
import {
  BOUNDS,
  candidatesFor,
  hopQuery,
  keyCountsQuery,
  keyHitsQuery,
  neighbourMentionsQuery,
  neighbourPaths,
  parseCounts,
  parseHits,
  parseHops,
  parseNeighbourMentions,
  stopKeys,
  type Candidate,
  type Hop,
  type KeyHit,
  type NeighbourMention,
} from "./candidates.js";
import {
  decideRequest,
  effectIdOf,
  linkRule,
  none,
  packRequests,
  rulesDecisions,
  sameRecord,
  sourceState,
  type Asked,
  type AskedPair,
  type Decision,
  type RecordContext,
} from "./decide.js";
import { blockKeys, keptKeys, normalName, type SpanKind } from "./names.js";
import {
  MENTION_FIELDS,
  orphanMentionsQuery,
  parseSourceMentions,
  parseSources,
  parts,
  sourceMentionsQuery,
  sourcesQuery,
  type WrittenMention,
} from "./reads.js";
import {
  DECIDED_BYTES,
  classOf,
  idIn,
  reviewsWorkflowName,
  thingsId,
  type DecidedMessage,
  type LinkPorts,
  type Settings,
  type SourceMessage,
} from "./settings.js";
import {
  checkExtracted,
  extractRequest,
  extracts,
  gazetteerKeys,
  roleOf,
  selfMentions,
  textMentions,
  type FieldSpec,
  type FoundMention,
  type SourceRecord,
} from "./sources/records.js";
import { mentionIri, type IdentityPair } from "./things.js";

/** What a source shard has done, over all its turns. */
export interface ShardState {
  turns: number;
  sources: number;
  mentions: number;
  links: number;
  review: number;
  nolink: number;
  alone: number;
  identities: number;
  /** The stop keys that fired, with how many mentions held each (at most 50 keys). */
  stopKeys: Record<string, number>;
  /** How often each bound cut a list. */
  bounds: Record<string, number>;
}

export const emptyShard = (): ShardState => ({
  turns: 0,
  sources: 0,
  mentions: 0,
  links: 0,
  review: 0,
  nolink: 0,
  alone: 0,
  identities: 0,
  stopKeys: {},
  bounds: {},
});

/** A mention of the turn, with its IRI and keys. */
export interface SourceMention extends FoundMention {
  iri: string;
  source: string;
  record: string | null;
  keys: string[];
  cannot: string[];
  thing: string | null;
}

/** Mentions of one `link-<n>` step. */
export const LINK_STEP = 40;
/** Stop keys the state keeps. */
const MAX_STOP_KEYS = 50;

const strong = { consistency: "strong" as const };

/** The text fields of a class, and its context fields. */
const fieldsOf = (fields: Record<string, FieldSpec>, role: (spec: FieldSpec) => boolean) =>
  Object.entries(fields)
    .filter(([, spec]) => role(spec))
    .map(([field]) => field);

/** A source turn, or a turn of the reviews workflow. */
export async function sourceTurn(
  ctx: WorkflowContext,
  lbb: LbbActivities,
  ports: LinkPorts,
  settings: Settings,
  message: SourceMessage,
  state: ShardState,
): Promise<{ state: ShardState; next?: SourceMessage }> {
  if (message.workflow === reviewsWorkflowName(settings)) {
    await reviewsTurn(ctx, ports, settings, message);
    return { state: { ...state, turns: state.turns + 1 } };
  }
  const cls = classOf(settings, message.workflow);
  const fields = settings.fields[cls]!;
  const read = reader(lbb, message, cls, fields);

  const at = message.cursor ?? 0;
  const plan = await ctx.step("sources", async (s) => {
    s.progress("reading sources", { done: 0, total: message.instances.length, unit: "records" });
    const records = await read.records();
    const textual = fieldsOf(fields, (spec) => roleOf(spec) === "text");
    const chunk: string[] = [];
    let chars = 0;
    for (const iri of message.instances.slice(at)) {
      const record = records.get(iri);
      const length = textual.reduce(
        (sum, f) => sum + (record?.values[f] ?? []).reduce((n, v) => n + v.length, 0),
        0,
      );
      if (
        chunk.length &&
        (chunk.length >= settings.sourcesPerTurn || chars + length > settings.textPerTurn)
      )
        break;
      chunk.push(iri);
      chars += length;
    }
    const gone = at === 0 ? message.removed : [];
    const written = new Map<string, WrittenMention[]>();
    for (const part of parts([...chunk, ...gone]))
      for (const [source, list] of parseSourceMentions(
        (await lbb.sparql(sourceMentionsQuery(part), strong)).rows,
      ))
        written.set(source, list);
    // A deleted record took the edges to it: its mentions are found as orphans.
    if (gone.length) {
      const orphans = (await lbb.sparql(orphanMentionsQuery(), strong)).rows
        .filter((r) => r.m)
        .map((r) => ({ mention: r.m!, thing: r.thing ?? null, cannot: [] }));
      if (orphans.length) written.set(gone[0]!, [...(written.get(gone[0]!) ?? []), ...orphans]);
    }
    return {
      chunk,
      gone,
      written: Object.fromEntries(written),
      names: Object.fromEntries(chunk.map((iri) => [iri, records.get(iri)?.name ?? ""])),
    };
  });

  const found: { source: string; mentions: FoundMention[] }[] = [];
  for (const [k, iri] of plan.chunk.entries()) {
    const mentions = await ctx.step(`mentions-${k}`, async (s) => {
      s.progress("finding mentions", { done: k, total: plan.chunk.length, unit: "records" });
      const record = (await read.records()).get(iri);
      return record ? findMentions(s, lbb, settings, record, fields) : [];
    });
    found.push({ source: iri, mentions });
  }

  const cannotOf = new Map<string, string[]>();
  const thingNow = new Map<string, string | null>();
  for (const list of Object.values(plan.written))
    for (const w of list) {
      cannotOf.set(w.mention, w.cannot);
      thingNow.set(w.mention, w.thing);
    }
  const mentions: SourceMention[] = found.flatMap(({ source, mentions: list }) =>
    list.map((f) => {
      const iri = mentionIri(message.graph, source, f.field, f.span, f.occurrence);
      return {
        ...f,
        iri,
        source,
        record: f.role === "self" ? source : null,
        keys: keptKeys(blockKeys(f.span, f.kind)),
        cannot: cannotOf.get(iri) ?? [],
        thing: thingNow.get(iri) ?? null,
      };
    }),
  );

  const decided: LinkOutput = { decisions: [], identities: [], stop: {}, bounds: {} };
  for (let n = 0; n * LINK_STEP < mentions.length; n++) {
    const out = await ctx.step(`link-${n}`, (s) =>
      linkPart(s, lbb, settings, cls, plan.names, mentions, n),
    );
    decided.decisions.push(...out.decisions);
    decided.identities.push(...out.identities);
    Object.assign(decided.stop, out.stop);
    for (const [bound, count] of Object.entries(out.bounds))
      decided.bounds[bound] = (decided.bounds[bound] ?? 0) + count;
  }

  const kindOf = new Map(
    decided.decisions.filter((d) => d.kind).map((d) => [d.mention, d.kind!] as const),
  );
  const sources = [...plan.chunk, ...plan.gone];
  for (const [k, source] of sources.entries())
    await lbb.writeOwned(
      ctx,
      `write-${k}`,
      (s) => {
        s.progress("writing mentions", { done: k, total: sources.length, unit: "records" });
        return mentionsWrite(
          source,
          cls,
          plan.names[source] ?? "",
          mentions.filter((m) => m.source === source),
          plan.written[source] ?? [],
          kindOf,
        );
      },
      { graph: message.graph },
    );

  const newIris = new Set(mentions.map((m) => m.iri));
  const retracted = Object.values(plan.written)
    .flat()
    .filter((w) => !newIris.has(w.mention));
  await ctx.step("send", async (s) => {
    const messages = decidedMessages(settings, message, ctx, {
      mentions: mentions.map((m) => idIn(m.iri)),
      removed: retracted.map((w) => idIn(w.mention)),
      things: [...new Set(retracted.map((w) => w.thing).filter((t): t is string => !!t))].map(idIn),
      decisions: decided.decisions.map(compact),
      identities: decided.identities.map((p) => ({ ...p, a: idIn(p.a), b: idIn(p.b) })),
    });
    for (const [n, body] of messages.entries()) {
      s.progress("sending decisions", { done: n, total: messages.length, unit: "messages" });
      await ports.send(thingsId(settings), body, {
        id: decidedId(ctx, n),
        origin: { kind: "app", reason: "decided", note: `${ctx.workflowId} turn ${ctx.turn}` },
      });
    }
    return messages.length;
  });

  const count = (outcome: Decision["outcome"]) =>
    decided.decisions.filter((d) => d.outcome === outcome).length;
  const stopKeysSeen = { ...state.stopKeys, ...decided.stop };
  const next: ShardState = {
    turns: state.turns + 1,
    sources: state.sources + plan.chunk.length,
    mentions: state.mentions + mentions.length,
    links: state.links + count("link"),
    review: state.review + count("review"),
    nolink: state.nolink + count("nolink"),
    alone: state.alone + count("none"),
    identities: state.identities + decided.identities.length,
    stopKeys: Object.fromEntries(Object.entries(stopKeysSeen).sort().slice(0, MAX_STOP_KEYS)),
    bounds: { ...state.bounds },
  };
  for (const [bound, n] of Object.entries(decided.bounds))
    next.bounds[bound] = (next.bounds[bound] ?? 0) + n;
  const end = at + plan.chunk.length;
  if (end < message.instances.length)
    return { state: next, next: { ...message, removed: [], cursor: end } };
  return { state: next };
}

/** The id of the `n`th part of a turn's decided message: `decided-<shard>-<turn>`, then `.1`, `.2`, … */
export const decidedId = (ctx: WorkflowContext, n: number) =>
  `decided-${ctx.workflowId}-${ctx.turn}${n ? `.${n}` : ""}`;

/** A decision with entity ids for IRIs, for a message. */
const compact = (d: Decision): Decision => ({
  ...d,
  mention: idIn(d.mention),
  target: d.target ? idIn(d.target) : null,
  thing: d.thing ? idIn(d.thing) : null,
});

/** The decided message of a turn, in parts of at most 24,000 bytes. */
export function decidedMessages(
  settings: Settings,
  message: { graph: string; as_of_commit_seq: number },
  ctx: { workflowId: string; turn: number },
  body: Pick<DecidedMessage, "mentions" | "removed" | "things" | "decisions" | "identities">,
): DecidedMessage[] {
  const empty = (part: number): DecidedMessage => ({
    type: "decided",
    workflow: settings.name,
    graph: message.graph,
    as_of_commit_seq: message.as_of_commit_seq,
    from: ctx.workflowId,
    turn: ctx.turn,
    part,
    mentions: [],
    removed: [],
    things: [],
    decisions: [],
    identities: [],
  });
  const out = [empty(0)];
  const fits = (m: DecidedMessage) => JSON.stringify(m).length <= DECIDED_BYTES;
  for (const field of ["mentions", "removed", "things", "decisions", "identities"] as const)
    for (const item of body[field] as unknown[]) {
      let last = out.at(-1)!;
      (last[field] as unknown[]).push(item);
      if (!fits(last) && (last[field] as unknown[]).length > 1) {
        (last[field] as unknown[]).pop();
        last = empty(out.length);
        out.push(last);
        (last[field] as unknown[]).push(item);
      }
    }
  return out;
}

/** A turn of the reviews workflow: accepted review items wrote `SAME_THING_AS`; the things identity groups again. */
async function reviewsTurn(
  ctx: WorkflowContext,
  ports: LinkPorts,
  settings: Settings,
  message: SourceMessage,
) {
  const origin = message.origin ?? ctx.origin ?? null;
  const requests = origin?.requests ?? [];
  // The link workflow's own writes wake the watch too: forward only an accept, or a change it cannot name.
  if (requests.length && !requests.some((r) => r.startsWith("ontology-suggestion:"))) return;
  if (!message.instances.length) return;
  await ctx.step("send", async () => {
    const [body] = decidedMessages(settings, message, ctx, {
      mentions: message.instances.map(idIn),
      removed: [],
      things: [],
      decisions: [],
      identities: [],
    });
    await ports.send(thingsId(settings), body!, {
      id: decidedId(ctx, 0),
      origin: { kind: "app", reason: "accepted", note: `${ctx.workflowId} turn ${ctx.turn}` },
    });
    return 1;
  });
}

/** The records of a message, read once per attempt at the message's commit. */
function reader(
  lbb: LbbActivities,
  message: SourceMessage,
  cls: string,
  fields: Record<string, FieldSpec>,
) {
  let records: Promise<Map<string, SourceRecord>> | undefined;
  const names = Object.keys(fields);
  return {
    records: () =>
      (records ??= (async () => {
        const out = new Map<string, SourceRecord>();
        for (const part of parts(message.instances)) {
          const { rows } = await lbb.sparql({
            query: sourcesQuery(part, names),
            as_of_commit_seq: message.as_of_commit_seq,
          });
          for (const [iri, record] of parseSources(rows, part, cls, names)) out.set(iri, record);
        }
        return out;
      })()),
  };
}

/** The keys among `keys` that one mention or more hold, and fewer than the stop limit. */
async function knownKeys(
  lbb: LbbActivities,
  keys: string[],
): Promise<{ known: Set<string>; counts: Map<string, number> }> {
  const counts = new Map<string, number>();
  for (const part of parts(keys, BOUNDS.keysPerRead))
    for (const [key, n] of parseCounts((await lbb.sparql(keyCountsQuery(part), strong)).rows))
      counts.set(key, n);
  const known = new Set(
    [...counts].filter(([, n]) => n >= 1 && n <= BOUNDS.stopKey).map(([k]) => k),
  );
  return { known, counts };
}

/** The mentions of one record. */
async function findMentions(
  s: WorkflowStepContext,
  lbb: LbbActivities,
  settings: Settings,
  record: SourceRecord,
  fields: Record<string, FieldSpec>,
): Promise<FoundMention[]> {
  const out = selfMentions(record, fields);
  const texts = Object.entries(fields).filter(([, spec]) => roleOf(spec) === "text");
  const values = texts.flatMap(([field]) => record.values[field] ?? []);
  if (!values.length) return out;
  const { known } = await knownKeys(lbb, gazetteerKeys(values));
  let calls = 0;
  for (const [field, spec] of texts)
    for (const [i, text] of (record.values[field] ?? []).entries()) {
      const found = textMentions(field, i, text, known, BOUNDS.textMentions);
      if (settings.modelsReadRecords && extracts(spec) && found.length < BOUNDS.textMentions) {
        const answer = await lbb.reason(extractRequest(record, field, text), {
          effectId: calls ? `${s.effectId}.${calls}` : s.effectId,
          label: `${record.class} ${field} mentions`.slice(0, 64),
        });
        calls += 1;
        found.push(...checkExtracted(answer.value, field, i, text, found, BOUNDS.textMentions));
      }
      out.push(...found);
    }
  return out;
}

/** What one `link-<n>` step saves. */
interface LinkOutput {
  decisions: Decision[];
  identities: IdentityPair[];
  stop: Record<string, number>;
  bounds: Record<string, number>;
}

/** The candidates and decisions of the `n`th 40 mentions of the turn. */
async function linkPart(
  s: WorkflowStepContext,
  lbb: LbbActivities,
  settings: Settings,
  cls: string,
  names: Record<string, string>,
  all: SourceMention[],
  n: number,
): Promise<LinkOutput> {
  const part = all.slice(n * LINK_STEP, (n + 1) * LINK_STEP);
  const out: LinkOutput = { decisions: [], identities: [], stop: {}, bounds: {} };
  const bound = (name: string) => (out.bounds[name] = (out.bounds[name] ?? 0) + 1);
  s.progress("finding candidates", { done: n * LINK_STEP, total: all.length, unit: "mentions" });

  // Keys: the counts first, so a stop key finds nothing; then the mentions of the others.
  const keys = [...new Set(part.flatMap((m) => m.keys))];
  const { counts } = await knownKeys(lbb, keys);
  const stop = new Set(stopKeys(counts, BOUNDS.stopKey));
  for (const key of stop) out.stop[key] = counts.get(key)!;
  const wanted = keys.filter((k) => !stop.has(k) && (counts.get(k) ?? 0) > 0);
  const hits: KeyHit[] = [];
  for (const chunk of parts(wanted, BOUNDS.keysPerRead)) {
    const rows = (await lbb.sparql(keyHitsQuery(chunk), strong)).rows;
    if (rows.length >= BOUNDS.keyRows) bound("key_rows");
    hits.push(...parseHits(rows));
  }
  // The new mentions of this turn are not written yet: they are candidates of each other too.
  for (const m of all.filter((x) => x.thing === null && !hits.some((h) => h.mention === x.iri)))
    for (const key of m.keys)
      if (!stop.has(key))
        hits.push({
          key,
          mention: m.iri,
          role: m.role,
          span: m.span,
          source: m.source,
          kind: m.kind,
          window: m.window ?? null,
          thing: null,
          label: null,
        });

  // The neighbours of the sources of `refers` mentions, two hops out.
  const sources = [...new Set(part.map((m) => m.source))];
  const near = await neighbours(lbb, sources, bound);

  // For the identities of `self` mentions: the names near each record and its context values.
  const contexts = await recordContexts(lbb, settings, part, hits, near.hops);

  const candidates = new Map<string, Candidate[]>();
  for (const m of part) {
    const list = candidatesFor(
      m,
      hits,
      stop,
      m.role === "refers" ? (near.bySource.get(m.source) ?? []) : [],
    );
    if (list.length >= BOUNDS.total) bound("candidates");
    candidates.set(m.iri, list);
  }

  s.progress("linking mentions", { done: n * LINK_STEP, total: all.length, unit: "mentions" });
  if (!settings.modelsReadRecords) {
    for (const m of part) {
      const decided = rulesDecisions(m, candidates.get(m.iri)!, contexts);
      out.decisions.push(...decided.decisions);
      out.identities.push(...decided.identities);
    }
    claimedOnce(out.decisions, part);
    return out;
  }
  await decideByModel(
    s,
    lbb,
    settings,
    cls,
    names,
    part,
    candidates,
    contexts,
    near.relations,
    out,
  );
  return out;
}

/** The records two hops from the sources, and the mentions on them. */
async function neighbours(
  lbb: LbbActivities,
  sources: string[],
  bound: (name: string) => void,
): Promise<{
  bySource: Map<string, { mention: NeighbourMention; via: string }[]>;
  hops: Hop[];
  relations: Map<string, string[]>;
}> {
  const first = parseHops((await lbb.sparql(hopQuery(sources), strong)).rows);
  const reachedFirst = [...new Set(first.map((h) => h.to))].slice(0, BOUNDS.neighbourRecords);
  const second = reachedFirst.length
    ? parseHops((await lbb.sparql(hopQuery(reachedFirst), strong)).rows)
    : [];
  const paths = neighbourPaths(sources, [first, second]);
  const records = [...new Set([...paths.values()].flatMap((p) => [...p.keys()]))];
  if (records.length >= BOUNDS.neighbourRecords) bound("neighbour_records");
  const mentions = records.length
    ? parseNeighbourMentions(
        (
          await lbb.sparql(
            neighbourMentionsQuery(records.slice(0, BOUNDS.neighbourRecords)),
            strong,
          )
        ).rows,
      )
    : [];
  const bySource = new Map<string, { mention: NeighbourMention; via: string }[]>();
  for (const [source, reached] of paths)
    bySource.set(
      source,
      mentions
        .filter((m) => reached.has(m.record))
        .map((m) => ({ mention: m, via: reached.get(m.record)! })),
    );
  const relations = new Map<string, string[]>();
  for (const h of first)
    (relations.get(h.from) ?? relations.set(h.from, []).get(h.from)!).push(
      `${h.dir === "in" ? `${h.class || "record"} "${h.name}" ${h.relation} this` : `${h.relation} ${h.class || "record"} "${h.name}"`}`,
    );
  return { bySource, hops: [...first, ...second], relations };
}

/**
 * For each record whose self mention has a candidate with another record:
 * the normal names of the records it is related to and of its context field
 * values. Two records that share one are corroborated (the rules' identity).
 */
async function recordContexts(
  lbb: LbbActivities,
  settings: Settings,
  part: SourceMention[],
  hits: KeyHit[],
  known: Hop[],
): Promise<Map<string, RecordContext>> {
  const records = new Set<string>();
  for (const m of part) {
    if (m.role !== "self") continue;
    records.add(m.source);
    for (const h of hits)
      if (h.role === "self" && h.source !== m.source && m.keys.includes(h.key))
        records.add(h.source);
  }
  const out = new Map<string, RecordContext>();
  if (!records.size) return out;
  const list = [...records];
  const hops = [...known.filter((h) => records.has(h.from))];
  const missing = list.filter((r) => !known.some((h) => h.from === r));
  for (const chunk of parts(missing, 50))
    hops.push(...parseHops((await lbb.sparql(hopQuery(chunk), strong)).rows));
  const contextFields = [
    ...new Set(
      Object.values(settings.fields).flatMap((f) =>
        fieldsOf(f, (spec) => roleOf(spec) === "context"),
      ),
    ),
  ];
  const values = new Map<string, string[]>();
  if (contextFields.length)
    for (const chunk of parts(list)) {
      const { rows } = await lbb.sparql(sourcesQuery(chunk, contextFields), strong);
      for (const [iri, record] of parseSources(rows, chunk, "", contextFields))
        values.set(iri, Object.values(record.values).flat());
    }
  for (const record of list) {
    const near = new Set<string>();
    for (const h of hops) if (h.from === record && h.name) near.add(normalName(h.name));
    for (const v of values.get(record) ?? []) near.add(normalName(v));
    near.delete("");
    out.set(record, { near });
  }
  return out;
}

/** The decisions of the decision model, per source: one state, packed requests, content effect ids. */
async function decideByModel(
  s: WorkflowStepContext,
  lbb: LbbActivities,
  settings: Settings,
  cls: string,
  names: Record<string, string>,
  part: SourceMention[],
  candidates: Map<string, Candidate[]>,
  contexts: Map<string, RecordContext>,
  relations: Map<string, string[]>,
  out: LinkOutput,
) {
  const sources = [...new Set(part.map((m) => m.source))];
  for (const source of sources) {
    const mentions = part.filter((m) => m.source === source);
    const asked: Asked[] = [];
    const pairs: (AskedPair & {
      record: string;
      other: string;
      mention: string;
      candidate: Candidate;
      kind: "identity" | "self";
    })[] = [];
    mentions.forEach((m, position) => {
      const list = candidates.get(m.iri)!;
      if (m.role === "refers") {
        const strongOnes = list.filter((c) => c.strong);
        const distinct = new Set(strongOnes.map((c) => c.thing ?? c.target));
        if (distinct.size === 1) {
          out.decisions.push(rulesDecisions(m, list).decisions[0]!);
          return;
        }
        if (!list.length) {
          out.decisions.push(none(m.iri, list));
          return;
        }
        asked.push({
          position,
          span: m.span,
          context: `${cls} "${names[source] ?? ""}", field ${m.field}: "${m.window ?? m.span}".`,
          kind: m.kind === "text",
          candidates: strongOnes.length > 1 ? strongOnes : list,
        });
        return;
      }
      // A self mention: identities with other records, links to things without a record.
      let any = false;
      list.forEach((c, k) => {
        const others = c.records.filter((r) => r !== m.record);
        if (others.length) {
          for (const other of others) {
            if (c.strong) {
              out.identities.push({
                a: m.record!,
                b: other,
                confidence: 1,
                reason: `the same ${c.found}`,
              });
              any = true;
            } else if (c.found === "name" || c.found === "alias" || c.found === "name:initial") {
              // The same two records give the same question from either side.
              const mine = `${cls} "${m.span}"${describeNear(contexts.get(m.record!))}`;
              const theirs = `"${c.label}"${describeNear(contexts.get(other))}`;
              const [a, b] = m.record! < other ? [mine, theirs] : [theirs, mine];
              pairs.push({
                id: `p${position}x${k}x${pairs.length}`,
                a,
                b,
                match: c.found,
                record: m.record!,
                other,
                mention: m.iri,
                candidate: c,
                kind: "identity",
              });
              any = true;
            }
          }
          return;
        }
        if (c.records.length) return;
        any = true;
        if (c.strong) out.decisions.push(rulesDecisions(m, [c]).decisions[0]!);
        else
          pairs.push({
            id: `p${position}x${k}x${pairs.length}`,
            a: `the span "${c.spans[0] ?? c.label}"${c.window ? ` in "${c.window}"` : ""}`,
            b: `the ${cls} "${m.span}"${describeNear(contexts.get(m.record!))}`,
            match: c.found,
            record: m.record!,
            other: "",
            mention: m.iri,
            candidate: c,
            kind: "self",
          });
      });
      if (!any) out.decisions.push(none(m.iri, list));
    });
    if (!asked.length && !pairs.length) continue;
    const state = sourceState(`${cls} "${names[source] ?? ""}"`, relations.get(source) ?? []);
    const answers: Record<string, DecideAnswer> = {};
    const ask = async (
      request: DecideRequest,
      items: unknown[],
      again: (half: unknown[]) => DecideRequest,
    ) => {
      try {
        const answered = await lbb.decide(request, {
          effectId: effectIdOf(request),
          label: `${cls} links`.slice(0, 64),
        });
        Object.assign(answers, answered.answers);
      } catch (error) {
        if (!isActivityRefused(error)) throw error;
        const halves = splitInHalves(items);
        if (halves) for (const half of halves) await ask(again(half), half, again);
      }
    };
    for (const group of packRequests(state, asked))
      await ask(decideRequest(state, group), group, (half) =>
        decideRequest(state, half as Asked[]),
      );
    for (const group of parts(pairs, 32))
      await ask(decideRequest(state, [], group), group, (half) =>
        decideRequest(state, [], half as AskedPair[]),
      );
    for (const a of asked) {
      const m = mentions[a.position]!;
      out.decisions.push(
        linkRule(
          m.iri,
          a,
          answers[`m${a.position}-kind`],
          answers[`m${a.position}-names`],
          settings.gate,
        ),
      );
    }
    for (const pair of pairs) {
      const answer = answers[`${pair.id}-same`];
      if (pair.kind === "identity") {
        const identity = sameRecord(pair.record, pair.other, answer, pair.match);
        if (identity) out.identities.push(identity);
        continue;
      }
      const p =
        answer?.probabilities?.same ?? (answer?.choice === "same" ? (answer.confidence ?? 0) : 0);
      const confidence = Math.round(p * 1000) / 1000;
      if (confidence < 0.5) continue;
      out.decisions.push({
        mention: pair.mention,
        outcome: confidence >= settings.gate ? "link" : "review",
        target: pair.candidate.target,
        thing: pair.candidate.thing,
        confidence,
        by: "model",
        found: pair.candidate.found,
        kind: null,
      });
    }
    for (const m of mentions)
      if (m.role === "self" && !out.decisions.some((d) => d.mention === m.iri))
        out.decisions.push(none(m.iri, candidates.get(m.iri)!));
  }
  claimedOnce(out.decisions, part);
  s.progress("linking mentions", { done: part.length, total: part.length, unit: "mentions" });
}

/**
 * A mention without a thing that the self mentions of two records link to
 * is no link of either: a person decides. Without it, the record whose pair
 * the grouping takes first would win.
 */
export function claimedOnce(
  decisions: Decision[],
  part: { iri: string; role: string; record: string | null }[],
) {
  const recordOf = new Map(part.map((m) => [m.iri, m.record]));
  const claims = new Map<string, Set<string>>();
  for (const d of decisions)
    if (d.outcome === "link" && d.target && !d.thing && recordOf.get(d.mention))
      (claims.get(d.target) ?? claims.set(d.target, new Set()).get(d.target)!).add(
        recordOf.get(d.mention)!,
      );
  for (const d of decisions)
    if (d.outcome === "link" && d.target && (claims.get(d.target)?.size ?? 0) > 1) {
      d.outcome = "review";
      d.confidence = Math.min(d.confidence, 0.5);
    }
}

const describeNear = (context: RecordContext | undefined) =>
  context?.near.size ? ` (related: ${[...context.near].slice(0, 6).join(", ")})` : "";

/** The owned write of one record: its mentions, their fields and keys, and `MENTIONED_IN`; the mentions it no longer has go. */
export function mentionsWrite(
  source: string,
  cls: string,
  name: string,
  mentions: SourceMention[],
  written: WrittenMention[],
  kindOf: Map<string, string> = new Map(),
): OwnedWrite {
  const keep = new Set(mentions.map((m) => m.iri));
  const ref = (m: { iri: string; span: string }) => ({
    type: "Mention",
    name: m.span.slice(0, 200),
    key: `${ENTITY_ID_KEY_SENTINEL}${idIn(m.iri)}`,
  });
  const target = entityRef(source, cls, name || undefined);
  return {
    subjects: mentions.map(ref),
    relations: ["MENTIONED_IN"],
    properties: MENTION_FIELDS,
    retract_entities: written
      .filter((w) => !keep.has(w.mention))
      .map((w) => ({
        type: "Mention",
        name: idIn(w.mention),
        key: `${ENTITY_ID_KEY_SENTINEL}${idIn(w.mention)}`,
      })),
    entity_properties: mentions.map((m) => ({
      ...ref(m),
      properties: {
        span: m.span,
        role: m.role,
        kind: kindOf.get(m.iri) ?? spanKindName(m.kind),
        field: m.field,
        offset: m.offset,
        length: m.length,
        block_key: m.keys,
        ...(m.window ? { window: m.window } : {}),
      },
    })),
    triplets: mentions.map((m) => ({ source: ref(m), relation: "MENTIONED_IN", target })),
  };
}

const spanKindName = (kind: SpanKind) => (kind === "text" ? "name" : kind);
