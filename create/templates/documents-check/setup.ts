// Create the pipeline on your graph: the classes and properties, the SHACL
// shapes, `documents.parse` and one `values.extract` per class (LBB-run), and
// the two named workflows of your worker. Each call is safe to repeat.
//
//   LBB_URL=... LBB_API_KEY=... LBB_GRAPH=... npm run setup
import { LbbClient, lbbActivities } from "@littlebigbrain/client";
import { setup } from "./workflow.js";

const graph = process.env.LBB_GRAPH ?? "main";
const client = new LbbClient({
  baseUrl: process.env.LBB_URL ?? "http://127.0.0.1:7400",
  apiKey: process.env.LBB_API_KEY,
  graph,
});
const names = await setup(client, lbbActivities(client));
console.log(`Created ${names.join(", ")} on the graph ${graph}.`);
console.log(`Serve the two named workflows with LBB_GRAPH=${graph} npm start.`);
