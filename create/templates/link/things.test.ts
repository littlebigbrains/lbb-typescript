// Things (general linking 2.4, 5.4): the grouping with must-links and
// cannot-links, the identity proposals, the anchors, the deterministic IRIs,
// and the merges and splits from one grouping to the next.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTITY_IRI_NAMESPACE } from "@littlebigbrain/client";
import {
  anchorKeyOf,
  anchorOf,
  group,
  mentionIri,
  nameThings,
  thingIri,
  type Member,
  type Pair,
} from "./things.js";

const e = (n: number | string) => `${ENTITY_IRI_NAMESPACE}${String(n).padStart(32, "0")}`;
const self = (n: number, record: number, span: string, keyed = false): Member => ({
  iri: e(n),
  role: "self",
  record: e(`r${record}`.replace("r", "9")),
  span,
  kind: "Person",
  keyed,
});
const refers = (n: number, span: string): Member => ({
  iri: e(n),
  role: "refers",
  record: null,
  span,
  kind: "person",
});
const pair = (a: number, b: number, confidence: number, by: Pair["by"] = "model"): Pair => ({
  a: e(a),
  b: e(b),
  confidence,
  by,
});

test("the IRIs of mentions and things are hashes: pinned", () => {
  const source = "https://littlebigbrain.com/e/0123456789abcdef0123456789abcdef";
  assert.equal(
    mentionIri("samples", source, "name", "Mira Tannenholt-Ruiz", 0),
    "https://littlebigbrain.com/e/2b8a3464c3a38d435f59f67efdc1b28b",
  );
  assert.equal(
    mentionIri("samples", source, "body", "Mimi T.", 1),
    "https://littlebigbrain.com/e/baa1d4333f2ef9b8f8724c9399ef988c",
  );
  assert.equal(
    thingIri("samples", "record:0123456789abcdef0123456789abcdef"),
    "https://littlebigbrain.com/e/bb0279d177d2971f056cf6d82a726bf2",
  );
  assert.equal(
    thingIri("samples", "mention:fedcba9876543210fedcba9876543210"),
    "https://littlebigbrain.com/e/6632612e562605c43a8309e54eee34dd",
  );
  assert.notEqual(
    thingIri("other", "record:0123456789abcdef0123456789abcdef"),
    thingIri("samples", "record:0123456789abcdef0123456789abcdef"),
  );
});

test("a record's self mentions are one thing, anchored by the record, named by its name", () => {
  const members = [self(2, 1, "mira@northbay.example", true), self(1, 1, "Mira Ruiz")];
  const { groups } = group({ members, pairs: [], cannot: [], sameAs: [] });
  assert.deepEqual(groups, [[e(1), e(2)]]);
  const anchor = anchorOf(members);
  assert.equal(anchor.iri, e(1), "the name before the key");
  assert.equal(anchorKeyOf(anchor), `record:${e(91).slice(-32)}`);
  const naming = nameThings("samples", groups, new Map(members.map((m) => [m.iri, m])));
  assert.equal(naming.things[0]!.label, "Mira Ruiz");
  assert.equal(naming.things[0]!.iri, thingIri("samples", anchorKeyOf(anchor)));
});

test("the things of two records stay apart without an accepted identity, and the pair becomes a proposal", () => {
  const members = [
    self(1, 1, "Mira Ruiz"),
    self(2, 2, "Mira Tannenholt-Ruiz"),
    refers(3, "M. Tannenholt"),
  ];
  const pairs = [pair(3, 2, 0.9), pair(3, 1, 0.85)];
  const apart = group({ members, pairs, cannot: [], sameAs: [] });
  assert.equal(apart.groups.length, 2);
  assert.equal(apart.blockedByRecords, 1);
  assert.deepEqual(
    apart.proposals.map((p) => p.records),
    [[e(91), e(92)]],
  );
  // An accepted identity joins them; nothing is proposed.
  const joined = group({ members, pairs, cannot: [], sameAs: [[e(91), e(92)]] });
  assert.deepEqual(joined.groups, [[e(1), e(2), e(3)]]);
  assert.deepEqual(joined.proposals, []);
});

test("a cannot-link keeps two mentions apart, also through other pairs; a person's pairs join first", () => {
  const members = [refers(1, "Lena Fair"), refers(2, "L. Fair"), refers(3, "Lena Fairweather")];
  const pairs = [pair(1, 2, 0.95), pair(2, 3, 0.9)];
  const kept = group({ members, pairs, cannot: [[e(1), e(3)]], sameAs: [] });
  assert.deepEqual(
    kept.groups,
    [[e(1), e(2)], [e(3)]],
    "the higher pair joins, the lower one is blocked",
  );
  assert.equal(kept.blockedByPerson, 1);
  // A person's must-link joins before the model's higher pair.
  const person = group({
    members,
    pairs: [...pairs, pair(2, 3, 0.5, "person")],
    cannot: [[e(1), e(3)]],
    sameAs: [],
  });
  assert.deepEqual(person.groups, [[e(1)], [e(2), e(3)]]);
});

test("an identity of more than 10 records is not proposed; a dismissed identity is not proposed again", () => {
  const members = Array.from({ length: 12 }, (_, n) => self(n + 1, n + 1, "Alex Brandt"));
  const identities = members.slice(1).map((m) => ({
    a: members[0]!.record!,
    b: m.record!,
    confidence: 1,
    reason: "a team address",
  }));
  const big = group({ members, pairs: [], cannot: [], sameAs: [], identities });
  assert.equal(big.tooLarge, 1);
  assert.deepEqual(big.proposals, []);
  const two = members.slice(0, 2);
  const dismissed = group({
    members: two,
    pairs: [],
    cannot: [[two[0]!.iri, two[1]!.iri]],
    sameAs: [],
    identities: [identities[0]!],
  });
  assert.deepEqual(dismissed.proposals, []);
});

test("a thing of mentions alone takes the smallest key; a record that joins becomes its anchor, and the old IRI points to it", () => {
  const notes = [refers(5, "Bob Haldane"), refers(4, "Bob Haldane")];
  const first = group({ members: notes, pairs: [pair(5, 4, 0.96)], cannot: [], sameAs: [] });
  const map1 = new Map(notes.map((m) => [m.iri, m]));
  const before = nameThings("samples", first.groups, map1);
  assert.equal(before.things[0]!.anchorKey, `mention:${e(4).slice(-32)}`);

  const robert = self(1, 7, "Robert Haldane");
  const all = [...notes, robert];
  const second = group({
    members: all,
    pairs: [pair(5, 4, 0.96), pair(1, 4, 0.9)],
    cannot: [],
    sameAs: [],
  });
  const after = nameThings("samples", second.groups, new Map(all.map((m) => [m.iri, m])), [
    { iri: before.things[0]!.iri, anchorKey: before.things[0]!.anchorKey, members: [e(4), e(5)] },
  ]);
  assert.equal(after.things.length, 1);
  assert.equal(after.things[0]!.anchorKey, `record:${e(97).slice(-32)}`);
  assert.deepEqual(after.merged, [{ from: before.things[0]!.iri, into: after.things[0]!.iri }]);
  assert.deepEqual(after.things[0]!.aliases, [], "a nickname of the label is no alias");
});

test("a split keeps the anchor's part at its IRI, and the other part gets the IRI of its own anchor", () => {
  const members = [self(1, 7, "Robert Haldane"), refers(4, "Bob Haldane"), refers(5, "R. Haldane")];
  const map = new Map(members.map((m) => [m.iri, m]));
  const together = nameThings(
    "samples",
    group({ members, pairs: [pair(4, 1, 0.9), pair(5, 4, 0.9)], cannot: [], sameAs: [] }).groups,
    map,
  );
  assert.equal(together.things.length, 1);
  const recordThing = together.things[0]!.iri;
  // A person keeps "Bob Haldane" apart from the record: the pair to it goes.
  const split = group({
    members,
    pairs: [pair(4, 1, 0.9), pair(5, 4, 0.9)],
    cannot: [[e(4), e(1)]],
    sameAs: [],
  });
  const named = nameThings("samples", split.groups, map, [
    {
      iri: recordThing,
      anchorKey: together.things[0]!.anchorKey,
      members: members.map((m) => m.iri),
    },
  ]);
  const byIri = new Map(named.things.map((t) => [t.iri, t]));
  assert.deepEqual(byIri.get(recordThing)?.members, [e(1)], "the record keeps its IRI");
  const other = named.things.find((t) => t.iri !== recordThing)!;
  assert.deepEqual(other.members, [e(4), e(5)]);
  assert.equal(other.iri, thingIri("samples", `mention:${e(4).slice(-32)}`));
  assert.deepEqual(named.merged, []);
  assert.deepEqual(named.gone, []);
});

test("a mention alone is no thing; a thing whose members are all gone is gone", () => {
  const lone = refers(3, "Kim Oak");
  const naming = nameThings("samples", [[lone.iri]], new Map([[lone.iri, lone]]), [
    { iri: thingIri("samples", "mention:x"), anchorKey: "mention:x", members: [e(8)] },
  ]);
  assert.deepEqual(naming.things, []);
  assert.deepEqual(naming.lone, [lone.iri]);
  assert.deepEqual(naming.gone, [thingIri("samples", "mention:x")]);
});
