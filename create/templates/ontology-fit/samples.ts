// The samples of ontology-fit, for `npm run try`: the ontology of
// samples/expected.md and five invented site reports (samples/texts.json),
// committed as instances of the class the settings name.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LbbClient, Schemas } from "@littlebigbrain/client";
import { defaults, ontology } from "./workflow.js";

/** The graph before the run: the classes, properties and relations of expected.md. */
export const sampleOntology: Schemas["OntologyEvolveOp"][] = [
  ...ontology(),
  { op: "add_entity_type", name: "Raum" },
  { op: "add_entity_type", name: "Firma" },
  { op: "add_property", name: "datum", value_type: "date_time" },
  { op: "add_property", name: "nummer", value_type: "keyword" },
  { op: "add_property", name: "bezeichnung", value_type: "text" },
  { op: "add_property", name: "gewerk", value_type: "keyword" },
  { op: "add_relation", name: "betrifft_raum", domain: [defaults.className], range: ["Raum"] },
  { op: "add_relation", name: "anwesend", domain: [defaults.className], range: ["Firma"] },
];

/** Set up the sample ontology and commit the sample texts to the client's graph. */
export async function loadSamples(client: LbbClient, dir: string): Promise<void> {
  const texts = JSON.parse(await readFile(join(dir, "texts.json"), "utf8")) as {
    name: string;
    text: string;
  }[];
  await client.ontology.evolve({ ops: sampleOntology });
  await client.commit(
    {
      entity_properties: texts.map((t) => ({
        type: defaults.className,
        name: t.name,
        properties: { [defaults.textField]: t.text },
      })),
    },
    { idempotencyKey: "ontology-fit-samples" },
  );
  console.log(`Committed ${texts.length} ${defaults.className} texts`);
}
