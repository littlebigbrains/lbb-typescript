// The workflow worker conformance suite (sdk/conformance/workflow-worker) on
// `WorkflowWorker`: each scenario's scripted server exchange, and the
// requests the worker must send. The Python suite runs the same scenarios
// (sdk/python/tests/test_worker_conformance.py); the format is in the
// suite's README.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LbbClient, type FetchLike } from "./client.js";
import {
  captureActivities,
  lbbActivities,
  type ActivityCapture,
  type ActivityCaptureResult,
  type LbbActivities,
  type ReviewItemRequest,
  type ReviewRequest,
} from "./activities.js";
import {
  triggeredWorkflow,
  type OwnedWrite,
  type TriggeredWorkflowTurn,
} from "./triggered-workflow-worker.js";
import {
  workflow,
  WorkflowError,
  WorkflowWait,
  WorkflowWorker,
  type WorkflowContext,
  type WorkflowResult,
  type WorkflowStepContext,
} from "./workflows.js";

type Json = unknown;
type Obj = Record<string, unknown>;

interface Exchange {
  request: {
    method: string;
    path: string;
    query?: Record<string, string>;
    headers?: Record<string, string | null>;
    body?: Json;
    raw?: string;
    same_body_as?: number;
  };
  response?: {
    status?: number;
    body?: Json;
    claim?: Json;
    transport_error?: boolean;
    delay_ms?: number;
  };
}

interface Scenario {
  name: string;
  rule: string;
  workflow: {
    type: "plain" | "triggered";
    name: string;
    version: string;
    initial_state?: Json;
    worker?: { progress_every_ms?: number; execution_reads?: boolean };
  };
  handler?: Obj[];
  on_instances?: Obj[];
  on_fan_in?: Obj[];
  task: Obj;
  runs?: number;
  client_graph?: string;
  capture?: { workflow: string };
  exchanges: Exchange[];
  expect: {
    outcomes: string[];
    ran?: string[];
    effect_ids?: string[];
    settle_ms?: number;
    captured?: Json;
  };
}

function suite(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up++, dir = dirname(dir))
    for (const candidate of [
      join(dir, "conformance", "workflow-worker", "scenarios"),
      join(dir, "sdk", "conformance", "workflow-worker", "scenarios"),
    ])
      if (existsSync(candidate)) return candidate;
  throw new Error("sdk/conformance/workflow-worker/scenarios not found");
}

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function merge(base: Json, overrides: Json): Json {
  if (isObj(base) && isObj(overrides)) {
    const out: Obj = { ...base };
    for (const [key, value] of Object.entries(overrides))
      out[key] = key in base ? merge(base[key], value) : value;
    return out;
  }
  return overrides;
}

function at(value: Json, path: string): Json {
  for (const part of path.split(".").filter(Boolean))
    value = (value as Obj)[part];
  return value;
}

function matches(
  want: Json,
  got: Json,
  arrivedMs: number,
  missing = false,
): boolean {
  if (isObj(want) && "$absent" in want) return missing;
  if (missing) return false;
  if (isObj(want) && "$any" in want) return true;
  if (isObj(want) && "$at_least_now_plus_ms" in want)
    return (
      typeof got === "number" &&
      got >= arrivedMs + (want.$at_least_now_plus_ms as number) - 100
    );
  if (isObj(want))
    return (
      isObj(got) &&
      Object.entries(want).every(([key, item]) =>
        matches(item, got[key], arrivedMs, !(key in got)),
      )
    );
  if (Array.isArray(want))
    return (
      Array.isArray(got) &&
      want.length === got.length &&
      want.every((item, i) => matches(item, got[i], arrivedMs))
    );
  return want === got;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The scripted server: each request must match the next exchange. */
function server(scenario: Scenario) {
  const bodies: Json[] = [];
  const problems: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const arrivedMs = Date.now();
    const url = new URL(input);
    const index = bodies.length;
    // A blob's body is its bytes.
    const sent = init?.body as unknown;
    const raw =
      sent instanceof Uint8Array
        ? new TextDecoder().decode(sent)
        : typeof sent === "string"
          ? sent
          : "";
    let body: Json;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    bodies.push(body);
    const where = `request ${index} (${init?.method} ${url.pathname})`;
    const exchange = scenario.exchanges[index];
    if (!exchange) {
      problems.push(`${where}: no exchange is left for it, body ${raw}`);
      return Response.json(
        { error: { code: "unexpected", message: "unexpected" } },
        { status: 500 },
      );
    }
    const want = exchange.request;
    if (init?.method !== want.method || url.pathname !== want.path)
      problems.push(`${where}: expected ${want.method} ${want.path}`);
    for (const [key, value] of Object.entries(want.query ?? {}))
      if (url.searchParams.get(key) !== value)
        problems.push(
          `${where}: query ${key} is ${url.searchParams.get(key)}, not ${value}`,
        );
    const headers = new Headers(init?.headers ?? {});
    for (const [key, value] of Object.entries(want.headers ?? {}))
      if (headers.get(key) !== value)
        problems.push(
          `${where}: header ${key} is ${headers.get(key)}, not ${value}`,
        );
    if (want.raw !== undefined && raw !== want.raw)
      problems.push(`${where}: body ${raw}, not ${want.raw}`);
    if (want.body !== undefined && !matches(want.body, body, arrivedMs))
      problems.push(
        `${where}: body ${raw} does not match ${JSON.stringify(want.body)}`,
      );
    if (
      want.same_body_as !== undefined &&
      JSON.stringify(body) !== JSON.stringify(bodies[want.same_body_as])
    )
      problems.push(`${where}: body differs from request ${want.same_body_as}`);
    const answer = exchange.response ?? {};
    // A delayed answer ignores the request's abort, as an answer in flight does.
    if (answer.delay_ms) await sleep(answer.delay_ms);
    if (answer.transport_error) throw new TypeError("the connection failed");
    if ("claim" in answer)
      return Response.json({
        task: answer.claim === null ? null : merge(scenario.task, answer.claim),
      });
    return Response.json(answer.body ?? {}, { status: answer.status ?? 200 });
  };
  return { fetch, bodies, problems };
}

/** What a capture kept, in the suite's names. */
function captured(result: ActivityCaptureResult): Json {
  return {
    writes: result.writes.map((write) => ({
      step_key: write.stepKey,
      ...(write.graph ? { graph: write.graph } : {}),
      body: write.body,
      check: write.check,
      errors: write.errors,
      ...(write.report ? { report: write.report } : {}),
    })),
    reviews: result.reviews.map((review) => ({ request: review.request })),
  };
}

/**
 * The scenario's handler program, run with the SDK's context: the
 * activities of the client, or of a capture when the scenario names one.
 */
class Program {
  ran: string[] = [];
  effectIds: string[] = [];
  readonly capture: ActivityCapture | undefined;
  readonly activities: LbbActivities;
  constructor(
    private readonly client: LbbClient,
    capture?: { workflow: string },
  ) {
    this.capture = capture
      ? captureActivities(lbbActivities(client), capture)
      : undefined;
    this.activities = this.capture?.activities ?? lbbActivities(client);
  }

  resolve(value: Json, outputs: Obj, state: Json, message: Json): Json {
    if (isObj(value)) {
      if ("$ref" in value) {
        const [key, ...rest] = String(value.$ref).split(".");
        return at(outputs[key!], rest.join("."));
      }
      if ("$message" in value) return at(message, String(value.$message));
      if ("$state" in value) return at(state, String(value.$state));
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          this.resolve(v, outputs, state, message),
        ]),
      );
    }
    if (Array.isArray(value))
      return value.map((v) => this.resolve(v, outputs, state, message));
    return value;
  }

  async act(ctx: WorkflowContext, step: WorkflowStepContext, action: Obj) {
    if ("heartbeat" in action)
      await step.heartbeat(
        action.heartbeat,
        "checkpoint" in action ? { checkpoint: action.checkpoint } : undefined,
      );
    else if ("progress" in action)
      step.progress(String(action.progress), {
        done: action.done as number,
        ...(action.total !== undefined
          ? { total: action.total as number }
          : {}),
        ...(action.unit !== undefined ? { unit: action.unit as string } : {}),
      });
    else if ("sleep_ms" in action) await sleep(action.sleep_ms as number);
    else if ("block" in action) await new Promise<never>(() => {});
    else if ("raise" in action) {
      const message = String(action.message ?? "raised");
      throw action.raise === "workflow_error"
        ? new WorkflowError(message)
        : new Error(message);
    } else if ("reason" in action) {
      const request = action.reason as {
        prompt: string;
        schema: Record<string, unknown>;
      };
      await this.activities.reason(request, {
        ...(action.effect_id ? { effectId: step.effectId } : {}),
      });
    } else if ("blob_put" in action)
      await this.client.workflows.blobs.put(String(action.blob_put), {
        workflowId: ctx.workflowId,
      });
    else throw new Error(`unknown action ${JSON.stringify(action)}`);
  }

  async run(
    ops: Obj[],
    ctx: WorkflowContext,
    state: Json,
    message: Json,
  ): Promise<WorkflowResult<unknown> | undefined> {
    const outputs: Obj = {};
    const value = (v: Json) => this.resolve(v, outputs, state, message);
    for (const op of ops) {
      if ("step" in op) {
        const key = String(op.step);
        outputs[key] = await ctx.step(
          key,
          async (s) => {
            this.ran.push(key);
            this.effectIds.push(s.effectId);
            for (const action of (op.do as Obj[] | undefined) ?? [])
              await this.act(ctx, s, action);
            return value(op.returns);
          },
          {
            ...(op.kind !== undefined
              ? { kind: op.kind as "step" | "model" | "tool" }
              : {}),
            ...(op.timeout_ms !== undefined
              ? { timeoutMs: op.timeout_ms as number }
              : {}),
            ...(op.heartbeat_timeout_ms !== undefined
              ? { heartbeatTimeoutMs: op.heartbeat_timeout_ms as number }
              : {}),
          },
        );
      } else if ("sleep" in op) {
        await ctx.sleep(String(op.sleep), op.ms as number);
        outputs[String(op.sleep)] = null;
      } else if ("wait_for_signal" in op) {
        outputs[String(op.wait_for_signal)] = await ctx.waitForSignal(
          String(op.wait_for_signal),
          { name: String(op.name), timeoutMs: op.timeout_ms as number },
        );
      } else if ("write_owned" in op) {
        const graph = value(op.graph) as string | undefined;
        outputs[String(op.write_owned)] = await this.activities.writeOwned(
          ctx,
          String(op.write_owned),
          op.write as OwnedWrite,
          graph ? { graph } : {},
        );
      } else if ("requeue" in op) {
        const graph = value(op.graph) as string | undefined;
        outputs[String(op.requeue)] = await this.activities.requeue(
          ctx,
          String(op.requeue),
          op.failed as { instance: string; error?: string }[],
          graph ? { graph } : {},
        );
      } else if ("wait_for_review" in op) {
        outputs[String(op.wait_for_review)] =
          await this.activities.waitForReview(
            ctx,
            String(op.wait_for_review),
            op.request as ReviewItemRequest,
            { timeoutMs: op.timeout_ms as number },
          );
      } else if ("review" in op) {
        outputs[String(op.review)] = await this.activities.review(
          op.request as ReviewRequest,
        );
      } else if ("review_items" in op) {
        outputs[String(op.review_items)] = await this.activities.reviewItems(
          op.keys as string[],
        );
      } else if ("wait" in op) throw new WorkflowWait(op.wait as number);
      else if ("raise" in op) {
        const message = String(op.message ?? "raised");
        throw op.raise === "workflow_error"
          ? new WorkflowError(message)
          : new Error(message);
      } else if ("return" in op) {
        const ret = op.return as Obj;
        return {
          state: value(ret.state),
          ...(ret.result !== undefined ? { result: value(ret.result) } : {}),
        };
      } else if ("continue" in op) {
        const ret = op.continue as Obj;
        return ctx.continue(value(ret.state), value(ret.message));
      } else if ("keep" in op) return undefined;
      else throw new Error(`unknown operation ${JSON.stringify(op)}`);
    }
    throw new Error("the program ends without a return");
  }
}

function definition(scenario: Scenario, program: Program) {
  const spec = scenario.workflow;
  if (spec.type === "plain")
    return workflow<unknown, unknown>({
      name: spec.name,
      version: spec.version,
      initialState: spec.initial_state ?? null,
      async onMessage(ctx, state, message) {
        const result = await program.run(
          scenario.handler!,
          ctx,
          state,
          message,
        );
        assert.ok(result);
        return result;
      },
    });
  // The program's result is a triggered turn; its continuation is checked by
  // the SDK, so its message is typed loosely here.
  const turn = (ops: Obj[], ctx: WorkflowContext, state: Json, message: Json) =>
    program.run(ops, ctx, state, message) as Promise<
      TriggeredWorkflowTurn<unknown> | undefined
    >;
  return triggeredWorkflow<unknown>({
    name: spec.name,
    version: spec.version,
    initialState: spec.initial_state,
    onInstances: (ctx, message, state) =>
      turn(scenario.on_instances!, ctx, state, message),
    ...(scenario.on_fan_in
      ? {
          onFanIn: (ctx: WorkflowContext, message: unknown, state: unknown) =>
            turn(scenario.on_fan_in!, ctx, state, message),
        }
      : {}),
  });
}

async function run(scenario: Scenario) {
  const scripted = server(scenario);
  const client = new LbbClient({
    baseUrl: "http://localhost:7400",
    graph: scenario.client_graph ?? "main",
    maxRetries: 2,
    retryDelayMs: 0,
    fetch: scripted.fetch,
  });
  const program = new Program(client, scenario.capture);
  const options = scenario.workflow.worker ?? {};
  const worker = new WorkflowWorker(client, [definition(scenario, program)], {
    worker: "conformance",
    ...(options.progress_every_ms !== undefined
      ? { progressEveryMs: options.progress_every_ms }
      : {}),
    ...(options.execution_reads !== undefined
      ? { executionReads: options.execution_reads }
      : {}),
  });
  const outcomes: string[] = [];
  for (let i = 0; i < (scenario.runs ?? 1); i++) {
    try {
      outcomes.push((await worker.runOnce()) ? "claimed" : "idle");
    } catch {
      outcomes.push("error");
    }
  }
  const expect = scenario.expect;
  if (expect.settle_ms) await sleep(expect.settle_ms);
  const problems = [...scripted.problems];
  if (scripted.bodies.length < scenario.exchanges.length)
    problems.push(
      `${scenario.exchanges.length - scripted.bodies.length} exchange(s) were not used: the worker sent ${scripted.bodies.length} request(s)`,
    );
  if (JSON.stringify(outcomes) !== JSON.stringify(expect.outcomes))
    problems.push(`outcomes ${outcomes}, not ${expect.outcomes}`);
  if (expect.ran && JSON.stringify(program.ran) !== JSON.stringify(expect.ran))
    problems.push(`ran ${program.ran}, not ${expect.ran}`);
  if (
    expect.effect_ids &&
    JSON.stringify(program.effectIds) !== JSON.stringify(expect.effect_ids)
  )
    problems.push(`effect ids ${program.effectIds}, not ${expect.effect_ids}`);
  if (expect.captured !== undefined) {
    assert.ok(program.capture, "the scenario expects a capture and names none");
    const got = captured(program.capture.result());
    if (!matches(expect.captured, got, 0))
      problems.push(
        `captured ${JSON.stringify(got)} does not match ${JSON.stringify(expect.captured)}`,
      );
  }
  assert.deepEqual(problems, [], `${scenario.name}: ${scenario.rule}`);
}

const dir = suite();
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .sort();

for (const file of files) {
  const scenario = JSON.parse(
    readFileSync(join(dir, file), "utf8"),
  ) as Scenario;
  test(`conformance: ${scenario.name}`, () => run(scenario));
}

test("the conformance suite covers the named rules", () => {
  for (const rule of [
    "replay",
    "lease",
    "fence",
    "wait",
    "fan-in",
    "signal",
    "timeout",
    "review",
    "captured",
  ])
    assert.ok(
      files.some((name) => name.includes(rule)),
      rule,
    );
});
