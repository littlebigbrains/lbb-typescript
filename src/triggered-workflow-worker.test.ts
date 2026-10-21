import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, type FetchLike, type Schemas } from "./client.js";
import { WorkflowError, WorkflowWorker } from "./workflows.js";
import { LbbError } from "./transport.js";
import { WorkflowWait } from "./workflows.js";
import {
  requeueFailed,
  ENTITY_ID_KEY_SENTINEL,
  ENTITY_IRI_NAMESPACE,
  entityIdFromIri,
  entityRef,
  ownedCommitBody,
  parseTriggerMessage,
  triggeredWorkflow,
  triggeredWorkflowState,
  writeOwned,
  type WorkflowTriggerMessage,
} from "./triggered-workflow-worker.js";

/** A fetch that answers `payloads` in order and keeps each request. */
function queuedFetch(payloads: Array<{ status?: number; body: unknown }>) {
  const requests: Array<{
    url: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }> = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: init?.headers,
    });
    const next = payloads.shift() ?? { body: {} };
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(next.body),
    };
  };
  return { fetch, requests };
}

const MESSAGE: WorkflowTriggerMessage = {
  type: "instances",
  workflow: "notes",
  graph: "crm",
  as_of_commit_seq: 41,
  reason: "changed",
  instances: [
    "https://littlebigbrain.com/e/aa",
    "https://littlebigbrain.com/e/bb",
  ],
  removed: [],
};

const TRIGGERED = {
  starter: "workflow",
  version: "v1",
  name: "notes",
  owns: { properties: ["https://littlebigbrain.com/p/word_count"] },
  status: { state: "paused", pending: 0 },
};

test("workflows.triggered.pause posts the flag for one triggered workflow", async () => {
  const { fetch, requests } = queuedFetch([
    { body: TRIGGERED },
    { body: { ...TRIGGERED, status: { state: "ready", pending: 0 } } },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", graph: "crm", fetch });
  const ref = { starter: "workflow", name: "notes" };

  const paused = await client.workflows.triggered.pause(ref);
  const resumed = await client.workflows.triggered.pause(ref, false);

  assert.equal(paused.status.state, "paused");
  assert.equal(resumed.status.state, "ready");
  assert.deepEqual(
    requests.map(({ url, method, body }) => ({ url, method, body })),
    [
      {
        url: "http://h/v1/workflows/triggered/pause?graph=crm&starter=workflow&name=notes",
        method: "POST",
        body: { paused: true },
      },
      {
        url: "http://h/v1/workflows/triggered/pause?graph=crm&starter=workflow&name=notes",
        method: "POST",
        body: { paused: false },
      },
    ],
  );
});

test("workflows.named reads, changes, runs, pauses and deletes one workflow, and reads its queue", async () => {
  const named = {
    name: "notes",
    starter: "workflow",
    workflow: { workflow_type: "word-count", version: "v1" },
    runs_in: "worker",
    shards: 2,
    window: 4,
    owns: {},
    triggers: [
      { id: "watch", kind: "watch", watch: { class: "urn:Note", fields: [] } },
    ],
    paused: false,
    status: { state: "ready", pending: 0 },
  };
  const queue = {
    name: "notes",
    trigger: "watch",
    pending: 1,
    items: [
      {
        iri: "https://littlebigbrain.com/e/aa",
        reason: "changed",
        shard: 1,
        origin: { kind: "commit", trigger: "watch", from_seq: 4, to_seq: 5 },
      },
    ],
    next_after: null,
  };
  const { fetch, requests } = queuedFetch([
    { body: { workflows: [named] } },
    { body: named },
    { body: named },
    { body: { workflow: named, queued: true } },
    { body: { ...named, paused: true } },
    { body: queue },
    { body: { deleted: true } },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", graph: "crm", fetch });
  const request: Schemas["NamedWorkflowRequest"] = {
    name: "notes",
    workflow: { workflow_type: "word-count", version: "v1" },
    shards: 2,
    route_by: "author",
    triggers: [{ watch: { class: "Note" } }],
  };

  const listed = await client.workflows.named.list();
  const one = await client.workflows.named.get("notes");
  await client.workflows.named.put(request);
  const ran = await client.workflows.named.run("notes");
  const paused = await client.workflows.named.pause("notes");
  const waiting = await client.workflows.named.queue("notes", {
    after: 50,
    limit: 25,
  });
  await client.workflows.named.delete("notes");

  assert.equal(listed.workflows[0]?.shards, 2);
  assert.equal(one.triggers[0]?.id, "watch");
  assert.equal(ran.queued, true);
  assert.equal(paused.paused, true);
  assert.equal(waiting.items[0]?.origin.kind, "commit");
  assert.deepEqual(
    requests.map(({ url, method, body }) => ({ url, method, body })),
    [
      {
        url: "http://h/v1/workflows/named?graph=crm",
        method: "GET",
        body: undefined,
      },
      {
        url: "http://h/v1/workflows/named?graph=crm&name=notes",
        method: "GET",
        body: undefined,
      },
      {
        url: "http://h/v1/workflows/named?graph=crm",
        method: "PUT",
        body: request,
      },
      {
        url: "http://h/v1/workflows/named/run?graph=crm&name=notes",
        method: "POST",
        body: undefined,
      },
      {
        url: "http://h/v1/workflows/named/pause?graph=crm&name=notes",
        method: "POST",
        body: { paused: true },
      },
      {
        url: "http://h/v1/workflows/named/queue?graph=crm&name=notes&after=50&limit=25",
        method: "GET",
        body: undefined,
      },
      {
        url: "http://h/v1/workflows/named?graph=crm&name=notes&confirm=notes",
        method: "DELETE",
        body: undefined,
      },
    ],
  );
});

test("workflows.named.put takes a content trigger, and a content message names its upload", async () => {
  const content = {
    id: "pdfs",
    kind: "content",
    content: { media_types: ["application/pdf"] },
  };
  const { fetch, requests } = queuedFetch([
    { body: { name: "pdfs", triggers: [content] } },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", graph: "crm", fetch });
  const request: Schemas["NamedWorkflowRequest"] = {
    name: "pdfs",
    workflow: { workflow_type: "acme.parse", version: "v1" },
    shards: 4,
    triggers: [{ id: "pdfs", content: { media_types: ["application/pdf"] } }],
  };

  const created = await client.workflows.named.put(request);

  assert.deepEqual(created.triggers[0], content);
  assert.equal(requests[0]?.method, "PUT");
  assert.deepEqual(requests[0]?.body, request);
  // The message of a content trigger: one document, and the content in its
  // origin.
  const origin: Schemas["WorkflowMessageOrigin"] = {
    kind: "content",
    trigger: "pdfs",
    sha256: "ab".repeat(32),
    media_type: "application/pdf",
    uploaded_at_ms: 1_791_967_651_158,
    requests: ["file-upload:ab"],
  };
  assert.equal(origin.sha256?.length, 64);
});

test("workflows.starters.use sends the workflow, the owned outputs and the batch", async () => {
  const { fetch, requests } = queuedFetch([{ body: TRIGGERED }]);
  const client = new LbbClient({ baseUrl: "http://h", graph: "crm", fetch });
  const request: Schemas["TriggeredWorkflowRequest"] = {
    starter: "workflow",
    name: "notes",
    watch: { class: "Note", fields: ["body"] },
    workflow: { workflow_type: "word-count", version: "v1" },
    owns: { properties: ["word_count"] },
    batch: 8,
  };

  await client.graph("crm").workflows.starters.use(request);

  assert.equal(requests[0]?.method, "PUT");
  assert.equal(requests[0]?.url, "http://h/v1/workflows/triggered?graph=crm");
  assert.deepEqual(requests[0]?.body, request);
});

test("a commit carries replace_owned and returns what it removed", async () => {
  const owned = {
    edges_retracted: 1,
    fields_removed: 2,
    entities_retracted: 0,
  };
  const { fetch, requests } = queuedFetch([
    {
      body: {
        commit_seq: 42,
        replayed: false,
        idempotency_key: "k",
        owned,
        entities_written: 1,
        edges_written: 0,
      },
    },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", graph: "crm", fetch });
  const body: Schemas["TripletCommitFile"] = {
    entity_properties: [
      {
        type: "Note",
        name: "n1",
        properties: { word_count: 3 },
      },
    ],
    replace_owned: {
      subjects: [{ type: "Note", name: "n1" }],
      properties: ["word_count"],
    },
  };

  const written = await client.commit(body, { idempotencyKey: "k" });

  assert.deepEqual(written.owned, owned);
  assert.equal(written.commitSeq, 42);
  assert.deepEqual(requests[0]?.body, body);
  assert.equal(requests[0]?.headers?.["idempotency-key"], "k");
});

test("suggestions carry facts on create and report facts_commit on accept", async () => {
  const facts: Schemas["SuggestedFacts"] = {
    triplets: [
      {
        source: { type: "Room", name: "R 1.04" },
        relation: "HAS_COMPONENT",
        target: { type: "Component", name: "Fire door T30" },
        confidence: 0.62,
      },
    ],
    summary: "One component of room R 1.04",
  };
  const factsCommit = {
    commit_seq: 9,
    request_id: "ontology-suggestion:sg_1:facts:r1",
  };
  const { fetch, requests } = queuedFetch([
    { body: { suggestion_id: "sg_1", facts, change: [] } },
    {
      body: {
        suggestion_id: "sg_1",
        status: "accepted",
        facts_commit: factsCommit,
      },
    },
  ]);
  const client = new LbbClient({ baseUrl: "http://h", graph: "crm", fetch });

  await client.ontology.suggestions.create({
    title: "Link room R 1.04",
    origin: { kind: "agent", id: "starter:rooms" },
    change: [],
    facts,
  });
  const accepted = await client.ontology.suggestions.accept("sg_1");

  assert.deepEqual((requests[0]?.body as { facts: unknown }).facts, facts);
  assert.deepEqual(accepted.facts_commit, factsCommit);
  assert.equal(
    requests[1]?.url,
    "http://h/v1/ontology/suggestions/accept?graph=crm&suggestion_id=sg_1",
  );
});

test("a trigger message is checked before the handler sees it", () => {
  assert.deepEqual(parseTriggerMessage(MESSAGE), MESSAGE);
  const withoutRemoved: Partial<WorkflowTriggerMessage> = { ...MESSAGE };
  delete withoutRemoved.removed;
  assert.deepEqual(parseTriggerMessage(withoutRemoved).removed, []);
  // A reason this SDK does not know passes through.
  assert.equal(
    parseTriggerMessage({ ...MESSAGE, reason: "rebuilt" }).reason,
    "rebuilt",
  );
  for (const [bad, problem] of [
    [null, /not a JSON object/],
    [{ ...MESSAGE, type: "other" }, /type is "other"/],
    [{ ...MESSAGE, workflow: "" }, /workflow is not a name/],
    [{ ...MESSAGE, workflow: 3, starter: "notes" }, /workflow is not a name/],
    [{ ...MESSAGE, graph: 3 }, /graph/],
    [{ ...MESSAGE, as_of_commit_seq: -1 }, /as_of_commit_seq/],
    [{ ...MESSAGE, as_of_commit_seq: "41" }, /as_of_commit_seq/],
    [{ ...MESSAGE, instances: "https://x" }, /instances/],
    [{ ...MESSAGE, removed: [1] }, /removed/],
  ] as const) {
    assert.throws(
      () => parseTriggerMessage(bad),
      (error: unknown) =>
        error instanceof WorkflowError && problem.test(error.message),
    );
  }
});

test("a message stored with starter instead of workflow still reads", () => {
  const { workflow, ...rest } = MESSAGE;
  const stored = { ...rest, starter: workflow };
  const parsed = parseTriggerMessage(stored);
  assert.equal(parsed.workflow, "notes");
  assert.equal("starter" in parsed, false);
  assert.deepEqual(parsed, MESSAGE);
  // `workflow` wins when a message carries both.
  assert.equal(
    parseTriggerMessage({ ...MESSAGE, starter: "older" }).workflow,
    "notes",
  );
  assert.throws(
    () => parseTriggerMessage({ ...rest, starter: "" }),
    (error: unknown) =>
      error instanceof WorkflowError &&
      /workflow is not a name/.test(error.message),
  );
});

test("an owned write builds one commit, with replace_owned only for subjects", () => {
  assert.equal(ownedCommitBody({ subjects: [] }), null);
  const note = { type: "Note", name: "n1" };
  assert.deepEqual(
    ownedCommitBody({
      subjects: [note],
      properties: ["word_count"],
      relations: [],
      entity_properties: [
        {
          type: "Note",
          name: "n1",
          properties: { word_count: 3 },
        },
      ],
    }),
    {
      entity_properties: [
        {
          type: "Note",
          name: "n1",
          properties: { word_count: 3 },
        },
      ],
      edge_idempotency: "skip_unchanged",
      replace_owned: { subjects: [note], properties: ["word_count"] },
    },
  );
  const link = {
    source: note,
    relation: "MENTIONS",
    target: { type: "Topic", name: "pricing" },
  };
  assert.deepEqual(
    ownedCommitBody({ subjects: [], triplets: [link] }, "append"),
    {
      triplets: [link],
      edge_idempotency: "append",
    },
  );
  assert.deepEqual(
    ownedCommitBody({ subjects: [], retract_entities: [note] }),
    {
      edge_idempotency: "skip_unchanged",
      replace_owned: { subjects: [], retract_entities: [note] },
    },
  );
});

const ENTRY_ID = "0123456789abcdef0123456789abcdef";
const ENTRY_IRI = `https://littlebigbrain.com/e/${ENTRY_ID}`;

test("entityRef addresses the entity an IRI names by its id", () => {
  assert.equal(ENTITY_IRI_NAMESPACE, "https://littlebigbrain.com/e/");
  assert.equal(ENTITY_ID_KEY_SENTINEL, "\u0000lbb-eid:");
  assert.equal(entityIdFromIri(ENTRY_IRI), ENTRY_ID);
  assert.equal(
    entityIdFromIri(`${ENTITY_IRI_NAMESPACE}${ENTRY_ID.toUpperCase()}`),
    ENTRY_ID,
  );
  assert.deepEqual(entityRef(ENTRY_IRI, "DocEntry"), {
    type: "DocEntry",
    name: ENTRY_ID,
    key: `\u0000lbb-eid:${ENTRY_ID}`,
  });
  assert.deepEqual(entityRef(ENTRY_IRI, "DocEntry", "S 1.1"), {
    type: "DocEntry",
    name: "S 1.1",
    key: `\u0000lbb-eid:${ENTRY_ID}`,
  });
  // The key travels as JSON with its NUL escaped, as the server reads it.
  assert.match(
    JSON.stringify(entityRef(ENTRY_IRI, "DocEntry")),
    /"key":"\\u0000lbb-eid:0123456789abcdef0123456789abcdef"/,
  );
});

test("entityRef refuses an IRI of another namespace or a malformed id", () => {
  for (const iri of [
    "https://example.org/e/0123456789abcdef0123456789abcdef",
    "https://littlebigbrain.com/class/docentry",
    `${ENTRY_IRI}0`,
    "https://littlebigbrain.com/e/0123456789abcdef0123456789abcdeg",
    "https://littlebigbrain.com/e/",
  ]) {
    let thrown: unknown;
    try {
      entityRef(iri, "DocEntry");
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof RangeError, iri);
  }
  let typeError: unknown;
  try {
    entityRef(ENTRY_IRI, " ");
  } catch (error) {
    typeError = error;
  }
  assert.ok(typeError instanceof TypeError);
});

test("an owned write names its subjects by IRI with entityRef", () => {
  const subjects = [ENTRY_IRI].map((iri) => entityRef(iri, "DocEntry"));
  const body = ownedCommitBody({
    subjects,
    properties: ["width_cm"],
    entity_properties: [
      {
        ...entityRef(ENTRY_IRI, "DocEntry", "S 1.1"),
        properties: { width_cm: 60 },
      },
    ],
  });
  assert.deepEqual(body?.replace_owned?.subjects, [
    { type: "DocEntry", name: ENTRY_ID, key: `\u0000lbb-eid:${ENTRY_ID}` },
  ]);
  assert.equal(body?.entity_properties?.[0]?.key, `\u0000lbb-eid:${ENTRY_ID}`);
});

type Task = Schemas["WorkflowTurnTask"];
function task(
  message: unknown,
  steps: Task["turn"]["steps"] = [],
  state: unknown = { seen: 0 },
): Task {
  return {
    workflow_type: "word-count",
    state,
    token: "token",
    lease_ms: 60_000,
    effect_prefix: "4f2a",
    turn: {
      workflow_id: "starter.notes",
      number: 3,
      message_id: "starter-notes-3",
      message,
      version: "v1",
      status: "running",
      attempt: 1,
      created_at_ms: 1,
      updated_at_ms: 1,
      ready_at_ms: 1,
      steps,
      result: null,
      state_after: null,
      sequence: 1,
    },
  };
}

/** A worker's server: hands out `tasks`, answers commits, keeps each call. */
/** A worker on a mock data plane; `graph: null` builds a client with no graph. */
function worker(tasks: Task[], graph: string | null = "main") {
  const calls: Array<{
    path: string;
    query: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }> = [];
  const client = new LbbClient({
    baseUrl: "http://h",
    ...(graph === null ? {} : { graph }),
    maxRetries: 0,
    retryDelayMs: 0,
    fetch: async (input, init) => {
      const url = new URL(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      calls.push({
        path: url.pathname,
        query: url.search,
        body,
        headers: init?.headers ?? {},
      });
      const answer =
        url.pathname === "/v1/workflows/turns/claim"
          ? { task: tasks.shift() ?? null }
          : url.pathname === "/v1/graph/commit"
            ? {
                commit_seq: 43,
                replayed: false,
                idempotency_key: init?.headers?.["idempotency-key"],
                owned: {
                  edges_retracted: 0,
                  fields_removed: 1,
                  entities_retracted: 0,
                },
                entities_written: 2,
                edges_written: 0,
              }
            : {};
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, calls };
}

test("triggeredWorkflow() hands the typed message to onInstances and keeps the state", async () => {
  const { client, calls } = worker([task(MESSAGE), task(MESSAGE)]);
  const seen: WorkflowTriggerMessage[] = [];
  let turns = 0;
  const notes = triggeredWorkflow<{ seen: number }>({
    name: "word-count",
    version: "v1",
    initialState: { seen: 0 },
    async onInstances(_ctx, message, state) {
      seen.push(message);
      turns += 1;
      // The first turn returns nothing; the second one a new state.
      return turns === 1
        ? undefined
        : {
            state: { seen: state.seen + message.instances.length },
            result: "ok",
          };
    },
  });
  assert.equal(notes.name, "word-count");
  assert.deepEqual(notes.initialState, { seen: 0 });
  const run = new WorkflowWorker(client, [notes], { worker: "w" });
  await run.runOnce();
  await run.runOnce();

  assert.deepEqual(seen, [MESSAGE, MESSAGE]);
  const done = calls.filter((c) => c.path.endsWith("/turns/complete"));
  assert.deepEqual(done[0]?.body.state, { seen: 0 });
  assert.equal(done[0]?.body.result, null);
  assert.deepEqual(done[1]?.body.state, { seen: 2 });
  assert.equal(done[1]?.body.result, "ok");
});

test("triggeredWorkflow() merges initialState under the saved state", async () => {
  // The server creates `starter.<name>` with the state `{}`, so the first
  // turn reads `{}`; a later turn reads what the turn before saved.
  const { client, calls } = worker([
    task(MESSAGE, [], {}),
    task(MESSAGE, [], { seen: 2 }),
    task(MESSAGE, [], null),
    task(MESSAGE, [], { other: "kept" }),
  ]);
  const states: unknown[] = [];
  const notes = triggeredWorkflow<{ seen: number; other?: string }>({
    name: "word-count",
    version: "v1",
    initialState: { seen: 0 },
    async onInstances(_ctx, message, state) {
      states.push(structuredClone(state));
      // Changed in place: the next turn must still start from `{ seen: 0 }`.
      state.seen += message.instances.length;
      return { state };
    },
  });
  const run = new WorkflowWorker(client, [notes], { worker: "w" });
  for (let turn = 0; turn < 4; turn += 1) await run.runOnce();

  assert.deepEqual(states, [
    { seen: 0 },
    { seen: 2 },
    { seen: 0 },
    { seen: 0, other: "kept" },
  ]);
  assert.equal(calls.filter((c) => c.path.endsWith("/turns/fail")).length, 0);
  const done = calls.filter((c) => c.path.endsWith("/turns/complete"));
  assert.deepEqual(
    done.map((c) => c.body.state),
    [{ seen: 2 }, { seen: 4 }, { seen: 2 }, { seen: 2, other: "kept" }],
  );
  // A handler that changes its state leaves the definition's state alone.
  assert.deepEqual(notes.initialState, { seen: 0 });
});

test("triggeredWorkflowState keeps a saved state that is not an object", () => {
  assert.deepEqual(triggeredWorkflowState({ seen: 0 }, {}), { seen: 0 });
  assert.deepEqual(triggeredWorkflowState({ seen: 0 }, undefined), { seen: 0 });
  assert.deepEqual(triggeredWorkflowState({ seen: 0, a: 1 }, { seen: 5 }), {
    seen: 5,
    a: 1,
  });
  assert.equal(triggeredWorkflowState<number>(0, 7), 7);
  assert.deepEqual(triggeredWorkflowState<unknown>([1], { a: 1 }), { a: 1 });
});

test("triggeredWorkflow() fails a turn whose message has another shape, without a retry", async () => {
  const { client, calls } = worker([task({ add: 1 })]);
  let called = false;
  const notes = triggeredWorkflow({
    name: "word-count",
    version: "v1",
    async onInstances() {
      called = true;
    },
  });
  await new WorkflowWorker(client, [notes], { worker: "w" }).runOnce();

  assert.equal(called, false);
  const failed = calls.find((c) => c.path.endsWith("/turns/fail"));
  assert.equal(failed?.body.non_retryable, true);
  assert.match(String(failed?.body.error), /not a trigger message/);
  assert.equal(calls.filter((c) => c.path.endsWith("/complete")).length, 0);
});

test("writeOwned commits in a step with the step's effect id as idempotency key", async () => {
  const { client, calls } = worker([task(MESSAGE)]);
  const results: unknown[] = [];
  const notes = triggeredWorkflow({
    name: "word-count",
    version: "v1",
    async onInstances(ctx, message) {
      results.push(
        await writeOwned(
          client,
          ctx,
          "write-counts",
          {
            subjects: [{ type: "Note", name: "n1" }],
            properties: ["word_count"],
            entity_properties: [
              {
                type: "Note",
                name: "n1",
                properties: { word_count: 3 },
              },
            ],
          },
          { graph: message.graph },
        ),
      );
    },
  });
  await new WorkflowWorker(client, [notes], { worker: "w" }).runOnce();

  const commits = calls.filter((c) => c.path === "/v1/graph/commit");
  assert.equal(commits.length, 1);
  assert.equal(commits[0]?.headers["idempotency-key"], "4f2a/write-counts");
  assert.equal(commits[0]?.query, "?graph=crm");
  assert.deepEqual(commits[0]?.body, {
    entity_properties: [
      {
        type: "Note",
        name: "n1",
        properties: { word_count: 3 },
      },
    ],
    edge_idempotency: "skip_unchanged",
    replace_owned: {
      subjects: [{ type: "Note", name: "n1" }],
      properties: ["word_count"],
    },
    // No fence: the turn lives in the worker's graph (`main`), and the
    // engine of `crm` holds no such turn.
  });
  const saved = {
    commit_seq: 43,
    idempotency_key: "4f2a/write-counts",
    replayed: false,
    owned: { edges_retracted: 0, fields_removed: 1, entities_retracted: 0 },
    entities_written: 2,
    edges_written: 0,
  };
  assert.deepEqual(results, [saved]);
  // The step's result is saved before the turn completes.
  const checkpoint = calls.find((c) => c.path.endsWith("/turns/checkpoint"));
  assert.equal(checkpoint?.body.key, "write-counts");
  assert.deepEqual(checkpoint?.body.output, saved);
  const operation = calls.find((c) => c.path.endsWith("/turns/operation"));
  assert.ok(
    calls.indexOf(operation!) < calls.indexOf(commits[0]!),
    "the step begins before the commit",
  );
});

test("a replayed turn returns the saved write and never commits twice", async () => {
  const saved = {
    commit_seq: 43,
    idempotency_key: "4f2a/write-counts",
    replayed: false,
    owned: null,
    entities_written: 2,
    edges_written: 0,
  };
  const { client, calls } = worker([
    task(MESSAGE, [
      { key: "write-counts", kind: "step", output: saved, at_ms: 2 },
    ]),
  ]);
  const results: unknown[] = [];
  const notes = triggeredWorkflow({
    name: "word-count",
    version: "v1",
    async onInstances(ctx) {
      results.push(
        await writeOwned(client, ctx, "write-counts", {
          subjects: [{ type: "Note", name: "n1" }],
          properties: ["word_count"],
        }),
      );
    },
  });
  await new WorkflowWorker(client, [notes], { worker: "w" }).runOnce();

  assert.deepEqual(results, [saved]);
  assert.equal(calls.filter((c) => c.path === "/v1/graph/commit").length, 0);
  assert.equal(calls.filter((c) => c.path.endsWith("/complete")).length, 1);
});

test("writeOwned fences a write to the worker's own graph with the step's turn", async () => {
  const { client, calls } = worker([task(MESSAGE)]);
  const notes = triggeredWorkflow({
    name: "word-count",
    version: "v1",
    async onInstances(ctx) {
      for (const [key, graph] of [
        ["own", undefined],
        ["named", "main"],
      ] as const)
        await writeOwned(
          client,
          ctx,
          key,
          {
            subjects: [{ type: "Note", name: "n1" }],
            properties: ["word_count"],
          },
          graph ? { graph } : {},
        );
    },
  });
  await new WorkflowWorker(client, [notes], { worker: "w" }).runOnce();
  const commits = calls.filter((c) => c.path === "/v1/graph/commit");
  assert.equal(commits.length, 2);
  for (const commit of commits)
    // The fence: the server refuses a new commit once the lease is gone.
    assert.deepEqual(commit.body.workflow_fence, {
      workflow_id: "starter.notes",
      turn: 3,
      token: "token",
    });
});

test("a worker whose client names no graph fences the write to the message's graph", async () => {
  // The turn's graph is then the one the write names (`message.graph`):
  // the documented pattern stays fenced.
  const { client, calls } = worker([task(MESSAGE)], null);
  const notes = triggeredWorkflow({
    name: "word-count",
    version: "v1",
    async onInstances(ctx, message) {
      await writeOwned(
        client,
        ctx,
        "write-counts",
        {
          subjects: [{ type: "Note", name: "n1" }],
          properties: ["word_count"],
        },
        { graph: message.graph },
      );
    },
  });
  await new WorkflowWorker(client, [notes], { worker: "w" }).runOnce();
  const commits = calls.filter((c) => c.path === "/v1/graph/commit");
  assert.equal(commits.length, 1);
  assert.equal(commits[0]?.query, "?graph=crm");
  assert.deepEqual(commits[0]?.body.workflow_fence, {
    workflow_id: "starter.notes",
    turn: 3,
    token: "token",
  });
});

test("writeOwned with nothing to write saves the step without a commit", async () => {
  const { client, calls } = worker([task(MESSAGE)]);
  const results: unknown[] = [];
  const notes = triggeredWorkflow({
    name: "word-count",
    version: "v1",
    async onInstances(ctx) {
      results.push(await writeOwned(client, ctx, "nothing", { subjects: [] }));
    },
  });
  await new WorkflowWorker(client, [notes], { worker: "w" }).runOnce();

  assert.equal(calls.filter((c) => c.path === "/v1/graph/commit").length, 0);
  assert.deepEqual(results, [
    {
      commit_seq: null,
      idempotency_key: "4f2a/nothing",
      replayed: false,
      owned: null,
      entities_written: 0,
      edges_written: 0,
    },
  ]);
});

test("a writeOwned write function gets the step's context and reports progress before the commit", async () => {
  const { client, calls } = worker([task(MESSAGE)]);
  const notes = triggeredWorkflow({
    name: "word-count",
    version: "v1",
    async onInstances(ctx) {
      await writeOwned(client, ctx, "write-counts", (step) => {
        assert.equal(step.effectId, "4f2a/write-counts");
        step.progress("writing facts", {
          done: 0,
          total: 1,
          unit: "instances",
        });
        return {
          subjects: [{ type: "Note", name: "n1" }],
          properties: ["word_count"],
          entity_properties: [
            { type: "Note", name: "n1", properties: { word_count: 3 } },
          ],
        };
      });
    },
  });
  await new WorkflowWorker(client, [notes], { worker: "w" }).runOnce();

  const progress = calls.filter((c) => c.path.endsWith("/turns/progress"));
  assert.deepEqual(
    progress.map((c) => c.body.details),
    [{ phase: "writing facts", done: 0, total: 1, unit: "instances" }],
  );
  const commit = calls.find((c) => c.path === "/v1/graph/commit");
  assert.ok(commit, "the write commits");
  assert.ok(calls.indexOf(progress[0]!) < calls.indexOf(commit!));
});

test("a spent budget fails the turn with retry_at_ms and counts no attempt", async () => {
  const { client, calls } = worker([task(MESSAGE)]);
  const retryAt = Date.now() + 30 * 86_400_000;
  const notes = triggeredWorkflow({
    name: "word-count",
    version: "v1",
    async onInstances(ctx) {
      await ctx.step("count", async () => {
        throw new LbbError(429, "{}", {
          code: "workflow_budget_exceeded",
          message: "the workflow `notes` spent its budget",
          retry_at_ms: retryAt,
        });
      });
    },
  });
  await new WorkflowWorker(client, [notes], { worker: "w" }).runOnce();
  const failed = calls.find((c) => c.path === "/v1/workflows/turns/fail");
  assert.equal(failed?.body.retry_at_ms, retryAt);
  assert.equal(failed?.body.non_retryable, false);
});

test("a thrown WorkflowWait waits until its time; a WorkflowError stays final", async () => {
  const { client, calls } = worker([task(MESSAGE), task(MESSAGE)]);
  let n = 0;
  const notes = triggeredWorkflow({
    name: "word-count",
    version: "v1",
    async onInstances() {
      n += 1;
      if (n === 1)
        throw new WorkflowWait(Date.now() + 60_000, "the parse has not run");
      throw new WorkflowError("bad message");
    },
  });
  const worker2 = new WorkflowWorker(client, [notes], { worker: "w" });
  await worker2.runOnce();
  await worker2.runOnce();
  const fails = calls.filter((c) => c.path === "/v1/workflows/turns/fail");
  assert.equal(fails.length, 2);
  assert.ok(typeof fails[0]?.body.retry_at_ms === "number");
  assert.equal(fails[0]?.body.non_retryable, false);
  assert.equal(fails[1]?.body.retry_at_ms, undefined);
  assert.equal(fails[1]?.body.non_retryable, true);
});

test("a wait of now still waits a second, so a turn that keeps waiting cannot spin", async () => {
  const { client, calls } = worker([task(MESSAGE)]);
  const notes = triggeredWorkflow({
    name: "word-count",
    version: "v1",
    async onInstances() {
      throw new WorkflowWait(Date.now() - 5_000, "a clock behind the server's");
    },
  });
  const before = Date.now();
  await new WorkflowWorker(client, [notes], { worker: "w" }).runOnce();
  const fail = calls.find((c) => c.path === "/v1/workflows/turns/fail");
  assert.ok(
    typeof fail?.body.retry_at_ms === "number" &&
      fail.body.retry_at_ms >= before + 1_000,
    `${fail?.body.retry_at_ms} waits at least a second`,
  );
});

test("requeueFailed asks the watch for the failed instances inside a step", async () => {
  const { client, calls } = worker([task(MESSAGE)]);
  const notes = triggeredWorkflow({
    name: "word-count",
    version: "v1",
    async onInstances(ctx, message) {
      assert.equal(ctx.workflowName, "notes");
      await requeueFailed(
        client,
        ctx,
        "requeue",
        [{ instance: message.instances[0]!, error: "refused" }],
        { graph: message.graph },
      );
      // No failed instance: no call.
      assert.equal(await requeueFailed(client, ctx, "requeue-none", []), null);
    },
  });
  await new WorkflowWorker(client, [notes], { worker: "w" }).runOnce();
  const requeue = calls.find((c) => c.path === "/v1/workflows/named/requeue");
  assert.equal(requeue?.query, "?graph=crm&name=notes");
  assert.deepEqual(requeue?.body, {
    workflow_id: "starter.notes",
    turn: 3,
    items: [{ instance: MESSAGE.instances[0], error: "refused" }],
  });
  const checkpoint = calls.find((c) => c.path.endsWith("/turns/checkpoint"));
  assert.equal(checkpoint?.body.key, "requeue");
});

test("a fan-in identity's message goes to onFanIn, not to the trigger parser", async () => {
  const fanIn = task({ type: "decided", pairs: "rooms/ab" });
  fanIn.turn.workflow_id = "starter.notes.things";
  const { client, calls } = worker([fanIn]);
  const seen: unknown[] = [];
  const notes = triggeredWorkflow({
    name: "word-count",
    version: "v1",
    async onInstances() {
      throw new Error("not a trigger message");
    },
    async onFanIn(ctx, message, state) {
      assert.equal(ctx.workflowName, "notes");
      seen.push(message);
      return { state: { ...(state as object), built: 1 } };
    },
  });
  await new WorkflowWorker(client, [notes], { worker: "w" }).runOnce();
  assert.deepEqual(seen, [{ type: "decided", pairs: "rooms/ab" }]);
  const completed = calls.find(
    (c) => c.path === "/v1/workflows/turns/complete",
  );
  assert.deepEqual(completed?.body.state, { seen: 0, built: 1 });
});
