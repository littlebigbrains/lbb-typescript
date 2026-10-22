// The samples of values-extract, for `npm run try`: six invented product
// data sheets of office furniture and small appliances
// (samples/records.json), committed as instances of the class the settings
// name, each with its text.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LbbClient } from "@littlebigbrain/client";
import { defaults, ontology } from "./workflow.js";

/** Add the class and its properties, then commit the sample records to the client's graph. */
export async function loadSamples(client: LbbClient, dir: string): Promise<void> {
  const records = JSON.parse(await readFile(join(dir, "records.json"), "utf8")) as {
    name: string;
    text: string;
  }[];
  await client.ontology.evolve({ ops: ontology() });
  await client.commit(
    {
      entity_properties: records.map((record) => ({
        type: defaults.className,
        name: record.name,
        properties: { [defaults.textField]: record.text },
      })),
    },
    { idempotencyKey: "values-extract-samples" },
  );
  console.log(`Committed ${records.length} ${defaults.className} records`);
}
