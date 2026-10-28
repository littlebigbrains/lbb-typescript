import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cellRef,
  columnLetters,
  columnNumber,
  parseSpreadsheetFragment,
  spreadsheetFragment,
  type SpreadsheetPlace,
} from "./spreadsheet.js";

// Golden: the fragment of each place, and the fragments that name no place.
// The table is shared with the Python SDK's test
// (`sdk/conformance/spreadsheet-places.json`; the public repositories hold it
// in `conformance/`).
interface SharedPlace {
  kind: "cells" | "rows" | "cols";
  sheet: string;
  row?: number;
  col?: number;
  to_row?: number;
  to_col?: number;
  from?: number;
  to?: number;
}

function fixture(): {
  places: { fragment: string; place: SharedPlace }[];
  invalid: string[];
} {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    for (const candidate of [
      join(dir, "conformance", "spreadsheet-places.json"),
      join(dir, "sdk", "conformance", "spreadsheet-places.json"),
    ])
      if (existsSync(candidate))
        return JSON.parse(readFileSync(candidate, "utf8"));
    const up = dirname(dir);
    if (up === dir) throw new Error("spreadsheet-places.json not found");
    dir = up;
  }
}

const SHARED = fixture();

function toPlace(shared: SharedPlace): SpreadsheetPlace {
  switch (shared.kind) {
    case "cells":
      return {
        kind: "cells",
        sheet: shared.sheet,
        row: shared.row!,
        col: shared.col!,
        toRow: shared.to_row!,
        toCol: shared.to_col!,
      };
    default:
      return {
        kind: shared.kind,
        sheet: shared.sheet,
        from: shared.from!,
        to: shared.to!,
      };
  }
}

const VECTORS = SHARED.places.map(({ fragment, place }) => ({
  place: toPlace(place),
  fragment,
}));

test("a place has a fixed fragment, and the fragment reads back to the place", () => {
  assert.ok(VECTORS.length >= 10);
  for (const { place, fragment } of VECTORS) {
    assert.equal(spreadsheetFragment(place), fragment, JSON.stringify(place));
    assert.deepEqual(parseSpreadsheetFragment(fragment), place, fragment);
    assert.deepEqual(
      parseSpreadsheetFragment(`#${fragment}`),
      place,
      `#${fragment}`,
    );
  }
});

test("a fragment that names no place reads as null", () => {
  assert.ok(SHARED.invalid.length >= 10);
  for (const bad of SHARED.invalid)
    assert.equal(parseSpreadsheetFragment(bad), null, JSON.stringify(bad));
  assert.equal(parseSpreadsheetFragment(null), null);
  assert.throws(
    () => spreadsheetFragment({ kind: "rows", sheet: "", from: 1, to: 1 }),
    RangeError,
  );
});

test("lower-case letters in a fragment read as their column", () => {
  assert.deepEqual(parseSpreadsheetFragment("Sales!b2:d9"), {
    kind: "cells",
    sheet: "Sales",
    row: 2,
    col: 2,
    toRow: 9,
    toCol: 4,
  });
});

test("columns count in letters like a spreadsheet", () => {
  const cases: [number, string][] = [
    [1, "A"],
    [26, "Z"],
    [27, "AA"],
    [52, "AZ"],
    [53, "BA"],
    [702, "ZZ"],
    [703, "AAA"],
    [512, "SR"],
  ];
  for (const [n, letters] of cases) {
    assert.equal(columnLetters(n), letters);
    assert.equal(columnNumber(letters), n);
  }
  assert.equal(cellRef(2, 3), "B3");
  assert.equal(columnNumber("AAAA"), null);
  assert.equal(columnNumber("A1"), null);
  assert.throws(() => columnLetters(0), RangeError);
  assert.throws(() => cellRef(1, 0), RangeError);
});
