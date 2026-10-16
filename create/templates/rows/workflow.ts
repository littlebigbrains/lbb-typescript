// rows: one instance per row of a CSV or TSV file, each with an edge to the
// file whose evidence is the row.
//
// A named workflow with a content trigger sends each upload of `text/csv` or
// `text/tab-separated-values` here within seconds, one file per message,
// without a wait for a publication. For each file the workflow:
//
// 1. reads the file's name and checks its derivation: a file this version
//    already read with these settings is skipped, so identical bytes under
//    two names are read once;
// 2. reads the header row and maps its columns to properties of the graph
//    (the settings' `columns`, else each column whose header matches a
//    property by its normalized name);
// 3. writes one instance of the settings' class per data row: the mapped
//    values, its key (the key column, else `<sha256>:<row>`) and an edge
//    `READ_FROM` to the file's `Document` whose evidence is the row's text,
//    with the source `<Document IRI>#row=<n>` (RFC 7111: rows from 1, the
//    header is row 1);
// 4. with `represents`, writes `Document REPRESENTS <instance>` when the
//    file's name names exactly one instance of that class;
// 5. records the derivation.
//
// A turn reads at most `rowsPerTurn` rows; the rest goes to a new turn
// (`ctx.continue`) that starts where the last one stopped. The file is read
// by byte range, a window of at most 4 MiB per read: the first turn reads
// the header, and each turn reads on from the byte offset where the last
// one stopped, so a large file is read about once in all.
import { createHash } from "node:crypto";
import {
  LbbError,
  entityRef,
  triggeredWorkflow,
  type LbbActivities,
  type Schemas,
  type WorkflowTriggerMessage,
} from "@littlebigbrain/client";
import {
  MAX_RECORD_BYTES,
  WINDOW_BYTES,
  delimiterOf,
  isBlank,
  normalizeName,
  readRecords,
  type CsvRecord,
  type HeldBytes,
  type ReadRange,
  type RecordsRead,
  type WindowOptions,
} from "./csv.js";

export type ValueType = "text" | "keyword" | "i64" | "f64" | "bool" | "date_time";

export interface Settings {
  /** The class of the instances: one per data row. */
  className: string;
  /** The column whose value keys each instance. Without it (or without a value), the key is `<sha256>:<row>`. */
  key?: string;
  /** Column → property. Without it: each column whose header matches a property of the graph by its normalized name. */
  columns?: Record<string, string>;
  /** Also write `Document REPRESENTS <instance>` when the file's name, without its extension, is the label of exactly one instance of this class. */
  represents?: { class: string };
  /** Only files whose name matches this regular expression. Default: every file. */
  match?: string;
  /** Rows one turn reads, 1 to 20,000. */
  rowsPerTurn: number;
}

/** The settings: edit them for your files. These fit the samples. */
export const defaults: Settings = {
  className: "Customer",
  key: "Customer ID",
  represents: { class: "Report" },
  match: "customers",
  rowsPerTurn: 5_000,
};

/** The workflow type and version the named workflow names, and the derivations record. */
export const workflowType = { workflow_type: "rows", version: "v1" };

/** The media types the content trigger sends. */
export const MEDIA_TYPES = ["text/csv", "text/tab-separated-values"];

/** The relation from each instance to the file it was read from. */
export const READ_FROM = "READ_FROM";
const REPRESENTS = "REPRESENTS";

/** The named workflow with its content trigger: `client.workflows.named.put(trigger())`. */
export function trigger(settings: Settings = defaults): Schemas["NamedWorkflowRequest"] {
  return {
    name: "rows",
    workflow: workflowType,
    triggers: [{ id: "rows", content: { media_types: MEDIA_TYPES } }],
    owns: {
      classes: [settings.className],
      relations: [READ_FROM, ...(settings.represents ? [REPRESENTS] : [])],
      properties: [...new Set(Object.values(settings.columns ?? {}))],
    },
  };
}

/**
 * The class and the relations the workflow writes, for `lbb.evolve`. The
 * properties are the graph's own. `REPRESENTS` is the relation an upload
 * adds (from `Document` to any class); an evolve that adds it again
 * changes nothing.
 */
export function ontology(settings: Settings = defaults): Schemas["OntologyEvolveOp"][] {
  return [
    { op: "add_entity_type", name: settings.className },
    { op: "add_entity_type", name: "Document" },
    { op: "add_relation", name: READ_FROM, domain: [settings.className], range: ["Document"] },
    ...(settings.represents
      ? [{ op: "add_relation" as const, name: REPRESENTS, domain: ["Document"], range: [] }]
      : []),
  ];
}

/** What a client reads for the workflow beside the activities. An `LbbClient` has both. */
export interface ContentPorts {
  files: {
    /** The file's bytes; with `range`, bytes `start` to `end` (both included), answered `206`. */
    content(
      sha256: string,
      options?: { range?: { start: number; end?: number } },
    ): Promise<Uint8Array>;
  };
  workflows: {
    derivations: {
      check(key: Schemas["DerivationKey"]): Promise<Schemas["DerivationCheckResponse"]>;
      record(
        request: Schemas["DerivationRecordRequest"],
      ): Promise<Schemas["DerivationRecordResponse"]>;
    };
  };
}

/** What the workflow has done, over all its turns. */
export interface RowsState {
  /** Files read to their end. */
  contents: number;
  /** Files skipped: read before with these settings, another name, or no file. */
  skipped: number;
  rows: number;
  instances: number;
  represents: number;
}

/** A mapped column: its index in the header, its header, and the property it fills with its type. */
interface Column {
  index: number;
  header: string;
  property: string;
  type: ValueType;
}

/** What the first turn of a file decides, carried by its later turns. */
interface Plan {
  sha256: string;
  document: string;
  name: string;
  delimiter: string;
  columns: Column[];
  /** The headers that fill no property, at most 100. */
  left: string[];
  key: number | null;
  label: number | null;
  represents: string | null;
}

/** Where a file's next turn starts, and what its turns did so far. */
interface Cursor {
  /** The byte offset of the next row. */
  byte: number;
  /** The row number of the next row. */
  row: number;
  plan: Plan;
  done: Done;
}

interface Done {
  rows: number;
  instances: number;
  /** Rows without a key value. */
  keyless: number;
  /** Values that did not take their property's type. */
  rejected: number;
  /** The commits of the writes, at most 256. */
  commits: number[];
}

/** A file of the graph: its content's SHA-256, its `Document`, its name and media type. */
interface FileInfo {
  sha256: string;
  document: string;
  name: string;
  mediaType: string;
}

/** What the check of a file found: the file to read, or why it is skipped. */
interface Checked {
  file?: FileInfo;
  skip?: string;
}

/** A trigger message; a file's later turns carry the cursor. */
type RowsMessage = WorkflowTriggerMessage & { cursor?: Cursor };

/** Rows one owned write holds: a commit names at most 1,000 entities. */
const PART = 400;
/** Characters of a row's text its evidence keeps. */
const EVIDENCE_CHARS = 1_000;
const SHA256 = /^[0-9a-f]{64}$/;
const PLAIN_IRI = /^[^\s<>"{}|\\^`]+$/;
const P = "PREFIX p: <https://littlebigbrain.com/p/>\n";
const LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const LABEL_HEADERS = new Set(["name", "title", "label"]);
const SCALAR: Record<string, ValueType> = {
  text: "text",
  keyword: "keyword",
  i64: "i64",
  f64: "f64",
  bool: "bool",
  datetime: "date_time",
  date_time: "date_time",
};

/** The media type without parameters, in lower case. */
const baseType = (mediaType: string) => mediaType.split(";")[0]!.trim().toLowerCase();

/** A file name without its last extension. */
export const stem = (name: string) => name.replace(/\.[^./\\]*$/, "");

/** A label for comparing a file name with labels: lower case, and runs of `-`, `_` and spaces as one space. */
export const labelKey = (text: string) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[-_\s]+/g, " ")
    .trim();

/** JSON with its object keys sorted, so equal settings give one digest. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The settings digest of the derivations: the hex SHA-256 of the settings' canonical JSON. */
export function settingsDigest(settings: Settings): string {
  return createHash("sha256").update(canonical(settings)).digest("hex");
}

/** The derivation key of one content with these settings. */
export function derivationKey(sha256: string, settings: Settings): Schemas["DerivationKey"] {
  return { sha256, ...workflowType, settings_digest: settingsDigest(settings) };
}

/** The value of a cell in its property's type, or null when it is empty or does not take the type. */
export function typed(raw: string, type: ValueType): string | number | boolean | null {
  const text = raw.trim();
  if (!text) return null;
  switch (type) {
    case "i64": {
      const n = Number(text.replace(/[\s_]/g, ""));
      return Number.isSafeInteger(n) ? n : null;
    }
    case "f64": {
      const n = Number(text.replace(/\s/g, "").replace(/^([-+]?\d+),(\d+)$/, "$1.$2"));
      return Number.isFinite(n) ? n : null;
    }
    case "bool":
      return /^(true|yes|1)$/i.test(text) ? true : /^(false|no|0)$/i.test(text) ? false : null;
    case "date_time": {
      if (/^\d{4}-\d{2}-\d{2}$/.test(text))
        return Number.isNaN(Date.parse(text)) ? null : `${text}T00:00:00Z`;
      if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || Number.isNaN(Date.parse(text))) return null;
      return new Date(Date.parse(text)).toISOString().replace(/\.000Z$/, "Z");
    }
    default:
      return text;
  }
}

/** The index of the header a setting names: the same text, else the same normalized name. */
function headerIndex(header: string[], name: string): number {
  const exact = header.indexOf(name);
  if (exact >= 0) return exact;
  return header.findIndex((h) => normalizeName(h) === normalizeName(name));
}

/**
 * The columns that fill properties: the settings' `columns`, else each
 * header whose normalized name is a property of the graph's registry. A
 * property must be in the registry with a scalar type.
 */
export function mapColumns(
  header: string[],
  registry: { name: string; value_type: string }[],
  columns?: Record<string, string>,
): { columns: Column[]; left: string[] } {
  const byName = new Map<string, { name: string; type: ValueType }>();
  for (const p of registry) {
    const type = SCALAR[p.value_type.toLowerCase()];
    if (type && !byName.has(normalizeName(p.name)))
      byName.set(normalizeName(p.name), { name: p.name, type });
  }
  const mapped: Column[] = [];
  if (columns)
    for (const [column, property] of Object.entries(columns)) {
      const index = headerIndex(header, column);
      const found = byName.get(normalizeName(property));
      if (index >= 0 && found)
        mapped.push({ index, header: header[index]!, property: found.name, type: found.type });
    }
  else
    header.forEach((h, index) => {
      const found = byName.get(normalizeName(h));
      if (found) mapped.push({ index, header: h, property: found.name, type: found.type });
    });
  const used = new Set(mapped.map((c) => c.index));
  return { columns: mapped, left: header.filter((_, i) => !used.has(i)).slice(0, 100) };
}

/**
 * How the workflow reads a file: bytes per read (default 4 MiB, at least
 * 64) and the longest row (default 16 MiB). They change no output, so they
 * are no settings and enter no derivation key.
 */
export type ReadOptions = Partial<WindowOptions>;

/** The workflow, for a `WorkflowWorker`. `lbb` is `lbbActivities(client)` and `ports` the client, or mocks in a test. */
export function createWorkflow(
  lbb: LbbActivities,
  ports: ContentPorts,
  settings: Settings = defaults,
  reading: ReadOptions = {},
) {
  if (!(Number.isSafeInteger(settings.rowsPerTurn) && settings.rowsPerTurn >= 1))
    throw new RangeError("rowsPerTurn is a whole number from 1");
  if (settings.rowsPerTurn > 20_000)
    throw new RangeError("rowsPerTurn is at most 20,000: a turn holds 64 steps");
  const windows: WindowOptions = {
    window: reading.window ?? WINDOW_BYTES,
    maxRecord: reading.maxRecord ?? MAX_RECORD_BYTES,
  };
  if (!(Number.isSafeInteger(windows.window) && windows.window >= 64))
    throw new RangeError("window is a whole number of bytes from 64");
  if (!(Number.isSafeInteger(windows.maxRecord) && windows.maxRecord >= 1))
    throw new RangeError("maxRecord is a whole number of bytes from 1");
  const match = settings.match ? new RegExp(settings.match, "u") : null;

  /** Bytes `start` to `end` of a content: none from its end on (the server answers 416 there). */
  const rangeOf =
    (sha256: string): ReadRange =>
    async (start, end) => {
      try {
        const bytes = await ports.files.content(sha256, { range: { start, end } });
        // A server or proxy that ignores Range answers the whole file.
        return bytes.length > end - start + 1 ? bytes.subarray(start, end + 1) : bytes;
      } catch (error) {
        if (error instanceof LbbError && error.status === 416) return new Uint8Array(0);
        throw error;
      }
    };

  return triggeredWorkflow<RowsState>({
    name: workflowType.workflow_type,
    version: workflowType.version,
    initialState: { contents: 0, skipped: 0, rows: 0, instances: 0, represents: 0 },
    async onInstances(ctx, message: RowsMessage, state) {
      /** The state after this file: the message's next instance goes to a new turn. */
      const rest = (next: RowsState) => {
        const others = message.instances.slice(1);
        if (!others.length) return { state: next };
        const plain: RowsMessage = { ...message, instances: others, removed: [], origin: null };
        delete plain.cursor;
        return ctx.continue(next, plain);
      };
      const document = message.instances[0];
      if (!document) return { state };
      // A cursor without a byte offset (a message of an earlier version of
      // this template) reads the file again from its start.
      let cursor = typeof message.cursor?.byte === "number" ? message.cursor : undefined;
      // The bytes the header read holds after the header, for the rows of
      // the same turn: they are not read again.
      let held: HeldBytes | undefined;

      if (!cursor) {
        const checked = await ctx.step("check", async (s): Promise<Checked> => {
          s.progress("checking the file", { done: 0, total: 1, unit: "documents" });
          const file = await readDocument(message, document);
          if (!file) return { skip: "no file" };
          const named = /\.(csv|tsv)$/i.test(file.name);
          if (!MEDIA_TYPES.includes(file.mediaType) && !named) return { skip: "media type" };
          if (match && !match.test(file.name)) return { skip: "name" };
          const found = await ports.workflows.derivations.check(
            derivationKey(file.sha256, settings),
          );
          return found.exists ? { skip: "derived" } : { file };
        });
        if (!checked.file) {
          const next = { ...state, skipped: state.skipped + 1 };
          return rest(next);
        }
        const file = checked.file;
        const planned = await ctx.step("plan", async (s) => {
          s.progress("reading the header", { done: 0, total: 1, unit: "documents" });
          const delimiter = delimiterOf(file.mediaType, file.name);
          const header = await readRecords(rangeOf(file.sha256), delimiter, 0, 1, 1, windows);
          held = header.held;
          return plan(file, delimiter, header);
        });
        const first: number[] = [];
        if (planned.plan.represents) {
          const written = await lbb.writeOwned(ctx, "represents", (s) => {
            s.progress("writing facts", { done: 0, total: 1, unit: "documents" });
            const p = planned.plan;
            return {
              subjects: [entityRef(p.document, "Document", p.name)],
              relations: [REPRESENTS],
              triplets: [
                {
                  source: entityRef(p.document, "Document", p.name),
                  relation: REPRESENTS,
                  target: entityRef(
                    p.represents!,
                    settings.represents!.class,
                    planned.label ?? undefined,
                  ),
                  confidence: 1,
                  evidence: { text: p.name, source_id: p.document },
                },
              ],
            };
          });
          if (written.commit_seq !== null) first.push(written.commit_seq);
        }
        cursor = {
          byte: planned.at,
          row: 2,
          plan: planned.plan,
          done: { rows: 0, instances: 0, keyless: 0, rejected: 0, commits: first },
        };
      }

      // The rows of this turn, read from the byte offset where the last turn
      // stopped, then their writes in parts. A turn run again after a crash
      // reads its rows again from the same offset.
      const from = cursor;
      const filePlan = from.plan;
      let rows: Promise<RecordsRead> | undefined;
      const turnRows = () =>
        (rows ??= readRecords(
          rangeOf(filePlan.sha256),
          filePlan.delimiter,
          from.byte,
          from.row,
          settings.rowsPerTurn,
          windows,
          held,
        ));
      const windowRecords = async (): Promise<CsvRecord[]> => (await turnRows()).records;
      const window = await ctx.step("rows", async (s) => {
        s.progress("reading rows", { done: 0, unit: "rows" });
        const read = await turnRows();
        const taken = read.records;
        s.progress("reading rows", { done: taken.length, unit: "rows" });
        const counts = { instances: 0, keyless: 0, rejected: 0 };
        for (const record of taken) {
          const built = rowFacts(filePlan, record);
          if (built === "blank") continue;
          if (built === "keyless") counts.keyless += 1;
          else {
            counts.instances += 1;
            counts.rejected += built.rejected;
          }
        }
        return { count: taken.length, byte: read.next, row: read.row, end: read.end, ...counts };
      });
      const commits: number[] = [];
      for (let n = 0; n * PART < window.count; n++) {
        const written = await lbb.writeOwned(ctx, `write-${n}`, async (s) => {
          s.progress("writing facts", { done: n * PART, total: window.count, unit: "rows" });
          const part = (await windowRecords()).slice(n * PART, (n + 1) * PART);
          return partWrite(filePlan, part);
        });
        if (written.commit_seq !== null) commits.push(written.commit_seq);
      }
      const done: Done = {
        rows: from.done.rows + window.count,
        instances: from.done.instances + window.instances,
        keyless: from.done.keyless + window.keyless,
        rejected: from.done.rejected + window.rejected,
        commits: [...from.done.commits, ...commits].slice(0, 256),
      };
      const counted = {
        ...state,
        rows: state.rows + window.count,
        instances: state.instances + window.instances,
      };
      if (!window.end)
        return ctx.continue(counted, {
          ...message,
          removed: [],
          cursor: { byte: window.byte, row: window.row, plan: filePlan, done },
        });

      await ctx.step("record", async (s) => {
        s.progress("recording the derivation", { done: 0, total: 1, unit: "documents" });
        const recorded = await ports.workflows.derivations.record({
          ...derivationKey(filePlan.sha256, settings),
          run_id: ctx.messageId,
          outputs: {
            rows: done.rows,
            instances: done.instances,
            rows_without_key: done.keyless,
            values_left_out: done.rejected,
            columns: filePlan.columns.slice(0, 100).map((c) => `${c.header} → ${c.property}`),
            columns_left_out: filePlan.left,
            represents: filePlan.represents,
            commits: done.commits,
          },
        });
        return recorded.recorded;
      });
      return rest({
        ...counted,
        contents: counted.contents + 1,
        represents: counted.represents + (filePlan.represents ? 1 : 0),
      });
    },
  });

  /** The file of a `Document`: its SHA-256, name and media type, read with a strong read. */
  async function readDocument(message: RowsMessage, document: string): Promise<FileInfo | null> {
    if (!PLAIN_IRI.test(document)) return null;
    const query = `# rows: document\n${P}SELECT ?name ?sha ?type WHERE {
  VALUES ?doc { <${document}> }
  OPTIONAL { ?doc p:name ?name } OPTIONAL { ?doc p:file_sha256 ?sha } OPTIONAL { ?doc p:content_type ?type }
}`;
    const { rows } = await lbb.sparql(query, { consistency: "strong" });
    const row = rows[0] ?? {};
    const origin =
      message.instances.length === 1 && message.origin?.kind === "content" ? message.origin : null;
    const sha256 = (origin?.sha256 ?? row.sha ?? "").toLowerCase();
    if (!SHA256.test(sha256)) return null;
    return {
      sha256,
      document,
      name: row.name ?? sha256.slice(0, 12),
      mediaType: baseType(origin?.media_type ?? row.type ?? ""),
    };
  }

  /** The plan of a file: its delimiter, the mapped columns, the key and label columns, and what it represents. */
  async function plan(file: FileInfo, delimiter: string, read: RecordsRead) {
    const first = read.records[0];
    const header = first ? first.fields.map((h) => h.trim()) : [];
    const registry = header.length ? ((await lbb.ontology()).property_defs ?? []) : [];
    const mapped = mapColumns(header, registry, settings.columns);
    const key = settings.key ? headerIndex(header, settings.key) : -1;
    const labelAt = header.findIndex((h) => LABEL_HEADERS.has(normalizeName(h)));
    const label = labelAt >= 0 ? labelAt : key >= 0 ? key : null;
    const found = settings.represents ? await representsOf(file.name) : null;
    return {
      at: read.next,
      label: found?.label ?? null,
      plan: {
        sha256: file.sha256,
        document: file.document,
        name: file.name,
        delimiter,
        columns: mapped.columns,
        left: mapped.left,
        key: key >= 0 ? key : null,
        label,
        represents: found?.iri ?? null,
      } satisfies Plan,
    };
  }

  /** The one instance of the `represents` class whose label is the file's name without its extension; null for none or several. */
  async function representsOf(name: string) {
    const wanted = labelKey(stem(name));
    if (!wanted) return null;
    const cls = `https://littlebigbrain.com/class/${encodeURIComponent(settings.represents!.class.toLowerCase())}`;
    const query = `# rows: represents
SELECT DISTINCT ?s ?label WHERE {
  ?s a <${cls}> ; <${LABEL}> ?label .
  FILTER(REPLACE(REPLACE(LCASE(STR(?label)), "[-_\\\\s]+", " "), "^ | $", "") = ${JSON.stringify(wanted)})
}
LIMIT 2`;
    const { rows } = await lbb.sparql(query, { consistency: "strong" });
    const iris = [...new Set(rows.map((r) => r.s).filter(Boolean))];
    if (iris.length !== 1) return null;
    return { iri: iris[0]!, label: rows[0]!.label ?? stem(name) };
  }

  /** The instance, values and evidence of one row; `blank` for a blank row, `keyless` for a row without its key. */
  function rowFacts(p: Plan, record: CsvRecord) {
    if (isBlank(record)) return "blank" as const;
    const cell = (index: number | null) =>
      index === null ? "" : (record.fields[index] ?? "").trim();
    const key = p.key === null ? `${p.sha256}:${record.row}` : cell(p.key);
    if (!key) return "keyless" as const;
    const name = (cell(p.label) || `${stem(p.name)} row ${record.row}`).slice(0, 200);
    const ref = { type: settings.className, name, key };
    const values: Record<string, string | number | boolean> = {};
    let rejected = 0;
    for (const c of p.columns) {
      const raw = cell(c.index);
      const value = typed(raw, c.type);
      if (value !== null) values[c.property] = value;
      else if (raw) rejected += 1;
    }
    return {
      ref,
      values,
      rejected,
      edge: {
        source: ref,
        relation: READ_FROM,
        target: entityRef(p.document, "Document", p.name),
        confidence: 1,
        evidence: {
          text: record.text.slice(0, EVIDENCE_CHARS),
          source_id: `${p.document}#row=${record.row}`,
        },
      },
    };
  }

  /** The owned write of a part of a turn's rows: each instance's mapped values replaced, and its edge to the file. */
  function partWrite(p: Plan, part: CsvRecord[]) {
    const subjects: Schemas["NamedEntityInput"][] = [];
    const entity_properties: Schemas["EntityPropertiesInput"][] = [];
    const triplets: Schemas["TripletInput"][] = [];
    for (const record of part) {
      const facts = rowFacts(p, record);
      if (typeof facts === "string") continue;
      subjects.push(facts.ref);
      entity_properties.push({ ...facts.ref, properties: facts.values });
      triplets.push(facts.edge);
    }
    return {
      subjects,
      properties: [...new Set(p.columns.map((c) => c.property))],
      entity_properties,
      triplets,
    };
  }
}
