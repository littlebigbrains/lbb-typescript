// The samples of rows, for `npm run try`: an invented customer list
// (samples/q3-customers.csv) and order table (samples/q3-orders.tsv), the
// properties their columns fill (samples/properties.json), and three
// reports (samples/reports.json) that the files' names can name.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LbbClient, Schemas } from "@littlebigbrain/client";
import { defaults } from "./workflow.js";

/** The sample files and their media types. */
export const SAMPLE_FILES = [
  { name: "q3-customers.csv", contentType: "text/csv" },
  { name: "q3-orders.tsv", contentType: "text/tab-separated-values" },
];

/** Add the properties and the reports, then upload the sample files to the client's graph. */
export async function loadSamples(client: LbbClient, dir: string): Promise<void> {
  const properties = JSON.parse(await readFile(join(dir, "properties.json"), "utf8")) as {
    name: string;
    value_type: string;
  }[];
  const reports = JSON.parse(await readFile(join(dir, "reports.json"), "utf8")) as {
    name: string;
    text: string;
  }[];
  const reportClass = defaults.represents?.class ?? "Report";
  const ops: Schemas["OntologyEvolveOp"][] = [
    { op: "add_entity_type", name: reportClass },
    { op: "add_property", name: "text", value_type: "text" },
    ...properties.map((p) => ({
      op: "add_property" as const,
      name: p.name,
      value_type: p.value_type,
    })),
  ];
  await client.ontology.evolve({ ops });
  await client.commit(
    {
      entity_properties: reports.map((report) => ({
        type: reportClass,
        name: report.name,
        properties: { text: report.text },
      })),
    },
    { idempotencyKey: "rows-samples" },
  );
  console.log(`Committed ${reports.length} ${reportClass} records`);
  for (const file of SAMPLE_FILES) {
    const bytes = await readFile(join(dir, file.name));
    const uploaded = await client.files.upload(new Uint8Array(bytes), {
      name: file.name,
      contentType: file.contentType,
    });
    console.log(`Uploaded ${file.name} (${uploaded.file.sha256.slice(0, 12)})`);
  }
}
