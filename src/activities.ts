// LBB activities: the calls a workflow's code makes from a durable step.
// `reason`, `decide` and `embed` run LBB's own models
// (`POST /v1/workflows/activities/*`): LBB meters them against the stack's
// model budget for workflows and writes them to the call log. Pass the
// step's `effectId` and a step that runs again after a crash gets the
// answer it got the first time, at no cost. The other activities are thin
// helpers over routes the client already has: parsed pages, SPARQL, owned
// writes, review items and ontology changes. A model activity called from
// a step of a `WorkflowWorker` turn names the turn's run (`workflow`), so
// the call log links the call to the run, and its usage adds up for the
// turn's completion: the worker's code does nothing for it. Reference:
// `docs/reference/workflow-activities.md`.
import type { LbbClient } from "./client.js";
import type { FilePages } from "./files.js";
import type { OntologySuggestionListOptions } from "./namespaces.js";
import {
  ownedCommitBody,
  requeueFailed,
  writeOwned,
  type FailedInstance,
  type OwnedWrite,
  type OwnedWriteOptions,
  type OwnedWriteResult,
} from "./triggered-workflow-worker.js";
import { LbbError, type CallOptions } from "./transport.js";
import type {
  ReadConsistencyOptions,
  Schemas,
  SparqlResults,
} from "./types.js";
import {
  activityTurn,
  addTurnUsage,
  WorkflowError,
  type ActivityTurn,
  type WorkflowContext,
  type WorkflowStepContext,
} from "./workflows.js";

/** The options of a model activity (`reason`, `decide`, `embed`). */
export interface ActivityOptions extends CallOptions {
  /**
   * The effect id of the step that makes the call: pass `s.effectId` of
   * `ctx.step(key, (s) => …)` as it is. The server keeps the first answer
   * under it, and the same request again returns that answer with
   * `cached: true` at no cost. Another request under the same effect id
   * fails with `409 activity_effect_conflict`. A step that makes several
   * calls of one activity gives each its own id, for example
   * `${s.effectId}.2`. `[A-Za-z0-9_.:/-]`, 1 to 200 characters.
   */
  effectId?: string;
  /** A short name for the call log, at most 64 characters. */
  label?: string;
  /**
   * What the call works on, for the call log and the run's page: an
   * instance IRI or a document's name, at most 512 characters. The turn
   * and its run are set from the step context.
   */
  instance?: string;
}

/** A `reason` request: the prompt, an optional system prompt, the answer's JSON Schema. */
export type ReasonRequest = Omit<
  Schemas["ReasonActivityRequest"],
  "effect_id" | "label" | "workflow"
>;
/** A `reason` answer: `value` (typed by the caller) and the usage. */
export type ReasonResult<T> = Omit<
  Schemas["ReasonActivityResponse"],
  "value"
> & { value: T };
/** A `decide` request: the state and the choice questions by id. */
export type DecideRequest = Omit<
  Schemas["DecideActivityRequest"],
  "effect_id" | "label" | "workflow"
>;
/** One choice question: what to decide and the options by id. */
export type DecideQuestion = Schemas["DecideActivityQuestion"];
/** The answer of one question: `choice`, `confidence` and `probabilities`. */
export type DecideAnswer = Schemas["DecideActivityAnswer"];
/** A `decide` answer: the answers by question id, and the usage. */
export type DecideResult = Schemas["DecideActivityResponse"];
/** An `embed` request: 1 to 256 texts, each at most 8,000 characters. */
export type EmbedRequest = Omit<
  Schemas["EmbedActivityRequest"],
  "effect_id" | "label" | "workflow"
>;
/** An `embed` answer: one vector per text, the model, `dim` and the usage. */
export type EmbedResult = Schemas["EmbedActivityResponse"];

/**
 * A review item: a suggestion in the graph's review inbox that a person
 * accepts or dismisses. `facts` are the graph facts accepting it commits;
 * `change` the ontology changes it applies. `workflow` names the triggered
 * workflow that files it (pass `message.workflow`): the item's origin is
 * then `{ kind: "agent", id: "starter:<workflow>" }`, so the workflow's
 * status counts it. `origin` sets the origin instead. `key` makes a repeat
 * update the same item instead of filing a second one.
 */
export type ReviewRequest = Omit<
  Schemas["OntologyChangeSuggestionCreateRequest"],
  "origin"
> & {
  workflow?: string;
  origin?: Schemas["SuggestionOrigin"];
};

/**
 * A question for a person of another kind than a change
 * (`POST /v1/reviews`): a `value` to confirm or correct, a `choice`, a
 * `grade` or a free-text `answer`. `workflow` names the workflow that asks,
 * by its name or with its run and step: the item's origin is then
 * `{ kind: "agent", id: "starter:<name>" }`, and a workflow with a review
 * trigger receives the answer. An answer of a `value` writes the value.
 */
export type ReviewItemRequest = Omit<
  Schemas["ReviewItemCreateRequest"],
  "origin" | "workflow" | "wait"
> & {
  workflow?: string | Schemas["ReviewWorkflowOrigin"];
  origin?: Schemas["SuggestionOrigin"];
};

/** What `waitForReview` returns: the answer, or none when the wait timed out. */
export type ReviewWaitResult =
  | {
      answered: true;
      answer: Schemas["ReviewAnswer"];
      item: Schemas["ReviewItem"];
    }
  | { answered: false; answer: null; item: Schemas["ReviewItem"] };

/** Keys one read of `reviewItems` names, at most (the list route's bound). */
const REVIEW_KEYS_PER_READ = 100;

/** The body of `POST /v1/reviews` for a request. */
function reviewItemBody(
  request: ReviewItemRequest,
  run?: { identity: string; turn: number },
): Schemas["ReviewItemCreateRequest"] {
  const { workflow, origin, ...item } = request;
  const named = typeof workflow === "string" ? { name: workflow } : workflow;
  const asking = named && run ? { ...named, ...run } : named;
  return {
    ...item,
    // An item that names no workflow is filed by the run itself: its
    // origin id is the run's identity.
    origin: origin ?? {
      kind: "agent",
      ...(named
        ? { id: `starter:${named.name}` }
        : run
          ? { id: run.identity }
          : {}),
    },
    ...(asking ? { workflow: asking } : {}),
    ...(run ? { wait: { ...run, signal: "" } } : {}),
  };
}

/** The page range of `pages`: 0-based, `to` is the first page not read. */
export interface ActivityPagesOptions extends CallOptions {
  /** The first page index. Default 0. */
  from?: number;
  /** The page index after the last one. Default: the end of the file. */
  to?: number;
}

/**
 * The activities of a workflow, bound to one client and its graph. Make one
 * with {@link lbbActivities}; a test can hand a workflow its own object of
 * this shape.
 */
export interface LbbActivities {
  /**
   * The reasoning model answers `prompt` with JSON that follows `schema`
   * (`POST /v1/workflows/activities/reason`). `T` types the answer's
   * `value`. A request the model cannot answer (too large, or no usable
   * answer) fails with `422 activity_request_refused`: see
   * {@link isActivityRefused}.
   */
  reason<T = unknown>(
    request: ReasonRequest,
    options?: ActivityOptions,
  ): Promise<ReasonResult<T>>;
  /**
   * The decision model answers each choice question about `state` with one
   * option, a confidence and the probability of each option
   * (`POST /v1/workflows/activities/decide`). A question the model did not
   * answer is missing from `answers`.
   */
  decide(
    request: DecideRequest,
    options?: ActivityOptions,
  ): Promise<DecideResult>;
  /** The server's embedding model embeds `texts` (`POST /v1/workflows/activities/embed`). */
  embed(request: EmbedRequest, options?: ActivityOptions): Promise<EmbedResult>;
  /**
   * The parsed pages of a file: each page's lines with their ids, texts,
   * boxes and words (`GET /v1/files/pages`, 50 pages per call). Without
   * `to`, it reads to the end of the file.
   */
  pages(sha256: string, options?: ActivityPagesOptions): Promise<FilePages>;
  /**
   * A SPARQL query (SELECT or ASK) with its rows flattened to
   * `{ variable: value }` (`POST /v1/query/sparql-text`). Pass
   * `as_of_commit_seq` in the request to read at a trigger message's
   * commit; `consistency: "strong"` in the options reads the commits that
   * are not published yet, your own writes included.
   */
  sparql(
    request: string | Schemas["SparqlTextRequest"],
    options?: ReadConsistencyOptions,
  ): Promise<SparqlResults>;
  /**
   * Commit an owned write inside the step `stepKey`, with the step's effect
   * id as the idempotency key: `writeOwned(client, ctx, …)` bound to this
   * client. A `write` function gets the step's context.
   */
  writeOwned(
    ctx: WorkflowContext,
    stepKey: string,
    write:
      | OwnedWrite
      | ((step: WorkflowStepContext) => OwnedWrite | Promise<OwnedWrite>),
    options?: OwnedWriteOptions,
  ): Promise<OwnedWriteResult>;
  /**
   * Send the instances a turn could not do back to the watch, inside the
   * step `stepKey`: `requeueFailed(client, ctx, …)` bound to this client.
   * Past 3 attempts the instances are exhausted. Without failed instances
   * it calls nothing.
   */
  requeue(
    ctx: WorkflowContext,
    stepKey: string,
    failed: readonly FailedInstance[],
    options?: { graph?: string },
  ): Promise<Schemas["WorkflowRequeueResponse"] | null>;
  /**
   * File a review item (`POST /v1/ontology/suggestions`): facts or ontology
   * changes for a person to accept. The same `key` again updates the item,
   * so a failed call is retried.
   */
  review(
    request: ReviewRequest,
    options?: CallOptions,
  ): Promise<Schemas["OntologyChangeSuggestion"]>;
  /**
   * Ask a person (`POST /v1/reviews`): a value to confirm or correct, a
   * choice, a grade or a free-text answer. Returns at once; the answer
   * reaches a workflow with a review trigger as a `review.answered`
   * message. The same `key` again updates the item.
   */
  review(
    request: ReviewItemRequest,
    options?: CallOptions,
  ): Promise<Schemas["ReviewItem"]>;
  /**
   * The review items filed under `keys`, of every status
   * (`GET /v1/reviews?key=…`, 100 keys a read): a workflow reads them
   * before it writes, so a person's answer wins over what it would write
   * itself, and an item asked again on new evidence keeps the answer in
   * force (`previous_answer`) until a new one.
   */
  reviewItems(
    keys: string[],
    options?: CallOptions,
  ): Promise<Schemas["ReviewItem"][]>;
  /**
   * Ask a person and wait for the answer without holding a worker: files
   * the item in the step `<key>.ask` with this run as the one that waits,
   * then waits for the answer's signal (`<key>.answer`). An answer that came
   * before the wait is taken at once. When the wait times out, the step
   * `<key>.read` reads the item again, so an answer whose signal was lost
   * still counts. Only for a run with its own identity: a trigger shard
   * (`starter.<name>`) serves many inputs, and a wait would hold them all,
   * so it is refused there; file with `review` and take the answer with a
   * review trigger instead.
   */
  waitForReview(
    ctx: WorkflowContext,
    key: string,
    request: ReviewItemRequest,
    options: { timeoutMs: number },
  ): Promise<ReviewWaitResult>;
  /**
   * The suggestions (`change` review items), newest update first, with
   * counts per status (`GET /v1/ontology/suggestions`):
   * `client.ontology.suggestions.list`.
   * Filter by `originId` (`starter:<workflow>`, `fit:<source>`), `status`,
   * `key` or `anchor`.
   */
  listReviews(
    options?: OntologySuggestionListOptions,
  ): Promise<Schemas["OntologyChangeSuggestionList"]>;
  /**
   * The suggestion (a `change` review item) filed under `key`, with its
   * evidence and facts, or null when none is: a merge of new evidence into
   * an item reads it first. `reviewItems` reads the items of every kind.
   */
  reviewItem(
    key: string,
    options?: CallOptions,
  ): Promise<Schemas["OntologyChangeSuggestion"] | null>;
  /**
   * Change the ontology (`POST /v1/ontology/evolve`). With `dryRun: true`
   * it writes nothing and answers what the change would do: `no_op` when
   * the ontology has it already.
   */
  evolve(
    ops: Schemas["OntologyEvolveOp"][],
    options?: CallOptions & { dryRun?: boolean },
  ): Promise<Schemas["OntologyEvolveResponse"]>;
  /** The graph's ontology: classes, relations and properties (`GET /v1/ontology`). */
  ontology(options?: CallOptions): Promise<Schemas["OntologyView"]>;
}

/** Output tokens of a `reason` call can take minutes: its default timeout. */
const REASON_TIMEOUT_MS = 300_000;
/** Pages one `GET /v1/files/pages` returns at most. */
const PAGES_PER_CALL = 50;

/**
 * The request body and call options of a model activity. With an effect id
 * a retry is safe (a repeat returns the kept answer), so 5xx and network
 * failures are retried; without one only a `429` the server returns before
 * it runs the request is.
 */
function activityCall<B extends object>(
  request: B,
  options: ActivityOptions,
): {
  body: B & {
    effect_id?: string;
    label?: string;
    workflow?: Schemas["ActivityWorkflow"];
  };
  call: CallOptions;
  turn: ActivityTurn | undefined;
} {
  const { effectId, label, instance, ...call } = options;
  // The turn of the step that makes the call (none outside a turn).
  const turn = activityTurn(effectId);
  return {
    body: {
      ...request,
      ...(effectId !== undefined ? { effect_id: effectId } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(turn
        ? {
            workflow: {
              ...turn.workflow,
              ...(instance !== undefined ? { instance } : {}),
            },
          }
        : {}),
    },
    call: {
      ...call,
      retry: call.retry ?? (effectId !== undefined ? true : "rate_limited"),
    },
    turn,
  };
}

/** What an activity answer reports it used. */
interface ActivityUsage {
  tokens_in?: number;
  tokens_out?: number;
  cost_micro_usd?: number;
  cached?: boolean;
}

/**
 * Add a model activity's usage to its turn: an answer that is not `cached`
 * is one call; a refusal (422) or a model that did not answer (5xx) is a
 * call that failed. A kept answer cost nothing and is no call.
 */
async function counted<T extends ActivityUsage>(
  turn: ActivityTurn | undefined,
  answer: Promise<T>,
): Promise<T> {
  if (!turn) return answer;
  try {
    const answered = await answer;
    if (!answered.cached)
      addTurnUsage(turn, {
        calls: 1,
        tokens_in: answered.tokens_in ?? 0,
        tokens_out: answered.tokens_out ?? 0,
        cost_micro_usd: answered.cost_micro_usd ?? 0,
      });
    return answered;
  } catch (error) {
    if (
      error instanceof LbbError &&
      (error.status === 422 || error.status >= 500)
    )
      addTurnUsage(turn, { calls: 1, errors: 1 });
    throw error;
  }
}

/**
 * The LBB activities of `client`, for the graph the client is scoped to (a
 * workflow worker serves the graph of its client).
 *
 * ```ts
 * const lbb = lbbActivities(client);
 * const answer = await ctx.step("define-p3", (s) =>
 *   lbb.reason<{ code: string }>(
 *     { prompt, schema },
 *     { effectId: s.effectId, label: "define p3" },
 *   ),
 * );
 * ```
 */
export function lbbActivities(client: LbbClient): LbbActivities {
  const activities: LbbActivities = {
    reason<T = unknown>(
      request: ReasonRequest,
      options: ActivityOptions = {},
    ): Promise<ReasonResult<T>> {
      const { body, call, turn } = activityCall(request, options);
      return counted(
        turn,
        client.request<ReasonResult<T>>(
          "POST",
          "/v1/workflows/activities/reason",
          {
            timeoutMs: REASON_TIMEOUT_MS,
            ...call,
            body,
          },
        ),
      );
    },
    decide(request, options = {}) {
      const { body, call, turn } = activityCall(request, options);
      return counted(
        turn,
        client.request<DecideResult>(
          "POST",
          "/v1/workflows/activities/decide",
          {
            ...call,
            body,
          },
        ),
      );
    },
    embed(request, options = {}) {
      const { body, call, turn } = activityCall(request, options);
      return counted(
        turn,
        client.request<EmbedResult>("POST", "/v1/workflows/activities/embed", {
          ...call,
          body,
        }),
      );
    },
    async pages(sha256, options = {}) {
      const { from = 0, to, ...call } = options;
      const first = await client.files.pages(sha256, {
        ...call,
        from,
        to: Math.min(to ?? from + PAGES_PER_CALL, from + PAGES_PER_CALL),
      });
      const end = Math.min(to ?? first.page_count, first.page_count);
      const pages = [...first.pages];
      for (let at = first.to; at < end; at += PAGES_PER_CALL) {
        const more = await client.files.pages(sha256, {
          ...call,
          from: at,
          to: Math.min(end, at + PAGES_PER_CALL),
        });
        pages.push(...more.pages);
      }
      return { ...first, from, to: Math.max(first.to, end), pages };
    },
    sparql(request, options) {
      return client.sparqlRows(
        typeof request === "string" ? { query: request } : request,
        options,
      );
    },
    writeOwned(ctx, stepKey, write, options) {
      return writeOwned(client, ctx, stepKey, write, options);
    },
    requeue(ctx, stepKey, failed, options) {
      return requeueFailed(client, ctx, stepKey, failed, options);
    },
    review: ((
      request: ReviewRequest | ReviewItemRequest,
      options: CallOptions = {},
    ) => {
      if ("kind" in request && request.kind && request.kind !== "change") {
        return client.reviews.create(reviewItemBody(request), options);
      }
      const { workflow, origin, ...suggestion } = request as ReviewRequest;
      return client.ontology.suggestions.create(
        {
          ...suggestion,
          origin: origin ?? {
            kind: "agent",
            ...(workflow ? { id: `starter:${workflow}` } : {}),
          },
        },
        options,
      );
    }) as LbbActivities["review"],
    async reviewItems(keys, options = {}) {
      const unique = [...new Set(keys)];
      const out: Schemas["ReviewItem"][] = [];
      for (let at = 0; at < unique.length; at += REVIEW_KEYS_PER_READ) {
        const chunk = unique.slice(at, at + REVIEW_KEYS_PER_READ);
        const page = await client.reviews.list({
          ...options,
          key: chunk,
          limit: chunk.length,
        });
        out.push(...page.data);
      }
      return out;
    },
    async waitForReview(ctx, key, request, { timeoutMs }) {
      refuseTriggerShard(ctx);
      const item = await ctx.step(`${key}.ask`, () =>
        client.reviews.create(
          reviewItemBody(request, {
            identity: ctx.workflowId,
            turn: ctx.turn,
          }),
        ),
      );
      if (item.status !== "open" && item.answer) {
        return { answered: true, answer: item.answer, item };
      }
      const signal = item.wait?.signal;
      if (!signal) {
        throw new WorkflowError(
          `review item ${item.id} names no signal to wait for`,
        );
      }
      const got = await ctx.waitForSignal<Schemas["ReviewAnswer"]>(
        `${key}.answer`,
        { name: signal, timeoutMs },
      );
      if (got.received) return { answered: true, answer: got.value, item };
      // The wait timed out: the answer may have come and its signal not
      // (a dropped event). Read the item again.
      const now = await ctx.step(`${key}.read`, () =>
        client.reviews.get(item.id),
      );
      return now.status === "answered" && now.answer
        ? { answered: true, answer: now.answer, item: now }
        : { answered: false, answer: null, item: now };
    },
    listReviews(options = {}) {
      return client.ontology.suggestions.list(options);
    },
    async reviewItem(key, options = {}) {
      const list = await client.ontology.suggestions.list({
        ...options,
        key,
        limit: 1,
      });
      const found = list.suggestions.find((item) => item.key === key);
      return found
        ? client.ontology.suggestions.get(found.suggestion_id, options)
        : null;
    },
    evolve(ops, options = {}) {
      return client.ontology.evolve({ ops }, options);
    },
    ontology(options = {}) {
      return client.request("GET", "/v1/ontology", options);
    },
  };
  // `captureActivities` checks writes with this client.
  Object.defineProperty(activities, ACTIVITIES_CLIENT, { value: client });
  return activities;
}

/**
 * A trigger shard (`starter.<name>`) serves many inputs, and a wait would
 * hold them all: `waitForReview` refuses it, live and in a capture.
 */
function refuseTriggerShard(ctx: WorkflowContext): void {
  if (ctx.workflowId.startsWith("starter.")) {
    throw new WorkflowError(
      `waitForReview needs a run with its own identity: ${ctx.workflowId} serves many inputs, and a wait would hold them all. File the item with review() and take the answer with a review trigger.`,
    );
  }
}

/** The client {@link lbbActivities} made the activities with. */
const ACTIVITIES_CLIENT = Symbol.for("littlebigbrain.activities.client");

/** One owned write a captured workflow made, as it would commit it. */
export interface CapturedWrite {
  /** The step key the workflow wrote under. */
  stepKey: string;
  /** The graph it would write: the client's, or `options.graph`. */
  graph?: string;
  /** The commit body: the owned triplets and fields and their `replace_owned`. */
  body: Schemas["TripletCommitFile"];
  /**
   * How it was checked: `dry_run` (`POST /v1/graph/commit?dry_run=true`,
   * the server's own validation), or `shape` (a local check of the body,
   * for an RDF-native graph, whose commits have no dry run, or a capture
   * without a client).
   */
  check: "dry_run" | "shape";
  /** Why the check refused it; empty when it passes. */
  errors: string[];
  /** What the dry run reports the write would do. */
  report?: Schemas["GraphCommitDryRunResponse"];
}

/** One review item a captured workflow filed. */
export interface CapturedReview {
  /** A change (`ReviewRequest`), or a question of another kind. */
  request: ReviewRequest | ReviewItemRequest;
}

/** What a captured workflow would have written and filed, in call order. */
export interface ActivityCaptureResult {
  writes: CapturedWrite[];
  reviews: CapturedReview[];
}

/** Activities that write nothing, and what they kept. */
export interface ActivityCapture {
  /**
   * The activities to hand the workflow. The models and the reads run as
   * they do in `activities`; `writeOwned` checks its write and keeps it
   * instead of committing it, and `review` keeps its item instead of
   * filing it (the item it answers is `open`); `evolve` runs as a dry run.
   */
  readonly activities: LbbActivities;
  /** What was kept so far. */
  result(): ActivityCaptureResult;
  /** Forget what was kept. */
  reset(): void;
}

/**
 * A local check of an owned commit body: each named entity has a type and
 * a name (or an id), each edge a source, a relation and a target, each field
 * a name. The errors, empty when it passes.
 */
function shapeErrors(body: Schemas["TripletCommitFile"]): string[] {
  const errors: string[] = [];
  const named = (
    entity: { type?: string | null; name?: string | null } | undefined,
    where: string,
  ) => {
    if (!entity?.type?.trim() || !entity.name?.trim())
      errors.push(`${where} needs a type and a name`);
  };
  body.triplets?.forEach((triplet, i) => {
    named(triplet.source, `triplets[${i}].source`);
    named(triplet.target, `triplets[${i}].target`);
    if (!triplet.relation?.trim())
      errors.push(`triplets[${i}].relation is empty`);
  });
  body.entity_properties?.forEach((entity, i) => {
    if (!entity.entity_id) named(entity, `entity_properties[${i}]`);
    const properties = Array.isArray(entity.properties)
      ? entity.properties
      : Object.keys(entity.properties ?? {}).map((field) => ({ field }));
    properties.forEach((property: { field?: string }, j: number) => {
      if (!property.field?.trim())
        errors.push(`entity_properties[${i}].properties[${j}] has no field`);
    });
  });
  const owned = body.replace_owned;
  if (owned) {
    // The commit's own checks of `replace_owned`.
    const entities =
      (owned.subjects?.length ?? 0) + (owned.retract_entities?.length ?? 0);
    if (entities === 0)
      errors.push(
        "replace_owned needs at least one subject or one entity in retract_entities",
      );
    if (entities > REPLACE_OWNED_ENTITIES_MAX)
      errors.push(
        `replace_owned names ${entities} entities; at most ${REPLACE_OWNED_ENTITIES_MAX}`,
      );
    for (const [field, names] of [
      ["relations", owned.relations],
      ["properties", owned.properties],
    ] as const)
      if ((names?.length ?? 0) > REPLACE_OWNED_NAMES_MAX)
        errors.push(
          `replace_owned.${field} holds at most ${REPLACE_OWNED_NAMES_MAX} names`,
        );
    owned.subjects?.forEach((subject, i) =>
      named(subject, `replace_owned.subjects[${i}]`),
    );
    owned.retract_entities?.forEach((entity, i) =>
      named(entity, `replace_owned.retract_entities[${i}]`),
    );
  }
  return errors;
}

/** The entities and the names one `replace_owned` holds at most. */
const REPLACE_OWNED_ENTITIES_MAX = 1_000;
const REPLACE_OWNED_NAMES_MAX = 64;

/** A review item as a capture answers it: kept, not filed, and `open`. */
/** A question of another kind than a change (`POST /v1/reviews`). */
function isItemRequest(
  request: ReviewRequest | ReviewItemRequest,
): request is ReviewItemRequest {
  return (
    "kind" in request && Boolean(request.kind) && request.kind !== "change"
  );
}

/** The open review item a captured question stands for; nothing is filed. */
function capturedItem(
  request: ReviewItemRequest,
  n: number,
): Schemas["ReviewItem"] {
  const body = reviewItemBody(request);
  const now = new Date().toISOString();
  return {
    ...body,
    id: `captured_${n}`,
    object: "review_item",
    key: body.key ?? `captured_${n}`,
    scope: body.scope ?? "test",
    status: "open",
    revision: 1,
    created: now,
    updated: now,
  };
}

function capturedSuggestion(
  request: ReviewRequest,
  n: number,
): Schemas["OntologyChangeSuggestion"] {
  const { workflow, origin, ...item } = request;
  const now = new Date().toISOString();
  return {
    ...item,
    suggestion_id: `captured_${n}`,
    key: request.key ?? `captured_${n}`,
    title: request.title,
    anchor: request.anchor ?? { kind: "ontology" },
    change: request.change ?? [],
    origin: origin ?? {
      kind: "agent",
      ...(workflow ? { id: `starter:${workflow}` } : {}),
    },
    graph: { tenant_id: "", graph_id: "", branch_id: "main" },
    revision: 1,
    status: "open",
    created_at: now,
    updated_at: now,
  } as Schemas["OntologyChangeSuggestion"];
}

/**
 * Activities that write nothing: run a workflow on chosen inputs with
 * them, and read what it would write (`result()`). The models and the reads
 * run (and spend) as they do live; each `writeOwned` is checked (a local
 * check of its shape, then the commit's dry run,
 * `POST /v1/graph/commit?dry_run=true`) and kept, each `review` of every
 * kind is kept and filed nowhere, `waitForReview` keeps its item and ends
 * at once without an answer (a trigger shard is refused, as live), `requeue`
 * sends nothing back to the watch (it
 * answers `null`), and `evolve` runs as a dry run. The reads
 * (`reviewItems`, `listReviews`, `reviewItem`) run. On an RDF-native graph
 * the dry run refuses the write, as the commit would (`rdf_native_graph`).
 *
 * The `reason` and `decide` calls name the test (`test: { workflow }`, the
 * `workflow` option, default `test`): the call log shows them under
 * `tests/<workflow>`, and calibration, model checks and trials leave them
 * out. That needs a server with workflow tests; an older one answers
 * `400` to the field.
 *
 * ```ts
 * const capture = captureActivities(lbbActivities(client), { workflow: "sinks" });
 * const workflow = createWorkflow(capture.activities);
 * // … run the workflow on a trigger message …
 * const { writes, reviews } = capture.result();
 * ```
 *
 * `client` checks the writes; it defaults to the client the activities
 * were made with by {@link lbbActivities}. Without one, the writes get the
 * local check only.
 */
export function captureActivities(
  activities: LbbActivities,
  options: { client?: LbbClient; workflow?: string } = {},
): ActivityCapture {
  // The calls of a capture are a test's: `tests/<workflow>` in the call log.
  const test = { workflow: options.workflow ?? "test" };
  const client =
    options.client ??
    (activities as unknown as { [ACTIVITIES_CLIENT]?: LbbClient })[
      ACTIVITIES_CLIENT
    ];
  let writes: CapturedWrite[] = [];
  let reviews: CapturedReview[] = [];
  let filed = 0;
  async function check(
    body: Schemas["TripletCommitFile"],
    graph: string | undefined,
  ): Promise<Pick<CapturedWrite, "check" | "errors" | "report">> {
    const errors = shapeErrors(body);
    if (!client || errors.length) return { check: "shape", errors };
    const target = graph ? client.withScope({ graph }) : client;
    try {
      return {
        check: "dry_run",
        errors: [],
        report: await target.commitDryRun(body),
      };
    } catch (error) {
      if (
        !(error instanceof LbbError) ||
        error.status >= 500 ||
        error.status === 429
      )
        throw error;
      // The dry run refuses what the commit refuses: on an RDF-native graph
      // (`rdf_native_graph`) the commit of an owned write is refused too.
      return { check: "dry_run", errors: [error.message] };
    }
  }
  // The reads and models of `activities`, called on it: a class instance
  // keeps its methods on its prototype.
  const captured: LbbActivities = {
    reason: (request, options) =>
      activities.reason({ ...request, test }, options),
    decide: (request, options) =>
      activities.decide({ ...request, test }, options),
    embed: (request, options) => activities.embed(request, options),
    pages: (sha256, options) => activities.pages(sha256, options),
    sparql: (request, options) => activities.sparql(request, options),
    ontology: (options) => activities.ontology(options),
    writeOwned(ctx, stepKey, write, writeOptions = {}) {
      const { graph, edgeIdempotency, ...stepOptions } = writeOptions;
      return ctx.step(
        stepKey,
        async (step): Promise<OwnedWriteResult> => {
          const body = ownedCommitBody(
            typeof write === "function" ? await write(step) : write,
            edgeIdempotency,
          );
          if (body) {
            writes.push({
              stepKey,
              ...(graph ? { graph } : {}),
              body,
              ...(await check(body, graph)),
            });
          }
          return {
            commit_seq: null,
            idempotency_key: step.effectId,
            replayed: false,
            owned: null,
            entities_written: 0,
            edges_written: 0,
          };
        },
        stepOptions,
      );
    },
    // A test sends nothing back to the watch.
    requeue: async () => null,
    // Every kind of review item is kept, not filed.
    review: (async (request: ReviewRequest | ReviewItemRequest) => {
      reviews.push({ request });
      filed += 1;
      return isItemRequest(request)
        ? capturedItem(request, filed)
        : capturedSuggestion(request, filed);
    }) as LbbActivities["review"],
    // An item a test asks is kept and never answered: the wait ends at once.
    // A trigger shard is refused, as the live call refuses it.
    async waitForReview(ctx, _key, request) {
      refuseTriggerShard(ctx);
      reviews.push({ request });
      filed += 1;
      return {
        answered: false,
        answer: null,
        item: capturedItem(request, filed),
      };
    },
    reviewItems: (keys, itemsOptions) =>
      activities.reviewItems(keys, itemsOptions),
    listReviews: (listOptions) => activities.listReviews(listOptions),
    reviewItem: (key, itemOptions) => activities.reviewItem(key, itemOptions),
    evolve(ops, evolveOptions = {}) {
      return activities.evolve(ops, { ...evolveOptions, dryRun: true });
    },
  };
  return {
    activities: captured,
    result: () => ({ writes: [...writes], reviews: [...reviews] }),
    reset() {
      writes = [];
      reviews = [];
    },
  };
}

/**
 * Whether `error` is the refusal of a model activity: `422
 * activity_request_refused`. The model provider refused the request as
 * too large or malformed, or the reasoning model gave no usable answer.
 * The same request fails again; split it (see {@link splitInHalves}),
 * make it smaller, or raise `max_tokens`.
 *
 * ```ts
 * async function ask(items: Item[], id: string): Promise<Answers> {
 *   try {
 *     return await lbb.decide(requestFor(items), { effectId: id });
 *   } catch (error) {
 *     const halves = isActivityRefused(error) ? splitInHalves(items) : null;
 *     if (!halves) throw error;
 *     return { ...(await ask(halves[0], `${id}.0`)), ...(await ask(halves[1], `${id}.1`)) };
 *   }
 * }
 * ```
 */
export function isActivityRefused(error: unknown): boolean {
  return error instanceof LbbError && error.code === "activity_request_refused";
}

/**
 * The two halves of `items` (the first one the smaller when the count is
 * odd), or `null` for fewer than two items, which cannot be split. The
 * split of a refused request: send each half as its own request.
 */
export function splitInHalves<T>(items: readonly T[]): [T[], T[]] | null {
  if (items.length < 2) return null;
  const middle = Math.floor(items.length / 2);
  return [items.slice(0, middle), items.slice(middle)];
}
