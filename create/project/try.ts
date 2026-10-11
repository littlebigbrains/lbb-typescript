// Try the workflow on its samples: create a graph (default try-__TEMPLATE__), put the samples on
// it, and create the workflow there. Then serve it with npm start and the same LBB_GRAPH.
//
//   LBB_URL=... LBB_API_KEY=... LBB_GRAPH=try-__TEMPLATE__ npm run try
import { fileURLToPath } from "node:url";
import { LbbClient, LbbError, lbbActivities } from "@littlebigbrain/client";
import { loadSamples } from "./samples.js";
import { ontology, trigger } from "./workflow.js";

const graph = process.env.LBB_GRAPH ?? "try-__TEMPLATE__";
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
await lbbActivities(client).evolve(ontology());
await loadSamples(client, fileURLToPath(new URL("../samples/", import.meta.url)));
const created = await client.workflows.starters.use(trigger());
console.log(`Created ${created.name} on the graph ${graph}: ${created.status.state}.`);
console.log(`Serve it with LBB_GRAPH=${graph} npm start, and follow it with:`);
console.log(
  `  curl "$LBB_URL/v1/workflows/triggered?graph=${graph}&starter=workflow&name=${created.name}" -H "Authorization: Bearer $LBB_API_KEY"`,
);
