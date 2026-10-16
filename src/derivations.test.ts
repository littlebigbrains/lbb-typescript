import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, LbbError, type FetchLike } from "./client.js";
import { isDerivationUploadChanged } from "./triggered-workflows.js";

interface Seen {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown> | undefined;
}

type Answer = { status?: number; body?: unknown };

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
    });
    const answer = answers.shift() ?? { body: {} };
    const status = answer.status ?? 200;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => JSON.stringify(answer.body ?? {}),
    };
  };
  return { fetch, seen };
}

function derivations(answers: Answer[]) {
  const { fetch, seen } = fakeFetch(answers);
  const client = new LbbClient({
    baseUrl: "http://h",
    graph: "tender",
    fetch,
    retryDelayMs: 0,
    maxRetries: 2,
  });
  return { derivations: client.workflows.derivations, seen };
}

const KEY = {
  sha256: "ab".repeat(32),
  workflow_type: "acme.parse",
  version: "v1",
  settings_digest: "none",
};
const DERIVATION = {
  ...KEY,
  run_id: "starter-pdfs-1",
  outputs: { pages: 12 },
  recorded_at: "2026-10-14T10:00:00Z",
};

test("derive skips the work when the content has a derivation", async () => {
  const { derivations: api, seen } = derivations([
    { body: { exists: true, derivation: DERIVATION } },
  ]);
  let worked = 0;
  const result = await api.derive<{ pages: number }>(KEY, async () => {
    worked += 1;
    return { pages: 1 };
  });

  assert.equal(worked, 0);
  assert.equal(result.ran, false);
  assert.deepEqual(result.outputs, { pages: 12 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.method, "POST");
  assert.equal(seen[0]?.path, "/v1/workflows/derivations/check");
  assert.equal(seen[0]?.query, "?graph=tender");
  assert.deepEqual(seen[0]?.body, KEY);
});

test("derive works on a content once and records what it made", async () => {
  const { derivations: api, seen } = derivations([
    { body: { exists: false } },
    {
      body: {
        recorded: true,
        derivation: { ...DERIVATION, outputs: { pages: 3 } },
      },
    },
  ]);
  const result = await api.derive(KEY, async () => ({ pages: 3 }), {
    runId: "starter-pdfs-1",
  });

  assert.equal(result.ran, true);
  assert.deepEqual(result.outputs, { pages: 3 });
  assert.equal(seen[1]?.path, "/v1/workflows/derivations/record");
  assert.deepEqual(seen[1]?.body, {
    ...KEY,
    run_id: "starter-pdfs-1",
    outputs: { pages: 3 },
  });
});

test("derive answers the stored derivation when another run recorded first", async () => {
  const { derivations: api } = derivations([
    { body: { exists: false } },
    { body: { recorded: false, derivation: DERIVATION } },
  ]);
  const result = await api.derive(KEY, async () => ({ pages: 1 }));

  assert.equal(result.ran, false);
  assert.equal(result.uploadChanged, false);
  assert.deepEqual(result.outputs, { pages: 12 });
  assert.equal(result.derivation?.run_id, "starter-pdfs-1");
});

test("a derivation check is retried after a server error", async () => {
  const { derivations: api, seen } = derivations([
    {
      status: 503,
      body: { error: { code: "unavailable", message: "x", retryable: true } },
    },
    { body: { exists: false } },
  ]);
  const checked = await api.check(KEY);

  assert.equal(checked.exists, false);
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.path, "/v1/workflows/derivations/check");
});

const UPLOAD = "2026-10-15T09:00:00.123456+00:00";

test("derive records for the upload its check named", async () => {
  const { derivations: api, seen } = derivations([
    { body: { exists: false, content_uploaded_at: UPLOAD } },
    { body: { recorded: true, derivation: DERIVATION } },
  ]);
  const result = await api.derive(KEY, async () => ({ pages: 12 }), {
    runId: "starter-pdfs-1",
  });

  assert.equal(result.ran, true);
  assert.equal(result.uploadChanged, false);
  assert.deepEqual(seen[1]?.body, {
    ...KEY,
    run_id: "starter-pdfs-1",
    outputs: { pages: 12 },
    content_uploaded_at: UPLOAD,
  });
});

test("derive reports a file deleted during the work: nothing recorded, no retry", async () => {
  const { derivations: api, seen } = derivations([
    { body: { exists: false, content_uploaded_at: UPLOAD } },
    {
      status: 409,
      body: {
        error: {
          code: "derivation_upload_changed",
          message: "the file was deleted since the upload",
          param: "content_uploaded_at",
          retryable: false,
        },
      },
    },
  ]);
  const result = await api.derive(KEY, async () => ({ pages: 3 }));

  assert.equal(result.uploadChanged, true);
  assert.equal(result.ran, false);
  assert.equal(result.derivation, null);
  assert.deepEqual(result.outputs, { pages: 3 });
  assert.equal(seen.length, 2, "the record is not sent again");
});

test("derive throws the other refusals of a record", async () => {
  const { derivations: api } = derivations([
    { body: { exists: false } },
    {
      status: 400,
      body: {
        error: {
          code: "derivation_invalid",
          message: "outputs",
          retryable: false,
        },
      },
    },
  ]);
  await assert.rejects(
    api.derive(KEY, async () => ({ pages: 1 })),
    (error: unknown) =>
      error instanceof LbbError && error.code === "derivation_invalid",
  );
});

test("isDerivationUploadChanged names the 409 of a record whose upload changed", () => {
  assert.equal(
    isDerivationUploadChanged(
      new LbbError(409, "{}", {
        code: "derivation_upload_changed",
        message: "x",
      }),
    ),
    true,
  );
  assert.equal(
    isDerivationUploadChanged(
      new LbbError(409, "{}", { code: "conflict", message: "x" }),
    ),
    false,
  );
  assert.equal(
    isDerivationUploadChanged(new Error("derivation_upload_changed")),
    false,
  );
});
