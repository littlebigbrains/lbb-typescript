// rows on its samples, without a server: the files and the derivations are
// the mock's (MockContent), the graph is in memory, and the SPARQL reads are
// answered from it. The expected instances come from samples/expected.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Schemas } from "@littlebigbrain/client";
import {
  Crash,
  MockActivities,
  MockContent,
  contentMessage,
  phases,
  readJson,
  runMessage,
  runTurn,
  samplesDir,
  type MemoryGraph,
  type MockFile,
} from "../_shared/testing.js";
import { csvRecords, normalizeName, readRecords, type ReadRange } from "./csv.js";
import {
  READ_FROM,
  createWorkflow,
  defaults,
  derivationKey,
  labelKey,
  typed,
  type ReadOptions,
  type RowsState,
  type Settings,
} from "./workflow.js";

const SAMPLES = samplesDir(import.meta.url, "rows");
const CUSTOMERS = readFileSync(join(SAMPLES, "q3-customers.csv"));
const ORDERS = readFileSync(join(SAMPLES, "q3-orders.tsv"));
const PROPERTIES = readJson<{ name: string; value_type: string }[]>(
  join(SAMPLES, "properties.json"),
);
const REPORTS = readJson<{ name: string }[]>(join(SAMPLES, "reports.json"));
interface ExpectedFile {
  settings: Partial<Settings>;
  rows: number;
  rows_without_key: number;
  values_left_out: number;
  columns?: string[];
  columns_left_out?: string[];
  represents: string;
  instances: { key: string; name: string; row: number; properties: Record<string, unknown> }[];
}
const EXPECTED = readJson<Record<string, ExpectedFile>>(join(SAMPLES, "expected.json"));

/** The SPARQL reads of the workflow, answered from the graph in memory. */
function sparql(query: string, graph: MemoryGraph): Record<string, string>[] {
  if (query.startsWith("# rows: document")) {
    const iri = /VALUES \?doc \{ <([^>]+)> \}/.exec(query)![1]!;
    const doc = graph.entities.get(iri);
    if (!doc) return [];
    const p = doc.properties;
    return [{ name: String(p.name), sha: String(p.file_sha256), type: String(p.content_type) }];
  }
  if (query.startsWith("# rows: represents")) {
    const cls = decodeURIComponent(
      /<https:\/\/littlebigbrain\.com\/class\/([^>]+)>/.exec(query)![1]!,
    );
    const wanted = JSON.parse(/= ("(?:[^"\\]|\\.)*")\)/.exec(query)![1]!) as string;
    return [...graph.entities.values()]
      .filter((e) => e.type.toLowerCase() === cls && labelKey(e.name) === wanted)
      .map((e) => ({ s: e.iri, label: e.name }))
      .slice(0, 2);
  }
  throw new Error(`unexpected query: ${query.slice(0, 60)}`);
}

const ONTOLOGY = {
  graph: { tenant: "samples", graph: "samples" },
  ontology_version: 1,
  entity_types: [],
  relations: [],
  property_defs: PROPERTIES.map((p) => ({ ...p, required: false })),
} as unknown as Schemas["OntologyView"];

/** A run of the workflow on a graph with the sample reports. */
function setup(
  settings: Settings = defaults,
  reports = REPORTS.map((r) => r.name),
  reading: ReadOptions = {},
) {
  const lbb = new MockActivities({ sparql, ontology: ONTOLOGY });
  for (const name of reports) lbb.graph.entity({ type: "Report", name });
  const content = new MockContent(lbb.graph);
  const definition = createWorkflow(lbb, content, settings, reading);
  const run = (file: MockFile, state: unknown = {}) =>
    runMessage<RowsState>(definition, contentMessage("rows", file), state);
  return { lbb, content, run, definition };
}

const instancesOf = (graph: MemoryGraph, type: string) =>
  graph.ofType(type).sort((a, b) => String(a.name).localeCompare(String(b.name)));

/** The instances, edges and REPRESENTS of a file's run, checked against its answer key. */
function assertMatchesKey(graph: MemoryGraph, file: MockFile, key: ExpectedFile, type: string) {
  const written = graph.ofType(type);
  assert.equal(written.length, key.instances.length, "one instance per data row with a key");
  for (const want of key.instances) {
    const got = written.find((e) => e.name === want.name);
    assert.ok(got, `an instance named ${want.name}`);
    assert.deepEqual(got.properties, want.properties, want.name);
    const edge = graph.edges.find((e) => e.source === got.iri && e.relation === READ_FROM);
    assert.ok(edge, `${want.name} is READ_FROM its file`);
    assert.equal(edge.target, file.document);
    const evidence = edge.evidence as { text: string; source_id: string };
    assert.equal(evidence.source_id, `${file.document}#row=${want.row}`);
    const record = [
      ...csvRecords(new TextDecoder().decode(file.bytes), type === "Order" ? "\t" : ","),
    ].find((r) => r.row === want.row)!;
    assert.equal(evidence.text, record.text, `the evidence of ${want.name} is its row's text`);
  }
  const represents = graph.edgesOf("REPRESENTS");
  assert.equal(represents.length, 1);
  assert.equal(represents[0]!.source, file.document);
  assert.equal(graph.entities.get(represents[0]!.target)!.name, key.represents);
}

test("the customer list gives the instances of the answer key, each READ_FROM its row", async () => {
  const { lbb, content, run } = setup();
  const file = content.upload("q3-customers.csv", CUSTOMERS, "text/csv");
  const { state, turns } = await run(file);
  const key = EXPECTED["q3-customers.csv"]!;

  assertMatchesKey(lbb.graph, file, key, "Customer");
  assert.deepEqual(state, { contents: 1, skipped: 0, rows: 8, instances: 6, represents: 1 });
  assert.equal(turns.length, 1);
  const derivation = content.recorded.get(
    `rows@v1/${derivationKey(file.sha256, defaults).settings_digest}/${file.sha256}`,
  );
  assert.ok(derivation, "the derivation is recorded");
  const outputs = derivation.outputs as Record<string, unknown>;
  assert.equal(outputs.rows, key.rows);
  assert.equal(outputs.rows_without_key, key.rows_without_key);
  assert.equal(outputs.values_left_out, key.values_left_out);
  assert.deepEqual(outputs.columns, key.columns);
  assert.deepEqual(outputs.columns_left_out, key.columns_left_out);
  assert.equal(derivation.run_id, "starter-test-1");
});

test("a TSV order table reads by tabs, with a quoted field and a decimal comma", async () => {
  const settings: Settings = {
    className: "Order",
    key: "Order ID",
    represents: { class: "Report" },
    rowsPerTurn: 5_000,
  };
  const { lbb, content, run } = setup(settings);
  const file = content.upload("q3-orders.tsv", ORDERS, "text/tab-separated-values");
  const { state } = await run(file);

  assertMatchesKey(lbb.graph, file, EXPECTED["q3-orders.tsv"]!, "Order");
  assert.equal(state.instances, 4);
});

test("a file whose name the settings do not match is skipped without a derivation", async () => {
  const { lbb, content, run } = setup();
  const file = content.upload("q3-orders.tsv", ORDERS, "text/tab-separated-values");
  const { state } = await run(file);

  assert.deepEqual(state, { contents: 0, skipped: 1, rows: 0, instances: 0, represents: 0 });
  assert.equal(lbb.graph.commits, 0);
  assert.equal(content.recorded.size, 0);
  assert.equal(content.reads, 0, "the bytes are not read");
});

test("a content with a derivation for these settings is skipped; new settings read it again", async () => {
  const { lbb, content, run } = setup();
  const file = content.upload("q3-customers.csv", CUSTOMERS, "text/csv");
  const first = await run(file);
  const commits = lbb.graph.commits;

  // The same bytes again, and under a second name: one derivation, no new write.
  const again = await run(file, first.state);
  const renamed = content.upload("customers-copy.csv", CUSTOMERS, "text/csv");
  assert.equal(renamed.sha256, file.sha256);
  const twice = await run(renamed, again.state);
  assert.equal(twice.state.skipped, 2);
  assert.equal(twice.state.contents, 1);
  assert.equal(lbb.graph.commits, commits, "a skipped content writes nothing");
  assert.equal(content.reads, 1, "a skipped content is not read");
  assert.equal(content.recorded.size, 1);

  // Other settings are another key: the content is read again.
  const other = setup({ ...defaults, rowsPerTurn: 100 });
  const copy = other.content.upload("q3-customers.csv", CUSTOMERS, "text/csv");
  for (const [k, v] of content.recorded) other.content.recorded.set(k, v);
  await other.run(copy);
  assert.equal(other.content.recorded.size, 2);
  assert.notEqual(
    derivationKey(file.sha256, defaults).settings_digest,
    derivationKey(file.sha256, { ...defaults, rowsPerTurn: 100 }).settings_digest,
  );
});

test("a file of more rows than a turn reads continues where the last turn stopped", async () => {
  const { lbb, content, run } = setup({ ...defaults, rowsPerTurn: 3 });
  const file = content.upload("q3-customers.csv", CUSTOMERS, "text/csv");
  const { state, turns } = await run(file);

  // 8 rows after the header: 3 + 3 + 2.
  assert.equal(turns.length, 3);
  assert.deepEqual(turns[0]!.keys, ["check", "plan", "represents", "rows", "write-0"]);
  assert.deepEqual(turns[1]!.keys, ["rows", "write-0"]);
  assert.deepEqual(turns[2]!.keys, ["rows", "write-0", "record"]);
  assert.deepEqual(state, { contents: 1, skipped: 0, rows: 8, instances: 6, represents: 1 });
  assertMatchesKey(lbb.graph, file, EXPECTED["q3-customers.csv"]!, "Customer");
  assert.equal(content.recorded.size, 1);
  const outputs = [...content.recorded.values()][0]!.outputs as { commits: number[] };
  assert.equal(outputs.commits.length, 4, "the REPRESENTS write and one write per turn");
});

test("a turn writes its rows in parts of at most 400", async () => {
  const lines = ["Customer ID,Email"];
  for (let n = 1; n <= 1_000; n++) lines.push(`C-${n},c${n}@shop.example`);
  const { lbb, content, run } = setup({ ...defaults, match: undefined, represents: undefined });
  const file = content.upload("customers-large.csv", lines.join("\r\n"), "text/csv");
  const { state, turns } = await run(file);

  assert.equal(state.instances, 1_000);
  assert.deepEqual(turns[0]!.keys, [
    "check",
    "plan",
    "rows",
    "write-0",
    "write-1",
    "write-2",
    "record",
  ]);
  assert.equal(lbb.graph.ofType("Customer").length, 1_000);
  const last = lbb.graph.edges.find((e) =>
    (e.evidence as { text: string }).text.startsWith("C-1000,"),
  );
  assert.equal((last!.evidence as { source_id: string }).source_id, `${file.document}#row=1001`);
});

test("a header-only file and an empty file write no instance and record a derivation", async () => {
  const { lbb, content, run } = setup({ ...defaults, match: undefined, represents: undefined });
  const header = content.upload("customers-none.csv", "Customer ID,Email\r\n", "text/csv");
  const empty = content.upload("empty.csv", "", "text/csv");
  const one = await run(header);
  const two = await run(empty, one.state);

  assert.deepEqual(two.state, { contents: 2, skipped: 0, rows: 0, instances: 0, represents: 0 });
  assert.equal(lbb.graph.ofType("Customer").length, 0);
  assert.equal(content.recorded.size, 2);
  for (const derivation of content.recorded.values())
    assert.equal((derivation.outputs as { rows: number }).rows, 0);
});

test("REPRESENTS needs exactly one instance whose label is the file's name", async () => {
  const counts: number[] = [];
  for (const reports of [["Q2 customers"], ["Q3 customers"], ["Q3 customers", "q3_Customers"]]) {
    const { lbb, content, run } = setup(defaults, reports);
    const file = content.upload("q3-customers.csv", CUSTOMERS, "text/csv");
    const { state, turns } = await run(file);
    counts.push(lbb.graph.edgesOf("REPRESENTS").length);
    assert.equal(state.represents, lbb.graph.edgesOf("REPRESENTS").length);
    assert.equal(turns[0]!.keys.includes("represents"), counts.at(-1) === 1);
    assert.equal(lbb.reviews.size, 0, "nothing is proposed");
  }
  assert.deepEqual(counts, [0, 1, 0]);
});

test("without a key column the key is the content and the row; settings columns map by name", async () => {
  const settings: Settings = {
    className: "Customer",
    columns: { "E-Mail": "email", Town: "city", Phone: "phone" },
    rowsPerTurn: 100,
  };
  const { lbb, content, run } = setup(settings);
  const csv = "E-Mail,Town,Phone\nana@shop.example,Faro,+351 1\nbo@shop.example,Bergen,+47 2\n";
  const file = content.upload("contacts.csv", csv, "text/csv");
  await run(file);

  const written = instancesOf(lbb.graph, "Customer");
  assert.equal(written.length, 2);
  assert.deepEqual(
    written.map((e) => e.name),
    ["contacts row 2", "contacts row 3"],
  );
  assert.deepEqual(written[0]!.properties, { email: "ana@shop.example", city: "Faro" });
  const outputs = [...content.recorded.values()][0]!.outputs as Record<string, unknown>;
  assert.deepEqual(outputs.columns, ["E-Mail → email", "Town → city"]);
  assert.deepEqual(outputs.columns_left_out, ["Phone"], "phone is no property of the graph");
  // The key of a row without a key column: the same row reads to the same instance.
  const again = setup(settings);
  const copy = again.content.upload("contacts.csv", csv, "text/csv");
  await again.run(copy);
  assert.ok([...again.lbb.graph.entities.keys()].every((iri) => lbb.graph.entities.has(iri)));
});

test("each step reports its phase in the progress convention", async () => {
  const { content, run } = setup();
  const file = content.upload("q3-customers.csv", CUSTOMERS, "text/csv");
  const { turns } = await run(file);
  assert.deepEqual(phases(turns), [
    "checking the file",
    "reading the header",
    "writing facts",
    "reading rows",
    "recording the derivation",
  ]);
});

test("RFC 4180: quotes, delimiters and line breaks inside quotes, and the row numbers", () => {
  const text =
    '﻿a,b,c\r\n"x, y","say ""hi""","two\r\nlines"\r\n\r\nplain,"",end\rlast,row,"no break"';
  const records = [...csvRecords(text)];
  assert.deepEqual(
    records.map((r) => [r.row, r.fields]),
    [
      [1, ["a", "b", "c"]],
      [2, ["x, y", 'say "hi"', "two\r\nlines"]],
      [3, [""]],
      [4, ["plain", "", "end"]],
      [5, ["last", "row", "no break"]],
    ],
  );
  assert.equal(records[1]!.text, '"x, y","say ""hi""","two\r\nlines"');
  // A turn that starts at a record's offset reads on from there.
  assert.deepEqual(
    [...csvRecords(text, ",", records[3]!.start, 4)].map((r) => r.row),
    [4, 5],
  );
  assert.deepEqual([...csvRecords("")], []);
  assert.deepEqual(
    [...csvRecords('a\tb\n1\t"2\t3"\n', "\t")].map((r) => r.fields),
    [
      ["a", "b"],
      ["1", "2\t3"],
    ],
  );
  // A quote inside an unquoted field stays.
  assert.deepEqual([...csvRecords('5" pipe,x')][0]!.fields, ['5" pipe', "x"]);
});

test("values take their property's type; names compare by letters and digits", () => {
  assert.equal(typed(" 42 ", "i64"), 42);
  assert.equal(typed("4.2", "i64"), null);
  assert.equal(typed("1250,50", "f64"), 1250.5);
  assert.equal(typed("yes", "bool"), true);
  assert.equal(typed("2026-07-03", "date_time"), "2026-07-03T00:00:00Z");
  assert.equal(typed("2026-07-03T10:00:00+02:00", "date_time"), "2026-07-03T08:00:00Z");
  assert.equal(typed("July", "date_time"), null);
  assert.equal(typed("", "text"), null);
  assert.equal(normalizeName("Customer ID"), normalizeName("customer_id"));
  assert.equal(normalizeName("Straße"), "straße");
  assert.equal(labelKey("q3-customers"), labelKey("Q3  customers"));
});

// ---- reading by range ------------------------------------------------------------

/** Settings that read every file and write no REPRESENTS. */
const EVERY_FILE: Settings = { ...defaults, match: undefined, represents: undefined };

/**
 * A customer list of `n` data rows with `eol` after each record: every third
 * name is quoted and holds a comma and letters beyond ASCII, every fifth
 * holds a line break (CRLF) and quotes inside its quotes.
 */
function customerList(n: number, eol = "\r\n"): string {
  const lines = ["Customer ID,Name,City"];
  for (let i = 1; i <= n; i++) {
    const name =
      i % 5 === 0
        ? `"Line ${i}\r\nsecond ""part"""`
        : i % 3 === 0
          ? `"Müller, Jürgen ${i}"`
          : `Ana ${i}`;
    lines.push(`C-${i},${name},Zürich`);
  }
  return lines.join(eol) + eol;
}

/** A read of `bytes` as the server answers a range: fewer at the end, none from the end on. */
const rangeOver =
  (bytes: Uint8Array): ReadRange =>
  async (start, end) =>
    bytes.slice(start, Math.min(end + 1, bytes.length));

/** Each data row of `csv` has its instance, whose edge cites its exact row and text. */
function assertEveryRow(graph: MemoryGraph, file: MockFile, csv: string) {
  const rows = [...csvRecords(csv)].slice(1);
  assert.equal(graph.ofType("Customer").length, rows.length);
  for (const record of rows) {
    const edge = graph.edges.find(
      (e) =>
        (e.evidence as { source_id: string }).source_id === `${file.document}#row=${record.row}`,
    );
    assert.ok(edge, `row ${record.row} has its edge`);
    assert.equal((edge.evidence as { text: string }).text, record.text, `row ${record.row}`);
    const instance = graph.entities.get(edge.source)!;
    assert.equal(instance.name, record.fields[1]!.trim(), `row ${record.row}`);
  }
}

test("a file larger than one window is read once, window by window, with exact row numbers", async () => {
  const csv = customerList(200);
  const { lbb, content, run } = setup(EVERY_FILE, [], { window: 256 });
  const file = content.upload("customers-big.csv", csv, "text/csv");
  assert.ok(file.bytes.length > 256 * 20, "the file holds many windows");
  const { state, turns } = await run(file);

  assert.equal(turns.length, 1);
  assert.equal(state.rows, 200);
  assertEveryRow(lbb.graph, file, csv);
  // The header's window goes on into the rows: each read asks for the next
  // window, and each byte is read once.
  content.ranges.forEach((range, n) =>
    assert.deepEqual(range, { start: n * 256, end: n * 256 + 255 }, `read ${n}`),
  );
  assert.equal(content.bytesRead, file.bytes.length);
});

test("a quoted field and a letter beyond ASCII across a window edge read as one row", async () => {
  // Every window size from 64 to 200 bytes, so window edges fall inside
  // quoted fields, between the bytes of `ü`, and between CR and LF; with the
  // three line breaks, and in turns of 3 records.
  for (const eol of ["\r\n", "\n", "\r"]) {
    const bytes = new TextEncoder().encode(customerList(40, eol));
    const whole = [...csvRecords(bytes)];
    assert.equal(whole.length, 41);
    for (let window = 64; window <= 200; window++) {
      const options = { window, maxRecord: 1 << 20 };
      const read = await readRecords(rangeOver(bytes), ",", 0, 1, 10_000, options);
      assert.deepEqual(read.records, whole, `window ${window}`);
      assert.equal(read.end, true);
      const turns = [];
      let at = 0;
      let row = 1;
      for (let end = false; !end;) {
        const turn = await readRecords(rangeOver(bytes), ",", at, row, 3, options);
        turns.push(...turn.records);
        ({ next: at, row, end } = turn);
      }
      assert.deepEqual(turns, whole, `window ${window} in turns of 3`);
    }
  }

  // The workflow, on a window that ends inside the quoted field of row 6.
  const csv = customerList(12);
  const edge = Buffer.from(csv).indexOf("Line 5") + 3;
  assert.ok(edge > 64);
  const { lbb, content, run } = setup(EVERY_FILE, [], { window: edge });
  const file = content.upload("customers-quoted.csv", csv, "text/csv");
  await run(file);
  assertEveryRow(lbb.graph, file, csv);
  const quoted = lbb.graph.ofType("Customer").find((e) => e.name.startsWith("Line 5"));
  assert.equal(quoted?.name, 'Line 5\r\nsecond "part"');
});

test("a CRLF file whose window ends between CR and LF keeps one row per line", async () => {
  const csv = customerList(30);
  // A window that ends after the CR of the line break that ends row 4.
  const bytes = Buffer.from(csv);
  const cr = bytes.indexOf("\r\nC-4,") + 1;
  const rowEnd = bytes.indexOf("\r\n", cr + 1) + 1;
  const { lbb, content, run } = setup(EVERY_FILE, [], { window: rowEnd });
  const file = content.upload("customers-crlf.csv", csv, "text/csv");
  const { state } = await run(file);
  assert.equal(content.ranges[0]!.end, rowEnd - 1, "the first window ends with the CR");
  assert.equal(bytes[rowEnd - 1], 0x0d);
  assert.equal(state.rows, 30, "no blank row between CR and LF");
  assertEveryRow(lbb.graph, file, csv);
});

test("a turn that continues starts at the byte offset where the last one stopped", async () => {
  const csv = customerList(10);
  const whole = [...csvRecords(csv)];
  const settings = { ...EVERY_FILE, rowsPerTurn: 4 };
  const { lbb, content, definition } = setup(settings, [], { window: 64 });
  const file = content.upload("customers-ten.csv", csv, "text/csv");

  // Turn 1 reads the header and rows 2 to 5, and continues at row 6.
  let message = contentMessage("rows", file);
  const first = await runTurn<RowsState>(definition, {}, message);
  type Continued = typeof message & { cursor: { byte: number; row: number } };
  message = first.result.continuation!.message;
  const cursor = (message as Continued).cursor;
  assert.deepEqual([cursor.byte, cursor.row], [whole[5]!.start, 6]);

  // Turn 2 stops after its rows (a crash) and runs again: each time its
  // first read starts at the cursor's byte, and it writes rows 6 to 9.
  const reads = content.ranges.length;
  const stopped = await runTurn<RowsState>(definition, first.result.state, message, {
    crashAfter: 1,
  }).then(
    () => assert.fail("the turn should stop"),
    (error: unknown) => error,
  );
  assert.ok(stopped instanceof Crash);
  assert.deepEqual(stopped.turn.keys, ["rows"]);
  assert.equal(content.ranges[reads]!.start, cursor.byte);
  const again = content.ranges.length;
  const second = await runTurn<RowsState>(definition, first.result.state, message, {
    saved: stopped.turn,
  });
  assert.deepEqual(second.turn.keys, ["rows", "write-0"]);
  assert.equal(content.ranges[again]!.start, cursor.byte);
  const next = (second.result.continuation!.message as Continued).cursor;
  assert.deepEqual([next.byte, next.row], [whole[9]!.start, 10]);

  // Turn 3 writes rows 10 and 11 and records the derivation.
  const third = await runTurn<RowsState>(
    definition,
    second.result.state,
    second.result.continuation!.message,
  );
  assert.deepEqual(third.turn.keys, ["rows", "write-0", "record"]);
  assert.equal(third.result.continuation, undefined);
  assert.equal(third.result.state.rows, 10);
  assertEveryRow(lbb.graph, file, csv);

  // A cursor without a byte offset (an earlier version of the template)
  // reads the file again from its start.
  const old = { ...message, cursor: { at: 120, row: 6 } } as unknown as typeof message;
  const restarted = await runTurn<RowsState>(definition, {}, old);
  assert.equal(restarted.turn.keys[0], "check");
});

test("a row longer than the longest row stops the read: a quote that never closes", async () => {
  const bytes = new TextEncoder().encode(`a,b\n1,"open${"x".repeat(500)}`);
  await assert.rejects(
    readRecords(rangeOver(bytes), ",", 4, 2, 10, { window: 64, maxRecord: 200 }),
    /row 2 is longer than 200 bytes from byte 4/,
  );
  // Within the limit, the open quote runs to the end of the file, as RFC 4180 parsers read it.
  const read = await readRecords(rangeOver(bytes), ",", 4, 2, 10, { window: 64, maxRecord: 1_000 });
  assert.deepEqual(
    read.records.map((r) => [r.row, r.fields[0], r.fields[1]!.length]),
    [[2, "1", 504]],
  );
});
