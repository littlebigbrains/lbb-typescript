// The sections of a Markdown file, split at its ATX headings (`#` to
// `######`, as CommonMark reads them). Each section holds its heading, its
// own text up to the next heading, its parent (the nearest heading above it
// of a lower level, else the document) and its lines, which its evidence
// names as RFC 5147 line positions: `#line=39,44` is lines 40 to 44.

/** One section of a file. */
export interface Section {
  /** Its place in the file: 0 for the text before the first heading, then 1, 2, … */
  position: number;
  /** 1 to 6; 0 for the text before the first heading. */
  level: number;
  title: string;
  /** Its own text: the lines after its heading, up to the next heading. */
  text: string;
  /** The titles of its parents and its own, from the top. */
  headingPath: string[];
  /** The position of its parent section; null when its parent is the document. */
  parent: number | null;
  /** Its first and last line, from 1. */
  from: number;
  to: number;
  /** The heading line, or the first line of the text before the first heading. */
  quote: string;
}

/** The lines of a text: split at CRLF, LF and CR, without a byte order mark. A line break at the end adds no line. */
export function splitLines(text: string): string[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!body) return [];
  const lines = body.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** An ATX heading: up to 3 spaces, 1 to 6 `#`, then a space or the end. A closing run of `#` is dropped. */
export function atxHeading(line: string): { level: number; title: string } | null {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
  if (!m) return null;
  const title = (m[2] ?? "").replace(/(?:^|[ \t]+)#+$/, "").trim();
  return { level: m[1]!.length, title };
}

/** The opening of a fenced code block: up to 3 spaces and 3 or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The sections of a Markdown text. Lines inside a fenced code block are
 * text, never headings. The text before the first heading, when it is not
 * blank, is section 0 of level 0, titled `untitled` (the caller names it
 * after the file). A section's lines run from its heading to its last line
 * that is not blank before the next heading.
 */
export function markdownSections(text: string, untitled = ""): Section[] {
  const lines = splitLines(text);
  const headings: { line: number; level: number; title: string }[] = [];
  let fence: { char: string; length: number } | null = null;
  lines.forEach((line, i) => {
    if (fence) {
      const close = new RegExp(`^ {0,3}\\${fence.char}{${fence.length},}[ \\t]*$`);
      if (close.test(line)) fence = null;
      return;
    }
    const open = FENCE.exec(line);
    if (open) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      return;
    }
    const heading = atxHeading(line);
    if (heading) headings.push({ line: i + 1, ...heading });
  });

  /** Lines `from` to `to` (from 1) without the blank lines at either end. */
  const span = (from: number, to: number) => {
    while (from <= to && !lines[from - 1]!.trim()) from += 1;
    while (to >= from && !lines[to - 1]!.trim()) to -= 1;
    return { from, to };
  };
  const out: Section[] = [];
  const firstHeading = headings[0]?.line ?? lines.length + 1;
  const before = span(1, firstHeading - 1);
  if (before.from <= before.to)
    out.push({
      position: 0,
      level: 0,
      title: untitled,
      text: lines.slice(before.from - 1, before.to).join("\n"),
      headingPath: [],
      parent: null,
      from: before.from,
      to: before.to,
      quote: lines[before.from - 1]!.trim(),
    });

  const open: Section[] = [];
  headings.forEach((heading, n) => {
    const end = (headings[n + 1]?.line ?? lines.length + 1) - 1;
    const body = span(heading.line + 1, end);
    while (open.length && open[open.length - 1]!.level >= heading.level) open.pop();
    const parent = open[open.length - 1] ?? null;
    const section: Section = {
      position: n + 1,
      level: heading.level,
      title: heading.title,
      text: body.from <= body.to ? lines.slice(body.from - 1, body.to).join("\n") : "",
      headingPath: [...(parent?.headingPath ?? []), heading.title],
      parent: parent?.position ?? null,
      from: heading.line,
      to: body.from <= body.to ? body.to : heading.line,
      quote: lines[heading.line - 1]!.trim(),
    };
    open.push(section);
    out.push(section);
  });
  return out;
}

/** The RFC 5147 fragment of a section's lines: `line=<from - 1>,<to>`. */
export function lineFragment(section: Pick<Section, "from" | "to">): string {
  return `line=${section.from - 1},${section.to}`;
}
