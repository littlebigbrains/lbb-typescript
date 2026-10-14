// The decision (general linking 5.1 to 5.3): which thing a mention names.
// Pure functions: the questions, the state the model reads, the packing of
// the requests, the link rule, and the decision by keys and rules alone.
//
// Without model reads of record values (`modelsReadRecords: false`, the
// default, decision 1) a strong key links at confidence 1, and every other
// candidate goes to a person: the rules use the gate 1. With them, the
// decision model answers a kind question and a names question per mention
// and a same-record question per record pair; the confidence of a link is
// the smaller of the linkable kinds' probability and the names answer (the
// rule of link version 7).
import type { DecideAnswer, DecideQuestion, DecideRequest } from "@littlebigbrain/client";
import type { Candidate } from "./candidates.js";
import { hash, idOf, type IdentityPair } from "./things.js";

/** What became of a mention's decision. */
export type Outcome = "link" | "review" | "nolink" | "none";

/** A decision about one mention and one candidate. */
export interface Decision {
  mention: string;
  outcome: Outcome;
  /** The mention a link pairs with (for `nolink`, the best candidate's). */
  target: string | null;
  thing: string | null;
  /** The value the gate compared: the link's confidence, or the no-link answer's. */
  confidence: number;
  by: "strong" | "model" | "rule";
  found: string | null;
  /** The kind answer of a mention found in text. */
  kind: string | null;
  /** The names answer's probability of each candidate, by target id, the four highest. */
  options?: Record<string, number>;
  /** For a mention left alone: the ids of the candidates it was compared with (for the second look). */
  seen?: string[];
}

/** The kinds of the kind question (5.1). */
export const KINDS: Record<string, string> = {
  person: "A person, by name, initials or a nickname.",
  organization: "A company, a team or another organization.",
  product: "A product, a part or a service that is offered.",
  place: "A place, a site or an address.",
  document: "A document, a file or a contract.",
  code: "A code or an identifier of something.",
  value: "A value: an amount, a date, a quantity or a property of something.",
  external: "Something outside the records: a standard, a law or a public name.",
  other: "No name: a common word or a phrase.",
};

/** The kinds that link: every kind but `value`, `external` and `other`. */
export const LINKABLE = ["person", "organization", "product", "place", "document", "code"];

const round = (x: number) => Math.round(x * 1000) / 1000;
/** A short id in decisions and messages: the first 12 hex characters of an entity id. */
export const shortId = (iri: string) => idOf(iri).slice(0, 12);

/** Two candidates are one thing when they share a thing, else when they are one mention. */
const sameCandidate = (a: Candidate, b: Candidate) =>
  (a.thing ?? a.target) === (b.thing ?? b.target);

// ---- by keys and rules ----------------------------------------------------------

/** What the rules know of a self mention's record, for an identity: the names near it and in its context fields. */
export interface RecordContext {
  /** Normal forms of the names of the records it is related to and of its context field values. */
  near: Set<string>;
}

/**
 * The decisions of one mention by keys and rules. A `refers` mention links
 * at 1 to the one thing with its strong key, and goes to a person when two
 * things share it or when only a medium or a weak key, or a neighbour, found
 * the best candidate. A `self` mention links at 1 to a thing without a
 * record that holds its strong key; a candidate with another record is an
 * identity: at 1 for a strong key, at 0.9 for a name when the records share
 * a related record or a context value, else none.
 */
export function rulesDecisions(
  m: { iri: string; role: "self" | "refers"; record: string | null },
  candidates: Candidate[],
  records: Map<string, RecordContext> = new Map(),
): { decisions: Decision[]; identities: IdentityPair[] } {
  const decisions: Decision[] = [];
  const identities: IdentityPair[] = [];
  const decision = (c: Candidate, outcome: Outcome, confidence: number): Decision => ({
    mention: m.iri,
    outcome,
    target: c.target,
    thing: c.thing,
    confidence: round(confidence),
    by: c.strong && outcome === "link" ? "strong" : "rule",
    found: c.found,
    kind: null,
  });
  if (m.role === "refers") {
    const strong = candidates.filter((c) => c.strong);
    const distinct = strong.filter((c, i) => strong.findIndex((d) => sameCandidate(c, d)) === i);
    if (distinct.length === 1) decisions.push(decision(distinct[0]!, "link", 1));
    else if (distinct.length > 1) decisions.push(decision(distinct[0]!, "review", 0.5));
    else if (candidates[0])
      decisions.push(decision(candidates[0], "review", Math.min(candidates[0].score, 0.99)));
    else decisions.push(none(m.iri, candidates));
    return { decisions, identities };
  }
  for (const c of candidates) {
    const others = c.records.filter((r) => r !== m.record);
    if (others.length && m.record) {
      for (const other of others) {
        const identity = ruleIdentity(m.record, other, c, records);
        if (identity) identities.push(identity);
      }
      continue;
    }
    if (c.records.length) continue;
    if (c.strong) decisions.push(decision(c, "link", 1));
    else decisions.push(decision(c, "review", Math.min(c.score, 0.99)));
  }
  if (!decisions.length && !identities.length) decisions.push(none(m.iri, candidates));
  return { decisions, identities };
}

function ruleIdentity(
  record: string,
  other: string,
  c: Candidate,
  records: Map<string, RecordContext>,
): IdentityPair | null {
  if (c.strong) return { a: record, b: other, confidence: 1, reason: `the same ${c.found}` };
  if (!(c.found === "name" || c.found === "alias")) return null;
  const [x, y] = [records.get(record)?.near, records.get(other)?.near];
  const shared = x && y ? [...x].find((name) => y.has(name)) : undefined;
  return shared
    ? { a: record, b: other, confidence: 0.9, reason: `the same name, and both name ${shared}` }
    : null;
}

/** A mention left alone: no candidate, or none it names. */
export function none(mention: string, candidates: Candidate[], confidence = 1): Decision {
  return {
    mention,
    outcome: "none",
    target: null,
    thing: null,
    confidence: round(confidence),
    by: "rule",
    found: null,
    kind: null,
    seen: candidates.map((c) => shortId(c.target)),
  };
}

// ---- by the decision model -------------------------------------------------------

/** One mention a decide request asks about. */
export interface Asked {
  /** The position in the source's list: the question ids are `m<position>-kind` and `m<position>-names`. */
  position: number;
  span: string;
  /** Where the span is: the sentence of a text field, or the field and its value. */
  context: string;
  /** Ask the kind question (a span found in text, not written as a key). */
  kind: boolean;
  candidates: Candidate[];
}

/** One record pair the same-record question asks about. */
export interface AskedPair {
  id: string;
  a: string;
  b: string;
  match: string;
}

/** The state of a source's decide requests: the source and its relations one hop out. */
export function sourceState(source: string, relations: string[]): Record<string, unknown> {
  return {
    source,
    relations: relations.slice(0, 12),
    rule: "A candidate is a thing of the graph: a record, or the mentions already linked to it.",
  };
}

const describe = (c: Candidate) =>
  [
    c.label.slice(0, 120),
    c.spans.length ? `names: ${c.spans.map((s) => s.slice(0, 60)).join(", ")}` : "",
    `found by ${c.found}`,
    c.via ? c.via.slice(0, 200) : "",
  ]
    .filter(Boolean)
    .join("; ");

/** One decide request: the questions of `asked` and `pairs` with the source's state. */
export function decideRequest(
  state: Record<string, unknown>,
  asked: Asked[],
  pairs: AskedPair[] = [],
): DecideRequest {
  const questions: Record<string, DecideQuestion> = {};
  for (const { position, span, context, kind, candidates } of asked) {
    if (kind)
      questions[`m${position}-kind`] = {
        instructions: `${context} What does the span "${span}" name here?`,
        criteria: KINDS,
      };
    if (!candidates.length) continue;
    const options: Record<string, string> = {};
    candidates.forEach((c, k) => (options[`c${k}`] = describe(c)));
    options.new_thing = "It names a thing that is not in this list.";
    options.not_a_name = "It names no thing.";
    questions[`m${position}-names`] = {
      instructions: `${context} Which thing does the span "${span}" name? Choose a thing only when the span names it: its name in another spelling or order, its initials, a nickname, or one of its keys. A thing whose name is only alike, or that the text only mentions near the span, is no match.`,
      criteria: options,
    };
  }
  for (const pair of pairs)
    questions[`${pair.id}-same`] = {
      instructions: `Record A: ${pair.a}. Record B: ${pair.b}. They match by ${pair.match}. Are they the same thing?`,
      criteria: {
        same: "The two records describe one real thing.",
        different: "They describe two different things.",
        cannot_tell: "The records do not say.",
      },
    };
  return { state, questions };
}

/** Estimated tokens of a request: its JSON length over four. */
export const estimatedTokens = (request: DecideRequest) =>
  Math.ceil(JSON.stringify(request).length / 4);

/** Tokens of one request, at most (5.2). */
export const REQUEST_TOKENS = 28_000;
/** Mentions of one request: two questions each, 64 questions at most. */
export const REQUEST_MENTIONS = 32;

/** The mentions of one source in requests of at most 32 mentions and 28,000 estimated tokens. */
export function packRequests(state: Record<string, unknown>, asked: Asked[]): Asked[][] {
  const out: Asked[][] = [];
  let current: Asked[] = [];
  for (const one of asked) {
    const trial = [...current, one];
    const size = estimatedTokens(decideRequest(state, trial));
    if (current.length && (trial.length > REQUEST_MENTIONS || size > REQUEST_TOKENS)) {
      out.push(current);
      current = [one];
    } else current = trial;
  }
  if (current.length) out.push(current);
  return out;
}

/** The effect id of a decide request, made from its content: the same request gets its first answer. */
export const effectIdOf = (request: DecideRequest) =>
  `link/d1/${hash(JSON.stringify(request)).slice(0, 48)}`;

/**
 * The link rule (5.3) for one asked mention. A chosen candidate with a
 * strong key links at 1. Otherwise a chosen candidate links when the
 * linkable kinds have a probability of at least 0.5, at the smaller of that
 * and the names answer; at or above `gate` it is written, below it a person
 * decides. An answer that chose no thing has the confidence of no link; with
 * a candidate below the gate it goes to a person with the best candidate.
 */
export function linkRule(
  mention: string,
  asked: Asked,
  kindAnswer: DecideAnswer | undefined,
  namesAnswer: DecideAnswer | undefined,
  gate: number,
): Decision {
  const probabilities = kindAnswer?.probabilities ?? {};
  const pLink = !asked.kind
    ? 1
    : Object.keys(probabilities).length
      ? LINKABLE.reduce((sum, id) => sum + (probabilities[id] ?? 0), 0)
      : LINKABLE.includes(kindAnswer?.choice ?? "")
        ? (kindAnswer?.confidence ?? 0)
        : 1 - (kindAnswer?.confidence ?? 1);
  const kind = kindAnswer?.choice ?? null;
  if (!asked.candidates.length || !namesAnswer) {
    const left = none(mention, asked.candidates, 1 - pLink);
    return { ...left, kind, by: namesAnswer || kindAnswer ? "model" : "rule" };
  }
  const options: Record<string, number> = {};
  const ranked = Object.entries(namesAnswer.probabilities ?? {})
    .filter(([id]) => /^c\d+$/.test(id))
    .sort((a, b) => b[1] - a[1]);
  for (const [id, p] of ranked.slice(0, 4)) {
    const c = asked.candidates[Number(id.slice(1))];
    if (c) options[shortId(c.target)] = round(p);
  }
  const choice = namesAnswer.choice ?? "";
  const namesConfidence = namesAnswer.confidence ?? 0;
  const chosen = /^c\d+$/.test(choice) ? asked.candidates[Number(choice.slice(1))] : undefined;
  if (chosen && (chosen.strong || pLink >= 0.5)) {
    const confidence = chosen.strong ? 1 : round(Math.min(pLink, namesConfidence));
    return {
      mention,
      outcome: confidence >= gate ? "link" : "review",
      target: chosen.target,
      thing: chosen.thing,
      confidence,
      by: chosen.strong ? "strong" : "model",
      found: chosen.found,
      kind,
      options,
    };
  }
  const best = ranked[0] ? asked.candidates[Number(ranked[0][0].slice(1))] : asked.candidates[0];
  const confidence = round(Math.max(1 - pLink, chosen ? 0 : namesConfidence));
  if (best && confidence < gate)
    return {
      mention,
      outcome: "nolink",
      target: best.target,
      thing: best.thing,
      confidence,
      by: "model",
      found: best.found,
      kind,
      options,
    };
  return { ...none(mention, asked.candidates, confidence), kind, by: "model", options };
}

/** The identity a same-record answer proposes: `same` with a probability of at least 0.5. */
export function sameRecord(
  a: string,
  b: string,
  answer: DecideAnswer | undefined,
  match: string,
): IdentityPair | null {
  const p =
    answer?.probabilities?.same ?? (answer?.choice === "same" ? (answer.confidence ?? 0) : 0);
  return p >= 0.5
    ? { a, b, confidence: round(p), reason: `the decision model: the same, by ${match}` }
    : null;
}
