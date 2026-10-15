// The samples of sections, for `npm run try`: an invented support handbook
// (samples/support-handbook.md) and two guides (samples/guides.json) that a
// file's name can name.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LbbClient } from "@littlebigbrain/client";

/** The class of the guides; set `represents: { class: GUIDE_CLASS }` to link the handbook to its guide. */
export const GUIDE_CLASS = "Guide";

/** Commit the guides, then upload the sample handbook to the client's graph. */
export async function loadSamples(client: LbbClient, dir: string): Promise<void> {
  const guides = JSON.parse(await readFile(join(dir, "guides.json"), "utf8")) as {
    name: string;
    text: string;
  }[];
  await client.ontology.evolve({
    ops: [
      { op: "add_entity_type", name: GUIDE_CLASS },
      { op: "add_property", name: "text", value_type: "text" },
    ],
  });
  await client.commit(
    {
      entity_properties: guides.map((guide) => ({
        type: GUIDE_CLASS,
        name: guide.name,
        properties: { text: guide.text },
      })),
    },
    { idempotencyKey: "sections-samples" },
  );
  console.log(`Committed ${guides.length} ${GUIDE_CLASS} records`);
  const name = "support-handbook.md";
  const bytes = await readFile(join(dir, name));
  const uploaded = await client.files.upload(new Uint8Array(bytes), {
    name,
    contentType: "text/markdown",
  });
  console.log(`Uploaded ${name} (${uploaded.file.sha256.slice(0, 12)})`);
}
