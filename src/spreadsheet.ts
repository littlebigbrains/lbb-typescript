// Places in a spreadsheet: cell addresses (A1) and the fragment that names a
// place in the evidence of a fact read from an XLSX workbook.
//
// The fragment of a place is `<sheet>!<range>` on the `Document` IRI, the
// form spreadsheet links use (`…/e/41ab…#Sales!B2:D9`). The range is one
// cell (`B2`), a rectangle of cells (`B2:D9`), whole rows (`5:7`) or whole
// columns (`B:D`). A sheet name that is not a plain word is single-quoted,
// with a quote in the name written twice (`'Q3 Sales'!B2`, `'Jane''s'!A1`),
// and the whole fragment is percent-encoded (`Q3%20Sales`). Rows count from
// 1. `rows` writes the fragment of a row; a worker that reads a value from
// one cell writes the fragment of that cell, and Review and the console open
// the file at it.

/** The last column the reader accepts (`SR`), as `FILE_XLSX_MAX_COLUMNS`. */
export const SPREADSHEET_MAX_COLUMNS = 512;
/** The last row the reader accepts, as `FILE_XLSX_MAX_ROWS`. */
export const SPREADSHEET_MAX_ROWS = 50_000;

/** A column number (from 1) as its letters: 1 is `A`, 27 is `AA`. */
export function columnLetters(column: number): string {
  if (!Number.isInteger(column) || column < 1)
    throw new RangeError("column must be 1 or more");
  let letters = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26))
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

/** The number (from 1) of a column's letters, or null for text that is no column. */
export function columnNumber(letters: string): number | null {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) return null;
  let n = 0;
  for (const letter of letters.toUpperCase())
    n = n * 26 + letter.charCodeAt(0) - 64;
  return n;
}

/** The A1 reference of a cell: `cellRef(2, 3)` is `B3`. */
export function cellRef(column: number, row: number): string {
  if (!Number.isInteger(row) || row < 1)
    throw new RangeError("row must be 1 or more");
  return `${columnLetters(column)}${row}`;
}

/** A place in a sheet. Rows and columns count from 1; both ends are included. */
export type SpreadsheetPlace =
  | {
      kind: "cells";
      sheet: string;
      row: number;
      col: number;
      toRow: number;
      toCol: number;
    }
  | { kind: "rows"; sheet: string; from: number; to: number }
  | { kind: "cols"; sheet: string; from: number; to: number };

const BARE_SHEET = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOOKS_LIKE_CELL = /^[A-Za-z]{1,3}[0-9]+$/;

/** The sheet's name as a fragment writes it: single-quoted unless it is a plain word. */
function sheetName(sheet: string): string {
  if (BARE_SHEET.test(sheet) && !LOOKS_LIKE_CELL.test(sheet)) return sheet;
  return `'${sheet.replace(/'/g, "''")}'`;
}

function rangeText(place: SpreadsheetPlace): string {
  switch (place.kind) {
    case "cells":
      return place.toRow === place.row && place.toCol === place.col
        ? cellRef(place.col, place.row)
        : `${cellRef(place.col, place.row)}:${cellRef(place.toCol, place.toRow)}`;
    case "rows":
      return `${place.from}:${place.to}`;
    case "cols":
      return `${columnLetters(place.from)}:${columnLetters(place.to)}`;
  }
}

/**
 * The fragment of a place, without its `#`: `Sales!B2:D9`, `'Q3 Sales'!B2`
 * written `Q3%20Sales`. A sheet name of any characters round-trips through
 * {@link parseSpreadsheetFragment}.
 */
export function spreadsheetFragment(place: SpreadsheetPlace): string {
  if (!place.sheet) throw new RangeError("a place needs a sheet");
  const text = `${sheetName(place.sheet)}!${rangeText(place)}`;
  // Percent-encoding keeps the separators the form is read by readable.
  return encodeURIComponent(text)
    .replace(/%3A/g, ":")
    .replace(/%21/g, "!")
    .replace(/%27/g, "'");
}

// A row has at most 7 digits, so a number never grows past what a double holds.
const CELL = /^([A-Za-z]{1,3})([1-9][0-9]{0,6})$/;
const ROWS = /^([1-9][0-9]{0,6}):([1-9][0-9]{0,6})$/;
const COLS = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/;

/**
 * The place a fragment names (`Sales!B2:D9`, with or without its `#`), or
 * null for a fragment of no known form. A place past the reader's limits
 * ({@link SPREADSHEET_MAX_ROWS} rows, {@link SPREADSHEET_MAX_COLUMNS}
 * columns) is null, and so is an end before its start.
 */
export function parseSpreadsheetFragment(
  fragment: string | null | undefined,
): SpreadsheetPlace | null {
  let text = (fragment ?? "").replace(/^#/, "");
  if (!text) return null;
  try {
    text = decodeURIComponent(text);
  } catch {
    return null;
  }
  const split = /^(?:'((?:[^']|'')+)'|([^!']+))!(.+)$/.exec(text);
  if (!split) return null;
  const sheet =
    split[1] !== undefined ? split[1].replace(/''/g, "'") : split[2]!;
  return parseSpreadsheetRange(sheet, split[3]!);
}

/**
 * The place of a range (`B2`, `B2:D9`, `5:7`, `B:D`) in the sheet named
 * `sheet`, or null for text that is no range. The sheet is the name as it is,
 * not quoted or encoded.
 */
export function parseSpreadsheetRange(
  sheet: string,
  range: string,
): SpreadsheetPlace | null {
  const rows = ROWS.exec(range);
  if (rows) {
    const [from, to] = [Number(rows[1]), Number(rows[2])];
    return to >= from && to <= SPREADSHEET_MAX_ROWS
      ? { kind: "rows", sheet, from, to }
      : null;
  }
  const cols = COLS.exec(range);
  if (cols) {
    const [from, to] = [columnNumber(cols[1]!)!, columnNumber(cols[2]!)!];
    return to >= from && to <= SPREADSHEET_MAX_COLUMNS
      ? { kind: "cols", sheet, from, to }
      : null;
  }
  const cells = /^([^:]+)(?::([^:]+))?$/.exec(range);
  if (!cells) return null;
  const start = CELL.exec(cells[1]!);
  const end = cells[2] === undefined ? start : CELL.exec(cells[2]);
  if (!start || !end) return null;
  const [col, row] = [columnNumber(start[1]!)!, Number(start[2])];
  const [toCol, toRow] = [columnNumber(end[1]!)!, Number(end[2])];
  return toRow >= row &&
    toCol >= col &&
    toRow <= SPREADSHEET_MAX_ROWS &&
    toCol <= SPREADSHEET_MAX_COLUMNS
    ? { kind: "cells", sheet, row, col, toRow, toCol }
    : null;
}

/** The range of a place as the fragment and the address write it: `B2`, `B2:D9`, `5:7`, `B:D`. */
export function spreadsheetRange(place: SpreadsheetPlace): string {
  return rangeText(place);
}
