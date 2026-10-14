// Try the workflow on its samples: create a graph (default try-link), put the
// invented CRM on it, and create the workflow there. Then serve it with
// npm start and the same LBB_GRAPH, and grade the run with npm run grade.
//
//   LBB_URL=... LBB_API_KEY=... LBB_GRAPH=try-link npm run try
import { fileURLToPath } from "node:url";
import { LbbClient, LbbError, lbbActivities } from "@littlebigbrain/client";
import { loadSamples } from "./samples.js";
import { setup } from "./workflow.js";

const graph = process.env.LBB_GRAPH ?? "try-link";
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
await loadSamples(client, fileURLToPath(new URL("../samples/", import.meta.url)));
const names = await setup(client, lbbActivities(client));
console.log(`Created ${names.join(", ")} on the graph ${graph}.`);
console.log(`Serve them with LBB_GRAPH=${graph} npm start, then grade the run with:`);
console.log(`  LBB_GRAPH=${graph} npx tsx src/grade-run.ts --gold samples/gold.json`);
