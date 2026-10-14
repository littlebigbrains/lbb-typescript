// Grade a run of the link workflow against a gold file: link precision at
// the gate and recall, cluster purity and completeness, the review share,
// and identity precision (general linking 9.2). The gold file's format is in
// grade.ts.
//
// A run on a graph of your stack (it reads the mentions with SPARQL and the
// workflow's review items):
//
//   LBB_URL=... LBB_API_KEY=... LBB_GRAPH=... npx tsx src/grade-run.ts --gold <gold.json> [--name link] [--save <run.json>]
//
// A run saved before:
//
//   npx tsx src/grade-run.ts --gold <gold.json> --run <run.json>
import { readFile, writeFile } from "node:fs/promises";
import { LbbClient, lbbActivities, type Schemas } from "@littlebigbrain/client";
import { formatReport, grade, readGraphRun, reviewOfItems, type Gold, type Run } from "./grade.js";

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : args[at + 1];
};
const goldFile = option("gold");
if (!goldFile)
  throw new Error("--gold <file> is required: the gold groups (format lbb.link.gold.v1)");
const gold = JSON.parse(await readFile(goldFile, "utf8")) as Gold;
if (gold.format !== "lbb.link.gold.v1") throw new Error(`${goldFile} is no lbb.link.gold.v1 file`);

let run: Run;
const runFile = option("run");
if (runFile) run = JSON.parse(await readFile(runFile, "utf8")) as Run;
else {
  const graph = process.env.LBB_GRAPH ?? "main";
  const client = new LbbClient({
    baseUrl: process.env.LBB_URL ?? "http://127.0.0.1:7400",
    apiKey: process.env.LBB_API_KEY,
    graph,
  });
  const name = option("name") ?? "link";
  const graphRun = await readGraphRun(lbbActivities(client));
  const list = await client.ontology.suggestions.list({ originId: `starter:${name}`, limit: 500 });
  const items: Schemas["OntologyChangeSuggestion"][] = [];
  for (const summary of list.suggestions)
    items.push(await client.ontology.suggestions.get(summary.suggestion_id));
  if (list.truncated)
    console.log(
      "The graph holds more review items than one read lists (500): the review share and identities count those read.",
    );
  run = { ...graphRun, ...reviewOfItems(items) };
  const save = option("save");
  if (save) await writeFile(save, `${JSON.stringify(run, null, 2)}\n`);
}
console.log(formatReport(grade(gold, run), `link run graded against ${goldFile}`));
