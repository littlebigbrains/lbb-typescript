// Serve the two workflows: the worker claims the turns of `documents-texts` and
// `documents-check` and runs them, one at a time. Run more workers for more at
// once.
//
//   LBB_URL=... LBB_API_KEY=... LBB_GRAPH=... npm start
import { LbbClient, WorkflowWorker, lbbActivities } from "@littlebigbrain/client";
import { checkPorts } from "./check.js";
import { createWorkflows } from "./workflow.js";

const graph = process.env.LBB_GRAPH ?? "main";
const client = new LbbClient({
  baseUrl: process.env.LBB_URL ?? "http://127.0.0.1:7400",
  apiKey: process.env.LBB_API_KEY,
  graph,
});
const workflows = createWorkflows(lbbActivities(client), checkPorts(client));
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
console.log(
  `Serving ${workflows.map((w) => `${w.name}@${w.version}`).join(" and ")} for the graph ${graph}. Stop with Ctrl-C.`,
);
await new WorkflowWorker(client, workflows, {
  worker: process.env.LBB_WORKER_ID ?? "documents-check-1",
}).run({ signal: stop.signal });
