// Create the workflow on your graph: add the classes and properties it writes, then create the
// triggered workflow that sends it the instances of the class it watches. Each call is safe to
// repeat.
//
//   LBB_URL=... LBB_API_KEY=... LBB_GRAPH=... npm run setup
import { LbbClient, lbbActivities } from "@littlebigbrain/client";
import { ontology, trigger } from "./workflow.js";

const graph = process.env.LBB_GRAPH ?? "main";
const client = new LbbClient({
  baseUrl: process.env.LBB_URL ?? "http://127.0.0.1:7400",
  apiKey: process.env.LBB_API_KEY,
  graph,
});
await lbbActivities(client).evolve(ontology());
const created = await client.workflows.starters.use(trigger());
console.log(`Created ${created.name} on the graph ${graph}: ${created.status.state}.`);
console.log(`Serve it with LBB_GRAPH=${graph} npm start.`);
