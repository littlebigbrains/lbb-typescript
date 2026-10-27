// Try the pipeline on its samples: create a graph (default try-documents-check),
// create the pipeline there, and upload the three sample PDFs. Then serve the
// two workflows with npm start and the same LBB_GRAPH. The Review inbox of the
// graph shows three candidates, each with the quotes of the documents it
// compares.
//
//   LBB_URL=... LBB_API_KEY=... LBB_GRAPH=try-documents-check npm run try
import { fileURLToPath } from "node:url";
import { LbbClient, LbbError, lbbActivities } from "@littlebigbrain/client";
import { loadSamples } from "./samples.js";
import { setup } from "./workflow.js";

const graph = process.env.LBB_GRAPH ?? "try-documents-check";
const client = new LbbClient({
  baseUrl: process.env.LBB_URL ?? "http://127.0.0.1:7400",
  apiKey: process.env.LBB_API_KEY,
  graph,
});
try {
  await client.graph(graph).create();
  console.log(`Created the graph ${graph}`);
} catch (error) {
  // 409: the graph exists already.
  if (!(error instanceof LbbError && error.status === 409)) throw error;
}
const names = await setup(client, lbbActivities(client));
console.log(`Created ${names.join(", ")} on the graph ${graph}.`);
await loadSamples(client, fileURLToPath(new URL("../samples/", import.meta.url)));
console.log(
  `Serve the two named workflows with LBB_GRAPH=${graph} npm start, then open the Review inbox.`,
);
