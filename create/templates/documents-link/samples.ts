// The samples of documents-link, for `npm run try`: three PDFs of an
// invented school building tender (samples/README.md in the repository
// describes them). LBB's own documents.parse workflow reads their text
// layer; this file uploads them and waits for the parse.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LbbClient } from "@littlebigbrain/client";

/** Upload the sample PDFs to the client's graph and wait until LBB has parsed them. */
export async function loadSamples(client: LbbClient, dir: string): Promise<void> {
  await client.workflows.starters.use({ starter: "documents.parse" });
  const names = (await readdir(dir)).filter((name) => name.endsWith(".pdf")).sort();
  for (const name of names) {
    const bytes = new Uint8Array(await readFile(join(dir, name)));
    await client.files.upload(bytes, { name, contentType: "application/pdf" });
    console.log(`Uploaded ${name}`);
  }
  // Link the documents once all are parsed, so the first turn sees every entry.
  for (let waited = 0; ; waited += 2) {
    const { files } = await client.files.list();
    const parsed = files.filter(
      (file) => names.includes(file.name) && file.parse?.status === "parsed",
    );
    if (parsed.length === names.length) return;
    if (waited >= 180)
      throw new Error(
        "The samples were not parsed within 3 minutes: is documents.parse available?",
      );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
