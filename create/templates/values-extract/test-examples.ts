// Test the workflow on examples before it writes. `npm run test:examples`
// runs it with the real models on chosen instances of your graph, through
// `captureActivities`, which writes nothing: each owned write is checked
// with the commit's dry run and kept, and each review item is kept. Then it
// prints, per input, the values the workflow would write and the values it
// would give a person to review.
//
//   LBB_URL=... LBB_API_KEY=... LBB_GRAPH=... npm run test:examples -- [<iri> …]
//
// Without IRIs it tests the first 6 instances of the class. The model calls
// count in your environment's budget.
import { pathToFileURL } from "node:url";
import {
  LbbClient,
  captureActivities,
  entityIdFromIri,
  lbbActivities,
  type ActivityCaptureResult,
  type LbbActivities,
  type WorkflowTriggerMessage,
} from "@littlebigbrain/client";
import { runMessage } from "../_shared/testing.js";
import { createWorkflow, defaults, type Settings } from "./workflow.js";

/** A value the workflow would write. */
export interface ExampleValue {
  property: string;
  value: string;
  quote?: string;
  support?: number;
}

/** What the workflow would do with one input. */
export interface ExampleResult {
  iri: string;
  /** Values at or above the gate, which it writes. */
  written: ExampleValue[];
  /** Values it gives a person to review: each item's title. */
  review: string[];
  /** Why the server's dry run (or the local check) refused a write. */
  errors: string[];
}

/** The first `limit` instances of the class, and the commit they were read at. */
export async function firstInstances(
  client: LbbClient,
  settings: Settings = defaults,
  limit = 6,
): Promise<{ iris: string[]; seq: number }> {
  const read = await client.sparqlRows({
    query: `SELECT ?s WHERE { ?s a <https://littlebigbrain.com/class/${encodeURIComponent(settings.className.toLowerCase())}> } LIMIT ${limit}`,
  });
  return {
    iris: read.rows.map((row) => row.s!).filter(Boolean),
    seq: read.snapshot?.served_at_seq ?? 0,
  };
}

/** Per input, what the captured writes and review items say. */
export function resultsOf(iris: string[], captured: ActivityCaptureResult): ExampleResult[] {
  return iris.map((iri) => {
    const id = entityIdFromIri(iri);
    const mine = (key: string | null | undefined) => key?.startsWith(`value:${id}:`) ?? false;
    const written: ExampleValue[] = [];
    const errors: string[] = [];
    for (const write of captured.writes) {
      const about = (write.body.triplets ?? []).filter(
        (edge) => edge.relation === "HAS_VALUE_SOURCE" && mine(edge.target.key),
      );
      if (about.length) errors.push(...write.errors);
      for (const edge of about) {
        const source = (write.body.entity_properties ?? []).find(
          (entity) => entity.type === "ValueSource" && entity.key === edge.target.key,
        );
        const properties = (source?.properties ?? {}) as Record<string, unknown>;
        const quote = typeof edge.evidence === "object" ? edge.evidence?.text : undefined;
        written.push({
          property: String(properties.property ?? edge.target.key?.split(":")[2] ?? ""),
          value: String(properties.value ?? ""),
          ...(quote ? { quote } : {}),
          ...(edge.confidence != null ? { support: edge.confidence } : {}),
        });
      }
    }
    const review = captured.reviews
      .filter((item) => item.request.key?.includes(`:value:${id}:`))
      .map((item) => item.request.title);
    return { iri, written, review, errors };
  });
}

/**
 * Run the workflow on `iris` with `activities` captured
 * (`captureActivities`): the models run, and nothing is written. `seq` is
 * the commit the workflow reads the texts at.
 */
export async function testExamples(
  activities: LbbActivities,
  iris: string[],
  options: { settings?: Settings; seq?: number; graph?: string } = {},
): Promise<ExampleResult[]> {
  const settings = options.settings ?? defaults;
  const capture = captureActivities(activities, { workflow: "values-extract" });
  const message: WorkflowTriggerMessage = {
    type: "instances",
    workflow: "values-extract-test",
    graph: options.graph ?? "main",
    as_of_commit_seq: options.seq ?? 0,
    reason: "refresh",
    instances: iris,
    removed: [],
  };
  await runMessage(createWorkflow(capture.activities, settings), message);
  return resultsOf(iris, capture.result());
}

/** The results as lines of text. */
export function report(results: ExampleResult[]): string[] {
  const lines: string[] = [];
  for (const result of results) {
    lines.push(result.iri);
    for (const value of result.written)
      lines.push(
        `  write   ${value.property} = ${value.value}${value.support != null ? ` (support ${value.support.toFixed(2)})` : ""}${value.quote ? ` "${value.quote}"` : ""}`,
      );
    for (const title of result.review) lines.push(`  review  ${title}`);
    if (!result.written.length && !result.review.length) lines.push("  no value");
    for (const error of result.errors) lines.push(`  refused ${error}`);
  }
  return lines;
}

async function main() {
  const graph = process.env.LBB_GRAPH;
  if (!graph) throw new Error("set LBB_GRAPH to the graph to test on");
  const client = new LbbClient({
    baseUrl: process.env.LBB_URL ?? "http://127.0.0.1:7400",
    apiKey: process.env.LBB_API_KEY,
    graph,
  });
  const named = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const first = await firstInstances(client);
  const iris = named.length ? named : first.iris;
  if (!iris.length) throw new Error(`the graph ${graph} has no ${defaults.className} to test`);
  const results = await testExamples(lbbActivities(client), iris, { seq: first.seq, graph });
  for (const line of report(results)) console.log(line);
  console.log("Nothing was written.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
