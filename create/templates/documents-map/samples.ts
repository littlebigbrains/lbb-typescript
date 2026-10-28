// The samples of documents-map, for `npm run try`: the three PDFs of the invented school building
// tender of documents-link, and the trace a correct documents-link run writes on them
// (samples/trace.json: the entries, the mentions and their links). LBB's documents.parse reads the
// PDFs, so the questions show the rows of each page. This file then commits the trace, so the map
// runs on known links without a link run first. samples/README.md in the repository describes them.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { entityRef, type LbbClient, type Schemas } from "@littlebigbrain/client";

/** The graph's own ontology before the run: rooms, their equipment, and the sections of the specification. */
export const sampleOntology: Schemas["OntologyEvolveOp"][] = [
  { op: "add_entity_type", name: "Room" },
  { op: "add_entity_type", name: "Equipment" },
  { op: "add_entity_type", name: "SpecSection" },
  { op: "add_relation", name: "HAS_EQUIPMENT", domain: ["Room"], range: ["Equipment"] },
  { op: "add_relation", name: "SPECIFIED_IN", domain: ["Room"], range: ["SpecSection"] },
];

/** The classes, properties and relations of the trace, as documents-link adds them. */
export const traceOntology: Schemas["OntologyEvolveOp"][] = [
  { op: "add_entity_type", name: "Document" },
  { op: "add_entity_type", name: "DocEntry" },
  { op: "add_entity_type", name: "DocMention" },
  ...Object.entries({
    identifier: "keyword",
    context: "text",
    line_id: "keyword",
    span: "keyword",
    kind: "keyword",
    line_text: "text",
    page: "i64",
    x0: "f64",
    y0: "f64",
    x1: "f64",
    y1: "f64",
  }).map(([name, value_type]) => ({ op: "add_property" as const, name, value_type })),
  { op: "add_relation", name: "DEFINED_IN", domain: ["DocEntry"], range: ["Document"] },
  { op: "add_relation", name: "MENTIONED_IN", domain: ["DocMention"], range: ["Document"] },
  { op: "add_relation", name: "REFERS_TO", domain: ["DocMention"], range: ["DocEntry"] },
  { op: "add_relation", name: "SAME_ITEM_AS", domain: ["DocMention"], range: ["DocEntry"] },
];

/** The trace of samples/trace.json. */
export interface SampleTrace {
  documents: { name: string; sha256: string; pages: number }[];
  entries: {
    document: string;
    identifier: string;
    context: string;
    line_id: string;
    page: number;
    box: number[];
  }[];
  mentions: {
    document: string;
    span: string;
    kind: string;
    line_id: string;
    line_text: string;
    page: number;
    box: number[];
    link: { relation: string; document: string; identifier: string; confidence: number } | null;
  }[];
}

const boxOf = (page: number, box: number[]) => ({
  page,
  x0: box[0]!,
  y0: box[1]!,
  x1: box[2]!,
  y1: box[3]!,
});

/**
 * The commit of the trace, as documents-link writes it: each entry `DEFINED_IN` its document, each
 * mention `MENTIONED_IN` its document, and each link with its confidence and its line as evidence.
 * `documents` gives each file name's `Document` IRI and SHA-256.
 */
export function traceCommit(
  trace: SampleTrace,
  documents: Map<string, { iri: string; sha256: string }>,
): Schemas["TripletCommitFile"] {
  const doc = (name: string) => {
    const found = documents.get(name);
    if (!found) throw new Error(`${name} is not uploaded`);
    return { ...found, ref: entityRef(found.iri, "Document", name) };
  };
  const entry = (name: string, identifier: string) => ({
    type: "DocEntry",
    name: identifier,
    key: `entry:${doc(name).sha256}:${identifier}`,
  });
  const mention = (m: SampleTrace["mentions"][number]) => ({
    type: "DocMention",
    name: m.span,
    key: `mention:${doc(m.document).sha256}:${m.line_id}:${m.span}`,
  });
  return {
    entity_properties: [
      ...trace.entries.map((e) => ({
        ...entry(e.document, e.identifier),
        properties: {
          identifier: e.identifier,
          context: e.context,
          line_id: e.line_id,
          ...boxOf(e.page, e.box),
        },
      })),
      ...trace.mentions.map((m) => ({
        ...mention(m),
        properties: {
          span: m.span,
          kind: m.kind,
          line_id: m.line_id,
          line_text: m.line_text,
          ...boxOf(m.page, m.box),
        },
      })),
    ],
    triplets: [
      ...trace.entries.map((e) => ({
        source: entry(e.document, e.identifier),
        relation: "DEFINED_IN",
        target: doc(e.document).ref,
      })),
      ...trace.mentions.map((m) => ({
        source: mention(m),
        relation: "MENTIONED_IN",
        target: doc(m.document).ref,
      })),
      ...trace.mentions.flatMap((m) =>
        m.link
          ? [
              {
                source: mention(m),
                relation: m.link.relation,
                target: entry(m.link.document, m.link.identifier),
                confidence: m.link.confidence,
                evidence: {
                  text: m.line_text,
                  source_id: m.document,
                  region: { ...boxOf(m.page, m.box), confidence: m.link.confidence },
                },
              },
            ]
          : [],
      ),
    ],
  };
}

/** Upload the sample PDFs, wait until LBB has parsed them, then commit the ontology and the trace. */
export async function loadSamples(client: LbbClient, dir: string): Promise<void> {
  await client.workflows.starters.use({ starter: "documents.parse" });
  const names = (await readdir(dir)).filter((name) => name.endsWith(".pdf")).sort();
  for (const name of names) {
    const bytes = new Uint8Array(await readFile(join(dir, name)));
    await client.files.upload(bytes, { name, contentType: "application/pdf" });
    console.log(`Uploaded ${name}`);
  }
  for (let waited = 0; ; waited += 2) {
    const { files } = await client.files.list();
    const parsed = files.flatMap((f) =>
      names.includes(f.name) && f.parse?.status === "parsed" && f.document
        ? [{ name: f.name, iri: f.document, sha256: f.sha256 }]
        : [],
    );
    if (parsed.length === names.length) {
      const documents = new Map(parsed.map((f) => [f.name, { iri: f.iri, sha256: f.sha256 }]));
      const trace = JSON.parse(await readFile(join(dir, "trace.json"), "utf8")) as SampleTrace;
      await client.ontology.evolve({ ops: [...traceOntology, ...sampleOntology] });
      await client.commit(traceCommit(trace, documents), {
        idempotencyKey: "documents-map-samples",
      });
      console.log(
        `Committed the trace: ${trace.entries.length} entries, ${trace.mentions.length} mentions, ${trace.mentions.filter((m) => m.link).length} links`,
      );
      return;
    }
    if (waited >= 180)
      throw new Error(
        "The samples were not parsed within 3 minutes: is documents.parse available?",
      );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
