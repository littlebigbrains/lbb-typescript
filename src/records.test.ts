import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbRecordCommitOutcomeError } from "./index.js";
import {
  LbbClient,
  LbbCapabilityError,
  LbbError,
  type FetchLike,
  type Schemas,
} from "./client.js";

function receipt() {
  return {
    object: "record_commit",
    version: "records/1",
    idempotent_replay: false,
    receipt: {
      epoch: "18446744073709551615",
      commit_seq: 7,
      visibility_token: "opaque",
      schema_revision: "schema/immutable",
      scope: { owner: "application", scope: "default" },
      resolved_ids: {
        entities: ["urn:entity:雪"],
        relationships: ["urn:claim"],
      },
      no_op: false,
      projection: { added: 2, removed: 0 },
    },
  };
}
function body(): Schemas["RecordCommitRequest"] {
  return {
    version: "records/1",
    schema_revision: "schema/immutable",
    entities: [
      {
        id: "urn:entity:雪",
        set: {
          "urn:label": "雪",
          "urn:count": 1,
          "urn:large": {
            "@value": "9007199254740993",
            "@type": "http://www.w3.org/2001/XMLSchema#integer",
          },
          "urn:decimal": {
            "@value": "1.0000000000000001",
            "@type": "http://www.w3.org/2001/XMLSchema#decimal",
          },
          "urn:time": {
            "@value": "2026-10-26T10:00:00+02:00",
            "@type": "http://www.w3.org/2001/XMLSchema#dateTime",
          },
          "urn:language": { "@value": "Bonjour", "@language": "fr" },
        },
      },
    ],
    relationships: [],
  };
}
function ok(value: unknown, status = 200): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(value),
  };
}
const capability = { capabilities: ["records_commit_v1"] };

test("records commit preserves exact body/epoch, original receipt and graph scope", async () => {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const expected = receipt();
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return ok(new URL(url).pathname === "/version" ? capability : expected);
  };
  const client = new LbbClient({
    baseUrl: "http://h",
    graph: "default",
    fetch,
  });
  const input = body();
  assert.deepEqual(
    await client.graph("other").records.commit(input, {
      idempotencyKey: "records:stable",
      expectedGraphEpoch: "18446744073709551615",
    }),
    expected,
  );
  assert.equal(calls.length, 2);
  const sent = calls[1];
  assert.equal(new URL(sent.url).pathname, "/v1/graph/commit");
  assert.equal(new URL(sent.url).searchParams.get("graph"), "other");
  assert.equal(
    new URL(sent.url).searchParams.get("expected_graph_epoch"),
    "18446744073709551615",
  );
  assert.equal(sent.init?.headers?.["idempotency-key"], "records:stable");
  assert.deepEqual(JSON.parse(sent.init?.body as string), input);
});

test("missing/malformed/old capabilities never send a mutation", async () => {
  for (const response of [
    {},
    null,
    { capabilities: null },
    { capabilities: "records_commit_v1" },
    { capabilities: { records_commit_v1: true } },
    { capabilities: [] },
  ]) {
    let calls = 0;
    const client = new LbbClient({
      baseUrl: "http://h",
      fetch: async () => {
        calls += 1;
        return ok(response);
      },
    });
    await assert.rejects(
      client.records.commit(body(), { idempotencyKey: "stable" }),
      LbbCapabilityError,
    );
    assert.equal(calls, 1);
  }
});

test("runtime version/key/header guards reject casts and serializer changes before any request", async () => {
  let calls = 0;
  const client = new LbbClient({
    baseUrl: "http://h",
    fetch: async () => {
      calls += 1;
      return ok(capability);
    },
  });
  for (const value of [
    {},
    { version: null },
    { version: "legacy" },
    [],
    { version: "records/1", toJSON: () => ({ triplets: [] }) },
    { version: "records/1", toJSON: () => ({ version: "legacy" }) },
  ]) {
    await assert.rejects(
      client.records.commit(
        value as unknown as Schemas["RecordCommitRequest"],
        { idempotencyKey: "stable" },
      ),
      TypeError,
    );
  }
  await assert.rejects(
    client.records.commit(body(), { idempotencyKey: "" }),
    TypeError,
  );
  await assert.rejects(
    client.records.commit(body(), {
      idempotencyKey: "stable",
      headers: { "IDEMPOTENCY-KEY": "override" },
    }),
    TypeError,
  );
  assert.equal(calls, 0);
});

test("wire bytes/key/options freeze before capability I/O and remain identical after failures", async () => {
  const input = body();
  const original = JSON.stringify(input);
  const options = {
    idempotencyKey: "original",
    expectedGraphEpoch: "9",
    headers: { "x-test": "original" },
    maxRetries: 2,
    retryBudgetMs: 1000,
  };
  const posts: { body: unknown; key: unknown; header: unknown; url: string }[] =
    [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch: FetchLike = async (url, init) => {
    if (new URL(url).pathname === "/version") {
      await barrier;
      return ok(capability);
    }
    posts.push({
      body: init?.body,
      key: init?.headers?.["idempotency-key"],
      header: init?.headers?.["x-test"],
      url,
    });
    if (posts.length === 1) {
      input.entities = [];
      options.headers["x-test"] = "again";
      throw new Error("lost reply");
    }
    if (posts.length === 2) return ok({ error: { message: "busy" } }, 503);
    return ok({ ...receipt(), idempotent_replay: true });
  };
  const client = new LbbClient({ baseUrl: "http://h", fetch, retryDelayMs: 0 });
  const pending = client.records.commit(input, options);
  input.entities = [];
  options.idempotencyKey = "changed";
  options.expectedGraphEpoch = "10";
  options.headers["x-test"] = "changed";
  release();
  assert.equal((await pending).idempotent_replay, true);
  assert.equal(posts.length, 3);
  for (const sent of posts) {
    assert.equal(sent.body, original);
    assert.equal(sent.key, "original");
    assert.equal(sent.header, "original");
    assert.equal(
      new URL(sent.url).searchParams.get("expected_graph_epoch"),
      "9",
    );
  }
});

test("typed graph refusal stays a graph refusal; legacy success never becomes a receipt", async () => {
  const client = new LbbClient({
    baseUrl: "http://h",
    fetch: async (url) =>
      new URL(url).pathname === "/version"
        ? ok(capability)
        : ok(
            {
              error: {
                type: "invalid_request_error",
                code: "rdf_mutation_not_enabled",
                message: "unsupported graph",
              },
            },
            400,
          ),
  });
  await assert.rejects(
    client.records.commit(body(), { idempotencyKey: "stable" }),
    (error: unknown) =>
      error instanceof LbbError && error.code === "rdf_mutation_not_enabled",
  );
  const old = new LbbClient({
    baseUrl: "http://h",
    fetch: async (url) =>
      ok(
        new URL(url).pathname === "/version"
          ? capability
          : { commit_seq: 0, no_op: true },
      ),
  });
  await assert.rejects(
    old.records.commit(body(), { idempotencyKey: "stable" }),
    LbbRecordCommitOutcomeError,
  );
});

test("unsafe, negative, fractional and missing receipt counters never become accepted JS numbers", async () => {
  const cases: unknown[] = [];
  for (const value of [9007199254740992, -1, 1.5, "1", null]) {
    for (const field of ["commit_seq", "added", "removed"]) {
      const r = receipt();
      if (field === "commit_seq")
        Object.assign(r.receipt, { commit_seq: value });
      else Object.assign(r.receipt.projection, { [field]: value });
      cases.push(r);
    }
  }
  const incomplete = receipt();
  Object.assign(incomplete.receipt, { resolved_ids: {} });
  cases.push(incomplete);
  for (const value of cases) {
    const client = new LbbClient({
      baseUrl: "http://h",
      fetch: async (url) =>
        ok(new URL(url).pathname === "/version" ? capability : value),
    });
    await assert.rejects(
      client.records.commit(body(), { idempotencyKey: "stable" }),
      LbbRecordCommitOutcomeError,
    );
  }
  const good = receipt();
  good.receipt.commit_seq = Number.MAX_SAFE_INTEGER;
  const client = new LbbClient({
    baseUrl: "http://h",
    fetch: async (url) =>
      ok(new URL(url).pathname === "/version" ? capability : good),
  });
  assert.equal(
    (await client.records.commit(body(), { idempotencyKey: "stable" })).receipt
      .commit_seq,
    Number.MAX_SAFE_INTEGER,
  );
});

test("malformed post-POST receipts report unknown outcome with the original frozen key", async () => {
  for (const reply of [{ commit_seq: 0 }, { ...receipt(), receipt: null }]) {
    let posts = 0;
    const options = { idempotencyKey: "original" };
    const client = new LbbClient({
      baseUrl: "http://h",
      fetch: async (url) => {
        if (new URL(url).pathname === "/version") {
          options.idempotencyKey = "changed";
          return ok(capability);
        }
        posts += 1;
        return ok(reply);
      },
    });
    await assert.rejects(
      client.records.commit(body(), options),
      (error: unknown) =>
        error instanceof LbbRecordCommitOutcomeError &&
        error.outcome === "unknown" &&
        error.idempotencyKey === "original" &&
        /may have committed/.test(error.message) &&
        !/does not advertise|upgrade/.test(error.message),
    );
    assert.equal(posts, 1);
  }
});

test("invalid JSON success retains unknown outcome and key; transport parsing never implies refusal", async () => {
  let posts = 0;
  const client = new LbbClient({
    baseUrl: "http://h",
    fetch: async (url) => {
      if (new URL(url).pathname === "/version") return ok(capability);
      posts += 1;
      return { ok: true, status: 200, text: async () => "not json" };
    },
  });
  await assert.rejects(
    client.records.commit(body(), { idempotencyKey: "original" }),
    (error: unknown) =>
      error instanceof LbbRecordCommitOutcomeError &&
      error.idempotencyKey === "original" &&
      error.cause instanceof SyntaxError,
  );
  assert.equal(posts, 1);
});

for (const maxRetries of [0, 2]) {
  test(`exhausted POST transport errors preserve original cause/key with retries=${maxRetries}`, async () => {
    const cause = Object.assign(new Error("lost final response"), {
      name: "TimeoutError",
    });
    let posts = 0;
    const client = new LbbClient({
      baseUrl: "http://h",
      maxRetries,
      retryDelayMs: 0,
      fetch: async (url) => {
        if (new URL(url).pathname === "/version") return ok(capability);
        posts += 1;
        throw cause;
      },
    });
    await assert.rejects(
      client.records.commit(body(), { idempotencyKey: "original" }),
      (error: unknown) =>
        error instanceof LbbRecordCommitOutcomeError &&
        error.outcome === "unknown" &&
        error.idempotencyKey === "original" &&
        error.cause === cause,
    );
    assert.equal(posts, maxRetries + 1);
  });
}

test("capability transport loss and known local refusals stay outside POST ambiguity", async () => {
  const cause = new Error("capability endpoint offline");
  let calls = 0;
  const client = new LbbClient({
    baseUrl: "http://h",
    maxRetries: 0,
    fetch: async () => {
      calls += 1;
      throw cause;
    },
  });
  await assert.rejects(
    client.records.commit(body(), { idempotencyKey: "original" }),
    (error: unknown) =>
      error === cause && !(error instanceof LbbRecordCommitOutcomeError),
  );
  assert.equal(calls, 1);
  await assert.rejects(
    client.records.commit(body(), {
      idempotencyKey: "original",
      maxRetries: -1,
    }),
    RangeError,
  );
  const controller = new AbortController();
  const reason = new Error("already cancelled");
  controller.abort(reason);
  await assert.rejects(
    client.records.commit(body(), {
      idempotencyKey: "original",
      signal: controller.signal,
    }),
    (error: unknown) => error === reason,
  );
  assert.equal(calls, 1);
});
