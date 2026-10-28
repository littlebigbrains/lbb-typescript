// Evals datasets (`client.evals.datasets`): named sets of examples with the
// outputs a correct run gives, which workflow tests, experiments and
// template evals share. The first kind is `values`: each item holds an input
// text, the property values a correct run reads from it, and the values it
// must leave out. A dataset exports in the files of a template's samples
// (`records.json` and `expected.json`), and an answer key loads back as the
// same items. A workflow test has one dataset: saving the test again brings
// that dataset up to date. Reference: `docs/reference/server.md` ("Evals
// datasets").
import type { LbbClient, Schemas } from "./client.js";
import type { CallOptions } from "./transport.js";

/** A dataset: its name, kind, grading settings and, from `get`, its items. */
export type EvalDataset = Schemas["EvalDataset"];
/** One example: a name, the input text, `values` and `leave_out`. */
export type EvalDatasetItem = Schemas["EvalDatasetItem"];
/** One label of an item: a value in `values`, or in `leave_out` one a correct run must not write. */
export type EvalExpectedValue = Schemas["EvalExpectedValue"];
/** Who gave a label: a person's answer on a test or a review item, `{ kind, id, at }`. */
export type EvalGradeSource = Schemas["EvalGradeSource"];
/** A dataset to create: items, or a `source` (a workflow test). */
export type EvalDatasetCreateRequest = Schemas["EvalDatasetCreateRequest"];
/** A dataset as a template's samples: `records` and `expected`. */
export type EvalDatasetExport = Schemas["EvalDatasetExport"];
/** One page of datasets. */
export type EvalDatasetList = Schemas["EvalDatasetList"];
/** A deleted dataset: `{ id, object: "eval_dataset", deleted: true }`. */
export type EvalDatasetDeleted = Schemas["EvalDatasetDeleted"];

/** The page of {@link EvalDatasetsNamespace.list}. */
export interface EvalDatasetListOptions extends CallOptions {
  /** Datasets per page, 1 to 50; default 20. */
  limit?: number;
  /** The `next_cursor` of the previous page. */
  cursor?: string;
}

/** `client.evals.datasets`: create, list, all, get, addItems, export and delete. */
export class EvalDatasetsNamespace {
  constructor(private readonly client: LbbClient) {}

  /**
   * Create a dataset with its first `items`, or save a workflow test's
   * answers (`source: { kind: "test", id }`). A test has one dataset, which
   * the test names (`test.dataset`): saving the test again brings that
   * dataset up to date and returns it with the same id. At most 500 items.
   * The client sends an idempotency key (or yours), so a retry answers the
   * same dataset; the same key with another body fails with
   * `409 idempotency_conflict`.
   */
  create(
    request: EvalDatasetCreateRequest,
    opts: CallOptions = {},
  ): Promise<EvalDataset> {
    return this.client.request("POST", "/v1/evals/datasets", {
      ...opts,
      idempotencyKey:
        opts.idempotencyKey ??
        this.client.idempotencyKey("eval-datasets.create"),
      body: request,
    });
  }

  /** One page of the graph's datasets, newest first, without their items. */
  list(options: EvalDatasetListOptions = {}): Promise<EvalDatasetList> {
    const { limit, cursor, ...opts } = options;
    return this.client.request("GET", "/v1/evals/datasets", {
      ...opts,
      query: { limit, cursor },
    });
  }

  /** Every dataset, page after page. */
  async *all(
    options: Omit<EvalDatasetListOptions, "cursor"> = {},
  ): AsyncGenerator<EvalDataset> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...options, cursor });
      yield* page.data;
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor);
  }

  /** One dataset with its items. */
  get(id: string, opts: CallOptions = {}): Promise<EvalDataset> {
    return this.client.request("GET", "/v1/evals/datasets/get", {
      ...opts,
      query: { id },
    });
  }

  /**
   * Add items (`POST /v1/evals/datasets/items`). An item with the name of
   * an item the dataset has replaces it in its place. The client sends an
   * idempotency key (or yours), so a retry is safe.
   */
  addItems(
    id: string,
    items: EvalDatasetItem[],
    opts: CallOptions = {},
  ): Promise<EvalDataset> {
    return this.client.request("POST", "/v1/evals/datasets/items", {
      ...opts,
      idempotencyKey:
        opts.idempotencyKey ??
        this.client.idempotencyKey("eval-datasets.items"),
      body: { id, items },
    });
  }

  /**
   * The dataset as a template's samples: `records` (records.json) and
   * `expected` (expected.json).
   */
  export(id: string, opts: CallOptions = {}): Promise<EvalDatasetExport> {
    return this.client.request("GET", "/v1/evals/datasets/export", {
      ...opts,
      query: { id },
    });
  }

  /**
   * Delete a dataset and its items. A get or an export of it then fails
   * with `404`, and the next save of its test makes a new dataset. A
   * repeated delete returns the same answer. The client sends an
   * idempotency key (or yours), so a retry is safe.
   */
  delete(id: string, opts: CallOptions = {}): Promise<EvalDatasetDeleted> {
    return this.client.request("DELETE", "/v1/evals/datasets", {
      ...opts,
      idempotencyKey:
        opts.idempotencyKey ??
        this.client.idempotencyKey("eval-datasets.delete"),
      query: { id },
    });
  }
}
