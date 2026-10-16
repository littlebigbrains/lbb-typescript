// The records of a CSV or TSV file, as RFC 4180 defines them: fields split by
// the delimiter, records by a line break (CRLF, LF or CR), and a field in
// double quotes may hold the delimiter, line breaks and quotes (written `""`).
// Each record keeps its row number as RFC 7111 counts rows (from 1, the
// header is row 1) and its text in the file, the quote of its evidence.
//
// The parser reads bytes. The delimiter, the quote and the line breaks are
// ASCII, and no byte of a UTF-8 character other than ASCII is ASCII, so a
// record boundary is never inside a character. `readRecords` reads a file
// in windows of bytes (`client.files.content(sha256, { range })`) and keeps a
// record that a window does not end for the next window.

/** One record: its fields, its row from 1, its text without the line break, and where it starts and ends. */
export interface CsvRecord {
  fields: string[];
  row: number;
  text: string;
  /** The byte offset of the record's first byte in the file. */
  start: number;
  /** The byte offset after the record's line break: where the next record starts. */
  next: number;
}

/** Where the bytes given to `csvRecords` are in the file, and whether the file ends with them. */
export interface CsvPart {
  /** The byte offset of the first byte given. Default 0. */
  base?: number;
  /**
   * The file ends with these bytes (default). With `false` the file goes on:
   * a record the bytes do not end is not given, nor one that ends in a
   * carriage return or a quote as the last byte (a line feed or a second
   * quote can follow). The next read starts at the `next` of the last
   * record given.
   */
  final?: boolean;
}

const QUOTE = 0x22;
const CR = 0x0d;
const LF = 0x0a;
const decoder = new TextDecoder();

/** The delimiter of a file: a tab for TSV (`text/tab-separated-values` or a `.tsv` name), else a comma. */
export function delimiterOf(mediaType: string, name: string): string {
  return mediaType === "text/tab-separated-values" || /\.tsv$/i.test(name) ? "\t" : ",";
}

/**
 * The records of `input` (bytes, or text as its UTF-8 bytes) from the byte
 * offset `at` of the file, numbered from `row`. A byte order mark at the
 * start of the file is dropped. A blank line is a record of one empty field,
 * so the row numbers stay those of RFC 7111. A quote inside an unquoted
 * field, and text after a closing quote, are kept as they are. A line break
 * at the end of the file ends the last record. `part` says where the bytes
 * are in the file and whether the file ends with them.
 */
export function* csvRecords(
  input: string | Uint8Array,
  delimiter = ",",
  at = 0,
  row = 1,
  part: CsvPart = {},
): Generator<CsvRecord, void, undefined> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const base = part.base ?? 0;
  const final = part.final ?? true;
  const split = delimiter.charCodeAt(0);
  const n = bytes.length;
  const text = (from: number, to: number) => decoder.decode(bytes.subarray(from, to));
  let i = at - base;
  if (at === 0 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < n) {
    const start = i;
    const fields: string[] = [];
    let field = "";
    let from = i;
    let quoted = false;
    let atFieldStart = true;
    let end = -1;
    let next = -1;
    while (i < n) {
      const c = bytes[i]!;
      if (quoted) {
        if (c === QUOTE) {
          if (i + 1 >= n && !final) return;
          if (bytes[i + 1] === QUOTE) {
            field += `${text(from, i)}"`;
            i += 2;
          } else {
            field += text(from, i);
            quoted = false;
            i += 1;
          }
          from = i;
        } else i += 1;
        continue;
      }
      if (c === QUOTE && atFieldStart) {
        quoted = true;
        atFieldStart = false;
        i += 1;
        from = i;
        continue;
      }
      if (c === split) {
        fields.push(field + text(from, i));
        field = "";
        atFieldStart = true;
        i += 1;
        from = i;
        continue;
      }
      if (c === CR || c === LF) {
        if (c === CR && i + 1 >= n && !final) return;
        end = i;
        next = c === CR && bytes[i + 1] === LF ? i + 2 : i + 1;
        break;
      }
      atFieldStart = false;
      i += 1;
    }
    if (end < 0) {
      if (!final) return;
      end = n;
      next = n;
    }
    fields.push(field + text(from, end));
    yield { fields, row, text: text(start, end), start: base + start, next: base + next };
    row += 1;
    i = next;
  }
}

/** Bytes `start` to `end` of a file, both included: fewer at its end, none from its end on. */
export type ReadRange = (start: number, end: number) => Promise<Uint8Array>;

/** Bytes a read holds that its records did not take: they start at `base`. */
export interface HeldBytes {
  base: number;
  bytes: Uint8Array;
  /** The file ends with these bytes. */
  eof: boolean;
}

/** What `readRecords` read. */
export interface RecordsRead {
  records: CsvRecord[];
  /** The byte offset after the last record: where the next read starts. */
  next: number;
  /** The row number of the record at `next`. */
  row: number;
  /** No byte of the file is left from `next` on. */
  end: boolean;
  /** The bytes read from the file. */
  bytesRead: number;
  /** The bytes read from `next` on: a later read of the same turn starts with them. */
  held: HeldBytes;
}

/** How `readRecords` reads. */
export interface WindowOptions {
  /** Bytes one read asks for. */
  window: number;
  /** The longest record: a record that is not complete after this many bytes stops the read with an error. */
  maxRecord: number;
}

/** Bytes one read asks for by default: 4 MiB. */
export const WINDOW_BYTES = 4 * 1024 * 1024;
/** The longest record by default: 16 MiB, as a quote that never closes makes the rest of a file one record. */
export const MAX_RECORD_BYTES = 16 * 1024 * 1024;

function joined(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * At most `limit` complete records of a file from the byte offset `at`,
 * numbered from `row`, read with `read` in windows of `options.window`
 * bytes. A record that a window does not end is read on in the next
 * window, so a quoted field can span windows and row numbers stay exact.
 * `held` gives bytes an earlier read of the same turn holds from `at` on,
 * which are not read again. Memory stays within the window and the longest
 * record.
 */
export async function readRecords(
  read: ReadRange,
  delimiter: string,
  at: number,
  row: number,
  limit: number,
  options: WindowOptions,
  held?: HeldBytes,
): Promise<RecordsRead> {
  const records: CsvRecord[] = [];
  let base = at;
  let buffer: Uint8Array = new Uint8Array(0);
  let eof = false;
  let bytesRead = 0;
  if (held && held.base <= at && at <= held.base + held.bytes.length) {
    buffer = held.bytes.subarray(at - held.base);
    eof = held.eof;
  }
  let first = true;
  while (records.length < limit) {
    if (!eof && !(first && buffer.length)) {
      const from = base + buffer.length;
      const chunk = await read(from, from + options.window - 1);
      bytesRead += chunk.length;
      eof = chunk.length < options.window;
      buffer = joined(buffer, chunk);
    }
    first = false;
    let taken = base;
    for (const record of csvRecords(buffer, delimiter, base, row, { base, final: eof })) {
      records.push(record);
      taken = record.next;
      row = record.row + 1;
      if (records.length >= limit) break;
    }
    buffer = buffer.subarray(taken - base);
    base = taken;
    if (eof) break;
    if (buffer.length > options.maxRecord)
      throw new RangeError(
        `row ${row} is longer than ${options.maxRecord} bytes from byte ${base}: a quote that never closes?`,
      );
  }
  return {
    records,
    next: base,
    row,
    end: eof && !buffer.length,
    bytesRead,
    held: { base, bytes: buffer, eof },
  };
}

/** A record of empty fields only: a blank line, or a row of delimiters. */
export function isBlank(record: Pick<CsvRecord, "fields">): boolean {
  return record.fields.every((field) => !field.trim());
}

/**
 * A header or property name for matching: letters and digits of any script,
 * in lower case, without marks and without spaces or punctuation.
 * `Customer ID`, `customer_id` and `CustomerId` are all `customerid`.
 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}
