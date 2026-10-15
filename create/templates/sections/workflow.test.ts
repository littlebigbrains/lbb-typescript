// sections on its samples, without a server: the files and the derivations
// are the mock's (MockContent), the graph is in memory, and the SPARQL reads
// are answered from it. The expected sections come from samples/expected.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MockActivities,
  MockContent,
  contentMessage,
  phases,
  readJson,
  runMessage,
  samplesDir,
  type MemoryGraph,
  type MockFile,
} from "../_shared/testing.js";
import { atxHeading, lineFragment, markdownSections, splitLines } from "./markdown.js";
import {
  PART_OF,
  createWorkflow,
  defaults,
  derivationKey,
  labelKey,
  type SectionsState,
  type Settings,
} from "./workflow.js";

const SAMPLES = samplesDir(import.meta.url, "sections");
const HANDBOOK = readFileSync(join(SAMPLES, "support-handbook.md"));
const GUIDES = readJson<{ name: string }[]>(join(SAMPLES, "guides.json"));
interface ExpectedSection {
  position: number;
  level: number;
  title: string;
  parent: number | null;
  lines: string;
  heading_path?: string;
  text: string | null;
}
const EXPECTED = readJson<Record<string, { sections: ExpectedSection[]; represents: string }>>(
  join(SAMPLES, "expected.json"),
)["support-handbook.md"]!;
const WITH_GUIDES: Settings = { ...defaults, represents: { class: "Guide" } };

/** The SPARQL reads of the workflow, answered from the graph in memory. */
function sparql(query: string, graph: MemoryGraph): Record<string, string>[] {
  if (query.startsWith("# sections: document")) {
    const iri = /VALUES \?doc \{ <([^>]+)> \}/.exec(query)![1]!;
    const doc = graph.entities.get(iri);
    if (!doc) return [];
    const p = doc.properties;
    return [{ name: String(p.name), sha: String(p.file_sha256), type: String(p.content_type) }];
  }
  if (query.startsWith("# sections: represents")) {
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

/** A run of the workflow on a graph with the sample guides. */
function setup(settings: Settings = WITH_GUIDES, guides = GUIDES.map((g) => g.name)) {
  const lbb = new MockActivities({ sparql });
  for (const name of guides) lbb.graph.entity({ type: "Guide", name });
  const content = new MockContent(lbb.graph);
  const definition = createWorkflow(lbb, content, settings);
  const run = (file: MockFile, state: unknown = {}) =>
    runMessage<SectionsState>(definition, contentMessage("sections", file), state);
  return { lbb, content, run };
}

/** The written sections by position. */
function written(graph: MemoryGraph) {
  return graph
    .ofType("Section")
    .sort((a, b) => Number(a.properties.position) - Number(b.properties.position));
}

test("the handbook gives the sections of the answer key, each PART_OF its parent", async () => {
  const { lbb, content, run } = setup();
  const file = content.upload("support-handbook.md", HANDBOOK, "text/markdown");
  const { state, turns } = await run(file);
  const sections = written(lbb.graph);

  assert.equal(turns.length, 1);
  assert.deepEqual(state, { contents: 1, skipped: 0, sections: 8, represents: 1 });
  assert.equal(sections.length, EXPECTED.sections.length);
  const lines = splitLines(new TextDecoder().decode(file.bytes));
  for (const [i, want] of EXPECTED.sections.entries()) {
    const got = sections[i]!;
    assert.equal(got.name, want.title, `section ${want.position}`);
    assert.deepEqual(got.properties, {
      title: want.title,
      level: want.level,
      ...(want.text !== null ? { text: want.text } : {}),
      ...(want.heading_path ? { heading_path: want.heading_path } : {}),
      position: want.position,
    });
    const edge = lbb.graph.edges.find((e) => e.source === got.iri && e.relation === PART_OF)!;
    const parent = want.parent === null ? file.document : sections[want.parent]!.iri;
    assert.equal(edge.target, parent, `the parent of ${want.title}`);
    const evidence = edge.evidence as { text: string; source_id: string };
    assert.equal(evidence.source_id, `${file.document}#${want.lines}`);
    // `line=a,b` is lines a + 1 to b: the first is the heading line, the quote.
    const [from] = want.lines.slice("line=".length).split(",").map(Number);
    assert.equal(evidence.text, lines[from!]!.trim());
  }
  const represents = lbb.graph.edgesOf("REPRESENTS");
  assert.equal(represents.length, 1);
  assert.equal(represents[0]!.source, file.document);
  assert.equal(lbb.graph.entities.get(represents[0]!.target)!.name, EXPECTED.represents);
  const derivation = content.recorded.get(
    `sections@v1/${derivationKey(file.sha256, WITH_GUIDES).settings_digest}/${file.sha256}`,
  );
  assert.deepEqual(derivation?.outputs, {
    sections: 8,
    levels: { 0: 1, 1: 2, 2: 3, 3: 2 },
    represents: represents[0]!.target,
    commits: [1, 2],
  });
});

test("text/plain is read with a .md name and skipped without one", async () => {
  const { lbb, content, run } = setup(defaults);
  const md = content.upload("support-handbook.md", HANDBOOK, "text/plain");
  const txt = content.upload("notes.txt", "# Notes\n\nNot Markdown by its name.\n", "text/plain");
  const one = await run(md);
  const two = await run(txt, one.state);

  assert.deepEqual(two.state, { contents: 1, skipped: 1, sections: 8, represents: 0 });
  assert.equal(lbb.graph.edgesOf("REPRESENTS").length, 0, "the defaults name no class");
  assert.equal(content.recorded.size, 1);
});

test("a file without a heading is one section of level 0 named after the file", async () => {
  const { lbb, content, run } = setup(defaults);
  const file = content.upload(
    "meeting-notes.md",
    "\nWe agreed on the plan.\nNext review in May.\n\n",
    "text/markdown",
  );
  await run(file);
  const [only, ...others] = written(lbb.graph);

  assert.equal(others.length, 0);
  assert.equal(only!.name, "meeting-notes");
  assert.deepEqual(only!.properties, {
    title: "meeting-notes",
    level: 0,
    text: "We agreed on the plan.\nNext review in May.",
    position: 0,
  });
  const edge = lbb.graph.edgesOf(PART_OF)[0]!;
  assert.equal(edge.target, file.document);
  assert.equal((edge.evidence as { source_id: string }).source_id, `${file.document}#line=1,3`);
});

test("an empty file writes no section and records a derivation", async () => {
  const { lbb, content, run } = setup(defaults);
  const file = content.upload("empty.md", "", "text/markdown");
  const { state } = await run(file);

  assert.deepEqual(state, { contents: 1, skipped: 0, sections: 0, represents: 0 });
  assert.equal(lbb.graph.ofType("Section").length, 0);
  assert.equal(([...content.recorded.values()][0]!.outputs as { sections: number }).sections, 0);
});

test("a file of more sections than a turn writes continues in a new turn", async () => {
  const { lbb, content, run } = setup({ ...WITH_GUIDES, sectionsPerTurn: 3 });
  const file = content.upload("support-handbook.md", HANDBOOK, "text/markdown");
  const { state, turns } = await run(file);

  assert.deepEqual(
    turns.map((t) => t.keys),
    [["check", "plan", "represents", "write-0"], ["write-0"], ["write-0", "record"]],
  );
  assert.equal(state.sections, 8);
  assert.equal(written(lbb.graph).length, 8);
  // A section of a later turn still names its parent of an earlier turn.
  const chat = written(lbb.graph).find((s) => s.name === "Chat")!;
  const edge = lbb.graph.edges.find((e) => e.source === chat.iri)!;
  assert.equal(lbb.graph.entities.get(edge.target)!.name, "Response times");
  const outputs = [...content.recorded.values()][0]!.outputs as { commits: number[] };
  assert.equal(outputs.commits.length, 4);
});

test("a content with a derivation for these settings is skipped, under any name", async () => {
  const { lbb, content, run } = setup();
  const file = content.upload("support-handbook.md", HANDBOOK, "text/markdown");
  const first = await run(file);
  const commits = lbb.graph.commits;
  const renamed = content.upload("handbook-copy.md", HANDBOOK, "text/markdown");
  const again = await run(renamed, first.state);

  assert.equal(renamed.sha256, file.sha256);
  assert.deepEqual(again.state, { ...first.state, skipped: 1 });
  assert.equal(lbb.graph.commits, commits);
  assert.equal(content.reads, 1);
  assert.deepEqual(again.turns[0]!.keys, ["check"]);
});

test("REPRESENTS needs exactly one instance whose label is the file's name", async () => {
  const counts: number[] = [];
  for (const guides of [
    ["Billing guide"],
    ["Support handbook"],
    ["Support handbook", "support_handbook"],
  ]) {
    const { lbb, content, run } = setup(WITH_GUIDES, guides);
    const file = content.upload("support-handbook.md", HANDBOOK, "text/markdown");
    await run(file);
    counts.push(lbb.graph.edgesOf("REPRESENTS").length);
    assert.equal(lbb.reviews.size, 0, "nothing is proposed");
  }
  assert.deepEqual(counts, [0, 1, 0]);
});

test("each step reports its phase in the progress convention", async () => {
  const { content, run } = setup();
  const file = content.upload("support-handbook.md", HANDBOOK, "text/markdown");
  const { turns } = await run(file);
  assert.deepEqual(phases(turns), [
    "checking the file",
    "reading sections",
    "writing facts",
    "recording the derivation",
  ]);
});

test("ATX headings: levels 1 to 6, closing hashes, indents, fences and line ends", () => {
  assert.deepEqual(atxHeading("# One"), { level: 1, title: "One" });
  assert.deepEqual(atxHeading("###### Six ######"), { level: 6, title: "Six" });
  assert.deepEqual(atxHeading("   ## Indented 3"), { level: 2, title: "Indented 3" });
  assert.deepEqual(atxHeading("#"), { level: 1, title: "" });
  assert.deepEqual(atxHeading("## C# and F#"), { level: 2, title: "C# and F#" });
  assert.equal(atxHeading("####### Seven"), null);
  assert.equal(atxHeading("    # Code"), null);
  assert.equal(atxHeading("#hashtag"), null);

  const text =
    "﻿# A\r\n~~~\r\n# not\r\n~~~\r\n## B\r\n\r\n### C\r\ntext of C\r\n```\r\n# open fence to the end";
  const sections = markdownSections(text);
  assert.deepEqual(
    sections.map((s) => [s.position, s.level, s.title, s.parent, lineFragment(s)]),
    [
      [1, 1, "A", null, "line=0,4"],
      [2, 2, "B", 1, "line=4,5"],
      [3, 3, "C", 2, "line=6,10"],
    ],
  );
  assert.deepEqual(sections[2]!.headingPath, ["A", "B", "C"]);
  assert.equal(sections[2]!.text, "text of C\n```\n# open fence to the end");
  // RFC 5147: `line=4,5` selects line 5 alone, the heading `## B`.
  assert.equal(splitLines(text)[4], "## B");
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines(""), []);
});
