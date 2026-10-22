// Starter workflows and the workflows of a graph (`client.workflows.starters`,
// `client.workflows.named`, and `client.workflows.triggered`, the same
// workflows by starter and name). A starter workflow is a template: what it
// does, its trigger (a watch on a class and its fields), the outputs it owns
// and its settings. A workflow made from one has a name on the graph. When a
// published commit adds or changes instances that its watch covers, it
// reads them and does its work. Embeddings on
// classes (`search.embed`) and fit sources (`ontology.fit`) are triggered
// workflows too: `client.embeddings` and `client.ontology.fitSources` read
// and write the same documents. A developer workflow (`workflow`) sends the
// instances to a workflow of your worker as messages; handle them with
// `triggeredWorkflow()` and write with `writeOwned()`.
import type { LbbClient, Schemas } from "./client.js";
import { LbbError, type CallOptions, type Query } from "./transport.js";
import type { ListPage } from "./types.js";

/** One triggered workflow: its starter workflow's catalog id and its name. */
export interface TriggeredWorkflowRef {
  /** The catalog id, for example `search.embed` or `ontology.fit`. */
  starter: string;
  /** The name the workflow has on the graph. */
  name: string;
}

/** Paging and the filter of a workflow's runs (`runs`). */
export interface WorkflowRunsOptions extends CallOptions {
  /** The `next_cursor` of the previous page. */
  cursor?: string;
  /** @deprecated The earlier name of `cursor`. */
  before?: string;
  /** Runs per page: 1 to 200, default 50. */
  limit?: number;
  /** Only the runs that ended so. */
  outcome?: Schemas["WorkflowRunOutcome"];
}

/** The hours of a workflow's run stats (`runStats`). */
export interface WorkflowRunStatsOptions extends CallOptions {
  /** Hours up to the current one: 1 to 168, default 24. */
  hours?: number;
}

/** Options of {@link TriggeredWorkflowsNamespace.runs}. */
export type TriggeredWorkflowRunsOptions = WorkflowRunsOptions;

/** Options of {@link TriggeredWorkflowsNamespace.runStats}. */
export type TriggeredWorkflowRunStatsOptions = WorkflowRunStatsOptions;

/** The search, sort and paging of a workflow's documents (`documents`). */
export interface WorkflowDocumentsOptions extends CallOptions {
  /** Only the documents whose name holds this text (any case). */
  q?: string;
  /** `review` (the most review items first; the default), `name`, or
   * `recent` (the last one read first). */
  sort?: Schemas["TriggeredDocumentSort"];
  /** The `next_cursor` of the previous page. */
  cursor?: string;
  /** Documents per page: 1 to 200, default 50. */
  limit?: number;
}

/** Options of {@link TriggeredWorkflowsNamespace.documents}. */
export interface TriggeredWorkflowDocumentsOptions extends WorkflowDocumentsOptions {
  /** @deprecated The earlier name of `cursor`. */
  after?: string;
}

/** Paging of the graph's workflows (`client.workflows.named.list`). */
export interface NamedWorkflowListOptions extends CallOptions {
  /** Workflows per page: 1 to 200, default 100. */
  limit?: number;
  /** The `next_cursor` of the previous page. */
  cursor?: string;
}

/**
 * The names a workflow list had before the list envelope (a server older
 * than `Lbb-Version` 2026-10-21): the field of the items, the field of the
 * next page's cursor, and the query parameter that took the cursor.
 */
interface EarlierList {
  items: string;
  next?: string;
  param?: string;
}

const EARLIER_RUNS: EarlierList = {
  items: "runs",
  next: "next_before",
  param: "before",
};
const EARLIER_DOCUMENTS: EarlierList = {
  items: "documents",
  next: "next_after",
  param: "after",
};

/**
 * One page of a workflow list, in the list envelope. A server older than
 * the envelope answers the earlier shape: the page comes back converted,
 * and a `cursor` it ignored is sent again under its earlier name.
 */
async function listPage<T>(
  client: LbbClient,
  path: string,
  query: Query,
  opts: CallOptions,
  earlier: EarlierList,
): Promise<T> {
  let body = await client.request<unknown>("GET", path, { ...opts, query });
  if (!isEarlierList(body, earlier)) return body as T;
  if (earlier.param && query.cursor !== undefined) {
    const { cursor, ...rest } = query;
    body = await client.request<unknown>("GET", path, {
      ...opts,
      query: { ...rest, [earlier.param]: cursor },
    });
    if (!isEarlierList(body, earlier)) return body as T;
  }
  return asListEnvelope(body, earlier) as T;
}

function isEarlierList(
  body: unknown,
  earlier: EarlierList,
): body is Record<string, unknown> {
  if (typeof body !== "object" || body === null) return false;
  const fields = body as Record<string, unknown>;
  return !Array.isArray(fields.data) && Array.isArray(fields[earlier.items]);
}

/** The earlier shape of a workflow list in the list envelope. */
function asListEnvelope(
  body: Record<string, unknown>,
  earlier: EarlierList,
): ListPage<unknown> & Record<string, unknown> {
  const { [earlier.items]: items, ...rest }: Record<string, unknown> = body;
  const next = earlier.next !== undefined ? rest[earlier.next] : undefined;
  if (earlier.next !== undefined) delete rest[earlier.next];
  const cursor =
    typeof next === "string" || typeof next === "number" ? String(next) : null;
  return {
    object: "list",
    data: items as unknown[],
    has_more: cursor !== null,
    ...(cursor !== null ? { next_cursor: cursor } : {}),
    ...rest,
  };
}

/**
 * The starter workflows this server offers, and creating a workflow from
 * one. Ontology starters (the base ontologies a graph starts from) are
 * `client.ontology.starters`.
 */
export class StarterWorkflowsNamespace {
  constructor(private readonly client: LbbClient) {}

  /**
   * Every starter workflow this server offers: its group, its trigger rule,
   * its settings, the graph kinds it supports, and whether it can run here
   * (`available`, with `unavailable_reason` when it cannot).
   */
  list(opts: CallOptions = {}): Promise<Schemas["StarterWorkflowCatalog"]> {
    return this.client.request("GET", "/v1/workflows/starters", opts);
  }

  /**
   * Create a workflow from a starter workflow, or change one. `starter` is
   * the catalog id (`search.embed`, `ontology.fit@v1`, `workflow`); `watch`
   * names the class and its fields in the path syntax of embeddings;
   * `params` holds the starter workflow's own settings (`model`, `dim` and
   * `title` for `search.embed`, `context` for `ontology.fit`). A developer
   * workflow (`workflow`) takes `workflow` (the `workflow_type` and
   * `version` of your worker that receives the messages), `owns` (the
   * classes, relations and properties your code writes) and `batch`
   * (instances per message, 1 to 64). Without `name` the server takes the
   * class's local name. The same request again is a no-op, so a failed call
   * is retried.
   */
  use(
    request: Schemas["TriggeredWorkflowRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["TriggeredWorkflow"]> {
    return this.client.request("PUT", "/v1/workflows/triggered", {
      ...opts,
      retry: opts.retry ?? true,
      body: request,
    });
  }

  /**
   * Try a starter workflow on its samples (SaaS mode). The server creates a
   * new graph `try-<starter>-<hex>` in this environment, loads the starter
   * workflow's samples, and creates the workflow there with its defaults;
   * `params` replace them key by key. The answer names the graph and its
   * workflows, which then run as usual. Each call makes a new graph, so it
   * is never retried. Delete the graph (`POST /v1/graph/delete`) when done.
   */
  try(
    request: Schemas["StarterWorkflowTryRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["StarterWorkflowTryResponse"]> {
    return this.client.request("POST", "/v1/workflows/starters/try", {
      ...opts,
      retry: false,
      body: request,
    });
  }
}

/**
 * The triggered workflows of the graph, by starter and name: read,
 * preview, run now, pause, delete. `client.workflows.named` reads and
 * changes the same workflows by name; `preview` and the calibration of a
 * gate stay here.
 */
export class TriggeredWorkflowsNamespace {
  constructor(private readonly client: LbbClient) {}

  /**
   * Every triggered workflow of the graph with its status, by starter, then
   * name.
   *
   * @deprecated Use {@link NamedWorkflowsNamespace.list}
   * (`client.workflows.named.list`) or `client.workflows.named.all()`.
   */
  list(opts: CallOptions = {}): Promise<Schemas["TriggeredWorkflowList"]> {
    return this.client.request("GET", "/v1/workflows/triggered", opts);
  }

  /**
   * One triggered workflow: its resolved watch, its settings, its status
   * (state, lag, counters, spend, last error) and its own status in
   * `details`. A name the graph does not have fails with
   * `404 triggered_workflow_not_found`.
   *
   * @deprecated Use {@link NamedWorkflowsNamespace.get}
   * (`client.workflows.named.get`).
   */
  get(
    ref: TriggeredWorkflowRef,
    opts: CallOptions = {},
  ): Promise<Schemas["TriggeredWorkflow"]> {
    return this.client.request("GET", "/v1/workflows/triggered", {
      ...opts,
      query: { starter: ref.starter, name: ref.name },
    });
  }

  /**
   * What creating or changing a workflow would do: the resolved watch, the
   * instance count, and the workflow's own preview in `details` (for a
   * developer workflow, the first messages it would send). Writes nothing.
   * With `propose: true` the workflow's models run on the sample (a dry run
   * of `ontology.fit`) and spend model budget, so that call is not retried
   * unless `retry` is set.
   */
  preview(
    request: Schemas["TriggeredWorkflowPreviewRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["TriggeredWorkflowPreview"]> {
    return this.client.request("POST", "/v1/workflows/triggered/preview", {
      ...opts,
      retry: opts.retry ?? request.propose !== true,
      body: request,
    });
  }

  /**
   * Ask the workflow to run now. Answers at once with the workflow and
   * `queued`; read {@link get} for the progress.
   *
   * @deprecated Use {@link NamedWorkflowsNamespace.run}
   * (`client.workflows.named.run`).
   */
  refresh(
    ref: TriggeredWorkflowRef,
    opts: CallOptions = {},
  ): Promise<Schemas["TriggeredWorkflowRefreshResponse"]> {
    return this.client.request("POST", "/v1/workflows/triggered/refresh", {
      ...opts,
      query: { starter: ref.starter, name: ref.name },
    });
  }

  /**
   * Pause (`paused: true`, the default) or resume (`paused: false`) a
   * triggered workflow: a developer workflow, or one of `documents.parse`,
   * `documents.link`, `documents.map` and `values.extract`. A paused
   * workflow reads and sends nothing; a resume catches up from where it
   * stopped. `search.embed` and `ontology.fit` answer
   * `400 workflow_pause_unsupported`. Returns the
   * triggered workflow; the same call again changes nothing, so a failed
   * call is retried.
   *
   * @deprecated Use {@link NamedWorkflowsNamespace.pause}
   * (`client.workflows.named.pause`).
   */
  pause(
    ref: TriggeredWorkflowRef,
    paused = true,
    opts: CallOptions = {},
  ): Promise<Schemas["TriggeredWorkflow"]> {
    return this.client.request("POST", "/v1/workflows/triggered/pause", {
      ...opts,
      retry: opts.retry ?? true,
      query: { starter: ref.starter, name: ref.name },
      body: { paused } satisfies Schemas["TriggeredWorkflowPauseRequest"],
    });
  }

  /**
   * The runs of a workflow, newest first, by starter and name, in the list
   * envelope. `search.embed` and `ontology.fit` keep no runs
   * (`400 workflow_param_invalid`).
   *
   * @deprecated Use {@link NamedWorkflowsNamespace.runs}
   * (`client.workflows.named.runs`).
   */
  runs(
    ref: TriggeredWorkflowRef,
    options: TriggeredWorkflowRunsOptions = {},
  ): Promise<Schemas["WorkflowRunList"]> {
    const { cursor, before, limit, outcome, ...opts } = options;
    return listPage(
      this.client,
      "/v1/workflows/triggered/runs",
      {
        starter: ref.starter,
        name: ref.name,
        cursor,
        before,
        limit,
        outcome,
      },
      opts,
      EARLIER_RUNS,
    );
  }

  /**
   * One run with its model calls in time order, by starter and name.
   * `404 workflow_run_not_found` for a run the workflow does not have.
   *
   * @deprecated Use {@link NamedWorkflowsNamespace.getRun}
   * (`client.workflows.named.getRun`).
   */
  run(
    ref: TriggeredWorkflowRef,
    runId: string,
    opts: CallOptions = {},
  ): Promise<Schemas["WorkflowRunDetail"]> {
    return this.client.request("GET", "/v1/workflows/triggered/runs/get", {
      ...opts,
      query: { starter: ref.starter, name: ref.name, run: runId },
    });
  }

  /**
   * The runs of a workflow by hour, by starter and name.
   *
   * @deprecated Use {@link NamedWorkflowsNamespace.runStats}
   * (`client.workflows.named.runStats`).
   */
  runStats(
    ref: TriggeredWorkflowRef,
    options: TriggeredWorkflowRunStatsOptions = {},
  ): Promise<Schemas["WorkflowRunStats"]> {
    const { hours, ...opts } = options;
    return this.client.request("GET", "/v1/workflows/triggered/runs/stats", {
      ...opts,
      query: { starter: ref.starter, name: ref.name, hours },
    });
  }

  /**
   * One page of the documents of a `documents.link` or `documents.map`
   * workflow, by starter and name, in the list envelope.
   *
   * @deprecated Use {@link NamedWorkflowsNamespace.documents}
   * (`client.workflows.named.documents`).
   */
  documents(
    ref: TriggeredWorkflowRef,
    options: TriggeredWorkflowDocumentsOptions = {},
  ): Promise<Schemas["TriggeredDocumentPage"]> {
    const { q, sort, cursor, after, limit, ...opts } = options;
    return listPage(
      this.client,
      "/v1/workflows/triggered/documents",
      {
        starter: ref.starter,
        name: ref.name,
        q,
        sort,
        cursor,
        after,
        limit,
      },
      opts,
      EARLIER_DOCUMENTS,
    );
  }

  /**
   * Delete a triggered workflow; the client repeats the name as `confirm`.
   * What it wrote stays. Deleting `search.embed` also removes the embedding
   * and its vectors; the suggestions an `ontology.fit` filed stay in the
   * inbox; a developer workflow leaves its workflow instance and the facts
   * your code wrote.
   *
   * @deprecated Use {@link NamedWorkflowsNamespace.delete}
   * (`client.workflows.named.delete`).
   */
  delete(
    ref: TriggeredWorkflowRef,
    opts: CallOptions = {},
  ): Promise<Schemas["TriggeredWorkflowDeleteResponse"]> {
    return this.client.request("DELETE", "/v1/workflows/triggered", {
      ...opts,
      query: { starter: ref.starter, name: ref.name, confirm: ref.name },
    });
  }
}

/** Paging of a workflow's queue (`client.workflows.named.queue`). */
export interface NamedWorkflowQueueOptions extends CallOptions {
  /** The trigger's id; the workflow's own when absent. */
  trigger?: string;
  /** The `next_cursor` of the page before. */
  cursor?: string;
  /** @deprecated The position to start from; use `cursor`. */
  after?: number;
  /** Items per page, 1 to 100 (default 50). */
  limit?: number;
}

/**
 * Workflows with triggers (`/v1/workflows/named`): a named workflow of the
 * graph has a target workflow type, shards, settings and triggers. A
 * trigger is a watch or a content trigger. A watch: when a published commit
 * adds, changes or removes instances of its class, the watch sends them as
 * messages to the target type's instances, its shards (`starter.<name>`,
 * `starter.<name>.<k>`), routed by `route_by` so the changes of one key
 * stay in order, at most `window` messages queued per shard. A content
 * trigger (`{ content: { media_types: ["application/pdf"] } }`) sends each
 * upload of those media types as it is logged, without a wait for a
 * publication: one content per message, routed by its SHA-256, with an
 * origin of kind `content`. Each message names its origin. The workflows
 * LBB runs list here too, with their `lbb.*` target.
 *
 * The lists (`list`, `runs`, `queue`, `documents`) answer in the list
 * envelope, `{ object: "list", data, has_more, next_cursor }`: pass
 * `next_cursor` as `cursor` for the next page, or iterate every item with
 * `all`, `allRuns` and `allDocuments`.
 */
export class NamedWorkflowsNamespace {
  constructor(private readonly client: LbbClient) {}

  /**
   * One page of the graph's workflows, by name, with their status: at most
   * `limit` (1 to 200, default 100) after `cursor`.
   */
  list(
    options: NamedWorkflowListOptions = {},
  ): Promise<Schemas["NamedWorkflowList"]> {
    const { limit, cursor, ...opts } = options;
    return listPage(
      this.client,
      "/v1/workflows/named",
      { limit, cursor },
      opts,
      { items: "workflows" },
    );
  }

  /**
   * Every workflow of the graph, by name: `list` page by page.
   *
   * ```ts
   * for await (const workflow of client.workflows.named.all()) {
   *   console.log(workflow.name, workflow.status.state);
   * }
   * ```
   */
  all(
    options: Omit<NamedWorkflowListOptions, "cursor"> = {},
  ): AsyncGenerator<Schemas["NamedWorkflow"], void, unknown> {
    return this.client.listAll((cursor) => this.list({ ...options, cursor }));
  }

  /**
   * One workflow: its target, shards, routing, window, trigger, status and
   * each shard's engine state. A name the graph does not have fails with
   * `404 named_workflow_not_found`.
   */
  get(name: string, opts: CallOptions = {}): Promise<Schemas["NamedWorkflow"]> {
    return this.client.request("GET", "/v1/workflows/named", {
      ...opts,
      query: { name },
    });
  }

  /**
   * Create or change a workflow of your worker: `name`, `workflow` (the
   * `workflow_type` and `version` of your worker), one trigger (a `watch`,
   * or a `content` trigger with its `media_types`), and optionally
   * `shards` (1 to 16), `route_by` (a field of the class; a content trigger
   * routes by the content's SHA-256), `window` (1 to 128, default 4),
   * `batch` (1 for a content trigger) and `owns`. A change of `shards` or
   * `route_by` needs every shard's inbox empty (`409 workflow_shards_busy`:
   * pause, let the inboxes drain, then change it). A workflow keeps its
   * trigger's kind. The same request again is a no-op, so a failed call is
   * retried.
   */
  put(
    request: Schemas["NamedWorkflowRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["NamedWorkflow"]> {
    return this.client.request("PUT", "/v1/workflows/named", {
      ...opts,
      retry: opts.retry ?? true,
      body: request,
    });
  }

  /**
   * Run now: the watch reads every instance of its class again and sends
   * them with origin `manual`; a content trigger reads its content log
   * again from the start. Answers at once with `queued`.
   */
  run(
    name: string,
    opts: CallOptions = {},
  ): Promise<Schemas["NamedWorkflowRunResponse"]> {
    return this.client.request("POST", "/v1/workflows/named/run", {
      ...opts,
      query: { name },
    });
  }

  /**
   * Pause (`paused: true`, the default) or resume a workflow: its watch,
   * and every shard of your worker's type (no new claims). A resume
   * catches up. The same call again changes nothing, so a failed call is
   * retried.
   */
  pause(
    name: string,
    paused = true,
    opts: CallOptions = {},
  ): Promise<Schemas["NamedWorkflow"]> {
    return this.client.request("POST", "/v1/workflows/named/pause", {
      ...opts,
      retry: opts.retry ?? true,
      query: { name },
      body: { paused } satisfies Schemas["NamedWorkflowPauseRequest"],
    });
  }

  /**
   * Send instances a turn of a shard could not do again later (`POST
   * /v1/workflows/named/requeue`): they go back into the watch's queue on
   * the asking shard, with origin `requeue` and a backoff of 1, 4, then 16
   * minutes. The server takes the attempt from the asking turn's message;
   * past 3 the instances are exhausted and not sent again. The same
   * request again changes nothing more, so a failed call is retried.
   * `requeueFailed` of a turn calls it inside a step.
   */
  requeue(
    name: string,
    request: Schemas["WorkflowRequeueRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["WorkflowRequeueResponse"]> {
    return this.client.request("POST", "/v1/workflows/named/requeue", {
      ...opts,
      retry: opts.retry ?? true,
      query: { name },
      body: request,
    });
  }

  /**
   * What the watch has not sent yet: each waiting instance with its
   * reason, shard and origin (a backfill, a commit range with the watched
   * fields and the requests that changed it, a run now, a schema change),
   * the pass in progress, and per shard its message in flight, its first
   * unfinished turns with their origins and its running turn's progress.
   * The items are a page in the list envelope (`data`, `has_more`,
   * `next_cursor`); the queue moves as it drains, so a page is a view at
   * one time.
   */
  queue(
    name: string,
    opts: NamedWorkflowQueueOptions = {},
  ): Promise<Schemas["NamedWorkflowQueue"]> {
    const { trigger, cursor, after, limit, ...call } = opts;
    return listPage(
      this.client,
      "/v1/workflows/named/queue",
      { name, trigger, cursor, after, limit },
      call,
      { items: "items", next: "next_after", param: "after" },
    );
  }

  /**
   * The runs of a workflow, newest first: each turn of its shards (each
   * attempt; one that failed and runs again is `retried`), or each step of
   * LBB's own document, values and review workflows, with its origin,
   * outcome, the queue before and after, what it finished, a sample, its
   * steps and phases, and the usage of its model calls. Runs are kept 30
   * days. A page in the list envelope: pass `next_cursor` as `cursor` for
   * the next page.
   */
  runs(
    name: string,
    options: WorkflowRunsOptions = {},
  ): Promise<Schemas["WorkflowRunList"]> {
    const { cursor, before, limit, outcome, ...opts } = options;
    return listPage(
      this.client,
      "/v1/workflows/named/runs",
      { name, cursor, before, limit, outcome },
      opts,
      EARLIER_RUNS,
    );
  }

  /** Every run of a workflow kept, newest first: `runs` page by page. */
  allRuns(
    name: string,
    options: Omit<WorkflowRunsOptions, "cursor" | "before"> = {},
  ): AsyncGenerator<Schemas["WorkflowRunSummary"], void, unknown> {
    return this.client.listAll((cursor) =>
      this.runs(name, { ...options, cursor }),
    );
  }

  /**
   * One run with its model calls in time order (at most 1,000). A node
   * writes its calls every 10 s, so the calls of a run that just ended can
   * come a little later. `404 workflow_run_not_found` for a run the
   * workflow does not have.
   */
  getRun(
    name: string,
    runId: string,
    opts: CallOptions = {},
  ): Promise<Schemas["WorkflowRunDetail"]> {
    return this.client.request("GET", "/v1/workflows/named/runs/get", {
      ...opts,
      query: { name, run: runId },
    });
  }

  /**
   * The runs of a workflow by hour, oldest first, up to the current hour:
   * runs, what they finished, calls, errors, tokens, cost, failed runs, the
   * largest and the last queue, and the time the runs took.
   */
  runStats(
    name: string,
    options: WorkflowRunStatsOptions = {},
  ): Promise<Schemas["WorkflowRunStats"]> {
    const { hours, ...opts } = options;
    return this.client.request("GET", "/v1/workflows/named/runs/stats", {
      ...opts,
      query: { name, hours },
    });
  }

  /**
   * One page of the documents of a `documents.link` or `documents.map`
   * workflow, rows as in its `details.documents` (which lists only the 20
   * with the most review items), with `total`, the documents that match
   * `q`. Another workflow answers `400 workflow_param_invalid`.
   */
  documents(
    name: string,
    options: WorkflowDocumentsOptions = {},
  ): Promise<Schemas["TriggeredDocumentPage"]> {
    const { q, sort, cursor, limit, ...opts } = options;
    return listPage(
      this.client,
      "/v1/workflows/named/documents",
      { name, q, sort, cursor, limit },
      opts,
      EARLIER_DOCUMENTS,
    );
  }

  /** Every document of a `documents.link` or `documents.map` workflow: `documents` page by page. */
  allDocuments(
    name: string,
    options: Omit<WorkflowDocumentsOptions, "cursor"> = {},
  ): AsyncGenerator<unknown, void, unknown> {
    return this.client.listAll((cursor) =>
      this.documents(name, { ...options, cursor }),
    );
  }

  /**
   * Delete a workflow's triggers; the client repeats the name as
   * `confirm`. What it wrote stays, and so do the engine identities of your
   * worker's type.
   */
  delete(
    name: string,
    opts: CallOptions = {},
  ): Promise<Schemas["NamedWorkflowDeleteResponse"]> {
    return this.client.request("DELETE", "/v1/workflows/named", {
      ...opts,
      query: { name, confirm: name },
    });
  }
}

/**
 * What a derivation is of: the content's SHA-256, your workflow type and
 * version, and a digest of the settings (`none` without settings).
 */
export type DerivationKey = Schemas["DerivationKey"];

/** The options of `derive`. */
export interface DeriveOptions extends CallOptions {
  /** Your run's id, kept with the derivation (a turn's message id). */
  runId?: string;
}

/**
 * What `derive` did. `ran` is true when this call did the work and recorded
 * it. Otherwise a derivation existed (or another run recorded one first),
 * and `outputs` are the stored ones.
 *
 * `uploadChanged` is true when this call did the work, but the file was
 * deleted (or deleted and uploaded again) since the check. Then nothing was
 * recorded, `outputs` are this call's and `derivation` is null. The run of
 * the current upload works on the file again.
 */
export type DeriveResult<T> =
  | {
      ran: boolean;
      uploadChanged: false;
      outputs: T;
      derivation: Schemas["Derivation"];
    }
  | { ran: false; uploadChanged: true; outputs: T; derivation: null };

/**
 * Whether an error is the answer of a derivation record whose upload
 * changed (`409 derivation_upload_changed`). The record named the upload
 * of its check, and the file was deleted (or deleted and uploaded again)
 * since. Nothing was recorded; end the run without an error.
 */
export function isDerivationUploadChanged(error: unknown): boolean {
  return (
    error instanceof LbbError && error.code === "derivation_upload_changed"
  );
}

/**
 * Derivations (`/v1/workflows/derivations/*`): the record that one version
 * of a workflow made something of one content with one set of settings,
 * keyed by the content's SHA-256, the workflow type and version, and a
 * digest of the settings. Check before you work on a content and skip it
 * when a derivation exists; record one after. Identical bytes under two
 * names are then worked on once, and a new version or new settings work
 * again. `derive` does the three steps.
 *
 * A derivation belongs to one upload of the file. The check answers it
 * (`content_uploaded_at`); send it back with the record. A record of a
 * file deleted since then records nothing (`isDerivationUploadChanged`).
 */
export class DerivationsNamespace {
  constructor(private readonly client: LbbClient) {}

  /**
   * Whether the key has a derivation: `exists`, and the derivation when
   * there is one. `content_uploaded_at` names the upload of the
   * content's live file; a deleted file has neither. A read, so a failed
   * call is retried.
   */
  check(
    key: Schemas["DerivationKey"],
    opts: CallOptions = {},
  ): Promise<Schemas["DerivationCheckResponse"]> {
    return this.client.request("POST", "/v1/workflows/derivations/check", {
      ...opts,
      retry: opts.retry ?? true,
      body: key,
    });
  }

  /**
   * Record a derivation once: the key, `run_id` (your run's id) and
   * `outputs` (at most 16 KiB of JSON). A second record of the key answers
   * the stored one with `recorded: false`, so a failed call is retried.
   * Send the check's `content_uploaded_at` too. When the file was deleted
   * since the check, nothing is recorded and the call throws `LbbError`
   * 409 `derivation_upload_changed` (`isDerivationUploadChanged`).
   */
  record(
    request: Schemas["DerivationRecordRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["DerivationRecordResponse"]> {
    return this.client.request("POST", "/v1/workflows/derivations/record", {
      ...opts,
      retry: opts.retry ?? true,
      body: request,
    });
  }

  /**
   * Work on one content once per workflow version and settings: check the
   * derivation of `key`; when one exists, return its outputs without
   * running `work`; else run `work` and record what it returns (at most
   * 16 KiB of JSON). Identical bytes under two names are worked on once. A
   * run that stops after `work` and before the record runs `work` again,
   * so make `work`'s writes idempotent (effect ids, owned writes). The
   * record names the upload the check answered. When the file was deleted
   * during `work`, nothing is recorded and the result has
   * `uploadChanged: true`.
   *
   * ```ts
   * const sha = message.origin?.sha256;
   * await client.workflows.derivations.derive(
   *   { sha256: sha, workflow_type: "acme.parse", version: "v1", settings_digest: "none" },
   *   () => parse(sha),
   *   { runId: turn.messageId },
   * );
   * ```
   */
  async derive<T>(
    key: DerivationKey,
    work: () => Promise<T>,
    options: DeriveOptions = {},
  ): Promise<DeriveResult<T>> {
    const { runId, ...call } = options;
    const checked = await this.check(key, call);
    if (checked.exists && checked.derivation) {
      return {
        ran: false,
        uploadChanged: false,
        outputs: checked.derivation.outputs as T,
        derivation: checked.derivation,
      };
    }
    const outputs = await work();
    const upload = checked.content_uploaded_at;
    let recorded: Schemas["DerivationRecordResponse"];
    try {
      recorded = await this.record(
        {
          ...key,
          ...(runId !== undefined ? { run_id: runId } : {}),
          outputs: outputs ?? null,
          ...(upload ? { content_uploaded_at: upload } : {}),
        },
        call,
      );
    } catch (error) {
      if (!isDerivationUploadChanged(error)) throw error;
      return { ran: false, uploadChanged: true, outputs, derivation: null };
    }
    return {
      ran: recorded.recorded,
      uploadChanged: false,
      outputs: (recorded.recorded ? outputs : recorded.derivation.outputs) as T,
      derivation: recorded.derivation,
    };
  }
}
