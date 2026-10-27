// documents-check on its samples, without a server. The parsed pages are the
// ones LBB's parse stores for the sample PDFs (samples/pages), the graph is in
// memory, and the SPARQL reads are answered from it. Two parts of the pipeline
// run in LBB and are stood in for here by plain functions of the graph:
//
// - `values.extract`: `readValues` reads the `label: value` lines of a text, as
//   the mock reasoning model of a local stack does, and converts a quantity to kg;
// - the conformance report: `sampleReport` lists the results that LBB's report
//   gives on the samples, as a fixture. Nothing here evaluates a rule.
//
// The answer key (samples/expected.json) says what a correct run reads and what
// it files. The shapes run in LBB: the lbb-server test `documents_check_shapes`
// runs shapes.ttl on the sample facts and checks the same three results, and
// live.test.ts runs the whole pipeline on a stack.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LbbError,
  type FilePages,
  type LbbClient,
  type ReviewAnsweredMessage,
  type Schemas,
} from "@littlebigbrain/client";
import {
  MockActivities,
  mockId,
  readJson,
  Crash,
  runMessage,
  runTurn,
  samplesDir,
  triggerMessage,
  type MemoryEntity,
  type MemoryGraph,
  type MockRules,
} from "../_shared/testing.js";
import {
  CHECK_NAME,
  OPTIONS,
  candidateOf,
  checkWorkflow,
  createCheckWorkflow,
  foundIn,
  locate,
  placesOf,
  type CheckMessage,
  type CheckPorts,
  type CheckState,
} from "./check.js";
import {
  CLASS_IRI,
  NAMESPACE,
  checkOfShape,
  checks,
  publishRequest,
  shapesTurtle,
  type Doc,
} from "./checks.js";
import { SAMPLE_FILES } from "./samples.js";
import {
  DOCUMENT_CLASS,
  KINDS,
  TEXT_OF,
  SEPARATOR,
  SHA_PROPERTY,
  TEXT_PROPERTY,
  TEXTS_NAME,
  createTextsWorkflow,
  documentText,
  kindOf,
  textsWorkflow,
  type PageOf,
  type TextsState,
} from "./texts.js";
import {
  PROPERTIES,
  defaults,
  createWorkflows,
  foreignShapes,
  ontology,
  setup,
  starters,
  workflows,
} from "./workflow.js";

const SAMPLES = samplesDir(import.meta.url, "documents-check");
const NAMES = ["purchase-order", "delivery-note", "invoice"];

interface KeyRecord {
  name: string;
  class: string;
  values: { property: string; value: string | number; stated?: string; quote: string }[];
}
interface KeyCheck {
  id: string;
  result: "violation" | "conforms";
  focus: string;
  other: string | null;
  quotes?: { record: string; quote: string }[];
}
const KEY = readJson<{
  install: { properties: Record<string, string>; units: Record<string, string> };
  records: KeyRecord[];
  checks: KeyCheck[];
}>(join(SAMPLES, "expected.json"));
const RECORDS = readJson<{ name: string; text: string }[]>(join(SAMPLES, "records.json"));
const PAGES = Object.fromEntries(
  NAMES.map((name) => [name, readJson<FilePages>(join(SAMPLES, "pages", `${name}.json`))]),
);

/** The `Document` IRI of a sample file. */
const documentIri = (name: string) => `https://littlebigbrain.com/e/${mockId(`document:${name}`)}`;

/** A document the graph holds: its `Document`, name, SHA-256 and parse. */
interface FileRow {
  iri: string;
  name: string;
  sha: string;
  status: string;
}
const FILES: FileRow[] = NAMES.map((name) => ({
  iri: documentIri(name),
  name: `${name}.pdf`,
  sha: PAGES[name]!.sha256,
  status: "parsed",
}));

/** A parsed page file whose first line is "MEMO": no kind reads it. */
const MEMO_SHA = "ee".repeat(32);
const MEMO: FilePages = {
  sha256: MEMO_SHA,
  parser: "test",
  page_count: 1,
  from: 0,
  to: 1,
  pages: [
    {
      page: 0,
      width: 595,
      height: 842,
      lines: [
        { id: "p1-l1", text: "MEMO", box: [0.1, 0.1, 0.2, 0.12], words: [] },
        { id: "p1-l2", text: "reference: M-1", box: [0.1, 0.2, 0.3, 0.22], words: [] },
      ],
    },
  ],
} as unknown as FilePages;
const MEMO_FILE: FileRow = {
  iri: documentIri("memo"),
  name: "memo.pdf",
  sha: MEMO_SHA,
  status: "parsed",
};

// ---- values.extract, stood in for -------------------------------------------------

const NUMBERS = new Set(["quantity", "price", "total"]);
/** The divisor that brings a quantity in this unit to kg. */
const TO_KG: Record<string, number> = { kg: 1, g: 1000 };

/**
 * The values of a text, as the mock reasoning model reads them: `label: value`
 * up to the next `|`, with the quote `label: value`. A quantity is converted to kg.
 */
function readValues(text: string, properties: string[]) {
  const out: Record<string, { value: string | number; quote: string }> = {};
  const lower = text.toLowerCase();
  for (const property of properties) {
    const needle = `${property}: `;
    const at = lower.indexOf(needle);
    if (at < 0) continue;
    const start = at + needle.length;
    const rest = text.slice(start);
    const end = rest.search(/[;,\n|]/);
    const raw = (end < 0 ? rest : rest.slice(0, end)).trim();
    const quote = text.slice(at, end < 0 ? text.length : start + end).trim();
    if (!NUMBERS.has(property)) {
      out[property] = { value: raw, quote };
      continue;
    }
    const [, number, unit] = /^([\d.]+)\s*([A-Za-z]*)$/.exec(raw) ?? [];
    assert.ok(number, `a number in ${raw}`);
    const divisor = property === "quantity" ? TO_KG[unit ?? ""] : 1;
    assert.ok(divisor, `a unit of ${property} in ${raw}`);
    out[property] = { value: Number(number) / divisor, quote };
  }
  return out;
}

/** The documents `values.extract` would have written for the instances of `graph`. */
function extracted(graph: MemoryGraph): Doc[] {
  return KINDS.flatMap((kind) =>
    graph.ofType(kind.className).map((entity): Doc => {
      // A file of the samples, or a synthetic one named after the instance.
      const file = FILES.find((f) => entity.name === f.name);
      return {
        iri: entity.iri,
        className: kind.className,
        name: entity.name,
        file: {
          iri: file?.iri ?? documentIri(entity.name),
          sha256: file?.sha ?? mockId(entity.name).repeat(2),
        },
        values: readValues(String(entity.properties[TEXT_PROPERTY]), kind.properties),
      };
    }),
  );
}

// ---- the conformance report, stood in for -----------------------------------------

const result = (shape: string, focus: Doc, value?: string): Schemas["SchemaAuditResult"] => ({
  component: "http://www.w3.org/ns/shacl#SPARQLConstraintComponent",
  focus_node: `<${focus.iri}>`,
  severity: "warning",
  source_node_shape: `<${NAMESPACE}${shape}>`,
  source_shape: `<${NAMESPACE}${shape}>`,
  message: "a message",
  ...(value ? { value } : {}),
});

/** A report of `results`, as LBB gives it. `at` is the commit it covers. */
function reportOf(
  results: Schemas["SchemaAuditResult"][],
  options: { truncated?: boolean; at?: number } = {},
): Schemas["SchemaAuditReport"] {
  return {
    conforms: results.length === 0,
    result_count: results.length,
    results,
    truncated: options.truncated ?? false,
    validated_at_seq: options.at ?? 9,
  };
}

/** The results of the three differences of the samples, as LBB's report lists them (live.test.ts and the lbb-server test check them on the engine). */
function sampleResults(docs: Doc[], without: string[] = []) {
  const [order, note, invoice] = ["PurchaseOrder", "DeliveryNote", "Invoice"].map((className) =>
    docs.find((d) => d.className === className)!,
  );
  const total = `"${invoice!.values.total?.value}"^^<http://www.w3.org/2001/XMLSchema#double>`;
  return [
    result("InvoiceQuantityVsDelivery", invoice!, `<${note!.iri}>`),
    result("InvoicePriceVsOrder", invoice!, `<${order!.iri}>`),
    result("TotalMatchesQuantityTimesPrice", invoice!, total),
  ].filter((r) => !without.some((shape) => r.source_node_shape?.endsWith(`#${shape}>`)));
}

/** The report LBB gives on the samples. */
const sampleReport = (docs: Doc[]) => reportOf(sampleResults(docs));

// ---- the mock server --------------------------------------------------------------

const valuesOf = (query: string) =>
  [...(/VALUES \?(?:doc|document) \{([^}]*)\}/.exec(query)?.[1] ?? "").matchAll(/<([^>]+)>/g)].map(
    (m) => m[1]!,
  );

/** The SPARQL reads of both workflows, answered from the graph in memory. */
function sparql(files: FileRow[], stale = false) {
  return (query: string, graph: MemoryGraph): Record<string, string>[] => {
    if (query.startsWith("# documents-texts: documents")) {
      const wanted = valuesOf(query);
      return files
        .filter((f) => wanted.includes(f.iri))
        .map((f) => ({ doc: f.iri, name: f.name, sha: f.sha, status: f.status }));
    }
    if (query.startsWith("# documents-texts: instances")) {
      // The instances this workflow wrote (they carry `read_sha256`) whose file no Document
      // holds any more, or whose SHA-256 the query lists. An instance of another writer is
      // not selected: it has no `read_sha256`.
      const listed = [
        ...(/VALUES \?sha \{([^}]*)\}/.exec(query)?.[1] ?? "").matchAll(/"([^"]+)"/g),
      ].map((m) => m[1]!);
      return KINDS.flatMap((kind) => graph.ofType(kind.className)).flatMap((entity) => {
        const sha = entity.properties[SHA_PROPERTY];
        if (typeof sha !== "string") return [];
        return !files.some((f) => f.sha === sha) || listed.includes(sha)
          ? [{ instance: entity.iri, class: CLASS_IRI[entity.type]! }]
          : [];
      });
    }
    if (query.startsWith("# documents-check: documents")) {
      const wanted = valuesOf(query);
      return extracted(graph)
        .filter((doc) => wanted.includes(doc.iri))
        .flatMap((doc) =>
          Object.entries(doc.values).flatMap(([property, fact]) => {
            const row = {
              doc: doc.iri,
              class: CLASS_IRI[doc.className]!,
              name: doc.name,
              file: doc.file!.iri,
              sha: doc.file!.sha256,
              property,
              value: String(fact.value),
            };
            // A value that changed keeps its older quote as evidence, at an earlier commit.
            return [
              { ...row, quote: fact.quote!, commit: "9" },
              ...(stale ? [{ ...row, quote: `old ${fact.quote}`, commit: "3" }] : []),
            ];
          }),
        );
    }
    throw new Error(`unexpected query: ${query.slice(0, 60)}`);
  };
}

/** The parsed pages the mock serves. */
const PAGE_FILES = [...Object.values(PAGES), MEMO];

/** The instances of the document classes in the graph. */
const instances = (graph: MemoryGraph) => KINDS.flatMap((kind) => graph.ofType(kind.className));

/** The graph after `documents-texts` has read the samples. */
async function readSamples(files: FileRow[] = FILES.map((f) => ({ ...f })), stale = false) {
  const lbb = new MockActivities({ sparql: sparql(files, stale), pages: PAGE_FILES });
  const texts = createTextsWorkflow(lbb);
  const run = await runMessage<TextsState>(
    texts,
    triggerMessage(
      TEXTS_NAME,
      files.map((f) => f.iri),
    ),
  );
  return { lbb, texts, files, state: run.state, turns: run.turns };
}

/** The ports of the check: the report is a function of the graph, and the open items are the mock's. */
function portsOf(lbb: MockActivities, report: (docs: Doc[]) => Schemas["SchemaAuditReport"]) {
  const withdrawn: { id: string; reason: string }[] = [];
  const ports: CheckPorts = {
    conformance: async () => report(extracted(lbb.graph)),
    openItems: async () =>
      [...lbb.questions.keys()]
        .filter((key) => !withdrawn.some((w) => w.id === `rev_${key}`))
        .map((key) => ({ id: `rev_${key}`, key })),
    withdraw: async (id, reason) => {
      withdrawn.push({ id, reason });
    },
  };
  return { ports, withdrawn };
}

const EMPTY: CheckState = { candidates: 0, filed: 0, withdrawn: 0, skipped: 0, unchecked: 0 };
const documentMessage = () =>
  triggerMessage(CHECK_NAME, [`https://littlebigbrain.com/e/${mockId("vs")}`]);

/**
 * `count` invoices from number `from`, each against its own delivery note, in the
 * graph of `lbb`, and the results of the shape that compares them.
 */
function syntheticDifferences(lbb: MockActivities, count: number, from = 0) {
  const results: Schemas["SchemaAuditResult"][] = [];
  for (let n = from; n < from + count; n++) {
    const note = lbb.graph.entity({ type: "DeliveryNote", name: `dn-${n}.pdf`, key: `dn${n}` });
    note.properties[TEXT_PROPERTY] = `DELIVERY NOTE | reference: DN-${n} | quantity: 8000 g`;
    const invoice = lbb.graph.entity({ type: "Invoice", name: `inv-${n}.pdf`, key: `inv${n}` });
    invoice.properties[TEXT_PROPERTY] =
      `INVOICE | reference: INV-${n} | delivery: DN-${n} | quantity: 10 kg`;
    results.push(result("InvoiceQuantityVsDelivery", { iri: invoice.iri } as Doc, `<${note.iri}>`));
  }
  return results;
}

/** A graph with no sample documents, for the synthetic ones. */
const emptyGraph = (rules: Partial<MockRules> = {}) =>
  new MockActivities({ sparql: sparql(FILES.map((f) => ({ ...f }))), pages: PAGE_FILES, ...rules });

/** The check ran on the samples. */
async function checkSamples(
  options: { stale?: boolean; report?: (docs: Doc[]) => Schemas["SchemaAuditReport"] } = {},
) {
  const read = await readSamples(undefined, options.stale);
  const { ports, withdrawn } = portsOf(read.lbb, options.report ?? sampleReport);
  const check = createCheckWorkflow(read.lbb, ports);
  const run = await runMessage<CheckState>(check, documentMessage(), EMPTY);
  return { ...read, ports, withdrawn, check, run };
}

/** The check id of an item key: `starter:<workflow>:<check id>:<hash>`. */
const checkIdOf = (key: string) => key.split(":")[2]!;
const items = (lbb: MockActivities) => [...lbb.questions.values()];
const normalized = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

// ---- documents-texts -------------------------------------------------------------

test("the sample PDFs are the ones the parsed pages and the records come from", () => {
  for (const name of NAMES) {
    const bytes = readFileSync(join(SAMPLES, `${name}.pdf`));
    assert.equal(
      PAGES[name]!.sha256,
      createHash("sha256").update(bytes).digest("hex"),
      `${name}.pdf changed: run _samples/make-checks.mjs, then make-pages.mjs documents-check`,
    );
  }
  assert.deepEqual(
    SAMPLE_FILES,
    NAMES.map((name) => `${name}.pdf`),
  );
});

test("documents-texts writes the text of each parsed PDF as an instance of its class", async () => {
  const { lbb, state } = await readSamples([...FILES, MEMO_FILE]);
  const expected = {
    "purchase-order.pdf": "PurchaseOrder",
    "delivery-note.pdf": "DeliveryNote",
    "invoice.pdf": "Invoice",
  };
  for (const [file, className] of Object.entries(expected)) {
    const entity = lbb.graph.ofType(className).find((e) => e.name === file) as MemoryEntity;
    const record = RECORDS.find((r) => `${r.name}.pdf` === file)!;
    assert.equal(
      entity.properties[TEXT_PROPERTY],
      record.text,
      `${file}: the text is the record's`,
    );
    const document = FILES.find((f) => f.name === file)!.iri;
    assert.deepEqual(
      lbb.graph
        .edgesOf(TEXT_OF)
        .filter((e) => e.source === entity.iri)
        .map((e) => e.target),
      [document],
    );
  }
  assert.equal(instances(lbb.graph).length, 3, "the memo has no kind: no instance");
  assert.deepEqual(state, { texts: 3, skipped: 1, dropped: 0 });
});

test("a rerun writes the same instances, and a deleted file drops its instance", async () => {
  const { lbb, texts, files } = await readSamples();
  const again = await runMessage<TextsState>(
    texts,
    triggerMessage(
      TEXTS_NAME,
      FILES.map((f) => f.iri),
    ),
  );
  assert.equal(instances(lbb.graph).length, 3, "the same three instances");
  assert.equal(lbb.graph.edgesOf(TEXT_OF).length, 3);
  assert.equal(again.state.texts, 3);
  for (const entity of instances(lbb.graph))
    assert.match(String(entity.properties[SHA_PROPERTY]), /^[0-9a-f]{64}$/, "the file's SHA-256");

  // Deleting the file retracts the Document, and the edges to it with it.
  const note = files.find((f) => f.name === "delivery-note.pdf")!;
  files.splice(files.indexOf(note), 1);
  lbb.graph.edges = lbb.graph.edges.filter((edge) => edge.target !== note.iri);
  const dropped = await runMessage<TextsState>(
    texts,
    triggerMessage(TEXTS_NAME, [], [note.iri]),
    again.state,
  );
  assert.deepEqual(lbb.graph.ofType("DeliveryNote"), [], "the delivery note's instance is gone");
  assert.equal(instances(lbb.graph).length, 2);
  assert.equal(dropped.state.dropped, 1);
});

test("an instance of another writer survives a deleted file and a failed parse", async () => {
  const { lbb, texts, files } = await readSamples();
  // An invoice that an integration wrote: it has no `read_sha256`, and no TEXT_OF edge.
  const foreign = lbb.graph.entity({ type: "Invoice", name: "crm-invoice" });
  foreign.properties.reference = "CRM-7";
  foreign.properties[TEXT_PROPERTY] = "INVOICE | reference: CRM-7";

  // A parse that fails: the invoice file is no longer `parsed`.
  const invoice = files.find((f) => f.name === "invoice.pdf")!;
  invoice.status = "failed";
  const failed = await runMessage<TextsState>(texts, triggerMessage(TEXTS_NAME, [invoice.iri]), {
    texts: 3,
    skipped: 0,
    dropped: 0,
  });
  assert.equal(failed.state.dropped, 1, "the instance read from the failed file is dropped");
  assert.deepEqual(
    lbb.graph.ofType("Invoice").map((e) => e.name),
    ["crm-invoice"],
    "the other writer's invoice is untouched",
  );

  // A deleted file: the sweep selects only what this workflow wrote.
  const order = files.find((f) => f.name === "purchase-order.pdf")!;
  files.splice(files.indexOf(order), 1);
  lbb.graph.edges = lbb.graph.edges.filter((edge) => edge.target !== order.iri);
  await runMessage<TextsState>(texts, triggerMessage(TEXTS_NAME, [], [order.iri]));
  assert.deepEqual(lbb.graph.ofType("PurchaseOrder"), []);
  assert.equal(foreign.properties.reference, "CRM-7");
  assert.ok(lbb.graph.entities.has(foreign.iri), "still there");
});

test("a document that is not parsed yet writes nothing", async () => {
  const lbb = new MockActivities({
    sparql: sparql(FILES.map((f) => ({ ...f, status: "pending" }))),
    pages: PAGE_FILES,
  });
  const run = await runMessage<TextsState>(
    createTextsWorkflow(lbb),
    triggerMessage(
      TEXTS_NAME,
      FILES.map((f) => f.iri),
    ),
  );
  assert.equal(instances(lbb.graph).length, 0);
  assert.equal(run.state.texts, 0);
});

test("the text is the lines of the pages, and the kind is its first line", () => {
  assert.equal(documentText([]), "");
  const page = (...texts: string[]): PageOf => ({
    page: 0,
    lines: texts.map((text) => ({ text, box: [0, 0, 1, 1] })),
  });
  assert.equal(documentText([page("A", "B"), page("C")]), `A${SEPARATOR}B${SEPARATOR}C`);
  assert.equal(kindOf(`INVOICE${SEPARATOR}reference: X`)?.className, "Invoice");
  assert.equal(kindOf(`Delivery Note${SEPARATOR}x`)?.className, "DeliveryNote");
  assert.equal(kindOf(`PURCHASE ORDER`)?.className, "PurchaseOrder");
  assert.equal(
    kindOf(`INVOICE REMINDER${SEPARATOR}x`),
    undefined,
    "the first line is the whole title",
  );
  assert.equal(kindOf(""), undefined);
});

// ---- the answer key --------------------------------------------------------------

test("the answer key holds the values a reader of the texts finds, each with its quote", () => {
  for (const record of KEY.records) {
    const text = RECORDS.find((r) => r.name === record.name)!.text;
    const kind = KINDS.find((k) => k.className === record.class)!;
    const read = readValues(text, kind.properties);
    assert.deepEqual(
      Object.keys(read).sort(),
      record.values.map((v) => v.property).sort(),
      `${record.name}: the same properties`,
    );
    for (const expected of record.values) {
      assert.equal(
        read[expected.property]?.value,
        expected.value,
        `${record.name}.${expected.property}`,
      );
      assert.equal(
        read[expected.property]?.quote,
        expected.quote,
        `${record.name}.${expected.property} quote`,
      );
    }
  }
});

test("the answer key, the properties and the starters agree", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(PROPERTIES).map(([name, p]) => [name, p.type])),
    KEY.install.properties,
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(PROPERTIES).flatMap(([name, p]) => (p.unit ? [[name, p.unit]] : [])),
    ),
    KEY.install.units,
  );
  assert.deepEqual(
    KEY.records.map((r) => r.class),
    KINDS.map((k) => k.className),
  );
  // Every property a kind fills is declared, and the Evals dataset shape is there.
  for (const kind of KINDS) for (const name of kind.properties) assert.ok(PROPERTIES[name], name);
  for (const record of KEY.records) {
    assert.ok(RECORDS.some((r) => r.name === record.name));
    assert.ok(Array.isArray(record.values));
  }
});

// ---- documents-check -------------------------------------------------------------

test("each difference becomes a review item with the quotes of both documents", async () => {
  const { lbb, run } = await checkSamples();
  const violations = KEY.checks.filter((c) => c.result === "violation");
  assert.equal(
    items(lbb).length,
    violations.length,
    "one item per difference, none for the rules that conform",
  );
  assert.deepEqual(run.state, {
    candidates: 3,
    filed: 3,
    withdrawn: 0,
    skipped: 0,
    unchecked: 0,
  });

  for (const expected of violations) {
    const item = items(lbb).find((i) => checkIdOf(i.key!) === expected.id)!;
    assert.ok(item, expected.id);
    assert.equal(item.kind, "choice");
    assert.equal(item.workflow, CHECK_NAME);
    assert.deepEqual(item.question.options, OPTIONS);
    assert.equal(item.question.proposed, "discrepancy");
    assert.equal(item.subject?.type, "Invoice");
    assert.deepEqual(
      item.evidence?.map((e) => e.quote),
      expected.quotes!.map((q) => q.quote),
      `${expected.id}: the quotes, in order`,
    );
    // Each quote names its file and page, and the box of its line.
    item.evidence!.forEach((e, i) => {
      const record = expected.quotes![i]!.record;
      assert.equal(e.source_id, `${documentIri(record)}#page=1`);
      const line = PAGES[record]!.pages[0]!.lines.find((l) =>
        normalized(l.text).includes(e.quote),
      )!;
      assert.deepEqual(
        [e.region?.page, e.region?.x0, e.region?.y0, e.region?.x1, e.region?.y1],
        [0, ...line.box],
        `${expected.id}: the box of "${e.quote}"`,
      );
    });
  }
  assert.deepEqual(
    items(lbb)
      .map((i) => i.title)
      .sort(),
    [
      "Invoice INV-1001 bills 10 kg. Delivery note DN-1001 shows 8 kg.",
      "Invoice INV-1001 has a price of 14.00 EUR. Order PO-1001 has 12.50 EUR.",
      "Invoice INV-1001 totals 139.50 EUR. Quantity times price is 140.00 EUR.",
    ],
  );
  for (const item of items(lbb)) {
    assert.match(item.rationale!, /no payment, approval or compliance decision/);
    assert.ok(item.title.length <= 200);
  }
});

test("a delivery in grams is read in kg, with the quote as the text states it", async () => {
  const { lbb } = await readSamples();
  const note = extracted(lbb.graph).find((d) => d.className === "DeliveryNote")!;
  assert.equal(note.values.quantity?.value, 8);
  assert.equal(note.values.quantity?.quote, "quantity: 8000 g");
  const invoice = extracted(lbb.graph).find((d) => d.className === "Invoice")!;
  assert.equal(invoice.values.quantity?.value, 10, "the invoice bills 10 kg, the note shows 8 kg");
});

test("the same difference is the same item, and the newest quote states the value", async () => {
  const { lbb, check, run } = await checkSamples({ stale: true });
  assert.deepEqual(
    items(lbb)
      .flatMap((i) => i.evidence!.map((e) => e.quote))
      .filter((q) => q.startsWith("old ")),
    [],
    "a quote of an earlier commit is not evidence",
  );
  const keys = [...lbb.questions.keys()].sort();
  const again = await runMessage<CheckState>(check, documentMessage(), run.state);
  assert.deepEqual([...lbb.questions.keys()].sort(), keys, "a rerun files the same keys");
  assert.equal(again.state.filed, 3, "and files nothing: the three items exist");
});

test("a corrected value withdraws the item whose difference is gone, and files the new one", async () => {
  let corrected = false;
  const { lbb, ports, withdrawn, check, run } = await checkSamples({
    report: (docs) => reportOf(sampleResults(docs, corrected ? ["InvoiceQuantityVsDelivery"] : [])),
  });
  const before = [...lbb.questions.keys()];
  // The invoice is corrected to 8 kg: it bills what was delivered, so LBB's report drops that result.
  corrected = true;
  const invoice = lbb.graph.ofType("Invoice")[0]!;
  invoice.properties[TEXT_PROPERTY] = String(invoice.properties[TEXT_PROPERTY]).replace(
    "quantity: 10 kg",
    "quantity: 8 kg",
  );
  const again = await runMessage<CheckState>(check, documentMessage(), run.state);

  const gone = withdrawn.map((w) => w.id.slice("rev_".length));
  assert.deepEqual(
    gone.map(checkIdOf).sort(),
    ["invoice-quantity-vs-delivery", "total-matches-quantity-times-price"],
    "the quantity difference is gone; the total has other quotes now",
  );
  assert.ok(withdrawn.every((w) => /no longer finds/.test(w.reason)));
  const open = (await ports.openItems()).map((i) => i.key);
  assert.deepEqual(open.map(checkIdOf).sort(), [
    "invoice-price-vs-order",
    "total-matches-quantity-times-price",
  ]);
  assert.ok(!open.some((key) => gone.includes(key)));
  assert.ok(lbb.questions.size > before.length, "the changed total is a new item");
  const total = items(lbb).find((i) => i.title.includes("Quantity times price is 112.00"))!;
  assert.deepEqual(
    total.evidence?.map((e) => e.quote),
    ["quantity: 8 kg", "price: 14.00 EUR", "total: 139.50 EUR"],
  );
  assert.equal(again.state.withdrawn, 2);
});

test("an item answered between the list and the withdrawal stays, and the turn goes on", async () => {
  let corrected = false;
  const { lbb, withdrawn, ports, run } = await checkSamples({
    report: (docs) => reportOf(sampleResults(docs, corrected ? ["InvoiceQuantityVsDelivery"] : [])),
  });
  corrected = true;
  const invoice = lbb.graph.ofType("Invoice")[0]!;
  invoice.properties[TEXT_PROPERTY] = String(invoice.properties[TEXT_PROPERTY]).replace(
    "quantity: 10 kg",
    "quantity: 8 kg",
  );
  // The server refuses to withdraw the first item: a person answered it since the list.
  const refused = withdrawn;
  let first = true;
  const answered: CheckPorts = {
    ...ports,
    withdraw: async (id, reason) => {
      if (first) {
        first = false;
        throw new LbbError(409, "{}", { code: "review_answered", message: "answered" });
      }
      refused.push({ id, reason });
    },
  };
  const again = await runMessage<CheckState>(
    createCheckWorkflow(lbb, answered),
    documentMessage(),
    run.state,
  );
  assert.equal(again.state.withdrawn, 1, "one withdrawn, one refused");
  assert.equal(refused.length, 1);
  // A server error is not a refusal: it fails the turn, and the step is tried again.
  const broken: CheckPorts = {
    ...ports,
    withdraw: async () => {
      throw new LbbError(500, "{}", { code: "internal", message: "boom" });
    },
  };
  await assert.rejects(
    runMessage<CheckState>(createCheckWorkflow(lbb, broken), documentMessage(), run.state),
    /boom|internal/,
  );
});

test("a report that does not cover the commit yet is waited for, with durable timers", async () => {
  const read = await readSamples();
  let reads = 0;
  const { ports } = portsOf(read.lbb, (docs) =>
    reportOf(sampleResults(docs), { at: ++reads < 3 ? 5 : 9 }),
  );
  const run = await runMessage<CheckState>(
    createCheckWorkflow(read.lbb, ports),
    documentMessage(), // as_of_commit_seq 7
    EMPTY,
  );
  assert.equal(reads, 3, "two reads behind the commit, one that covers it");
  assert.deepEqual(
    run.turns[0]!.sleeps.map((w) => w.key),
    ["wait-0", "wait-1"],
  );
  assert.deepEqual(
    run.turns[0]!.sleeps.map((w) => w.milliseconds),
    [2_000, 4_000],
  );
  assert.equal(read.lbb.questions.size, 3, "then the items are filed");
});

test("no report yet (429) waits too, and an error that is not a wait is not swallowed", async () => {
  const read = await readSamples();
  let calls = 0;
  const pending: CheckPorts = {
    ...portsOf(read.lbb, sampleReport).ports,
    conformance: async () => {
      if (++calls === 1)
        throw new LbbError(429, "{}", { code: "strong_read_pending", message: "pending" });
      return sampleReport(extracted(read.lbb.graph));
    },
  };
  const run = await runMessage<CheckState>(
    createCheckWorkflow(read.lbb, pending),
    documentMessage(),
    EMPTY,
  );
  assert.equal(run.turns[0]!.sleeps.length, 1);
  assert.equal(read.lbb.questions.size, 3);

  const broken: CheckPorts = {
    ...pending,
    conformance: async () => {
      throw new LbbError(500, "{}", { code: "internal", message: "boom" });
    },
  };
  await assert.rejects(
    runMessage<CheckState>(createCheckWorkflow(read.lbb, broken), documentMessage(), EMPTY),
    /boom|internal/,
  );
});

test("a report that stays behind never fails the turn: new turns wait, up to the cap, then the message ends as not checked", async () => {
  const read = await readSamples();
  let calls = 0;
  const behind: CheckPorts = {
    ...portsOf(read.lbb, sampleReport).ports,
    conformance: async () => {
      calls += 1;
      return reportOf(sampleResults(extracted(read.lbb.graph)), { at: 1 });
    },
  };
  const run = await runMessage<CheckState>(
    createCheckWorkflow(read.lbb, behind),
    documentMessage(), // as_of_commit_seq 7
    EMPTY,
  );
  // 60 s of waits a turn, and 30 minutes at most: 30 turns, none of them failed.
  assert.equal(run.turns.length, 30);
  assert.equal(calls, 30 * 6, "6 reads a turn");
  for (const turn of run.turns) assert.equal(turn.sleeps.length, 5);
  assert.deepEqual(
    run.turns.slice(0, 3).map((turn) => (turn.message as CheckMessage).waited_ms ?? 0),
    [0, 60_000, 120_000],
    "each turn carries the wait so far",
  );
  assert.deepEqual(run.state, { ...EMPTY, unchecked: 1 });
  assert.equal(read.lbb.questions.size, 0, "nothing filed");
});

test("the saved steps of a turn replay to the same result: a retry never repeats a decision", async () => {
  const read = await readSamples();
  let calls = 0;
  const base = portsOf(read.lbb, (docs) => reportOf(sampleResults(docs), { at: 1 })).ports;
  const counting: CheckPorts = {
    ...base,
    conformance: async () => {
      calls += 1;
      return base.conformance();
    },
  };
  const check = createCheckWorkflow(read.lbb, counting);
  const first = await runTurn(check, EMPTY, documentMessage());
  assert.ok(
    first.result.continuation,
    "a report that is behind asks for a new turn: it does not throw",
  );
  const reads = calls;
  // The engine keeps a turn's saved steps for its retries. A "not ready" saved there must lead
  // to the same continuation, not to a throw that repeats for good.
  const replay = await runTurn(check, EMPTY, documentMessage(), { saved: first.turn });
  assert.deepEqual(replay.result, first.result);
  assert.equal(calls, reads, "the saved steps replay: the port is not read again");
});

test("a turn that crashed part-way replays its saved steps and finishes as a clean run does", async () => {
  const clean = await checkSamples();
  const read = await readSamples();
  const check = createCheckWorkflow(read.lbb, portsOf(read.lbb, sampleReport).ports);
  let crashed: Crash | undefined;
  try {
    await runTurn(check, EMPTY, documentMessage(), { crashAfter: 2 }); // after the report and the candidates
  } catch (error) {
    if (!(error instanceof Crash)) throw error;
    crashed = error;
  }
  assert.ok(crashed, "the turn crashed before it filed");
  assert.equal(read.lbb.questions.size, 0);
  const resumed = await runTurn(check, EMPTY, documentMessage(), { saved: crashed.turn });
  assert.deepEqual(resumed.result.state, clean.run.state);
  assert.equal(read.lbb.questions.size, 3);
});

test("a report of 120 differences is filed over several turns, each inside the engine's limits", async () => {
  const lbb = emptyGraph();
  const results = syntheticDifferences(lbb, 120);
  const { ports, withdrawn } = portsOf(lbb, () => reportOf(results));
  // The engine's limits hold in runTurn: 64 steps, 64 KiB a step, 256 KiB a turn.
  const run = await runMessage<CheckState>(
    createCheckWorkflow(lbb, ports),
    documentMessage(),
    EMPTY,
  );
  assert.equal(run.turns.length, 5, "25 items a turn, the rest in a continuation");
  assert.equal(lbb.questions.size, 120);
  assert.deepEqual(run.state, { ...EMPTY, candidates: 120, filed: 120 });
  assert.deepEqual(withdrawn, [], "nothing was open that the report does not list");
  for (const turn of run.turns) {
    assert.ok(turn.keys.length < 20, turn.keys.join(","));
    const bytes = JSON.stringify(turn.outputs[turn.keys.indexOf("candidates")]).length;
    assert.ok(bytes < 56 * 1024, `the candidates step is ${bytes} bytes`);
  }
});

test("a report past the window is filed up to the window, and withdraws nothing", async () => {
  const lbb = emptyGraph();
  const results = syntheticDifferences(lbb, 160);
  const { ports, withdrawn } = portsOf(lbb, () => reportOf(results));
  const run = await runMessage<CheckState>(
    createCheckWorkflow(lbb, ports),
    documentMessage(),
    EMPTY,
  );
  assert.equal(lbb.questions.size, 150, "the window of a turn's report");
  assert.deepEqual(run.state, { ...EMPTY, candidates: 160, filed: 150, skipped: 10 });
  assert.deepEqual(withdrawn, [], "a report that left results out cannot say a difference is gone");
});

test("answered items stay in the report and do not crowd out new differences", async () => {
  const answered = new Set<string>();
  const lbb = emptyGraph({
    reviewAnswer: (request) =>
      answered.has(request.key ?? "") ? { decision: "choose", option: "acceptable" } : undefined,
  });
  const results = syntheticDifferences(lbb, 25);
  let window = 25;
  const { ports } = portsOf(lbb, () => reportOf(results.slice(0, window)));
  const check = createCheckWorkflow(lbb, ports);
  const first = await runMessage<CheckState>(check, documentMessage(), EMPTY);
  assert.equal(lbb.questions.size, 25);
  // A person answers every item "Acceptable". The differences stay in the report.
  for (const key of lbb.questions.keys()) answered.add(key);
  results.push(...syntheticDifferences(lbb, 3, 25));
  window = 28;
  const again = await runMessage<CheckState>(check, documentMessage(), first.state);
  assert.equal(
    lbb.questions.size,
    28,
    "the three new differences are filed, though 25 answered ones come first",
  );
  assert.equal(again.turns.length, 1, "in one turn: the answered ones take no share of it");
  assert.equal(again.state.filed, 28);
});

test("an answer starts the check again and files nothing new", async () => {
  const { lbb, withdrawn, check, run } = await checkSamples();
  const filed = lbb.questions.size;
  const message = {
    type: "review.answered",
    workflow: CHECK_NAME,
    graph: { tenant_id: "acme", graph_id: "samples", branch_id: "main" },
    request_id: "req-1",
    review_item: {
      id: "rev_x",
      kind: "choice",
      answer: { decision: "choose", option: "acceptable" },
    },
  } as unknown as ReviewAnsweredMessage;
  const again = await runMessage<CheckState>(
    check,
    message as unknown as Parameters<typeof runMessage>[1],
    run.state,
  );
  assert.equal(lbb.questions.size, filed, "the same three items");
  assert.deepEqual(withdrawn, [], "no difference is gone");
  assert.equal(again.state.candidates, 3);
});

test("a report that is cut, or a document that cannot be read, withdraws nothing", async () => {
  const first = await checkSamples();
  const cut = (docs: Doc[]) => reportOf(sampleResults(docs), { truncated: true });
  // The same items stay open when the report is only a window of the results.
  const { ports, withdrawn } = portsOf(first.lbb, cut);
  const check = createCheckWorkflow(first.lbb, ports);
  first.lbb.graph.ofType("Invoice")[0]!.properties[TEXT_PROPERTY] = String(
    first.lbb.graph.ofType("Invoice")[0]!.properties[TEXT_PROPERTY],
  ).replace("quantity: 10 kg", "quantity: 8 kg");
  await runMessage<CheckState>(check, documentMessage(), first.run.state);
  assert.deepEqual(withdrawn, [], "a cut report cannot say a difference is gone");

  // A result that names a document the graph does not hold is left out and counted.
  const stray = reportOf([
    result(
      "InvoicePriceVsOrder",
      { iri: "https://littlebigbrain.com/e/missing" } as Doc,
      "<https://littlebigbrain.com/e/other>",
    ),
  ]);
  const read = await readSamples();
  const stray2 = portsOf(read.lbb, () => stray);
  const run = await runMessage<CheckState>(
    createCheckWorkflow(read.lbb, stray2.ports),
    documentMessage(),
    EMPTY,
  );
  assert.equal(read.lbb.questions.size, 0);
  assert.equal(run.state.skipped, 1);
  assert.deepEqual(stray2.withdrawn, []);
});

test("a turn files at most candidatesPerTurn items, and a continuation files the rest", async () => {
  const read = await readSamples();
  const { ports } = portsOf(read.lbb, sampleReport);
  const check = createCheckWorkflow(read.lbb, ports, { candidatesPerTurn: 2 });
  const run = await runMessage<CheckState>(check, documentMessage(), EMPTY);
  assert.equal(run.turns.length, 2, "two items, then the third in a continuation");
  assert.equal((run.turns[1]!.message as CheckMessage).rounds, 1);
  assert.equal(read.lbb.questions.size, 3);
  assert.deepEqual(run.state, { ...EMPTY, candidates: 3, filed: 3 });

  // An answer cannot continue, and it changes no fact: what the cap leaves over is counted as skipped.
  const lone = await readSamples();
  const answered = await runMessage<CheckState>(
    createCheckWorkflow(lone.lbb, portsOf(lone.lbb, sampleReport).ports, { candidatesPerTurn: 2 }),
    {
      type: "review.answered",
      workflow: CHECK_NAME,
      graph: { tenant_id: "acme", graph_id: "samples", branch_id: "main" },
      review_item: { id: "rev_x", kind: "choice", answer: { decision: "choose" } },
    } as unknown as Parameters<typeof runMessage>[1],
    EMPTY,
  );
  assert.equal(lone.lbb.questions.size, 2);
  assert.deepEqual(answered.state, { ...EMPTY, candidates: 3, filed: 2, skipped: 1 });

  assert.throws(() => createCheckWorkflow(read.lbb, ports, { candidatesPerTurn: 0 }), RangeError);
  assert.throws(() => createCheckWorkflow(read.lbb, ports, { candidatesPerTurn: 41 }), RangeError);
});

test("the documents are read at the report's commit, and at the head when that commit is gone", async () => {
  const read = await readSamples();
  const base = read.lbb.rules.sparql!;
  const seen: (number | null | undefined)[] = [];
  let gone = false;
  read.lbb.rules.sparql = (query, graph, request) => {
    if (query.startsWith("# documents-check: documents")) {
      seen.push(request.as_of_commit_seq);
      if (gone && request.as_of_commit_seq !== undefined && request.as_of_commit_seq !== null)
        throw new LbbError(400, "{}", {
          code: "historical_generation_unavailable",
          message: "no longer retained",
        });
    }
    return base(query, graph, request);
  };
  const check = createCheckWorkflow(read.lbb, portsOf(read.lbb, sampleReport).ports);
  const first = await runMessage<CheckState>(check, documentMessage(), EMPTY);
  assert.deepEqual(
    seen,
    [9],
    "the commit the report covers, not the message's (7), and not `strong`",
  );
  gone = true;
  await runMessage<CheckState>(check, documentMessage(), first.state);
  assert.deepEqual(seen, [9, 9, undefined], "a commit that is gone is read at the head");
  assert.equal(read.lbb.questions.size, 3);
});

test("the report is read, its results are those of this template's shapes, and an item needs every quote", async () => {
  const report: Schemas["SchemaAuditReport"] = {
    conforms: false,
    result_count: 3,
    results: [
      { ...result("InvoicePriceVsOrder", { iri: "https://x/e/a" } as Doc, "<https://x/e/b>") },
      {
        ...result("InvoicePriceVsOrder", { iri: "https://x/e/a" } as Doc),
        source_node_shape: "<https://elsewhere#Shape>",
      },
      {
        ...result(
          "TotalMatchesQuantityTimesPrice",
          { iri: "https://x/e/c" } as Doc,
          `"1"^^<http://www.w3.org/2001/XMLSchema#double>`,
        ),
      },
    ],
  };
  assert.deepEqual(foundIn(report), [
    { check: "invoice-price-vs-order", focus: "https://x/e/a", other: "https://x/e/b" },
    { check: "total-matches-quantity-times-price", focus: "https://x/e/c" },
  ]);
  const check = checks.find((c) => c.id === "total-matches-quantity-times-price")!;
  const doc: Doc = {
    iri: "https://x/e/c",
    className: "Invoice",
    name: "i.pdf",
    values: {
      quantity: { value: 1, quote: "quantity: 1 kg" },
      price: { value: 1, quote: "price: 1 EUR" },
      total: { value: 3 },
    },
  };
  assert.equal(
    candidateOf("w", check, doc, undefined, new Map()),
    undefined,
    "the total has no quote",
  );
  doc.values.total = { value: 3, quote: "total: 3 EUR" };
  const candidate = candidateOf("w", check, doc, undefined, new Map())!;
  assert.match(candidate.key, /^starter:w:total-matches-quantity-times-price:[0-9a-f]{24}$/);
  assert.equal(
    candidate.request.evidence?.[0]?.source_id,
    "i.pdf",
    "no file: the evidence names the document",
  );
});

test("a quote is found on its page, with whitespace squashed", () => {
  const pages = PAGES["invoice"]!.pages as unknown as PageOf[];
  const price = locate(pages, "price: 14.00 EUR")!;
  assert.equal(price.page, 0);
  assert.deepEqual(locate(pages, "price:   14.00  EUR"), price);
  assert.equal(locate(pages, "price: 99.00 EUR"), undefined);
  assert.equal(locate(pages, " "), undefined);
  assert.deepEqual(Object.keys(placesOf(pages, ["total: 139.50 EUR", "nope"])), [
    "total: 139.50 EUR",
  ]);
});

// ---- the shapes and the setup ----------------------------------------------------

test("every check has a shape in the Turtle, and every shape a check", () => {
  const declared = [...shapesTurtle.matchAll(/^ex:(\w+) a sh:NodeShape/gm)].map(
    (m) => `${NAMESPACE}${m[1]}`,
  );
  assert.deepEqual(declared.sort(), checks.map((c) => c.shape).sort());
  for (const check of checks) assert.equal(checkOfShape(check.shape), check);
  // Each shape is a SPARQL constraint that returns its focus and the compared value, and only warns.
  assert.equal([...shapesTurtle.matchAll(/sh:select """/g)].length, checks.length);
  assert.equal([...shapesTurtle.matchAll(/SELECT \$this \?value WHERE/g)].length, checks.length);
  assert.equal([...shapesTurtle.matchAll(/sh:severity sh:Warning/g)].length, checks.length);
  assert.equal(
    publishRequest().desired_mode,
    "warn",
    "the shapes report; they never refuse a write",
  );
  // The key lists the rules of checks.ts, and only those.
  assert.deepEqual(
    [...new Set(KEY.checks.map((c) => c.id))].sort(),
    checks.map((c) => c.id).sort(),
  );
  // A class a shape targets is a class of the ontology.
  for (const [, iri] of shapesTurtle.matchAll(/dclass:(\w+)/g))
    assert.ok(
      Object.values(CLASS_IRI).some((c) => c.endsWith(`/${iri}`)),
      iri,
    );
});

test("the ontology declares the classes, the properties with their units, and TEXT_OF", () => {
  const ops = ontology();
  const names = (op: string) =>
    ops.filter((o) => o.op === op).map((o) => (o as { name: string }).name);
  assert.deepEqual(names("add_entity_type"), [
    "Document",
    DOCUMENT_CLASS,
    ...KINDS.map((k) => k.className),
  ]);
  // Each kind is a subclass of the class the check watches.
  assert.deepEqual(
    ops.filter((o) => o.op === "add_super_types"),
    KINDS.map((k) => ({
      op: "add_super_types",
      entity_type: k.className,
      super_types: [DOCUMENT_CLASS],
    })),
  );
  assert.deepEqual(
    names("add_property").sort(),
    [TEXT_PROPERTY, SHA_PROPERTY, ...Object.keys(PROPERTIES)].sort(),
  );
  const quantity = ops.find((o) => o.op === "add_property" && o.name === "quantity") as {
    unit?: string;
    value_type: string;
  };
  assert.deepEqual([quantity.value_type, quantity.unit], ["f64", "kg"]);
  assert.deepEqual(names("add_relation"), [TEXT_OF]);
});

test("the starters are documents.parse and one values.extract per class, below the gate to a person", () => {
  const list = starters();
  assert.deepEqual(
    list.map((s) => s.starter),
    ["documents.parse", "values.extract", "values.extract", "values.extract"],
  );
  const extract = list.slice(1);
  assert.deepEqual(
    extract.map((s) => s.watch),
    KINDS.map((k) => ({ class: k.className, fields: [TEXT_PROPERTY] })),
  );
  assert.deepEqual(
    extract.map((s) => (s.params as { properties: string[] }).properties),
    KINDS.map((k) => k.properties),
  );
  assert.ok(extract.every((s) => s.gate?.below === 0.8));
  assert.equal(new Set(list.map((s) => s.name ?? s.starter)).size, 4, "four distinct names");
});

test("the named workflows watch the documents and the answers", () => {
  const [texts, check] = workflows();
  assert.deepEqual(texts, textsWorkflow());
  assert.deepEqual(check, checkWorkflow());
  assert.deepEqual(texts!.triggers, [
    { id: "documents", watch: { class: "Document", fields: ["parse_status"] } },
  ]);
  assert.deepEqual(check!.triggers, [
    { id: "documents", watch: { class: DOCUMENT_CLASS } },
    { id: "review", review: {} },
  ]);
  assert.equal(check!.shards, 1, "one check at a time: it reads the whole report");
  assert.equal(
    check!.on_exhausted,
    "skip",
    "a turn that failed for good must not hold the only shard",
  );
  assert.deepEqual(
    texts!.owns?.classes,
    KINDS.map((k) => k.className),
  );
  const lbb = new MockActivities();
  const served = createWorkflows(lbb, {} as CheckPorts);
  assert.deepEqual(
    served.map((w) => w.name),
    [texts!.workflow!.workflow_type, check!.workflow!.workflow_type],
  );
});

/** A client that records what setup does, with the graph's shape set `view`. */
function setupClient(view: Partial<Schemas["SchemaBundleView"]>) {
  const calls: string[] = [];
  const client = {
    schema: {
      view: async () => {
        calls.push("view");
        return { shape_count: 0, enforce_mode: "off", shapes: [], ...view };
      },
      publish: async (request: Schemas["SchemaPublishRequest"]) => {
        calls.push(`publish ${request.desired_mode}`);
      },
    },
    workflows: {
      starters: {
        use: async (request: Schemas["TriggeredWorkflowRequest"]) => {
          calls.push(`starter ${request.starter}`);
          return { name: request.name ?? request.starter.replace(".", "-") };
        },
      },
      named: {
        put: async (request: Schemas["NamedWorkflowRequest"]) => {
          calls.push(`named ${request.name}`);
          return { name: request.name };
        },
      },
    },
  } as unknown as LbbClient;
  return { client, calls };
}

const rootShape = (id: string) => ({
  id,
  severity: "warning",
  targets: [{ kind: "class", term: "<https://littlebigbrain.com/class/invoice>" }],
});

test("setup creates the ontology, the shapes, the LBB-run workflows and the named workflows, in that order", async () => {
  const { client, calls } = setupClient({});
  const lbb = new MockActivities();
  const names = await setup(client, lbb);
  assert.equal(lbb.evolved.length, 1);
  assert.deepEqual(calls, [
    "view",
    "publish warn",
    "starter documents.parse",
    "starter values.extract",
    "starter values.extract",
    "starter values.extract",
    `named ${TEXTS_NAME}`,
    `named ${CHECK_NAME}`,
  ]);
  assert.equal(names.length, 6);
});

test("setup does not replace a shape set that is not its own, and keeps the mode of its own", async () => {
  // A graph with shapes of its own: setup stops before it writes anything.
  const foreign = setupClient({
    shape_count: 1,
    enforce_mode: "reject",
    shapes: [
      rootShape("<https://example.org/shapes/Ticket>"),
      { id: "_:b0", severity: "violation" },
    ],
  } as Partial<Schemas["SchemaBundleView"]>);
  const lbb = new MockActivities();
  await assert.rejects(
    setup(foreign.client, lbb),
    /shape set of its own.*Ticket.*Merge shapes\.ttl/s,
  );
  assert.deepEqual(foreign.calls, ["view"], "nothing written");
  assert.equal(lbb.evolved.length, 0);

  // A graph that holds this template's shapes keeps its mode, whatever it is.
  const ours = setupClient({
    shape_count: checks.length,
    enforce_mode: "off",
    shapes: checks.map((check) => rootShape(`<${check.shape}>`)),
  } as Partial<Schemas["SchemaBundleView"]>);
  await setup(ours.client, new MockActivities());
  assert.equal(ours.calls[1], "publish off");

  assert.deepEqual(foreignShapes({ shapes: [] } as unknown as Schemas["SchemaBundleView"]), []);
  assert.equal(publishRequest().desired_mode, "warn");
  assert.equal(publishRequest("reject").desired_mode, "reject");
});

test("setup leaves the shape set alone with publishShapes false: the way on for a merged shape set", async () => {
  // A graph with shapes of its own, which the person merged shapes.ttl into and publishes.
  const own = setupClient({
    shape_count: 1,
    enforce_mode: "reject",
    shapes: [rootShape("<https://example.org/shapes/Ticket>")],
  } as Partial<Schemas["SchemaBundleView"]>);
  const lbb = new MockActivities();
  await setup(own.client, lbb, { ...defaults, publishShapes: false });
  assert.equal(lbb.evolved.length, 1, "the ontology and the workflows are still created");
  assert.ok(!own.calls.includes("view"), "the shape set is not read");
  assert.ok(!own.calls.some((call) => call.startsWith("publish")), "and not written");
  assert.ok(own.calls.includes(`named ${CHECK_NAME}`));
});
