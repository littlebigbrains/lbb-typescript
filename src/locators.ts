// Places in a file, as `ground` reads them (`docs/reference/evidence.md`,
// `docs/architecture/agent-step.md` 3.1): `page=N` for a parsed PDF,
// `line=a,b` for text and Markdown (RFC 5147), `row=n` or `row=a-b` for CSV
// and TSV (RFC 7111). The agent's `files.read` tool reads the text of a place
// with {@link readPlace}, so the model sees the words that `ground` will test
// its quote against. The rules are those of the Rust module and its shared
// cases (`sdk/conformance/grounding.json`, section `locator`): a text splits
// lines at CRLF, LF and CR, drops a byte order mark, and a line break at the
// end adds no line; a CSV row is a record, so a quoted field can hold line
// breaks; the header is row 1; a blank line is a row.

/** Why a place cannot be read, as `ground` names it. */
export type PlaceError =
  "malformed" | "unsupported_media_type" | "wrong_media_type" | "out_of_range";

/** What {@link readPlace} answers: the text of the place, or why it has none. */
export type PlaceRead =
  { ok: true; text: string } | { ok: false; error: PlaceError };

/**
 * The kind of place a media type is read by, `null` for none. The type is
 * read as the file's record holds it, exactly as the server reads it
 * (`MediaKind::of`): no case folding, no parameters.
 */
export function placeKind(media: string): "line" | "row" | "page" | null {
  switch (media) {
    case "text/plain":
    case "text/markdown":
    case "text/x-markdown":
      return "line";
    case "text/csv":
    case "text/tab-separated-values":
      return "row";
    case "application/pdf":
      return "page";
    default:
      return null;
  }
}

/** The parts of a locator, or null for text that is no locator. */
export type Place =
  | { kind: "line"; from: number; to: number }
  | { kind: "row"; from: number; to: number }
  | { kind: "page"; page: number };

/** A decimal number of at most 12 digits; leading zeros are no fault. */
const WHOLE = /^[0-9]{1,12}$/;

/** The largest page the server reads (`u32`). */
const PAGE_MAX = 4_294_967_295;

/** The scheme of a locator (`line`, `row` or `page`), `null` when it has none of them. */
export function schemeOf(locator: string): "line" | "row" | "page" | null {
  const eq = locator.indexOf("=");
  if (eq < 0) return null;
  const scheme = locator.slice(0, eq);
  return scheme === "line" || scheme === "row" || scheme === "page"
    ? scheme
    : null;
}

/**
 * The parts of a locator: `line=a,b` (0 <= a < b), `row=n` or `row=a-b`
 * (1 <= a <= b), `page=n` (1 <= n <= 4294967295), numbers of at most 12
 * digits. `null` for anything else, which `ground` answers `locator_invalid`
 * (`malformed`).
 */
export function parsePlace(locator: string): Place | null {
  const eq = locator.indexOf("=");
  if (eq < 0) return null;
  const scheme = locator.slice(0, eq);
  const rest = locator.slice(eq + 1);
  if (scheme === "line") {
    const parts = rest.split(",");
    if (parts.length !== 2 || !parts.every((part) => WHOLE.test(part)))
      return null;
    const from = Number(parts[0]);
    const to = Number(parts[1]);
    return from < to ? { kind: "line", from, to } : null;
  }
  if (scheme === "row") {
    const parts = rest.split("-");
    if (
      parts.length < 1 ||
      parts.length > 2 ||
      !parts.every((part) => WHOLE.test(part))
    )
      return null;
    const from = Number(parts[0]);
    const to = Number(parts[parts.length - 1]);
    return from >= 1 && to >= from ? { kind: "row", from, to } : null;
  }
  if (scheme === "page") {
    if (!WHOLE.test(rest) || Number(rest) < 1 || Number(rest) > PAGE_MAX)
      return null;
    return { kind: "page", page: Number(rest) };
  }
  return null;
}

/** A text without its byte order mark. */
const withoutMark = (text: string) =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

/**
 * The lines of a text: split at CRLF, LF and CR; a line break at the end adds
 * no line; a blank line is a line.
 */
export function textLines(text: string): string[] {
  const body = withoutMark(text);
  const lines: string[] = [];
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const char = body[i];
    if (char === "\n" || char === "\r") {
      lines.push(body.slice(start, i));
      if (char === "\r" && body[i + 1] === "\n") i += 1;
      start = i + 1;
    }
    i += 1;
  }
  if (start < body.length) lines.push(body.slice(start));
  return lines;
}

/**
 * The records of a CSV or TSV text, each as its source text: a quote at the
 * start of a field opens a quoted field, which runs to its closing quote (a
 * doubled quote is a quote inside it), so it can hold separators and line
 * breaks; a quote inside an unquoted field is kept; an open quote runs to the
 * end. A line break at the end adds no row, and a blank line is a row.
 */
export function tableRows(text: string, separator: "," | "\t"): string[] {
  const body = withoutMark(text);
  const rows: string[] = [];
  let start = 0;
  let i = 0;
  let fieldStart = true;
  let quoted = false;
  while (i < body.length) {
    const char = body[i]!;
    if (quoted) {
      if (char === '"') {
        if (body[i + 1] === '"') i += 1;
        else quoted = false;
      }
    } else if (char === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else if (char === separator) {
      fieldStart = true;
    } else if (char === "\n" || char === "\r") {
      rows.push(body.slice(start, i));
      if (char === "\r" && body[i + 1] === "\n") i += 1;
      start = i + 1;
      fieldStart = true;
    } else {
      fieldStart = false;
    }
    i += 1;
  }
  if (start < body.length) rows.push(body.slice(start));
  return rows;
}

/** The field separator of a table media type. */
const separatorOf = (media: string): "," | "\t" =>
  media === "text/tab-separated-values" ? "\t" : ",";

/**
 * The place a locator names in a file of `media`, or why it names none. The
 * checks run in the order `ground` runs them: the media type has places at
 * all, the locator has a scheme, the scheme is the kind of place the media
 * type has, and the numbers are right.
 */
export function placeOf(
  media: string,
  locator: string,
): { ok: true; place: Place } | { ok: false; error: PlaceError } {
  const kind = placeKind(media);
  if (kind === null) return { ok: false, error: "unsupported_media_type" };
  const scheme = schemeOf(locator);
  if (scheme === null) return { ok: false, error: "malformed" };
  if (scheme !== kind) return { ok: false, error: "wrong_media_type" };
  const place = parsePlace(locator);
  return place === null
    ? { ok: false, error: "malformed" }
    : { ok: true, place };
}

/**
 * The text of the place `locator` in `text`, a file of `media`: text,
 * Markdown, CSV or TSV. The checks run in the order `ground` runs them: the
 * media type has places at all, the locator is well formed, it is the kind of
 * place the media type has, and the place exists. A PDF is read by page from
 * its parsed pages (`GET /v1/files/pages`), not from its bytes, so it is no
 * media type of this function.
 */
export function readPlace(
  media: string,
  locator: string,
  text: string,
): PlaceRead {
  const checked = placeOf(media, locator);
  if (!checked.ok || checked.place.kind === "page") {
    return checked.ok
      ? { ok: false, error: "unsupported_media_type" }
      : { ok: false, error: checked.error };
  }
  const place = checked.place;
  if (place.kind === "line") {
    const lines = textLines(text);
    if (place.to > lines.length) return { ok: false, error: "out_of_range" };
    return { ok: true, text: lines.slice(place.from, place.to).join("\n") };
  }
  const rows = tableRows(text, separatorOf(media));
  if (place.to > rows.length) return { ok: false, error: "out_of_range" };
  return { ok: true, text: rows.slice(place.from - 1, place.to).join("\n") };
}

/** The place after `place` of a text read, when more of it is left: `next`. */
export function nextPlace(place: Place, count: number): string | undefined {
  if (place.kind === "line")
    return place.to < count
      ? `line=${place.to},${Math.min(count, place.to + (place.to - place.from))}`
      : undefined;
  if (place.kind === "row")
    return place.to < count
      ? `row=${place.to + 1}-${Math.min(count, place.to + (place.to - place.from + 1))}`
      : undefined;
  return place.page < count ? `page=${place.page + 1}` : undefined;
}

/** The number of lines or rows a text has, by the kind of place. */
export function placeCount(
  media: string,
  kind: "line" | "row",
  text: string,
): number {
  return kind === "line"
    ? textLines(text).length
    : tableRows(text, separatorOf(media)).length;
}

/**
 * What {@link readWindow} answers: the text of the part of the place that the
 * file has, the locator of that part and the number of lines or rows the file
 * has; or why there is no text, with the same number when the file was counted.
 */
export type PlaceWindow =
  | {
      ok: true;
      text: string;
      /** The place that was read: the one asked for, or its part that the file has. */
      locator: string;
      /** The place that was read, in parts. */
      place: Place;
      /** The place asked for ran past the end of the file. */
      clamped: boolean;
      /** The lines (`line=`) or rows (`row=`) of the file. */
      total: number;
    }
  | { ok: false; error: PlaceError; total?: number };

/**
 * The text of the place `locator` in `text` for a reader that has to find its
 * way: like {@link readPlace}, except that a place which starts inside the
 * file and runs past its end answers the part the file has, with the locator
 * of that part. A place that starts at or past the end answers `out_of_range`
 * with the count. `ground` still tests a quote at the exact place, so a
 * citation uses the locator of the part.
 */
export function readWindow(
  media: string,
  locator: string,
  text: string,
): PlaceWindow {
  const checked = placeOf(media, locator);
  if (!checked.ok || checked.place.kind === "page") {
    return checked.ok
      ? { ok: false, error: "unsupported_media_type" }
      : { ok: false, error: checked.error };
  }
  const place = checked.place;
  if (place.kind === "line") {
    const lines = textLines(text);
    const total = lines.length;
    if (place.from >= total) return { ok: false, error: "out_of_range", total };
    const to = Math.min(place.to, total);
    return {
      ok: true,
      text: lines.slice(place.from, to).join("\n"),
      locator: to === place.to ? locator : `line=${place.from},${to}`,
      place: { kind: "line", from: place.from, to },
      clamped: to !== place.to,
      total,
    };
  }
  const rows = tableRows(text, separatorOf(media));
  const total = rows.length;
  if (place.from > total) return { ok: false, error: "out_of_range", total };
  const to = Math.min(place.to, total);
  return {
    ok: true,
    text: rows.slice(place.from - 1, to).join("\n"),
    locator: to === place.to ? locator : `row=${place.from}-${to}`,
    place: { kind: "row", from: place.from, to },
    clamped: to !== place.to,
    total,
  };
}

/**
 * The last place of a text of `total` lines or rows: the last line is
 * `line=<total - 1>,<total>`, the last row is `row=<total>`. `undefined` for a
 * text with none.
 */
export function lastPlace(
  kind: "line" | "row",
  total: number,
): string | undefined {
  if (total < 1) return undefined;
  return kind === "line" ? `line=${total - 1},${total}` : `row=${total}`;
}
