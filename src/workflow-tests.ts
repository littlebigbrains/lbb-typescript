// Workflow tests (`client.workflows.tests`): run a workflow on chosen inputs
// before it writes. A test reads each input as the live workflow would and
// writes nothing to the graph; a person answers each value, and the answers
// save as the test's one Evals dataset (`client.evals.datasets.create` with
// `source: { kind: "test", id }`). The first workflow a test runs is LBB's
// `values.extract`. A test goes `queued` → `running` → `done`, `failed` or
// `cancelled`; poll `get`, or `wait`.
// Reference: `docs/reference/starter-workflows.md` ("Test a workflow").
import type { LbbClient, Schemas } from "./client.js";
import type { CallOptions } from "./transport.js";

/**
 * A test: its frozen settings, its inputs, per input the values read, and
 * the id of the dataset saved from its answers (`dataset`).
 */
export type WorkflowTest = Schemas["WorkflowTest"];
/** What a test runs: a workflow of the graph (`name`) or a create request (`install`); the inputs. */
export type WorkflowTestCreateRequest = Schemas["WorkflowTestCreateRequest"];
/** A person's answer to one value of a test. */
export type WorkflowTestAnswerRequest = Schemas["WorkflowTestAnswerRequest"];
/** One page of tests. */
export type WorkflowTestList = Schemas["WorkflowTestList"];

/** The filters and the page of {@link WorkflowTestsNamespace.list}. */
export interface WorkflowTestListOptions extends CallOptions {
  /** The tests of the workflow of this name. */
  name?: string;
  /** Tests per page, 1 to 50; default 10. */
  limit?: number;
  /** The `next_cursor` of the previous page. */
  cursor?: string;
}

/** How {@link WorkflowTestsNamespace.wait} polls. */
export interface WorkflowTestWaitOptions extends CallOptions {
  /** Time between two reads. Default 1,000 ms. */
  intervalMs?: number;
  /**
   * Throw a `TimeoutError` when the test is still open after this long.
   * Default 10 minutes.
   */
  timeoutMs?: number;
}

/** Whether a test still reads inputs (`queued` or `running`). */
export function isWorkflowTestOpen(
  test: Pick<WorkflowTest, "status">,
): boolean {
  return test.status === "queued" || test.status === "running";
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

/** `client.workflows.tests`: create, get, list, all, answer, cancel and wait. */
export class WorkflowTestsNamespace {
  constructor(private readonly client: LbbClient) {}

  /**
   * Start a test. Name a workflow of the graph (`name`) or a workflow to
   * create (`install`), and `iris` (at most 20) or a `sample` of the
   * watched class (default 6). The test starts `queued`. The client sends
   * an idempotency key (or yours), so a retry answers the same test; the
   * same key with another body fails with `409 idempotency_conflict`.
   * `429 workflow_budget_exceeded` when the test may cost more than the
   * environment's monthly budget has left.
   */
  create(
    request: WorkflowTestCreateRequest,
    opts: CallOptions = {},
  ): Promise<WorkflowTest> {
    return this.client.request("POST", "/v1/workflows/named/tests", {
      ...opts,
      idempotencyKey:
        opts.idempotencyKey ??
        this.client.idempotencyKey("workflow-tests.create"),
      body: request,
    });
  }

  /** One test, with its inputs' texts and its results. */
  get(id: string, opts: CallOptions = {}): Promise<WorkflowTest> {
    return this.client.request("GET", "/v1/workflows/named/tests/get", {
      ...opts,
      query: { id },
    });
  }

  /** One page of the graph's tests, newest first, without texts and results. */
  list(options: WorkflowTestListOptions = {}): Promise<WorkflowTestList> {
    const { name, limit, cursor, ...opts } = options;
    return this.client.request("GET", "/v1/workflows/named/tests", {
      ...opts,
      query: { name, limit, cursor },
    });
  }

  /** Every test the filters match, page after page. */
  async *all(
    options: Omit<WorkflowTestListOptions, "cursor"> = {},
  ): AsyncGenerator<WorkflowTest> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...options, cursor });
      yield* page.data;
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor);
  }

  /**
   * Answer one value of a read input: `accept`, `reject`, `correct` with
   * the right `value`, or `cant_tell`; `answer: null` removes the answer.
   * Writes nothing to the graph. The client sends an idempotency key (or
   * yours), so a retry is safe.
   */
  answer(
    request: WorkflowTestAnswerRequest,
    opts: CallOptions = {},
  ): Promise<WorkflowTest> {
    return this.client.request("POST", "/v1/workflows/named/tests/answer", {
      ...opts,
      idempotencyKey:
        opts.idempotencyKey ??
        this.client.idempotencyKey("workflow-tests.answer"),
      body: request,
    });
  }

  /**
   * Stop a queued or running test. What it read stays; a test that ended
   * stays as it is, so a retry is safe.
   */
  cancel(id: string, opts: CallOptions = {}): Promise<WorkflowTest> {
    return this.client.request("POST", "/v1/workflows/named/tests/cancel", {
      ...opts,
      retry: opts.retry ?? true,
      query: { id },
    });
  }

  /**
   * Read the test until it ends (`done`, `failed` or `cancelled`), and
   * return it. Throws an `Error` named `TimeoutError` when the test is
   * still open after `timeoutMs` (default 10 minutes).
   */
  async wait(
    id: string,
    options: WorkflowTestWaitOptions = {},
  ): Promise<WorkflowTest> {
    const { intervalMs = 1_000, timeoutMs = 600_000, ...opts } = options;
    const until = Date.now() + timeoutMs;
    for (;;) {
      const test = await this.get(id, opts);
      if (!isWorkflowTestOpen(test)) return test;
      if (Date.now() >= until) {
        throw Object.assign(
          new Error(`workflow test ${id} is still ${test.status}`),
          { name: "TimeoutError" },
        );
      }
      await sleep(intervalMs, opts.signal);
    }
  }
}
