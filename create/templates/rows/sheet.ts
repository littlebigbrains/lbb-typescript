// XLSX files for `rows`: the rows of a sheet as the records a CSV file gives.
//
// The server reads a workbook (`GET /v1/files/sheets`, in a bounded child
// process) and serves the stored values of a sheet by A1 row. A record is a
// row with at least one cell: its fields are the values of columns A, B, …
// up to the row's last cell, as text, and empty where the row has no cell.
// A formula cell is the value its file stored; a formula the file stored no
// value for is empty (LBB calculates nothing). The record's `row` is the A1
// row, so evidence names the row as a range of the sheet (`Sales!A5:F5`).
import { spreadsheetFragment, type Schemas, type SpreadsheetPlace } from "@littlebigbrain/client";
import type { CsvRecord } from "./csv.js";

/** The media type of an XLSX workbook. */
export const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Whether a file is an XLSX workbook: its media type, or a ZIP or untyped file named `.xlsx`. */
export function isXlsx(mediaType: string, name: string): boolean {
  return (
    mediaType === XLSX_MEDIA_TYPE ||
    ((mediaType === "application/zip" || mediaType === "application/octet-stream" || !mediaType) &&
      /\.xlsx$/i.test(name))
  );
}

/** What `files.sheets` reads. */
export type ReadSheets = (
  sha256: string,
  options?: { sheet?: string; from?: number; to?: number },
) => Promise<Schemas["FileSheets"]>;

/** The sheet a file is read from: the setting's, else the first visible sheet. Null when the workbook has no such sheet. */
export async function chooseSheet(
  read: ReadSheets,
  sha256: string,
  wanted: string | undefined,
): Promise<string | null> {
  const outline = await read(sha256);
  if (wanted !== undefined) return outline.sheets.some((s) => s.name === wanted) ? wanted : null;
  return (outline.sheets.find((s) => s.state === "visible") ?? outline.sheets[0])?.name ?? null;
}

/** What a read of sheet rows holds, as `readRecords` holds it for bytes. */
export interface SheetRead {
  records: CsvRecord[];
  /** The A1 row to read from next. */
  row: number;
  /** The sheet has no row from `row` on. */
  end: boolean;
}

/**
 * Up to `limit` rows with cells of the sheet, from the A1 row `from`. The
 * server answers at most 1,000 rows and 20,000 cells a call; this goes on
 * from the answer's `next` until it has `limit` rows or the sheet ends.
 */
export async function readSheetRecords(
  read: ReadSheets,
  sha256: string,
  sheet: string,
  from: number,
  limit: number,
): Promise<SheetRead> {
  const records: CsvRecord[] = [];
  let at = from;
  for (;;) {
    const answer = await read(sha256, { sheet, from: at, to: at + Math.max(limit, 100) - 1 });
    const found = answer.sheets[0];
    if (!found) return { records, row: at, end: true };
    for (const row of found.rows ?? []) {
      if (records.length >= limit) return { records, row: row.row, end: false };
      const last = row.cells.reduce((n, c) => Math.max(n, c.col), 0);
      const fields: string[] = Array.from({ length: last }, () => "");
      for (const cell of row.cells) fields[cell.col - 1] = cell.value ?? "";
      records.push({
        row: row.row,
        fields,
        text: fields.join("\t"),
        start: 0,
        next: 0,
      });
    }
    if (answer.next == null) return { records, row: (answer.to ?? at) + 1, end: true };
    at = answer.next;
    if (records.length >= limit) return { records, row: at, end: false };
  }
}

/** The fragment that names a row of a sheet, for evidence: its cells from column A to the last one the row has. */
export function rowFragment(sheet: string, record: Pick<CsvRecord, "row" | "fields">): string {
  const place: SpreadsheetPlace = {
    kind: "cells",
    sheet,
    row: record.row,
    col: 1,
    toRow: record.row,
    toCol: Math.max(1, record.fields.length),
  };
  return spreadsheetFragment(place);
}
