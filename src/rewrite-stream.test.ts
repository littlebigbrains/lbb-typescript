import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LbbClient,
  LbbError,
  type FetchLike,
  type LbbResponseEvent,
  type Schemas,
} from "./client.js";
import type { QueryRewriteStreamEvent } from "./namespaces.js";
import { ServerSentEventParser } from "./sse.js";

const SPARQL =
  "SELECT ?name WHERE { ?s <http://www.w3.org/2000/01/rdf-schema#label> ?name }";

function rewriteResponse(): Schemas["QueryRewriteResponse"] {
  return {
    route: { kind: "lookup", confidence: 0.92, by: "router" },
    query: { sparql: SPARQL, entailment: "none" },
    rationale: "The question names services in Zürich — by name.",
    attempts: 2,
    grounding: {
      commit_seq: 7,
      classes: 3,
      properties: 5,
      embeddings: 0,
      age_ms: 10,
    },
    models: [],
    timings: {
      ground_ms: 1,
      route_ms: 2,
      rewrite_ms: 3,
      run_ms: 4,
      total_ms: 10,
    },
  };
}

function frame(event: string, data: unknown, lineEnd = "\n"): string {
  return `event: ${event}${lineEnd}data: ${JSON.stringify(data)}${lineEnd}${lineEnd}`;
}

/** The events of a rewrite with one correction, as the server sends them. */
function serverStream(): string {
  return [
    ": keep-alive\n\n",
    frame("grounding", { cached: true, age_ms: 5, classes: 3 }),
    frame("route", { kind: "lookup", confidence: 0.92, by: "router" }),
    frame("answer.delta", { text: "a later event" }),
    frame("query", { sparql: "SELECT ?x", entailment: "none", attempt: 1 }),
    frame("run", { as_of_commit_seq: null }, "\r\n"),
    ": keep-alive\r\n\r\n",
    frame("repair", { error: "unknown prefix ex", attempt: 2 }, "\r\n"),
    frame("query", { sparql: SPARQL, entailment: "none", attempt: 2 }),
    frame("run", { as_of_commit_seq: 7 }),
    frame("rows", { count: 12, ms: 85 }),
    frame("done", rewriteResponse()),
  ].join("");
}

/** Split bytes at uneven offsets, so events, lines and characters break. */
function split(text: string, sizes = [1, 7, 3, 13, 2, 29]): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (let index = 0; offset < bytes.length; index += 1) {
    const size = sizes[index % sizes.length];
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return chunks;
}

type StreamCall = {
  input: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  };
};

/** A fetch that answers every call with one streamed body. */
function streamingFetch(
  chunks: Uint8Array[],
  options: {
    status?: number;
    contentType?: string;
    hang?: boolean;
    onCancel?: () => void;
  } = {},
): { fetch: FetchLike; calls: StreamCall[] } {
  const calls: StreamCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index]);
          index += 1;
          return undefined;
        }
        if (options.hang) return new Promise<void>(() => undefined);
        controller.close();
        return undefined;
      },
      cancel() {
        options.onCancel?.();
      },
    });
    const status = options.status ?? 200;
    const headers = new Map([
      ["content-type", options.contentType ?? "text/event-stream"],
      ["x-request-id", "req_1"],
    ]);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      },
      text: async () => "",
      body,
    };
  };
  return { fetch, calls };
}

async function collect(
  events: AsyncIterable<QueryRewriteStreamEvent>,
): Promise<QueryRewriteStreamEvent[]> {
  const seen: QueryRewriteStreamEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

test("rewriteStream yields the events in order from a body split at any byte", async () => {
  const { fetch, calls } = streamingFetch(split(serverStream()));
  const responses: LbbResponseEvent[] = [];
  const client = new LbbClient({
    baseUrl: "http://h",
    apiKey: "k",
    graph: "main",
    fetch,
    onResponse: (event) => responses.push(event),
  });

  const events = await collect(
    client.query.rewriteStream(
      { question: "Which services exist?", run: true },
      { consistency: "strong" },
    ),
  );

  assert.deepEqual(
    events.map((event) => event.event),
    [
      "grounding",
      "route",
      "query",
      "run",
      "repair",
      "query",
      "run",
      "rows",
      "done",
    ],
    "comments and the unknown event are skipped",
  );
  assert.deepEqual(events[0].data, { cached: true, age_ms: 5, classes: 3 });
  assert.deepEqual(events[4].data, { error: "unknown prefix ex", attempt: 2 });
  assert.deepEqual(events[7].data, { count: 12, ms: 85 });
  const done = events[8];
  assert.equal(done.event, "done");
  if (done.event === "done") assert.deepEqual(done.data, rewriteResponse());

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].input,
    "http://h/v1/query/rewrite?graph=main&consistency=strong",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers?.accept, "text/event-stream");
  assert.equal(calls[0].init.headers?.authorization, "Bearer k");
  assert.equal(calls[0].init.headers?.["content-type"], "application/json");
  assert.equal(calls[0].init.headers?.["lbb-version"], "2026-07-23");
  assert.deepEqual(JSON.parse(calls[0].init.body ?? "{}"), {
    question: "Which services exist?",
    run: true,
  });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].requestId, "req_1");

  // One byte per chunk: every multi-byte character arrives in pieces.
  const bytewise = await collect(
    new LbbClient({
      baseUrl: "http://h",
      fetch: streamingFetch(split(serverStream(), [1])).fetch,
    }).query.rewriteStream({ question: "Which services exist?" }),
  );
  assert.deepEqual(bytewise, events);
});

test("rewriteStream throws an error event as the LbbError that rewrite throws", async () => {
  const text =
    frame("grounding", { cached: false, age_ms: 0, classes: 3 }) +
    frame("route", { kind: "lookup", confidence: 0.9, by: "router" }) +
    frame("error", {
      status: 503,
      code: "rewrite_model_unavailable",
      message: "the query rewriter model did not answer; try again",
    });
  const { fetch } = streamingFetch(split(text));
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  const seen: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of client.query.rewriteStream({ question: "q" }))
        seen.push(event.event);
    })(),
    (error) => {
      assert.ok(error instanceof LbbError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "rewrite_model_unavailable");
      assert.equal(
        error.message,
        "the query rewriter model did not answer; try again",
      );
      assert.equal(error.type, "api_error");
      assert.equal(error.requestId, "req_1");
      return true;
    },
  );
  assert.deepEqual(seen, ["grounding", "route"]);
});

test("rewriteStream throws a JSON error before the stream as rewrite does, once", async () => {
  const body = JSON.stringify({
    error: {
      type: "rate_limit_error",
      code: "rewrite_limit",
      message: "rewrite_limit: the stack used its 200 rewrites of the day",
      retryable: false,
    },
  });
  const calls: string[] = [];
  const headers = new Map([
    ["content-type", "application/json"],
    ["retry-after", "60"],
  ]);
  const fetch: FetchLike = async (input) => {
    calls.push(input);
    return {
      ok: false,
      status: 429,
      headers: {
        get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      },
      text: async () => body,
    };
  };
  const client = new LbbClient({ baseUrl: "http://h", fetch, retryDelayMs: 0 });

  const caught = async (run: () => Promise<unknown>): Promise<LbbError> => {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof LbbError);
      return error;
    }
    return assert.fail("expected an LbbError");
  };
  const streamed = await caught(() =>
    collect(
      client.query.rewriteStream(
        { question: "q" },
        { retry: "rate_limited", maxRetries: 3 },
      ),
    ),
  );
  assert.equal(calls.length, 1, "a stream is never retried");
  const plain = await caught(() => client.query.rewrite({ question: "q" }));
  for (const key of [
    "status",
    "code",
    "type",
    "message",
    "retryable",
    "retryAfterSeconds",
    "body",
  ] as const) {
    assert.deepEqual(streamed[key], plain[key], key);
  }
  assert.equal(streamed.status, 429);
  assert.equal(streamed.code, "rewrite_limit");
});

test("rewriteStream throws when the body ends before done or error", async () => {
  const text =
    frame("grounding", { cached: true, age_ms: 5, classes: 3 }) +
    'event: done\ndata: {"attempts":1}';
  const { fetch } = streamingFetch(split(text));
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  const seen: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of client.query.rewriteStream({ question: "q" }))
        seen.push(event.event);
    })(),
    (error) => {
      assert.ok(!(error instanceof LbbError));
      assert.match(String(error), /ended before its done or error event/);
      return true;
    },
  );
  assert.deepEqual(seen, ["grounding"], "an unfinished event is dropped");
});

test("rewriteStream stops on abort and cancels the request and the body", async () => {
  let cancelled = false;
  const { fetch, calls } = streamingFetch(
    split(frame("grounding", { cached: true, age_ms: 5, classes: 3 })),
    { hang: true, onCancel: () => (cancelled = true) },
  );
  const client = new LbbClient({ baseUrl: "http://h", fetch });
  const controller = new AbortController();
  const reason = new Error("the caller stopped");

  const seen: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of client.query.rewriteStream(
        { question: "q" },
        { signal: controller.signal },
      )) {
        seen.push(event.event);
        controller.abort(reason);
      }
    })(),
    (error) => {
      assert.equal(error, reason);
      return true;
    },
  );
  assert.deepEqual(seen, ["grounding"]);
  assert.equal(cancelled, true, "the body was cancelled");
  assert.equal(calls[0].init.signal?.aborted, true, "the fetch was aborted");

  await assert.rejects(
    collect(
      client.query.rewriteStream(
        { question: "q" },
        { signal: controller.signal },
      ),
    ),
    (error) => error === reason,
  );
  assert.equal(calls.length, 1, "an aborted signal sends no request");
});

test("rewriteStream closes the body when the loop ends early", async () => {
  let cancelled = false;
  const { fetch } = streamingFetch(split(serverStream()), {
    hang: true,
    onCancel: () => (cancelled = true),
  });
  const client = new LbbClient({ baseUrl: "http://h", fetch });

  for await (const event of client.query.rewriteStream({ question: "q" })) {
    if (event.event === "route") break;
  }
  assert.equal(cancelled, true);
});

test("rewriteStream reads a body without a stream and a server without streams", async () => {
  const textOnly: FetchLike = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "text/event-stream" : null,
    },
    text: async () => serverStream(),
  });
  const fromText = await collect(
    new LbbClient({ baseUrl: "http://h", fetch: textOnly }).query.rewriteStream(
      { question: "q" },
    ),
  );
  assert.equal(fromText.length, 9);

  // A Node stream body is an async iterable of byte chunks.
  const nodeStream: FetchLike = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "text/event-stream" : null,
    },
    text: async () => "",
    body: (async function* () {
      yield* split(serverStream());
    })(),
  });
  const fromNodeStream = await collect(
    new LbbClient({
      baseUrl: "http://h",
      fetch: nodeStream,
    }).query.rewriteStream({ question: "q" }),
  );
  assert.deepEqual(fromNodeStream, fromText);

  const json: FetchLike = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "application/json" : null,
    },
    text: async () => JSON.stringify(rewriteResponse()),
  });
  const fromJson = await collect(
    new LbbClient({ baseUrl: "http://h", fetch: json }).query.rewriteStream({
      question: "q",
    }),
  );
  assert.deepEqual(fromJson, [{ event: "done", data: rewriteResponse() }]);
});

test("the event parser joins data lines, splits every line end and bounds an event", () => {
  const parser = new ServerSentEventParser(64);
  const events = [
    ...parser.push("data: one\r"),
    ...parser.push("\ndata:two\rdata\r\r"),
    ...parser.push("event: x\nid: 1\nretry: 5\nunknown: y\ndata: \n\n"),
    ...parser.push("event: empty\n\n"),
  ];
  assert.deepEqual(events, [
    { event: "message", data: "one\ntwo\n" },
    { event: "x", data: "" },
  ]);

  assert.throws(
    () => parser.push(`data: ${"x".repeat(80)}`),
    /larger than 64 characters/,
  );
  const lines = new ServerSentEventParser(64);
  assert.throws(() => {
    for (let index = 0; index < 20; index += 1) lines.push("data: xxxx\n");
  }, /larger than 64 characters/);
});
