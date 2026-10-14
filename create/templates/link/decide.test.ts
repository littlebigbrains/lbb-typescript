// The candidates of a mention (general linking 4.3, 4.4) and the decision
// (5.1 to 5.3): the bounds and stop keys, the rules without model reads,
// the link rule of link version 7, and the packing of the requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTITY_IRI_NAMESPACE } from "@littlebigbrain/client";
import {
  BOUNDS,
  candidatesFor,
  neighbourPaths,
  stopKeys,
  type Candidate,
  type KeyHit,
} from "./candidates.js";
import {
  decideRequest,
  effectIdOf,
  linkRule,
  packRequests,
  rulesDecisions,
  sameRecord,
  type Asked,
} from "./decide.js";
import { blockKeys } from "./names.js";
import {
  identityItem,
  itemKind,
  rowsOfItem,
  thingItems,
  type Row,
  type TargetView,
} from "./items.js";

const e = (n: number) => `${ENTITY_IRI_NAMESPACE}${String(n).padStart(32, "0")}`;
const hit = (key: string, n: number, over: Partial<KeyHit> = {}): KeyHit => ({
  key,
  mention: e(n),
  role: "self",
  span: "Mira Tannenholt-Ruiz",
  source: e(100 + n),
  kind: "name",
  window: null,
  thing: e(500 + n),
  label: "Mira Tannenholt-Ruiz",
  ...over,
});
const mention = (span: string, keys = blockKeys(span, "text")) => ({
  iri: e(1),
  source: e(101),
  role: "refers" as const,
  span,
  keys,
  cannot: [],
});

test("a strong key comes first; a stop key, the mention's own record and a cannot-link find nothing", () => {
  const m = {
    ...mention("M. Tannenholt"),
    keys: ["email:mira@northbay.example", ...blockKeys("M. Tannenholt", "name")],
  };
  const hits = [
    hit("name:initial:tannenholt m", 2),
    hit("email:mira@northbay.example", 3, { span: "mira@northbay.example", kind: "email" }),
    hit("name:part:tannenholt", 4, { span: "Hanna Tannenholt", label: "Hanna Tannenholt" }),
    hit("name:initial:tannenholt m", 5, { thing: e(505) }),
  ];
  const found = candidatesFor(m, hits, new Set(), []);
  assert.equal(found[0]!.target, e(3));
  assert.ok(found[0]!.strong);
  assert.ok(
    !found.some((c) => c.target === e(4)),
    "a weak key alone and an unlike name stay below the score",
  );
  assert.deepEqual(
    candidatesFor(
      m,
      hits,
      new Set(["email:mira@northbay.example", "name:initial:tannenholt m"]),
      [],
    ).map((c) => c.target),
    [],
  );
  assert.ok(
    !candidatesFor({ ...m, cannot: [e(502)] }, hits, new Set(), []).some((c) => c.thing === e(502)),
  );
  const self = { ...m, role: "self" as const, source: e(103) };
  assert.ok(
    !candidatesFor(self, hits, new Set(), []).some((c) => c.target === e(3)),
    "its own record's mentions",
  );
});

test("a neighbour named alike is a candidate, with how it is reached", () => {
  const m = mention("Mimi T.");
  const neighbour = {
    mention: {
      record: e(200),
      mention: e(7),
      role: "refers",
      span: "M. Tannenholt",
      thing: e(507),
      label: "Mira Tannenholt-Ruiz",
    },
    via: 'ABOUT → Deal "Northbay retrofit"',
  };
  const unlike = {
    ...neighbour,
    mention: { ...neighbour.mention, mention: e(8), span: "Northbay Water", thing: e(508) },
  };
  const found = candidatesFor(m, [], new Set(), [neighbour, unlike]);
  assert.deepEqual(
    found.map((c) => [c.target, c.found, c.via]),
    [[e(7), "neighbour", 'named in ABOUT → Deal "Northbay retrofit"']],
  );
  const paths = neighbourPaths(
    [e(1)],
    [
      [
        {
          from: e(1),
          relation: "ABOUT",
          to: e(2),
          dir: "out",
          name: "Northbay retrofit",
          class: "deal",
        },
      ],
      [{ from: e(2), relation: "INVOLVES", to: e(3), dir: "out", name: "Mira", class: "person" }],
    ],
  );
  assert.equal(
    paths.get(e(1))!.get(e(3)),
    'ABOUT → deal "Northbay retrofit" → INVOLVES → person "Mira"',
  );
});

test("the stop keys are the keys more than 200 mentions hold", () => {
  const counts = new Map([
    ["email:team@northbay.example", 260],
    ["name:part:alex", BOUNDS.stopKey],
    ["name:part:mira", 3],
  ]);
  assert.deepEqual(stopKeys(counts), ["email:team@northbay.example"]);
});

const candidate = (n: number, over: Partial<Candidate> = {}): Candidate => ({
  target: e(n),
  thing: e(500 + n),
  label: "Mira Tannenholt-Ruiz",
  spans: ["Mira Tannenholt-Ruiz"],
  records: [e(100 + n)],
  score: 0.9,
  found: "name:initial",
  strong: false,
  ...over,
});

test("without model reads a strong key links at 1 and every other candidate goes to a person", () => {
  const refers = { iri: e(1), role: "refers" as const, record: null };
  assert.deepEqual(
    rulesDecisions(refers, [
      candidate(2, { strong: true, found: "email", score: 1 }),
    ]).decisions.map((d) => [d.outcome, d.confidence, d.by]),
    [["link", 1, "strong"]],
  );
  assert.deepEqual(
    rulesDecisions(refers, [
      candidate(2, { strong: true }),
      candidate(3, { strong: true }),
    ]).decisions.map((d) => d.outcome),
    ["review"],
    "two things share the strong key: a person decides",
  );
  assert.deepEqual(
    rulesDecisions(refers, [candidate(2)]).decisions.map((d) => [d.outcome, d.confidence]),
    [["review", 0.9]],
  );
  const alone = rulesDecisions(refers, []).decisions[0]!;
  assert.equal(alone.outcome, "none");
  // A self mention: another record is an identity, never a link.
  const self = { iri: e(1), role: "self" as const, record: e(101) };
  const near = new Map([
    [e(101), { near: new Set(["brightmoor foods"]) }],
    [e(102), { near: new Set(["brightmoor foods"]) }],
    [e(103), { near: new Set(["ridgeway transit"]) }],
  ]);
  const strong = rulesDecisions(self, [candidate(2, { strong: true, found: "email" })], near);
  assert.deepEqual(
    strong.identities.map((i) => [i.b, i.confidence]),
    [[e(102), 1]],
  );
  assert.deepEqual(strong.decisions, []);
  const byName = rulesDecisions(
    self,
    [candidate(2, { found: "name" }), candidate(3, { found: "name" })],
    near,
  );
  assert.deepEqual(
    byName.identities.map((i) => [i.b, i.confidence]),
    [[e(102), 0.9]],
    "a name and a shared related record",
  );
});

test("the link rule: the smaller of the linkable kinds and the names answer, against the gate", () => {
  const asked: Asked = {
    position: 0,
    span: "M. Tannenholt",
    context: "Deal",
    kind: true,
    candidates: [candidate(2), candidate(3)],
  };
  const kind = { choice: "person", confidence: 0.9, probabilities: { person: 0.9, other: 0.1 } };
  const names = {
    choice: "c0",
    confidence: 0.95,
    probabilities: { c0: 0.95, c1: 0.03, new_thing: 0.02 },
  };
  const link = linkRule(e(1), asked, kind, names, 0.8);
  assert.deepEqual([link.outcome, link.target, link.confidence], ["link", e(2), 0.9]);
  assert.equal(linkRule(e(1), asked, kind, names, 0.95).outcome, "review");
  const value = { choice: "value", confidence: 0.8, probabilities: { value: 0.8, person: 0.2 } };
  const noLink = linkRule(e(1), asked, value, names, 0.9);
  assert.deepEqual(
    [noLink.outcome, noLink.target, noLink.confidence],
    ["nolink", e(2), 0.8],
    "no link below the gate offers the best candidate",
  );
  const newThing = {
    choice: "new_thing",
    confidence: 0.97,
    probabilities: { new_thing: 0.97, c0: 0.02 },
  };
  assert.equal(
    linkRule(e(1), asked, kind, newThing, 0.8).outcome,
    "none",
    "a confident new thing writes nothing",
  );
  const strong = { ...asked, kind: false, candidates: [candidate(2, { strong: true })] };
  assert.equal(
    linkRule(e(1), strong, undefined, { choice: "c0", confidence: 0.6 }, 0.8).confidence,
    1,
  );
  assert.equal(
    sameRecord(
      e(1),
      e(2),
      { choice: "same", confidence: 0.7, probabilities: { same: 0.7 } },
      "name",
    )?.confidence,
    0.7,
  );
  assert.equal(
    sameRecord(
      e(1),
      e(2),
      { choice: "different", confidence: 0.8, probabilities: { same: 0.1 } },
      "name",
    ),
    null,
  );
});

test("requests hold at most 32 mentions and carry an effect id made of their content", () => {
  const asked: Asked[] = Array.from({ length: 70 }, (_, n) => ({
    position: n,
    span: `Name ${n}`,
    context: "Note",
    kind: true,
    candidates: [candidate(n + 2)],
  }));
  const parts = packRequests({ source: "Note" }, asked);
  assert.deepEqual(
    parts.map((p) => p.length),
    [32, 32, 6],
  );
  const request = decideRequest({ source: "Note" }, parts[2]!);
  assert.equal(Object.keys(request.questions).length, 12);
  assert.equal(effectIdOf(request), effectIdOf(decideRequest({ source: "Note" }, parts[2]!)));
  assert.notEqual(effectIdOf(request), effectIdOf(decideRequest({ source: "Note 2" }, parts[2]!)));
  assert.match(effectIdOf(request), /^link\/d1\/[0-9a-f]{48}$/);
});

test("an item per thing holds its rows; an identity item names its records; the rows read back", () => {
  const view = (n: number) => ({
    iri: e(n),
    span: `Name ${n}`,
    line: `the line of ${n}`,
    source: e(100 + n),
    sourceName: `Note ${n}`,
    sourceClass: "Note",
    field: "body",
  });
  const target: TargetView = {
    iri: e(900),
    anchor: view(9),
    label: "Mira Tannenholt-Ruiz",
    kind: "Person",
  };
  const rows: Row[] = Array.from({ length: 55 }, (_, n) => ({
    decision: {
      mention: e(n + 1),
      outcome: n === 0 ? "nolink" : "review",
      target: e(9),
      thing: e(900),
      confidence: 0.6,
      by: "rule",
      found: "name",
      kind: null,
    },
    mention: view(n + 1),
  }));
  const items = thingItems("link", 1, target, rows);
  assert.deepEqual(
    items.map((i) => [itemKind(i.key!), i.facts!.triplets!.length]),
    [
      ["link", 50],
      ["link", 4],
      ["nolink", 1],
    ],
  );
  assert.ok(items.every((i) => i.origin?.id === "starter:link" && i.origin.label === "link"));
  assert.match(items[0]!.key!, /^starter:link:link:0{29}900:[0-9a-f]{12}$/);
  assert.match(items[1]!.key!, /:1$/);
  // The parts of the pattern of the producer `link`: the sources' classes, the thing's kind, the key kind, link or no link.
  const mapping = (items[0]!.mapping as { link: Record<string, unknown> }).link;
  assert.deepEqual(
    [mapping.sources, mapping.kind, mapping.found, mapping.answer],
    [["Note"], "Person", ["name"], "link"],
  );
  const back = rowsOfItem({ ...items[0]!, status: "open", suggestion_id: "x" } as never);
  assert.equal(back.length, 50);
  assert.deepEqual(
    [back[0]!.mention.iri, back[0]!.decision.target, back[0]!.mention.line],
    [e(2), e(9), "the line of 2"],
  );
  const identity = identityItem(
    "link",
    0.99,
    {
      records: [e(101), e(102)],
      confidence: 1,
      pairs: [{ a: e(101), b: e(102), confidence: 1, reason: "the same email" }],
    },
    new Map([
      [
        e(101),
        { iri: e(101), name: "Mira Ruiz", class: "Lead", self: { iri: e(1), span: "Mira Ruiz" } },
      ],
      [
        e(102),
        {
          iri: e(102),
          name: "Mira Tannenholt-Ruiz",
          class: "Person",
          self: { iri: e(2), span: "Mira Tannenholt-Ruiz" },
        },
      ],
    ]),
  )!;
  assert.equal(itemKind(identity.key!), "identity");
  assert.equal(identity.identities![0]!.members.length, 2);
  assert.deepEqual(
    (identity.mapping as { identity: { above_gate: boolean } }).identity.above_gate,
    true,
  );
  assert.equal(identity.facts!.triplets![0]!.relation, "SAME_THING_AS");
});
