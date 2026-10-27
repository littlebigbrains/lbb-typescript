// The samples of documents-check, for `npm run try`: three invented PDFs, a
// purchase order, a delivery note and an invoice of one purchase
// (samples/*.pdf). The invoice bills more than was delivered, at another price,
// with a total that does not match; `samples/expected.json` lists the three
// differences a correct run finds.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LbbClient } from "@littlebigbrain/client";

/** The sample files, in the order they are uploaded. */
export const SAMPLE_FILES = ["purchase-order.pdf", "delivery-note.pdf", "invoice.pdf"];

/** Upload the sample PDFs to the client's graph. An upload of the same bytes again changes nothing. */
export async function loadSamples(client: LbbClient, dir: string): Promise<void> {
  for (const name of SAMPLE_FILES) {
    const bytes = await readFile(join(dir, name));
    const uploaded = await client.files.upload(bytes, { name, contentType: "application/pdf" });
    console.log(`Uploaded ${name} (${uploaded.created ? "new" : "already there"})`);
  }
}
