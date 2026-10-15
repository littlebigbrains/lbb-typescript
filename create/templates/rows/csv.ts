// The records of a CSV or TSV file, as RFC 4180 defines them: fields split by
// the delimiter, records by a line break (CRLF, LF or CR), and a field in
// double quotes may hold the delimiter, line breaks and quotes (written `""`).
// Each record keeps its row number as RFC 7111 counts rows (from 1, the
// header is row 1) and its text in the file, the quote of its evidence.

/** One record: its fields, its row from 1, its text without the line break, and where it starts and ends. */
export interface CsvRecord {
  fields: string[];
  row: number;
  text: string;
  /** The character offset of the record's first character. */
  start: number;
  /** The character offset after the record's line break: where the next record starts. */
  next: number;
}

/** The delimiter of a file: a tab for TSV (`text/tab-separated-values` or a `.tsv` name), else a comma. */
export function delimiterOf(mediaType: string, name: string): string {
  return mediaType === "text/tab-separated-values" || /\.tsv$/i.test(name) ? "\t" : ",";
}

/**
 * The records of `text` from the character offset `at`, numbered from `row`.
 * A byte order mark at the start of the file is dropped. A blank line is a
 * record of one empty field, so the row numbers stay those of RFC 7111. A
 * quote inside an unquoted field, and text after a closing quote, are kept
 * as they are. A line break at the end of the file ends the last record.
 */
export function* csvRecords(
  text: string,
  delimiter = ",",
  at = 0,
  row = 1,
): Generator<CsvRecord, void, undefined> {
  let i = at === 0 && text.charCodeAt(0) === 0xfeff ? 1 : at;
  while (i < text.length) {
    const start = i;
    const fields: string[] = [];
    let field = "";
    let quoted = false;
    let atFieldStart = true;
    let end = text.length;
    let next = text.length;
    while (i < text.length) {
      const c = text[i]!;
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            quoted = false;
            i += 1;
          }
        } else {
          field += c;
          i += 1;
        }
        continue;
      }
      if (c === '"' && atFieldStart) {
        quoted = true;
        atFieldStart = false;
        i += 1;
        continue;
      }
      if (c === delimiter) {
        fields.push(field);
        field = "";
        atFieldStart = true;
        i += 1;
        continue;
      }
      if (c === "\r" || c === "\n") {
        end = i;
        next = c === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1;
        break;
      }
      field += c;
      atFieldStart = false;
      i += 1;
    }
    fields.push(field);
    yield { fields, row, text: text.slice(start, end), start, next };
    row += 1;
    i = next;
  }
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
