// LBB activities: the calls a workflow's code makes from a durable step.
// `reason`, `decide` and `embed` run LBB's own models
// (`POST /v1/workflows/activities/*`): LBB meters them against the stack's
// model budget for workflows and writes them to the call log. Pass the
// step's `effectId` and a step that runs again after a crash gets the
// answer it got the first time, at no cost. The other activities are thin
// helpers over routes the client already has: parsed pages, SPARQL, owned
// writes, review items and ontology changes. Reference:
// `docs/reference/workflow-activities.md`.
import type { LbbClient } from "./client.js";
import type { FilePages } from "./files.js";
import {
  writeOwned,
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
import type { WorkflowContext, WorkflowStepContext } from "./workflows.js";

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
}

/** A `reason` request: the prompt, an optional system prompt, the answer's JSON Schema. */
export type ReasonRequest = Omit<
  Schemas["ReasonActivityRequest"],
  "effect_id" | "label"
>;
/** A `reason` answer: `value` (typed by the caller) and the usage. */
export type ReasonResult<T> = Omit<
  Schemas["ReasonActivityResponse"],
  "value"
> & { value: T };
/** A `decide` request: the state and the choice questions by id. */
export type DecideRequest = Omit<
  Schemas["DecideActivityRequest"],
  "effect_id" | "label"
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
  "effect_id" | "label"
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
   * File a review item (`POST /v1/ontology/suggestions`): facts or ontology
   * changes for a person to accept. The same `key` again updates the item,
   * so a failed call is retried.
   */
  review(
    request: ReviewRequest,
    options?: CallOptions,
  ): Promise<Schemas["OntologyChangeSuggestion"]>;
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
): { body: B & { effect_id?: string; label?: string }; call: CallOptions } {
  const { effectId, label, ...call } = options;
  return {
    body: {
      ...request,
      ...(effectId !== undefined ? { effect_id: effectId } : {}),
      ...(label !== undefined ? { label } : {}),
    },
    call: {
      ...call,
      retry: call.retry ?? (effectId !== undefined ? true : "rate_limited"),
    },
  };
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
  return {
    reason<T = unknown>(
      request: ReasonRequest,
      options: ActivityOptions = {},
    ): Promise<ReasonResult<T>> {
      const { body, call } = activityCall(request, options);
      return client.request("POST", "/v1/workflows/activities/reason", {
        timeoutMs: REASON_TIMEOUT_MS,
        ...call,
        body,
      });
    },
    decide(request, options = {}) {
      const { body, call } = activityCall(request, options);
      return client.request("POST", "/v1/workflows/activities/decide", {
        ...call,
        body,
      });
    },
    embed(request, options = {}) {
      const { body, call } = activityCall(request, options);
      return client.request("POST", "/v1/workflows/activities/embed", {
        ...call,
        body,
      });
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
    review(request, options = {}) {
      const { workflow, origin, ...suggestion } = request;
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
    },
    evolve(ops, options = {}) {
      return client.ontology.evolve({ ops }, options);
    },
    ontology(options = {}) {
      return client.request("GET", "/v1/ontology", options);
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
