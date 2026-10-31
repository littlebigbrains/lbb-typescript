// The places of a file (`locators.ts`) against the shared golden cases of
// `ground` (`sdk/conformance/grounding.json`, section `locator`): the Rust
// module runs the same cases, so `files.read` shows the model the words
// that `ground` tests its quote against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  nextPlace,
  parsePlace,
  placeCount,
  placeKind,
  readPlace,
  tableRows,
  textLines,
} from "./locators.js";

interface LocatorCase {
  name: string;
  media: string;
  locator: string;
  text: string;
  expect?: string;
  error?: string;
  rust_only?: boolean;
}

/** The shared fixture, found above the test file (`conformance/` in the public repositories, `sdk/conformance/` here). */
function fixturePath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    for (const candidate of [
      join(dir, "conformance", "grounding.json"),
      join(dir, "sdk", "conformance", "grounding.json"),
    ])
      if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) throw new Error("grounding.json not found");
    dir = up;
  }
}

const fixture = JSON.parse(readFileSync(fixturePath(), "utf8")) as {
  locator: LocatorCase[];
};

test("the places read as the shared golden cases say", () => {
  assert.ok(fixture.locator.length > 40);
  for (const item of fixture.locator) {
    if (item.rust_only) continue;
    const read = readPlace(item.media, item.locator, item.text);
    if (item.error !== undefined)
      assert.deepEqual(read, { ok: false, error: item.error }, item.name);
    else assert.deepEqual(read, { ok: true, text: item.expect }, item.name);
  }
});

test("a locator is parsed into its parts", () => {
  assert.deepEqual(parsePlace("line=1,3"), { kind: "line", from: 1, to: 3 });
  assert.deepEqual(parsePlace("row=2"), { kind: "row", from: 2, to: 2 });
  assert.deepEqual(parsePlace("row=2-9"), { kind: "row", from: 2, to: 9 });
  assert.deepEqual(parsePlace("page=3"), { kind: "page", page: 3 });
  for (const bad of [
    "",
    "page",
    "page=0",
    "page=-1",
    "page=1.5",
    "line=1",
    "line=2,2",
    "line=1,2,3",
    "row=0",
    "row=3-2",
    "row=1-2-3",
    "cell=A1",
    "page=4294967296",
    "line=0,1234567890123",
  ])
    assert.equal(parsePlace(bad), null, bad);
  // The server reads leading zeros and numbers of 12 digits.
  assert.deepEqual(parsePlace("line=01,2"), { kind: "line", from: 1, to: 2 });
  assert.deepEqual(parsePlace("page=4294967295"), {
    kind: "page",
    page: 4294967295,
  });
  assert.deepEqual(parsePlace("line=0,123456789012"), {
    kind: "line",
    from: 0,
    to: 123456789012,
  });
});

test("a media type has the kind of place the shared cases give it", () => {
  assert.equal(placeKind("text/plain"), "line");
  assert.equal(placeKind("text/x-markdown"), "line");
  // A type is read as the file's record holds it: no parameters, no case folding.
  assert.equal(placeKind("text/plain; charset=utf-8"), null);
  assert.equal(placeKind("TEXT/Markdown"), null);
  assert.equal(placeKind("text/csv"), "row");
  assert.equal(placeKind("text/tab-separated-values"), "row");
  assert.equal(placeKind("application/pdf"), "page");
  assert.equal(placeKind("image/png"), null);
  // A PDF is read by its parsed pages, not from its bytes.
  assert.deepEqual(readPlace("application/pdf", "page=1", "x"), {
    ok: false,
    error: "unsupported_media_type",
  });
});

test("lines and rows are counted the way places are read", () => {
  assert.deepEqual(textLines("a\r\nb\rc\n"), ["a", "b", "c"]);
  assert.deepEqual(textLines(""), []);
  assert.deepEqual(tableRows('a,"b\nc"\nd\n', ","), ['a,"b\nc"', "d"]);
  assert.equal(placeCount("text/plain", "line", "a\nb\n"), 2);
  assert.equal(placeCount("text/csv", "row", "a,b\n1,2\n"), 2);
});

test("the next place goes on from the end of the one read", () => {
  assert.equal(nextPlace({ kind: "line", from: 0, to: 10 }, 25), "line=10,20");
  assert.equal(nextPlace({ kind: "line", from: 10, to: 25 }, 25), undefined);
  assert.equal(nextPlace({ kind: "row", from: 1, to: 10 }, 25), "row=11-20");
  assert.equal(nextPlace({ kind: "row", from: 21, to: 25 }, 25), undefined);
  assert.equal(nextPlace({ kind: "page", page: 2 }, 5), "page=3");
  assert.equal(nextPlace({ kind: "page", page: 5 }, 5), undefined);
});
