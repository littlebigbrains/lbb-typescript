// Starter workflows and triggered workflows (`client.workflows.starters`,
// `client.workflows.triggered`). A starter workflow is a template: what it
// does, its trigger (a watch on a class and its fields), the outputs it owns
// and its settings. A triggered workflow is a workflow created from one on a
// graph, under a name. When a published commit adds or changes instances
// that its watch covers, it reads them and does its work. Embeddings on
// classes (`search.embed`) and fit sources (`ontology.fit`) are triggered
// workflows too: `client.embeddings` and `client.ontology.fitSources` read
// and write the same documents. A developer workflow (`workflow`) sends the
// instances to a workflow of your worker as messages; handle them with
// `triggeredWorkflow()` and write with `writeOwned()`.
import type { LbbClient, Schemas } from "./client.js";
import type { CallOptions } from "./transport.js";

/** One triggered workflow: its starter workflow's catalog id and its name. */
export interface TriggeredWorkflowRef {
  /** The catalog id, for example `search.embed` or `ontology.fit`. */
  starter: string;
  /** The name the workflow has on the graph. */
  name: string;
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

/** The triggered workflows of the graph: read, preview, run now, pause, delete. */
export class TriggeredWorkflowsNamespace {
  constructor(private readonly client: LbbClient) {}

  /** Every triggered workflow of the graph with its status, by starter, then name. */
  list(opts: CallOptions = {}): Promise<Schemas["TriggeredWorkflowList"]> {
    return this.client.request("GET", "/v1/workflows/triggered", opts);
  }

  /**
   * One triggered workflow: its resolved watch, its settings, its status
   * (state, lag, counters, spend, last error) and its own status in
   * `details`. A name the graph does not have fails with
   * `404 triggered_workflow_not_found`.
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
   * Delete a triggered workflow; the client repeats the name as `confirm`.
   * What it wrote stays. Deleting `search.embed` also removes the embedding
   * and its vectors; the suggestions an `ontology.fit` filed stay in the
   * inbox; a developer workflow leaves its workflow instance and the facts
   * your code wrote.
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
  /** The position to start from: `next_after` of the page before. */
  after?: number;
  /** Items per page, 1 to 100 (default 50). */
  limit?: number;
}

/**
 * Workflows with triggers (`/v1/workflows/named`): a named workflow of the
 * graph has a target workflow type, shards, settings and triggers. A
 * trigger is a watch: when a published commit adds, changes or removes
 * instances of its class, the watch sends them as messages to the target
 * type's instances, its shards (`starter.<name>`, `starter.<name>.<k>`),
 * routed by `route_by` so the changes of one key stay in order, at most
 * `window` messages queued per shard. Each message names its origin. The
 * workflows LBB runs list here too, with their `lbb.*` target. The
 * triggered workflows of `client.workflows.triggered` are the same
 * workflows in their older shape.
 */
export class NamedWorkflowsNamespace {
  constructor(private readonly client: LbbClient) {}

  /** Every workflow with triggers of the graph, by name, with its status. */
  list(opts: CallOptions = {}): Promise<Schemas["NamedWorkflowList"]> {
    return this.client.request("GET", "/v1/workflows/named", opts);
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
   * `workflow_type` and `version` of your worker), one `watch` trigger,
   * and optionally `shards` (1 to 16), `route_by` (a field of the class),
   * `window` (1 to 128, default 4), `batch` and `owns`. A change of
   * `shards` or `route_by` needs every shard's inbox empty
   * (`409 workflow_shards_busy`: pause, let the inboxes drain, then change
   * it). The same request again is a no-op, so a failed call is retried.
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
   * them with origin `manual`. Answers at once with `queued`.
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
   * What the watch has not sent yet: each waiting instance with its
   * reason, shard and origin (a backfill, a commit range with the watched
   * fields and the requests that changed it, a run now, a schema change),
   * the pass in progress, and per shard its message in flight, its first
   * unfinished turns with their origins and its running turn's progress.
   */
  queue(
    name: string,
    opts: NamedWorkflowQueueOptions = {},
  ): Promise<Schemas["NamedWorkflowQueue"]> {
    const { trigger, after, limit, ...call } = opts;
    return this.client.request("GET", "/v1/workflows/named/queue", {
      ...call,
      query: {
        name,
        ...(trigger !== undefined ? { trigger } : {}),
        ...(after !== undefined ? { after: String(after) } : {}),
        ...(limit !== undefined ? { limit: String(limit) } : {}),
      },
    });
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
