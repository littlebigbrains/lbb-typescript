// Serve the workflow: the worker claims the turns of its trigger messages and runs them, one at a
// time. Run more workers for more at once.
//
//   LBB_URL=... LBB_API_KEY=... LBB_GRAPH=... npm start
import { LbbClient, WorkflowWorker, lbbActivities } from "@littlebigbrain/client";
import { createWorkflow } from "./workflow.js";

const graph = process.env.LBB_GRAPH ?? "main";
const client = new LbbClient({
  baseUrl: process.env.LBB_URL ?? "http://127.0.0.1:7400",
  apiKey: process.env.LBB_API_KEY,
  graph,
});
const workflow = createWorkflow(lbbActivities(client));
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
console.log(
  `Serving ${workflow.name}@${workflow.version} for the graph ${graph}. Stop with Ctrl-C.`,
);
await new WorkflowWorker(client, [workflow], {
  worker: process.env.LBB_WORKER_ID ?? `${workflow.name}-1`,
}).run({ signal: stop.signal });
