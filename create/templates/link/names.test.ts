// The normal forms and block keys of the link template (general linking 4.1,
// 4.2), and how mentions are found in record fields (3.2, 3.3). Every name
// is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockKeys,
  codeForm,
  cologne,
  emailForm,
  fold,
  initialForms,
  jaroWinkler,
  keptKeys,
  keyKind,
  keyWeight,
  levenshteinRatio,
  nameSimilarity,
  nameWords,
  normalName,
  phoneForm,
  umlautFold,
  webForm,
} from "./names.js";
import {
  checkExtracted,
  nameShaped,
  selfMentions,
  textMentions,
  textSpans,
  windowOf,
} from "./sources/records.js";

test("the normal forms fold case, width, diacritics, titles, legal forms and word order", () => {
  assert.equal(fold("MIRA"), "mira");
  assert.equal(fold("Müller"), "muller");
  assert.equal(umlautFold("Müller"), "mueller");
  assert.equal(umlautFold("Mira"), null);
  assert.equal(fold("Søren Łukasz Æsir straße"), "soren lukasz aesir strasse");
  assert.equal(fold("Ｍｉｒａ"), "mira", "full width letters fold");
  assert.equal(normalName("Northbay Water GmbH"), "northbay water");
  assert.equal(normalName("Dr. Mira Ruiz"), "mira ruiz");
  assert.equal(normalName("Tannenholt-Ruiz, Mira"), "mira ruiz tannenholt");
  assert.equal(normalName("Mira Tannenholt-Ruiz"), "mira ruiz tannenholt");
  assert.equal(normalName("Bob Haldane"), "haldane robert", "a nickname reads as its common name");
  assert.equal(normalName("O'Neil"), "oneil");
  // A name that is only a title or a legal form keeps it.
  assert.equal(normalName("GmbH"), "gmbh");
  assert.deepEqual(
    nameWords("M. Tannenholt-Ruiz").map((w) => [w.parts, w.initial]),
    [
      [["m"], true],
      [["tannenholt", "ruiz"], false],
    ],
  );
});

test("the initials forms pair a full word with the first letter of the other", () => {
  assert.deepEqual(initialForms(nameWords("M. Tannenholt")), ["tannenholt m"]);
  assert.deepEqual(initialForms(nameWords("Mira Tannenholt")), ["mira t", "tannenholt m"]);
  assert.deepEqual(initialForms(nameWords("Mira Tannenholt-Ruiz")).sort(), [
    "mira t",
    "ruiz m",
    "tannenholt m",
  ]);
  assert.deepEqual(initialForms(nameWords("Mira")), []);
});

test("keys, addresses and codes take the resolver's and link version 7's forms", () => {
  assert.equal(
    emailForm("  Mira.Tannenholt@Northbay.example "),
    "mira.tannenholt@northbay.example",
  );
  assert.equal(emailForm("not an address"), null);
  assert.equal(webForm("https://www.Northbay.example/"), "northbay.example");
  assert.equal(webForm("northbay.example/contact?x=1"), "northbay.example/contact");
  assert.equal(phoneForm("+49 (30) 1234-5678"), "012345678", "the last 9 digits");
  assert.equal(phoneForm("12 34"), null);
  assert.equal(codeForm("P 38"), "p38");
  assert.equal(codeForm("P.38"), "p38");
  assert.equal(codeForm("S 4.1"), "s4.1");
  assert.equal(codeForm("Mira"), null, "a code holds a digit");
});

test("Cologne phonetics and the similarities give their published values", () => {
  assert.equal(cologne("Wikipedia"), "3412");
  assert.equal(cologne("Müller-Lüdenscheidt"), "65752682");
  assert.equal(cologne("Müller"), cologne("Mueller"));
  assert.equal(cologne("Ramaswamy"), cologne("Ramaswamey"), "a typo of one vowel keeps the sound");
  assert.equal(Math.round(jaroWinkler("martha", "marhta") * 10_000), 9611);
  assert.equal(Math.round(jaroWinkler("dixon", "dicksonx") * 10_000), 8133);
  assert.equal(Math.round(levenshteinRatio("kitten", "sitting") * 10_000), 5714);
  assert.equal(nameSimilarity("M. Tannenholt", "Mira Tannenholt-Ruiz"), 0.9);
  assert.equal(nameSimilarity("Mimi T.", "M. Tannenholt"), 0.8);
  assert.equal(
    nameSimilarity("F. Okafor", "Dana Okafor"),
    0.5,
    "an initial of another letter does not agree",
  );
  assert.equal(nameSimilarity("Bob Haldane", "Robert Haldane"), 0.975);
});

test("the block keys of the running example (general linking 4.6)", () => {
  const mira = blockKeys("Mira Tannenholt-Ruiz", "name");
  for (const key of [
    "name:mira ruiz tannenholt",
    "name:initial:tannenholt m",
    "name:initial:ruiz m",
    "name:initial:mira t",
  ])
    assert.ok(mira.includes(key), key);
  const lead = blockKeys("Mira Ruiz", "name");
  assert.ok(lead.includes("name:mira ruiz") && lead.includes("name:initial:ruiz m"));
  assert.deepEqual(blockKeys("M. Tannenholt", "name"), [
    "name:initial:tannenholt m",
    "name:part:tannenholt",
    "name:sound:26652",
  ]);
  const mimi = blockKeys("Mimi T.", "name");
  assert.ok(mimi.includes("name:initial:mimi t") && mimi.includes("name:part:mimi"));
  assert.ok(
    !mimi.some((k) => k.startsWith("name:initial:tannenholt")),
    "Mimi T. shares no key with Mira",
  );
  assert.deepEqual(blockKeys("mira.tannenholt@northbay.example", "email"), [
    "email:mira.tannenholt@northbay.example",
    "domain:northbay.example",
  ]);
  assert.deepEqual(
    blockKeys("someone@gmail.com", "email"),
    ["email:someone@gmail.com"],
    "no domain of free mail",
  );
  assert.deepEqual(blockKeys("P 38", "code"), ["code:p38"]);
  assert.deepEqual(
    blockKeys("P38", "text"),
    ["code:p38"],
    "a span of text written as a code is a code",
  );
  assert.ok(
    blockKeys("Jürgen Kessler", "name").includes("name:juergen kessler"),
    "the umlaut form",
  );
  assert.ok(blockKeys("Juergen Kessler", "name").includes("name:juergen kessler"));
  assert.ok(blockKeys("Bob Haldane", "name").includes("name:haldane robert"), "the nickname form");
  assert.ok(blockKeys("Mira", "name", ["Mimi T."]).includes("alias:mimi t"));
});

test("a key's kind and weight come from its prefix; the kept keys put strong ones first", () => {
  assert.equal(keyKind("name:initial:tannenholt m"), "name:initial");
  assert.equal(keyKind("name:mira ruiz"), "name");
  assert.equal(keyKind("email:a@b.example"), "email");
  assert.equal(keyKind("nothing"), null);
  assert.equal(keyWeight("code:p38"), "strong");
  assert.equal(keyWeight("name:initial:mira t"), "medium");
  assert.equal(keyWeight("name:sound:67"), "weak");
  const keys = keptKeys(["name:part:x", "email:a@b.example", "name:a b"]);
  assert.deepEqual(keys, ["email:a@b.example", "name:a b", "name:part:x"]);
  assert.equal(keptKeys(Array.from({ length: 30 }, (_, n) => `name:part:w${n}`)).length, 16);
});

test("the gazetteer looks up spans of capitalized words, and keeps the spans written like a name", () => {
  const spans = textSpans("Call with Mimi T.: she wants four filters.").map((s) => s.span);
  assert.ok(spans.includes("Mimi T."));
  assert.ok(
    !spans.some((s) => s.includes("she")),
    "a span stops at a colon and at a lower-case word",
  );
  assert.ok(textSpans("Wren, Tobias - annual renewal").some((s) => s.span === "Wren, Tobias"));
  assert.ok(
    !textSpans("Bob Haldane asked for the list").some((s) => s.span === "Bob Haldane asked"),
  );
  assert.ok(nameShaped("M. Tannenholt"));
  assert.ok(nameShaped("Lena van Dijk"), "a name particle may stand between the capitalized words");
  assert.ok(!nameShaped("van Dijk"), "but not first");
  assert.ok(nameShaped("k.marsh@fernway.example"));
  assert.ok(!nameShaped("Call"));
  assert.ok(
    !nameShaped("Met Kim Oak") && nameShaped("Kim Oak"),
    "a sentence's first word starts no name",
  );
  assert.ok(!nameShaped("PX-200"), "a code alone is kept only when the gazetteer finds it");
  assert.ok(!nameShaped("2026-09-30"), "a date is no phone number");
});

test("a text value gives each name once, the longest span first, with its sentence", () => {
  const text =
    "Northbay Water confirmed. Tobias Wren signed the renewal; Robert Haldane is in copy.";
  const found = textMentions("body", 0, text, new Set(["name:northbay water"]));
  assert.deepEqual(
    found.map((m) => [m.span, m.found, m.offset]),
    [
      ["Northbay Water", "gazetteer", 0],
      ["Tobias Wren", "shape", 26],
      ["Robert Haldane", "shape", 58],
    ],
  );
  assert.equal(found[1]!.window, "Tobias Wren signed the renewal; Robert Haldane is in copy.");
  assert.equal(textMentions("body", 0, "Ann Lee met Ann Lee.", new Set())[1]!.occurrence, 1);
  assert.equal(
    textMentions("body", 0, "A B. ".repeat(10) + "Tom Ash and Kim Oak.", new Set(), 1).length,
    1,
  );
  const long = "x".repeat(400) + " Mira Ruiz " + "y".repeat(400);
  assert.ok(windowOf(long, 401, 9).length <= 300);
});

test("a record's names and keys are its self mentions; given and family names join", () => {
  const record = {
    iri: "https://littlebigbrain.com/e/aa",
    class: "Lead",
    name: "Mira Ruiz",
    values: {
      first_name: ["Mira"],
      last_name: ["Ruiz"],
      email: ["mira@northbay.example", "not an address"],
    },
  };
  const found = selfMentions(record, {
    first_name: "name:given",
    last_name: "name:family",
    email: "key:email",
    company_name: "context",
  });
  assert.deepEqual(
    found.map((m) => [m.field, m.kind, m.span, m.role]),
    [
      ["email", "email", "mira@northbay.example", "self"],
      ["first_name+last_name", "name", "Mira Ruiz", "self"],
    ],
  );
});

test("the reasoning model's spans are kept only where the text holds them", () => {
  const text = "Met Kim Oak and Kim Oak again.";
  const taken = textMentions("body", 0, text, new Set());
  const extra = checkExtracted(
    {
      spans: [
        { span: "Kim Oak", kind: "person" },
        { span: "Nobody Here", kind: "person" },
        { span: "again", kind: "code" },
      ],
    },
    "body",
    0,
    text,
    taken,
  );
  assert.deepEqual(
    taken.map((m) => m.offset),
    [4, 16],
  );
  assert.deepEqual(
    extra.map((m) => [m.span, m.offset]),
    [["again", 24]],
    "taken places stay taken; a missing span goes",
  );
  assert.deepEqual(checkExtracted({ spans: "no list" }, "body", 0, text, []), []);
});
