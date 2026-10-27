import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, LbbError, type FetchLike, type Schemas } from "./client.js";
import {
  captureActivities,
  isActivityRefused,
  lbbActivities,
  splitInHalves,
} from "./activities.js";
import { workflow, WorkflowWorker, type WorkflowContext } from "./workflows.js";

interface Seen {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

type Answer = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

/** A fetch that answers each request with the next answer and keeps the requests. */
function fakeFetch(answers: Answer[]) {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    seen.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.search,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
      headers: init?.headers ?? {},
    });
    const answer = answers.shift() ?? { body: {} };
    const status = answer.status ?? 200;
    const headers = { "content-type": "application/json", ...answer.headers };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) =>
          headers[name.toLowerCase() as keyof typeof headers] ?? null,
      },
      text: async () => JSON.stringify(answer.body ?? {}),
    };
  };
  return { fetch, seen };
}

function activities(answers: Answer[]) {
  const { fetch, seen } = fakeFetch(answers);
  const client = new LbbClient({
    baseUrl: "http://h",
    graph: "tender",
    fetch,
    retryDelayMs: 0,
    maxRetries: 2,
  });
  return { lbb: lbbActivities(client), seen };
}

const USAGE = { tokens_in: 92, tokens_out: 21, cost_micro_usd: 591 };

const refusal = (code: string, status: number, retryable = false) => ({
  status,
  body: { error: { code, message: code, retryable } },
});

test("reason sends the request with the step's effect id and returns the typed value", async () => {
  const { lbb, seen } = activities([
    {
      body: {
        value: { code: "P3", description: "Waschtisch 55x45" },
        model: "claude-sonnet-5-5",
        ...USAGE,
        cached: false,
      },
    },
  ]);
  const schema = {
    type: "object",
    properties: { code: { type: "string" }, description: { type: "string" } },
    required: ["code", "description"],
  };
  const answer = await lbb.reason<{ code: string; description: string }>(
    {
      prompt: 'Which code does this row define? "P3 Waschtisch 55x45"',
      system: "You read equipment lists.",
      schema,
      max_tokens: 2_000,
    },
    {
      effectId: "0f3c9a51e2d84b7aa1c6d2e9b0f47a13/define-p3",
      label: "define P3",
    },
  );

  assert.equal(answer.value.code, "P3");
  assert.equal(answer.cost_micro_usd, 591);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.method, "POST");
  assert.equal(seen[0]?.path, "/v1/workflows/activities/reason");
  assert.equal(seen[0]?.query, "?graph=tender");
  assert.deepEqual(seen[0]?.body, {
    prompt: 'Which code does this row define? "P3 Waschtisch 55x45"',
    system: "You read equipment lists.",
    schema,
    max_tokens: 2_000,
    effect_id: "0f3c9a51e2d84b7aa1c6d2e9b0f47a13/define-p3",
    label: "define P3",
  });
});

test("reason names the attempt of a retry and sends it only then", async () => {
  const answer = {
    body: { value: {}, model: "claude-sonnet-5-5", ...USAGE, cached: false },
  };
  const { lbb, seen } = activities([answer, answer]);
  const request = { prompt: "p", schema: { type: "object" } };
  await lbb.reason(request, { effectId: "e/values" });
  await lbb.reason(request, { effectId: "e/values.repair", attempt: 2 });

  // The first call is a plain call: no field an older server would refuse.
  assert.deepEqual(seen[0]?.body, { ...request, effect_id: "e/values" });
  // The retry's own effect id, the same request, and its attempt.
  assert.deepEqual(seen[1]?.body, {
    ...request,
    effect_id: "e/values.repair",
    attempt: 2,
  });
});

test("a call without an effect id sends neither effect_id nor label", async () => {
  const { lbb, seen } = activities([
    { body: { answers: {}, model: "jev", ...USAGE, cached: false } },
  ]);
  await lbb.decide({
    state: { text: "Invoice 2026-118" },
    questions: {
      kind: {
        instructions: "What is the document?",
        criteria: { invoice: "an invoice", letter: "a letter" },
      },
    },
  });

  assert.equal(seen[0]?.path, "/v1/workflows/activities/decide");
  assert.deepEqual(seen[0]?.body, {
    state: { text: "Invoice 2026-118" },
    questions: {
      kind: {
        instructions: "What is the document?",
        criteria: { invoice: "an invoice", letter: "a letter" },
      },
    },
  });
});

test("decide and embed pass the effect id as it is, slash included", async () => {
  const { lbb, seen } = activities([
    {
      body: {
        answers: {
          kind: {
            choice: "invoice",
            confidence: 0.97,
            probabilities: { invoice: 0.97, letter: 0.03 },
          },
        },
        model: "jev-latest",
        ...USAGE,
        cached: true,
      },
    },
    {
      body: {
        vectors: [[0.1, 0.2]],
        model: "openai/text-embedding-3-small",
        dim: 2,
        tokens_in: 5,
        cost_micro_usd: 0,
        cached: false,
      },
    },
  ]);
  const decided = await lbb.decide(
    {
      state: "x",
      questions: {
        kind: { instructions: "?", criteria: { invoice: "i", letter: "l" } },
      },
    },
    { effectId: "abc/triage" },
  );
  const embedded = await lbb.embed(
    { texts: ["P3 Waschtisch 55x45"] },
    { effectId: "abc/triage", label: "fixtures" },
  );

  assert.equal(decided.answers.kind?.choice, "invoice");
  assert.equal(decided.cached, true);
  assert.deepEqual(embedded.vectors, [[0.1, 0.2]]);
  assert.equal(seen[0]?.body?.effect_id, "abc/triage");
  assert.equal(seen[1]?.path, "/v1/workflows/activities/embed");
  assert.deepEqual(seen[1]?.body, {
    texts: ["P3 Waschtisch 55x45"],
    effect_id: "abc/triage",
    label: "fixtures",
  });
});

test("a refused request is an LbbError that isActivityRefused names, and is not retried", async () => {
  const { lbb, seen } = activities([
    refusal("activity_request_refused", 422),
    refusal("activity_request_refused", 422),
  ]);
  const error = await lbb
    .reason({ prompt: "p", schema: { type: "object" } }, { effectId: "a/b" })
    .then(
      () => assert.fail("the call should fail"),
      (caught: unknown) => caught,
    );

  assert.ok(error instanceof LbbError);
  assert.equal(error.status, 422);
  assert.equal(error.code, "activity_request_refused");
  assert.equal(isActivityRefused(error), true);
  assert.equal(seen.length, 1);
});

test("isActivityRefused is false for other errors", () => {
  assert.equal(isActivityRefused(new Error("x")), false);
  assert.equal(isActivityRefused(undefined), false);
  const conflict = new LbbError(409, "{}", {
    code: "activity_effect_conflict",
    message: "another request",
  });
  assert.equal(isActivityRefused(conflict), false);
});

test("an effect conflict and a spent budget fail at once", async () => {
  const { lbb, seen } = activities([
    refusal("activity_effect_conflict", 409),
    refusal("workflow_budget_exceeded", 429),
  ]);
  for (const expected of [
    "activity_effect_conflict",
    "workflow_budget_exceeded",
  ]) {
    await assert.rejects(
      lbb.decide({ state: 1, questions: {} }, { effectId: "a/b" }),
      (error: unknown) => error instanceof LbbError && error.code === expected,
    );
  }
  assert.equal(seen.length, 2);
});

test("a model that did not answer is retried with an effect id, and not without one", async () => {
  const unavailable = refusal("activity_model_unavailable", 503, true);
  const answered = {
    body: {
      vectors: [[1]],
      model: "m",
      dim: 1,
      tokens_in: 1,
      cost_micro_usd: 0,
      cached: false,
    },
  };
  const kept = activities([unavailable, answered]);
  const result = await kept.lbb.embed(
    { texts: ["a"] },
    { effectId: "t/embed" },
  );
  assert.deepEqual(result.vectors, [[1]]);
  assert.equal(kept.seen.length, 2);
  assert.deepEqual(kept.seen[0]?.body, kept.seen[1]?.body);

  const unkept = activities([unavailable, answered]);
  await assert.rejects(
    unkept.lbb.embed({ texts: ["a"] }),
    (error: unknown) =>
      error instanceof LbbError && error.code === "activity_model_unavailable",
  );
  assert.equal(unkept.seen.length, 1);
});

test("pages reads to the end of the file in calls of at most 50 pages", async () => {
  const page = (n: number) => ({ page: n, width: 595, height: 842, lines: [] });
  const range = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => page(from + i));
  const sha = "ab".repeat(32);
  const answer = (from: number, to: number) => ({
    body: {
      sha256: sha,
      parser: "poppler-26.03.0",
      page_count: 120,
      from,
      to,
      pages: range(from, to),
    },
  });
  const { lbb, seen } = activities([
    answer(0, 50),
    answer(50, 100),
    answer(100, 120),
  ]);
  const pages = await lbb.pages(sha);

  assert.equal(pages.pages.length, 120);
  assert.equal(pages.from, 0);
  assert.equal(pages.to, 120);
  assert.deepEqual(
    seen.map((s) => s.query),
    [
      `?graph=tender&sha256=${sha}&from=0&to=50`,
      `?graph=tender&sha256=${sha}&from=50&to=100`,
      `?graph=tender&sha256=${sha}&from=100&to=120`,
    ],
  );

  const one = activities([answer(3, 5)]);
  const window = await one.lbb.pages(sha, { from: 3, to: 5 });
  assert.equal(window.pages.length, 2);
  assert.equal(one.seen.length, 1);
  assert.equal(one.seen[0]?.query, `?graph=tender&sha256=${sha}&from=3&to=5`);
});

test("sparql takes a query text or a request and returns rows", async () => {
  const results = JSON.stringify({
    head: { vars: ["s"] },
    results: {
      bindings: [
        { s: { type: "uri", value: "https://littlebigbrain.com/e/aa" } },
      ],
    },
  });
  const { lbb, seen } = activities([
    { body: { results } },
    { body: { results } },
  ]);
  const plain = await lbb.sparql("SELECT ?s WHERE { ?s ?p ?o }");
  const pinned = await lbb.sparql(
    { query: "SELECT ?s WHERE { ?s ?p ?o }", as_of_commit_seq: 41 },
    { consistency: "strong" },
  );

  assert.deepEqual(plain.rows, [{ s: "https://littlebigbrain.com/e/aa" }]);
  assert.equal(pinned.rows.length, 1);
  assert.equal(seen[0]?.path, "/v1/query/sparql-text");
  assert.deepEqual(seen[0]?.body, { query: "SELECT ?s WHERE { ?s ?p ?o }" });
  assert.deepEqual(seen[1]?.body, {
    query: "SELECT ?s WHERE { ?s ?p ?o }",
    as_of_commit_seq: 41,
  });
  assert.match(seen[1]?.query ?? "", /consistency=strong/);
});

test("writeOwned commits inside the step with its effect id as the idempotency key", async () => {
  const { lbb, seen } = activities([
    {
      body: {
        commit_seq: 9,
        replayed: false,
        idempotency_key: "turn/write",
        entities_written: 1,
        edges_written: 0,
      },
    },
  ]);
  const keys: string[] = [];
  const ctx = {
    step: async <T>(
      key: string,
      effect: (s: { effectId: string }) => Promise<T>,
    ) => {
      keys.push(key);
      return effect({ effectId: `turn/${key}` });
    },
  } as unknown as WorkflowContext;
  let built = 0;
  const written = await lbb.writeOwned(ctx, "write", async () => {
    built += 1;
    return {
      subjects: [{ type: "Note", name: "n1" }],
      properties: ["word_count"],
      entity_properties: [
        { type: "Note", name: "n1", properties: { word_count: 3 } },
      ],
    };
  });

  assert.equal(built, 1, "a write function runs inside the step");
  assert.deepEqual(keys, ["write"]);
  assert.equal(written.commit_seq, 9);
  assert.equal(seen[0]?.path, "/v1/graph/commit");
  assert.equal(seen[0]?.headers["idempotency-key"], "turn/write");
  assert.deepEqual(seen[0]?.body?.replace_owned, {
    subjects: [{ type: "Note", name: "n1" }],
    properties: ["word_count"],
  });
});

test("review files a suggestion with facts and the workflow's agent origin", async () => {
  const { lbb, seen } = activities([
    { body: { suggestion_id: "s1", status: "open" } },
  ]);
  const facts = {
    triplets: [
      {
        source: {
          type: "DocMention",
          name: "S1.1",
          key: "mention:ab:p1-l3:S1.1",
        },
        relation: "REFERS_TO",
        target: { type: "DocEntry", name: "S 1.1", key: "entry:cd:S 1.1" },
        confidence: 0.7,
      },
    ],
  };
  await lbb.review({
    workflow: "documents-link",
    key: "starter:documents-link:link:ab:s1.1",
    title: 'Link "S1.1" in raumblaetter.pdf to S 1.1',
    rationale: "below the gate",
    facts,
  });

  assert.equal(seen[0]?.path, "/v1/ontology/suggestions");
  assert.deepEqual(seen[0]?.body, {
    key: "starter:documents-link:link:ab:s1.1",
    title: 'Link "S1.1" in raumblaetter.pdf to S 1.1',
    rationale: "below the gate",
    facts,
    origin: { kind: "agent", id: "starter:documents-link" },
  });
});

test("review files a value item with /v1/reviews and the workflow that asks", async () => {
  const { lbb, seen } = activities([
    {
      body: {
        id: "rev_1",
        object: "review_item",
        kind: "value",
        status: "open",
      },
    },
  ]);
  const item = await lbb.review({
    kind: "value",
    workflow: { name: "areas", step: "review" },
    key: "starter:areas:value:r104:area",
    title: "Is the area of R 1.04 12.5?",
    subject: { type: "Room", name: "R 1.04" },
    question: { property: "area", value: 12.5, confidence: 0.62 },
    evidence: [{ quote: "Fläche 12,5 m²" }],
  });

  assert.equal(item.id, "rev_1");
  assert.equal(seen[0]?.path, "/v1/reviews");
  assert.deepEqual(seen[0]?.body, {
    kind: "value",
    key: "starter:areas:value:r104:area",
    title: "Is the area of R 1.04 12.5?",
    subject: { type: "Room", name: "R 1.04" },
    question: { property: "area", value: 12.5, confidence: 0.62 },
    evidence: [{ quote: "Fläche 12,5 m²" }],
    origin: { kind: "agent", id: "starter:areas" },
    workflow: { name: "areas", step: "review" },
  });
});

test("reviewItems reads the items of the keys, 100 keys a read", async () => {
  const keys = Array.from(
    { length: 150 },
    (_, n) => `starter:areas:value:e${n}:area`,
  );
  const { lbb, seen } = activities([
    {
      body: {
        object: "list",
        data: [{ id: "rev_1", key: keys[0] }],
        has_more: false,
      },
    },
    {
      body: {
        object: "list",
        data: [{ id: "rev_2", key: keys[120] }],
        has_more: false,
      },
    },
  ]);
  const answered = await lbb.reviewItems([...keys, keys[0]!]);
  assert.deepEqual(
    answered.map((item) => item.id),
    ["rev_1", "rev_2"],
  );
  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.path, "/v1/reviews");
  const first = new URLSearchParams(seen[0]?.query);
  assert.equal(first.get("status"), null);
  assert.equal(first.get("limit"), "100");
  assert.equal(first.get("key")?.split(",").length, 100);
  assert.equal(
    new URLSearchParams(seen[1]?.query).get("key")?.split(",").length,
    50,
  );
});

/** A context that runs each step and answers each wait from `signals`. */
function waitingContext(
  workflowId: string,
  signals: Array<{ received: boolean; value: unknown }>,
) {
  const keys: string[] = [];
  const waits: Array<{ key: string; name: string; timeoutMs: number }> = [];
  const ctx = {
    workflowId,
    turn: 3,
    step: async <T>(
      key: string,
      effect: (s: { effectId: string }) => Promise<T>,
    ) => {
      keys.push(key);
      return effect({ effectId: `turn/${key}` });
    },
    waitForSignal: async (
      key: string,
      options: { name: string; timeoutMs: number },
    ) => {
      waits.push({ key, ...options });
      return signals.shift() ?? { received: false, value: null };
    },
  } as unknown as WorkflowContext;
  return { ctx, keys, waits };
}

test("waitForReview files the item with the waiting run and waits for its signal", async () => {
  const { lbb, seen } = activities([
    {
      body: {
        id: "rev_2",
        kind: "choice",
        status: "open",
        wait: { identity: "asker", turn: 3, signal: "review.rev_2" },
      },
    },
  ]);
  const { ctx, keys, waits } = waitingContext("asker", [
    { received: true, value: { decision: "choose", option: "tiles" } },
  ]);
  const result = await lbb.waitForReview(
    ctx,
    "floor",
    {
      kind: "choice",
      workflow: "rooms",
      key: "asker:floor",
      title: "Which floor covering?",
      question: {
        options: [
          { id: "parquet", label: "Parquet" },
          { id: "tiles", label: "Tiles" },
        ],
      },
    },
    { timeoutMs: 60_000 },
  );

  assert.deepEqual(keys, ["floor.ask"]);
  assert.deepEqual(waits, [
    { key: "floor.answer", name: "review.rev_2", timeoutMs: 60_000 },
  ]);
  assert.equal(result.answered, true);
  assert.deepEqual(result.answer, { decision: "choose", option: "tiles" });
  assert.deepEqual(seen[0]?.body?.wait, {
    identity: "asker",
    turn: 3,
    signal: "",
  });
  assert.deepEqual(seen[0]?.body?.workflow, {
    name: "rooms",
    identity: "asker",
    turn: 3,
  });
});

test("waitForReview reads the item again when its wait times out", async () => {
  const filed = {
    id: "rev_4",
    kind: "choice",
    status: "open",
    wait: { identity: "asker", turn: 3, signal: "review.rev_4" },
  };
  const { lbb, seen } = activities([
    { body: filed },
    {
      body: {
        ...filed,
        status: "answered",
        answer: { decision: "choose", option: "b" },
      },
    },
  ]);
  const { ctx, keys } = waitingContext("asker", [
    { received: false, value: null },
  ]);
  const result = await lbb.waitForReview(
    ctx,
    "floor",
    {
      kind: "choice",
      key: "asker:floor:2",
      title: "Which floor covering?",
      question: {
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      },
    },
    { timeoutMs: 1_000 },
  );
  assert.deepEqual(keys, ["floor.ask", "floor.read"]);
  assert.equal(seen[1]?.path, "/v1/reviews/get");
  assert.equal(result.answered, true);
  assert.deepEqual(result.answer, { decision: "choose", option: "b" });
});

test("waitForReview takes an answer that came first, and refuses a trigger shard", async () => {
  const { lbb } = activities([
    {
      body: {
        id: "rev_3",
        kind: "choice",
        status: "answered",
        answer: { decision: "cant_tell" },
        wait: { identity: "asker", turn: 3, signal: "review.rev_3" },
      },
    },
  ]);
  const { ctx, waits } = waitingContext("asker", []);
  const request = {
    kind: "choice" as const,
    key: "asker:floor",
    title: "Which floor covering?",
    question: {
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
  };
  const result = await lbb.waitForReview(ctx, "floor", request, {
    timeoutMs: 1_000,
  });
  assert.equal(result.answered, true);
  assert.deepEqual(result.answer, { decision: "cant_tell" });
  assert.equal(waits.length, 0, "an answered item needs no wait");

  const shard = waitingContext("starter.rooms", []);
  await assert.rejects(
    lbb.waitForReview(shard.ctx, "floor", request, { timeoutMs: 1_000 }),
    /needs a run with its own identity/,
  );
});

test("evolve sends the operations, and a dry run asks for one", async () => {
  const { lbb, seen } = activities([{ body: { no_op: true } }, { body: {} }]);
  const ops = [{ op: "add_entity_type" as const, name: "Mangel" }];
  const preview = await lbb.evolve(ops, { dryRun: true });
  await lbb.evolve(ops);

  assert.equal(preview.no_op, true);
  assert.equal(seen[0]?.path, "/v1/ontology/evolve");
  assert.match(seen[0]?.query ?? "", /dry_run=true/);
  assert.deepEqual(seen[0]?.body, { ops });
  assert.doesNotMatch(seen[1]?.query ?? "", /dry_run/);
});

test("ontology reads the graph's ontology", async () => {
  const { lbb, seen } = activities([
    { body: { ontology_version: 3, entity_types: [], relations: [] } },
  ]);
  const view = await lbb.ontology();
  assert.equal(view.ontology_version, 3);
  assert.equal(seen[0]?.method, "GET");
  assert.equal(seen[0]?.path, "/v1/ontology");
});

test("splitInHalves splits a list in two, the first half the smaller", () => {
  assert.deepEqual(splitInHalves([1, 2, 3]), [[1], [2, 3]]);
  assert.deepEqual(splitInHalves(["a", "b"]), [["a"], ["b"]]);
  assert.equal(splitInHalves([1]), null);
  assert.equal(splitInHalves([]), null);
});

/** A claimed task: the turn 1 of `agent`, with the effect prefix `stable`. */
function turnTask(): Schemas["WorkflowTurnTask"] {
  return {
    workflow_type: "steps",
    state: {},
    token: "token",
    lease_ms: 60_000,
    effect_prefix: "stable",
    turn: {
      workflow_id: "agent",
      number: 1,
      message_id: "m1",
      message: {},
      version: "v1",
      status: "running",
      attempt: 1,
      created_at_ms: 1,
      updated_at_ms: 1,
      ready_at_ms: 1,
      steps: [],
      result: null,
      state_after: null,
      sequence: 1,
      run: { id: "0000000000001-agent-1", started_at_ms: 1, queue_before: 1 },
    },
  };
}

/** A worker's server: a claim hands out `tasks`, the activities answer, the other routes `{}`. */
function turnServer(tasks: Schemas["WorkflowTurnTask"][]) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const path = new URL(input).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    calls.push({ path, body });
    const used = { model: "m", ...USAGE, cached: false };
    const answer = path.endsWith("/claim")
      ? { task: tasks.shift() ?? null }
      : path.endsWith("/activities/reason")
        ? { value: {}, ...used }
        : path.endsWith("/activities/decide")
          ? { answers: {}, ...used }
          : path.endsWith("/activities/embed")
            ? { vectors: [[0.1]], dim: 1, ...used }
            : {};
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      text: async () => JSON.stringify(answer),
    };
  };
  const client = new LbbClient({
    baseUrl: "http://h",
    graph: "tender",
    fetch,
    retryDelayMs: 0,
  });
  const activityCalls = () =>
    calls
      .filter((c) => c.path.includes("/activities/"))
      .map((c) => ({
        effect_id: c.body.effect_id,
        workflow: c.body.workflow as Schemas["ActivityWorkflow"] | undefined,
        test: c.body.test,
      }));
  return { client, activityCalls };
}

const RUN = { identity: "agent", turn: 1, run_id: "0000000000001-agent-1" };
const OBJECT = { type: "object" };

test("a call in a step names the step's key, also with an id made from the step's", async () => {
  const { client, activityCalls } = turnServer([turnTask()]);
  const lbb = lbbActivities(client);
  const steps = workflow({
    name: "steps",
    version: "v1",
    initialState: {},
    async onMessage(ctx, state) {
      await ctx.step("define", async (s) => {
        await lbb.reason(
          { prompt: "p", schema: OBJECT },
          { effectId: s.effectId },
        );
        // More calls of one step, with ids made from the step's.
        await lbb.decide(
          { state: {}, questions: {} },
          { effectId: `${s.effectId}.2` },
        );
        await lbb.embed({ texts: ["t"] }, { effectId: `${s.effectId}:texts` });
        // An id that only starts with the step's text names no step.
        await lbb.reason(
          { prompt: "p", schema: OBJECT },
          { effectId: `${s.effectId}x` },
        );
        return null;
      });
      // A step key with a dot: the longest step id that starts the call's wins.
      await ctx.step("page", async () => null);
      await ctx.step("page.2", (s) =>
        lbb.reason(
          { prompt: "p", schema: OBJECT },
          { effectId: `${s.effectId}.1` },
        ),
      );
      // A call outside a step names the turn and no step.
      await lbb.reason({ prompt: "p", schema: OBJECT });
      return { state };
    },
  });
  await new WorkflowWorker(client, [steps], { worker: "test" }).runOnce();
  assert.deepEqual(
    activityCalls().map(({ effect_id, workflow }) => ({ effect_id, workflow })),
    [
      { effect_id: "stable/define", workflow: { ...RUN, step: "define" } },
      { effect_id: "stable/define.2", workflow: { ...RUN, step: "define" } },
      {
        effect_id: "stable/define:texts",
        workflow: { ...RUN, step: "define" },
      },
      { effect_id: "stable/definex", workflow: RUN },
      { effect_id: "stable/page.2.1", workflow: { ...RUN, step: "page.2" } },
      { effect_id: undefined, workflow: RUN },
    ],
  );
  // The steps go with the turn: outside a turn a call names no run and no step.
  await lbb.reason(
    { prompt: "p", schema: OBJECT },
    { effectId: "stable/define" },
  );
  assert.equal(activityCalls().at(-1)?.workflow, undefined);
});

test("a capture's calls in a step name the step as the live calls do", async () => {
  const { client, activityCalls } = turnServer([turnTask()]);
  const capture = captureActivities(lbbActivities(client), {
    workflow: "sinks",
  });
  const steps = workflow({
    name: "steps",
    version: "v1",
    initialState: {},
    async onMessage(ctx, state) {
      await ctx.step("define", async (s) => {
        await capture.activities.reason(
          { prompt: "p", schema: OBJECT },
          { effectId: s.effectId },
        );
        await capture.activities.decide(
          { state: {}, questions: {} },
          { effectId: `${s.effectId}.2` },
        );
        return null;
      });
      return { state };
    },
  });
  await new WorkflowWorker(client, [steps], { worker: "test" }).runOnce();
  assert.deepEqual(activityCalls(), [
    {
      effect_id: "stable/define",
      workflow: { ...RUN, step: "define" },
      test: { workflow: "sinks" },
    },
    {
      effect_id: "stable/define.2",
      workflow: { ...RUN, step: "define" },
      test: { workflow: "sinks" },
    },
  ]);
});
