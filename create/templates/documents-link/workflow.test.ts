// documents-link on its samples, with mock models whose rules are fixed: a
// row that starts with a code and a capitalized word defines the code, every
// code of a line is a mention, a span with a digit is an identifier, and the
// names question picks the candidate with the same identifier key. The
// expected links come from samples/expected.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  ENTITY_IRI_NAMESPACE,
  type DecideAnswer,
  type DecideRequest,
  type FilePages,
  type WorkflowTriggerMessage,
} from "@littlebigbrain/client";
import {
  Crash,
  MockActivities,
  mockId,
  readJson,
  runMessage,
  runTurn,
  samplesDir,
  triggerMessage,
  type MemoryGraph,
  type MockRules,
} from "../_shared/testing.js";
import { createWorkflow, defaults, type Settings } from "./workflow.js";
import * as link from "./link.js";

const SAMPLES = samplesDir(import.meta.url, "documents-link");
const FILES = ["ausstattungsliste", "baubeschreibung", "raumblaetter"];
const PAGES = FILES.map((name) => readJson<FilePages>(join(SAMPLES, "pages", `${name}.json`)));

interface Expected {
  roles: Record<string, string>;
  entries: { file: string; identifier: string; optional?: boolean }[];
  mentions: {
    file: string;
    page: number;
    line_text: string;
    span: string;
    refers_to: { file: string; identifier: string } | null;
  }[];
}
const EXPECTED = readJson<Expected>(join(SAMPLES, "expected.json"));

/** The Document facts of the samples, as the parse writes them. */
interface Doc {
  iri: string;
  name: string;
  sha: string;
  pages: number;
}
const sampleDocs = (pages: FilePages[] = PAGES, names = FILES.map((f) => `${f}.pdf`)): Doc[] =>
  pages.map((p, i) => ({
    iri: ENTITY_IRI_NAMESPACE + mockId(names[i]!),
    name: names[i]!,
    sha: p.sha256,
    pages: p.page_count,
  }));

// ---- the mock models -------------------------------------------------------------

const CODE = /\b[A-Z][A-Za-z]{0,5}[ .]?\d+(?:\.\d+)*\b|\b\d+(?:\.\d+)+\b/g;
const DEFINES = /^(\b[A-Z][A-Za-z]{0,5}[ .]?\d+(?:\.\d+)*|\b\d+(?:\.\d+)+)\s+\p{Lu}/u;

/** The lines of the listing a prompt ends with: `[id] text | [id] text` per row. */
const linesOf = (prompt: string) =>
  prompt
    .slice(prompt.indexOf("\n\n") + 2)
    .split("\n")
    .flatMap((row) => row.split(" | "))
    .map((cell) => cell.match(/^\[([^\]]+)\] (.*)$/)!)
    .map(([, id, text]) => ({ id: id!, text: text! }));

const answer = (choice: string, p: number, options: string[]): DecideAnswer => ({
  choice,
  confidence: p,
  probabilities: Object.fromEntries(
    options.map((o) => [o, o === choice ? p : (1 - p) / (options.length - 1)]),
  ),
});

function decide(request: DecideRequest): Record<string, DecideAnswer> {
  const out: Record<string, DecideAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const span = question.instructions.match(/span "([^"]*)"/)![1]!;
    const options = Object.keys(question.criteria);
    if (id.endsWith("-kind"))
      out[id] = /\d/.test(span)
        ? answer("identifier", 0.9, options)
        : answer("abbreviation", 0.85, options);
    else {
      const identifier = (option: string) =>
        question.criteria[option]!.split("] ")[1]!.split(": ")[0]!;
      const named = (same: (a: string, b: string) => boolean) =>
        options.find((o) => o.startsWith("e") && same(identifier(o), span));
      const exact = named((a, b) => link.identifierKey(a) === link.identifierKey(b));
      const dotless = named(
        (a, b) =>
          link.identifierKey(a).replace(/\./g, "") === link.identifierKey(b).replace(/\./g, ""),
      );
      out[id] = exact
        ? answer(exact, 0.95, options)
        : dotless
          ? answer(dotless, 0.7, options)
          : answer("none_of_these", 0.9, options);
    }
  }
  return out;
}

const VOCABULARY = "abcdefghijklmnopqrstuvwxyz0123456789";
const rules = (docs: Doc[], pages: FilePages[] = PAGES): MockRules => ({
  pages,
  reason: (request) =>
    "definitions" in (request.schema.properties as object)
      ? {
          definitions: linesOf(request.prompt).flatMap(({ id, text }) => {
            const code = text.match(DEFINES)?.[1];
            return code
              ? [{ row_id: id, identifier: code, description: text.slice(code.length).trim() }]
              : [];
          }),
        }
      : {
          mentions: linesOf(request.prompt).flatMap(({ id, text }) =>
            [...text.matchAll(CODE)].map((m) => ({ line_id: id, span: m[0] })),
          ),
        },
  decide,
  embed: (texts) =>
    texts.map((text) =>
      [...VOCABULARY].map((c) => [...text.toLowerCase()].filter((x) => x === c).length + 0.01),
    ),
  sparql: (query, graph) => sparql(query, graph, docs),
});

/** The three queries of the workflow, answered from the fixtures and the graph in memory. */
function sparql(query: string, graph: MemoryGraph, docs: Doc[]): Record<string, string>[] {
  const named = [...query.matchAll(/<(https:\/\/littlebigbrain\.com\/e\/[0-9a-f]+)>/g)].map(
    (m) => m[1]!,
  );
  const byIri = new Map(docs.map((d) => [d.iri, d]));
  if (query.startsWith("# documents-link: documents"))
    return named.flatMap((iri) => {
      const d = byIri.get(iri);
      return d
        ? [{ doc: iri, name: d.name, sha: d.sha, status: "parsed", pages: String(d.pages) }]
        : [];
    });
  const docOf = (iri: string, relation: string) =>
    graph.edges.find((e) => e.source === iri && e.relation === relation)?.target;
  if (query.startsWith("# documents-link: catalogue"))
    return graph.ofType("DocEntry").flatMap((e) => {
      const d = byIri.get(docOf(e.iri, "DEFINED_IN") ?? "");
      if (!d) return [];
      const p = e.properties as Record<string, string>;
      return [
        {
          identifier: p.identifier!,
          context: p.context!,
          line: p.line_id!,
          doc: d.iri,
          name: d.name,
          sha: d.sha,
        },
      ];
    });
  if (query.startsWith("# documents-link: outputs"))
    return [...graph.ofType("DocEntry"), ...graph.ofType("DocMention")].flatMap((e) => {
      const doc = docOf(e.iri, e.type === "DocEntry" ? "DEFINED_IN" : "MENTIONED_IN");
      if (doc && !named.includes(doc)) return [];
      return [{ entity: e.iri, class: `https://littlebigbrain.com/class/${e.type.toLowerCase()}` }];
    });
  throw new Error(`a query the mock does not know: ${query.slice(0, 40)}`);
}

// ---- reading the outcome -----------------------------------------------------------

/** The links of the graph as `file|page|line text|span -> file|identifier`. */
function links(graph: MemoryGraph, docs: Doc[]): string[] {
  const name = (iri: string) => docs.find((d) => d.iri === iri)?.name;
  const target = (iri: string, relation: string) =>
    graph.edges.find((e) => e.source === iri && e.relation === relation)?.target ?? "";
  return graph.edgesOf("REFERS_TO").map((edge) => {
    const mention = graph.entities.get(edge.source)!;
    const entry = graph.entities.get(edge.target)!;
    const m = mention.properties as { page: number; line_text: string; span: string };
    return `${name(target(mention.iri, "MENTIONED_IN"))}|${m.page + 1}|${m.line_text}|${m.span} -> ${name(target(entry.iri, "DEFINED_IN"))}|${entry.properties.identifier}`;
  });
}

const expectedLinks = EXPECTED.mentions
  .filter((m) => m.refers_to)
  .map(
    (m) =>
      `${m.file}|${m.page}|${m.line_text}|${m.span} -> ${m.refers_to!.file}|${m.refers_to!.identifier}`,
  );

const settings = (change: Partial<Settings> = {}): Settings => ({
  ...defaults,
  roles: EXPECTED.roles as Settings["roles"],
  ...change,
});

async function run(change: Partial<Settings> = {}, more: MockRules = {}) {
  const docs = sampleDocs();
  const lbb = new MockActivities({ ...rules(docs), ...more });
  const workflow = createWorkflow(lbb, settings(change));
  const out = await runMessage(
    workflow,
    triggerMessage(
      "documents-link",
      docs.map((d) => d.iri),
    ),
  );
  return { ...out, lbb, docs, workflow };
}

// ---- the tests -------------------------------------------------------------------

test("the samples give the 15 links of the answer key and no other", async () => {
  const { lbb, docs, state, turns } = await run();

  assert.deepEqual(links(lbb.graph, docs).sort(), [...expectedLinks].sort());
  assert.equal(expectedLinks.length, 15);
  assert.equal(lbb.reviews.size, 0, "every link is at or above the gate");
  assert.deepEqual(state, { entries: 15, mentions: 21, links: 15, review: 0 });
  // One turn per window: the two defining files, then the room sheets.
  assert.deepEqual(
    turns.map((t) => (t.message as { cursor?: number }).cursor),
    [undefined, 1, 2],
  );
});

test("the entries are those the answer key lists, each defined in its file", async () => {
  const { lbb, docs } = await run();
  const defined = lbb.graph.ofType("DocEntry").map((e) => {
    const doc = lbb.graph.edges.find(
      (x) => x.source === e.iri && x.relation === "DEFINED_IN",
    )!.target;
    return `${docs.find((d) => d.iri === doc)!.name}|${e.properties.identifier}`;
  });
  const required = EXPECTED.entries
    .filter((e) => !e.optional)
    .map((e) => `${e.file}|${e.identifier}`);
  const optional = EXPECTED.entries
    .filter((e) => e.optional)
    .map((e) => `${e.file}|${e.identifier}`);
  assert.deepEqual(defined.filter((d) => !optional.includes(d)).sort(), required.sort());
  // Every mention is written, with its document, kind and box.
  const mentions = lbb.graph.ofType("DocMention");
  assert.equal(mentions.length, 21);
  for (const m of mentions) {
    assert.equal(m.properties.kind, "identifier");
    assert.ok((m.properties.x0 as number) < (m.properties.x1 as number));
  }
});

test("every model call runs in a step with that step's effect id", async () => {
  const { lbb, turns } = await run();
  const steps = new Set(turns.flatMap((t) => t.keys));
  for (const call of lbb.calls) {
    const [, key] = call.effectId!.split("/");
    assert.ok(steps.has(key!.replace(/\.\d+$/, "")), `${call.effectId} names a step`);
  }
  assert.deepEqual([...new Set(lbb.calls.map((c) => c.kind))].sort(), [
    "decide",
    "embed",
    "reason",
  ]);
});

test("a turn that runs again sends the same requests and gets the kept answers", async () => {
  const docs = sampleDocs();
  const lbb = new MockActivities(rules(docs));
  const workflow = createWorkflow(lbb, settings());
  const message = triggerMessage(
    "documents-link",
    docs.map((d) => d.iri),
  );
  await runMessage(workflow, message);
  const first = lbb.calls.length;
  // The same turns again, their steps lost: every call repeats its request under its effect id.
  await runMessage(workflow, message);
  const again = lbb.calls.slice(first);
  assert.equal(again.length, first);
  assert.ok(
    again.every((c) => c.cached),
    "no request changed, so none conflicts",
  );
  assert.deepEqual(links(lbb.graph, docs).sort(), [...expectedLinks].sort());
});

test("a turn stopped part way resumes from its saved steps", async () => {
  const docs = sampleDocs();
  const lbb = new MockActivities(rules(docs));
  const workflow = createWorkflow(lbb, settings());
  let message: WorkflowTriggerMessage = triggerMessage(
    "documents-link",
    docs.map((d) => d.iri),
  );
  // The two defining windows, then the link window of the room sheets, stopped after 4 steps.
  for (let n = 0; n < 2; n++)
    message = (await runTurn(workflow, {}, message)).result.continuation!.message;
  const stopped = await runTurn(workflow, {}, message, { prefix: "t", crashAfter: 4 }).then(
    () => assert.fail("the turn should stop"),
    (error: unknown) => error,
  );
  assert.ok(stopped instanceof Crash);
  assert.deepEqual(stopped.turn.keys, ["documents", "mention-p1", "mention-p2", "meaning"]);
  const calls = lbb.calls.length;
  const { turn } = await runTurn(workflow, {}, message, { prefix: "t", saved: stopped.turn });

  assert.deepEqual(turn.keys, [
    ...stopped.turn.keys,
    "decide-p1",
    "decide-p2",
    "review",
    "mentions-0",
  ]);
  const again = lbb.calls
    .slice(calls)
    .filter((c) => stopped.turn.keys.some((k) => c.effectId === `t/${k}`));
  assert.deepEqual(again, [], "a saved step does not run again");
  assert.deepEqual(links(lbb.graph, docs).sort(), [...expectedLinks].sort());
});

test("a long document is read in windows over several turns", async () => {
  // 30 pages of room sheets: the two sample pages, alternately.
  const sheets = PAGES[2]!;
  const pages = Array.from({ length: 30 }, (_, n) => {
    const source = sheets.pages[n % 2]!;
    const renumber = (id: string) => id.replace(/^p\d+-/, `p${n + 1}-`);
    return { ...source, page: n, lines: source.lines.map((l) => ({ ...l, id: renumber(l.id) })) };
  });
  const book: FilePages = { ...sheets, sha256: "cd".repeat(32), page_count: 30, to: 30, pages };
  const all = [PAGES[0]!, PAGES[1]!, book];
  const docs = sampleDocs(all, ["ausstattungsliste.pdf", "baubeschreibung.pdf", "raumbuch.pdf"]);
  const lbb = new MockActivities(rules(docs, all));
  const workflow = createWorkflow(
    lbb,
    settings({ roles: { ...EXPECTED.roles, "raumbuch.pdf": "refers" } as Settings["roles"] }),
  );
  const { turns, state } = await runMessage(
    workflow,
    triggerMessage(
      "documents-link",
      docs.map((d) => d.iri),
    ),
  );

  // Two defining windows, then three windows of the book: 12, 12 and 6 pages.
  assert.equal(turns.length, 5);
  assert.deepEqual(
    turns.map((t) => t.keys.length),
    [3, 3, 28, 28, 16],
  );
  assert.equal(state.links, 15 * 8 + 15 * 7);
  assert.equal(lbb.graph.edgesOf("REFERS_TO").length, 225);
});

test("links below the gate go to review instead of the graph", async () => {
  const { lbb, docs, state } = await run({ gate: 0.99 });
  const reviewed = [...lbb.reviews.values()];
  const linked = reviewed.filter((r) => r.key!.includes(":link:"));
  // One item per document, span and entry: S1.1 and S 2.1 are on both room sheets.
  assert.equal(linked.length, 13);
  const facts = linked.flatMap((r) => r.facts!.triplets!);
  assert.equal(facts.length, 15);
  assert.ok(facts.every((t) => t.relation === "REFERS_TO" && (t.confidence ?? 1) < 0.99));
  assert.ok(reviewed.every((r) => r.origin === undefined && r.workflow === "documents-link"));
  assert.equal(reviewed.length, linked.length);
  assert.deepEqual(links(lbb.graph, docs), []);
  assert.deepEqual(state, { entries: 15, mentions: 21, links: 0, review: 15 });
});

test("a refused decide request is split in halves until it is answered", async () => {
  const { lbb, docs } = await run(
    {},
    {
      refuses: (kind, request) =>
        kind === "decide" && Object.keys((request as DecideRequest).questions).length > 4,
    },
  );
  const decides = lbb.calls.filter((c) => c.kind === "decide");
  assert.ok(decides.some((c) => c.refused));
  assert.ok(
    decides.some((c) => /\.0(\.\d)*$/.test(c.effectId!)),
    "each half has its own effect id",
  );
  assert.deepEqual(links(lbb.graph, docs).sort(), [...expectedLinks].sort());
});

test("a document that leaves the graph loses its entries, and the links to them", async () => {
  const { lbb, docs, workflow } = await run();
  const list = docs[0]!;
  await runMessage(workflow, triggerMessage("documents-link", [], [list.iri]));

  const left = links(lbb.graph, docs);
  assert.deepEqual(left.map((l) => l.split(" -> ")[1]).sort(), [
    "baubeschreibung.pdf|3.1",
    "baubeschreibung.pdf|3.2",
  ]);
  assert.equal(lbb.graph.ofType("DocEntry").length, 3);
});

test("a write of more than 900 entities goes in parts", () => {
  const subjects = Array.from({ length: 2000 }, (_, n) => ({
    type: "DocMention",
    name: `m${n}`,
    key: `k${n}`,
  }));
  const write = {
    subjects,
    entity_properties: subjects.map((s) => ({ ...s, properties: { span: s.name } })),
    triplets: subjects.map((s) => ({
      source: s,
      relation: "MENTIONED_IN",
      target: { type: "Document", name: "d" },
    })),
  };
  const parts = [0, 1, 2].map((n) => link.part(write, n));
  assert.deepEqual(
    parts.map((p) => p.subjects.length),
    [900, 900, 200],
  );
  assert.deepEqual(
    parts.map((p) => p.triplets!.length),
    [900, 900, 200],
  );
  assert.equal(parts[2]!.entity_properties![0]!.key, "k1800");
});

test("the link helpers match identifiers, words and confidences as the LBB link stage does", () => {
  assert.equal(link.identifierKey("S.4.1"), "s4.1");
  assert.equal(link.identifierKey("s 4.1"), "s4.1");
  assert.equal(link.identifierKey("Pos.-Nr. 2.4"), "pos.-nr.2.4");
  assert.ok(link.holdsAsWord("RB-Pos. 4.4.2) liegt", "4.4.2"));
  assert.ok(!link.holdsAsWord("RB-Pos. 4.4.2", "4.4"));
  assert.ok(!link.holdsAsWord("S11.1", "1.1"));
  const identifier = {
    choice: "identifier",
    confidence: 0.9,
    probabilities: { identifier: 0.9, value: 0.1 },
  };
  assert.deepEqual(
    link.linkRule(
      link.resolve(identifier, { choice: "e3", confidence: 0.95, probabilities: { e3: 0.95 } }),
    ),
    {
      target: 3,
      confidence: 0.9,
    },
  );
  const line = PAGES[2]!.pages[0]!.lines.find((l) => l.text.endsWith("Kap. 3.1"))!;
  assert.deepEqual(
    link.spanBox(line, "3.1"),
    line.words.at(-1)!.box,
    "the box of the span's own word",
  );
  const value = {
    choice: "value",
    confidence: 0.8,
    probabilities: { value: 0.8, identifier: 0.15 },
  };
  assert.equal(link.linkRule(link.resolve(value, { choice: "e3", confidence: 0.95 })).target, null);
});
