// Evals experiments (`client.evals.experiments`): two configurations of a
// workflow, A and B, on the items of one dataset, and the difference of B
// against A with a 95% interval. A is the workflow as it runs now; B changes
// one part of it, the model of one use or the settings revision. Each arm
// runs as a workflow test that writes nothing to the graph; each item is
// graded against the dataset's labels. An experiment goes `queued` →
// `running` → `done`, `failed` or `cancelled`; poll `get`, or `wait`. To use
// B, make the same change yourself with the `experiment` id: `models.choices
// .put({ ..., experiment })` or `workflows.named.activateRevision(name, id,
// { experiment })`. Reference: `docs/reference/server.md` ("Evals
// experiments").
import type { LbbClient, Schemas } from "./client.js";
import type { CallOptions } from "./transport.js";

/**
 * An experiment: its two arms, its status, one row per item with both arms'
 * grades (from `get`), and the report.
 */
export type EvalExperiment = Schemas["EvalExperiment"];
/** What to run: a workflow, a dataset, and what B changes (`b`). */
export type EvalExperimentCreateRequest =
  Schemas["EvalExperimentCreateRequest"];
/** What a start would estimate, with the cost limit and the budget left. */
export type EvalExperimentEstimate = Schemas["EvalExperimentEstimate"];
/** One page of experiments. */
export type EvalExperimentList = Schemas["EvalExperimentList"];

/** The filters and the page of {@link EvalExperimentsNamespace.list}. */
export interface EvalExperimentListOptions extends CallOptions {
  /** The experiments of the workflow of this name. */
  workflow?: string;
  /** The experiments on this dataset. */
  dataset?: string;
  /** `queued`, `running`, `done`, `failed` or `cancelled`. */
  status?: EvalExperiment["status"];
  /** Experiments per page, 1 to 50; default 20. */
  limit?: number;
  /** The `next_cursor` of the previous page. */
  cursor?: string;
}

/** How {@link EvalExperimentsNamespace.wait} polls. */
export interface EvalExperimentWaitOptions extends CallOptions {
  /** Time between two reads. Default 2,000 ms. */
  intervalMs?: number;
  /**
   * Throw a `TimeoutError` when the experiment is still open after this
   * long. Default 30 minutes.
   */
  timeoutMs?: number;
}

/** Whether an experiment still runs (`queued` or `running`). */
export function isEvalExperimentOpen(
  experiment: Pick<EvalExperiment, "status">,
): boolean {
  return experiment.status === "queued" || experiment.status === "running";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** `client.evals.experiments`: create, estimate, list, all, get, cancel and wait. */
export class EvalExperimentsNamespace {
  constructor(private readonly client: LbbClient) {}

  /**
   * Start an experiment. A is the workflow's configuration in use; `b`
   * changes one part of it: `{ model: { use: "extract", model: { provider,
   * model, effort? } } }` (a model of the use's `options` in
   * `client.models.choices.list()`) or `{ revision: "wrev_…" }` (a kept
   * revision of the workflow's settings), not both (`400
   * experiment_arms_mixed`). The first `max_items` items of the dataset run
   * (at most 200, default 200). The estimate must fit `max_cost_usd`
   * (default 5, at most 100) and the environment's monthly workflow budget
   * (`429 workflow_budget_exceeded`); `estimate` shows it first. The
   * experiment starts `queued`; the experiments of a graph run one at a
   * time. The client sends an idempotency key (or yours), so a retry
   * answers the same experiment; the same key with another body fails with
   * `409 idempotency_conflict`.
   */
  create(
    request: EvalExperimentCreateRequest,
    opts: CallOptions = {},
  ): Promise<EvalExperiment> {
    return this.client.request("POST", "/v1/evals/experiments", {
      ...opts,
      idempotencyKey:
        opts.idempotencyKey ??
        this.client.idempotencyKey("eval-experiments.create"),
      body: request,
    });
  }

  /**
   * What a start with the same body would estimate for both arms, with the
   * cost limit and what is left of the monthly budget. It runs no model and
   * writes nothing, so a retry is safe.
   */
  estimate(
    request: EvalExperimentCreateRequest,
    opts: CallOptions = {},
  ): Promise<EvalExperimentEstimate> {
    return this.client.request("POST", "/v1/evals/experiments/estimate", {
      ...opts,
      retry: opts.retry ?? true,
      body: request,
    });
  }

  /**
   * One experiment with its items. A final experiment whose dataset changed
   * since it was scored says `report.stale`; a turn then scores it again.
   */
  get(id: string, opts: CallOptions = {}): Promise<EvalExperiment> {
    return this.client.request("GET", "/v1/evals/experiments/get", {
      ...opts,
      query: { id },
    });
  }

  /** One page of the graph's experiments, newest first, without items. */
  list(options: EvalExperimentListOptions = {}): Promise<EvalExperimentList> {
    const { workflow, dataset, status, limit, cursor, ...opts } = options;
    return this.client.request("GET", "/v1/evals/experiments", {
      ...opts,
      query: { workflow, dataset, status, limit, cursor },
    });
  }

  /** Every experiment the filters match, page after page. */
  async *all(
    options: Omit<EvalExperimentListOptions, "cursor"> = {},
  ): AsyncGenerator<EvalExperiment> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...options, cursor });
      yield* page.data;
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor);
  }

  /**
   * Stop an experiment that has not ended. It keeps the items it compared;
   * a batch in flight finishes and counts its cost. An experiment that
   * ended stays as it is, so a retry is safe. The client sends an
   * idempotency key (or yours).
   */
  cancel(id: string, opts: CallOptions = {}): Promise<EvalExperiment> {
    return this.client.request("POST", "/v1/evals/experiments/cancel", {
      ...opts,
      retry: opts.retry ?? true,
      idempotencyKey:
        opts.idempotencyKey ??
        this.client.idempotencyKey("eval-experiments.cancel"),
      query: { id },
    });
  }

  /**
   * Read the experiment until it ends (`done`, `failed` or `cancelled`),
   * and return it. Throws an `Error` named `TimeoutError` when it is still
   * open after `timeoutMs` (default 30 minutes).
   */
  async wait(
    id: string,
    options: EvalExperimentWaitOptions = {},
  ): Promise<EvalExperiment> {
    const { intervalMs = 2_000, timeoutMs = 1_800_000, ...opts } = options;
    const until = Date.now() + timeoutMs;
    for (;;) {
      const experiment = await this.get(id, opts);
      if (!isEvalExperimentOpen(experiment)) return experiment;
      if (Date.now() >= until) {
        throw Object.assign(
          new Error(`experiment ${id} is still ${experiment.status}`),
          { name: "TimeoutError" },
        );
      }
      await sleep(intervalMs, opts.signal);
    }
  }
}
