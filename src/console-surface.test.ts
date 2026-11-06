import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, type FetchLike } from "./client.js";
import type { Schemas } from "./types.js";

/**
 * The console-visible routes the guides document as ordinary API surface:
 * plan/value-order index upgrades, workflow engine status, fit-text,
 * thresholds and the readable calibration sessions. A drift test pins the
 * hand-written wrappers so a namespace edit cannot drop one silently.
 */

type FetchCall = {
  input: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
};

type FetchResponse = { status?: number; body?: string };

function recordingFetch(
  responses: FetchResponse | FetchResponse[] = { status: 200, body: "{}" },
): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const fallback = Array.isArray(responses)
    ? responses[responses.length - 1]
    : responses;
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    const next = queue.shift() ?? fallback ?? {};
    return {
      ok: (next.status ?? 200) >= 200 && (next.status ?? 200) < 300,
      status: next.status ?? 200,
      headers: { get: () => null },
      text: async () => next.body ?? "{}",
    };
  };
  return { fetch, calls };
}

function queryParams(call: FetchCall): Record<string, string> {
  return Object.fromEntries(new URL(call.input).searchParams);
}

function stringBody(body: unknown): string {
  if (typeof body !== "string") {
    assert.fail("expected a string request body");
  }
  return body;
}

test("graph index-upgrade plan, queue and job poll wrap the contract routes", async () => {
  const queue = recordingFetch();
  const client = new LbbClient({
    baseUrl: "https://db.example.test",
    graph: "main",
    fetch: queue.fetch,
  });
  const graph = client.graph("main");

  await graph.indexUpgradePlan({ target: "recipes/2024-01" });
  await graph.indexUpgrade({ dryRun: false });
  await graph.indexUpgradeJob("job_1");

  const [plan, upgrade, job] = queue.calls;
  assert.equal(plan.init.method, "GET");
  assert.equal(new URL(plan.input).pathname, "/v1/graph/index-upgrade");
  assert.equal(queryParams(plan).target, "recipes/2024-01");

  assert.equal(upgrade.init.method, "POST");
  assert.equal(new URL(upgrade.input).pathname, "/v1/graph/index-upgrade");
  assert.equal(typeof upgrade.init.headers?.["idempotency-key"], "string");
  const body = JSON.parse(stringBody(upgrade.init.body)) as {
    dry_run: boolean;
  };
  assert.equal(body.dry_run, false);

  assert.equal(job.init.method, "GET");
  assert.equal(new URL(job.input).pathname, "/v1/graph/index-upgrade/job");
  assert.equal(queryParams(job).job_id, "job_1");
});

test("workflow engine status and triggered gate calibration reads", async () => {
  const calls = recordingFetch();
  const client = new LbbClient({
    baseUrl: "https://db.example.test",
    graph: "main",
    fetch: calls.fetch,
  });

  await client.workflows.status({ expectedGraphEpoch: "7" });
  await client.workflows.triggered.calibration({ includeBatch: true });

  const [status, gates] = calls.calls;
  assert.equal(status.init.method, "GET");
  assert.equal(new URL(status.input).pathname, "/v1/workflows/status");
  assert.equal(queryParams(status).expected_graph_epoch, "7");

  assert.equal(gates.init.method, "GET");
  assert.equal(
    new URL(gates.input).pathname,
    "/v1/workflows/triggered/calibration",
  );
  assert.equal(queryParams(gates).include_batch, "true");
});

test("workflow status preserves a full u64 epoch on an epoch-scoped client", async () => {
  const calls = recordingFetch();
  const epoch = "18446744073709551615";
  const client = new LbbClient({
    baseUrl: "https://db.example.test",
    graph: "main",
    expectedGraphEpoch: epoch,
    fetch: calls.fetch,
  });

  await client.workflows.status({ expectedGraphEpoch: epoch });
  await client.workflows.status();
  for (const call of calls.calls) {
    assert.equal(queryParams(call).expected_graph_epoch, epoch);
    assert.equal(
      new URL(call.input).searchParams.getAll("expected_graph_epoch").length,
      1,
    );
  }
});

test("fit-text posts its body with a default idempotency key", async () => {
  const calls = recordingFetch();
  const client = new LbbClient({
    baseUrl: "https://db.example.test",
    graph: "main",
    fetch: calls.fetch,
  });

  await client.ontology.fitText({
    name: "support-notes",
    text: "Contact submit persons read the manual.",
    context: "Support tickets, one paragraph each.",
  });
  await client.ontology.fitText(
    { text: "again" },
    {
      idempotencyKey: "fit:support-notes:2",
    },
  );

  const [first, second] = calls.calls;
  assert.equal(first.init.method, "POST");
  assert.equal(new URL(first.input).pathname, "/v1/ontology/fit-text");
  assert.equal(typeof first.init.headers?.["idempotency-key"], "string");
  const body = JSON.parse(
    stringBody(first.init.body),
  ) as Schemas["FitTextRequest"];
  assert.equal(body.name, "support-notes");

  assert.equal(new URL(second.input).pathname, "/v1/ontology/fit-text");
  assert.equal(second.init.headers?.["idempotency-key"], "fit:support-notes:2");
});

test("model thresholds and calibration sessions read behind the API key", async () => {
  const calls = recordingFetch();
  const client = new LbbClient({
    baseUrl: "https://db.example.test",
    graph: "main",
    fetch: calls.fetch,
  });

  await client.models.thresholds();
  await client.models.calibration.list({ limit: 5 });
  await client.models.calibration.get("cal_1");
  await client.models.calibration.start({ job: "route" });

  const [thresholds, list, one, start] = calls.calls;
  assert.equal(thresholds.init.method, "GET");
  assert.equal(new URL(thresholds.input).pathname, "/v1/models/thresholds");
  assert.equal(queryParams(thresholds).graph, "main");

  assert.equal(list.init.method, "GET");
  assert.equal(new URL(list.input).pathname, "/v1/models/calibration");
  assert.equal(queryParams(list).limit, "5");

  assert.equal(one.init.method, "GET");
  assert.equal(new URL(one.input).pathname, "/v1/models/calibration/get");
  assert.equal(queryParams(one).id, "cal_1");

  assert.equal(start.init.method, "POST");
  assert.equal(new URL(start.input).pathname, "/v1/models/calibration");
  const body = JSON.parse(
    stringBody(start.init.body),
  ) as Schemas["ModelCalibrationStartRequest"];
  assert.equal(body.job, "route");
});

for (const route of ["fit-text", "calibration"] as const) {
  const invoke = (client: LbbClient) =>
    route === "fit-text"
      ? client.ontology.fitText({ text: "one text" })
      : client.models.calibration.start({ job: "route" });

  test(`${route} does not replay a lost response or a server error`, async () => {
    let attempts = 0;
    const lostResponse = new Error("response connection lost");
    const client = new LbbClient({
      baseUrl: "https://db.example.test",
      graph: "main",
      maxRetries: 2,
      retryDelayMs: 0,
      fetch: async () => {
        attempts += 1;
        throw lostResponse;
      },
    });
    await assert.rejects(
      invoke(client),
      (error: unknown) => error === lostResponse,
    );
    assert.equal(attempts, 1);

    const calls = recordingFetch({ status: 503 });
    const unavailable = new LbbClient({
      baseUrl: "https://db.example.test",
      graph: "main",
      maxRetries: 2,
      retryDelayMs: 0,
      fetch: calls.fetch,
    });
    await assert.rejects(invoke(unavailable));
    assert.equal(calls.calls.length, 1);
  });

  test(`${route} retries rate limiting but stops on a subsequent server error`, async () => {
    const calls = recordingFetch([{ status: 429 }, { status: 503 }]);
    const client = new LbbClient({
      baseUrl: "https://db.example.test",
      graph: "main",
      maxRetries: 2,
      retryDelayMs: 0,
      fetch: calls.fetch,
    });
    await assert.rejects(invoke(client));
    assert.equal(calls.calls.length, 2);
  });
}
