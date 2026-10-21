import { test } from "node:test";
import assert from "node:assert/strict";
import { LbbClient, LbbError, type FetchLike } from "./client.js";

const SHA = "ab".repeat(32);

const RECORD = {
  sha256: SHA,
  name: "room-book.pdf",
  content_type: "application/pdf",
  bytes: 4,
  uploaded_at: "2026-10-10T08:00:00Z",
  document: "https://littlebigbrain.com/e/0123456789abcdef0123456789abcdef",
};

interface Seen {
  url: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

type Answer = {
  status?: number;
  body?: unknown;
  bytes?: Uint8Array;
  contentType?: string;
  noArrayBuffer?: boolean;
  /** The body as a stream of these chunks. */
  chunks?: Uint8Array[];
  headers?: Record<string, string>;
};

/** A fetch that answers `answers` in order and keeps each request as sent. */
function filesFetch(answers: Answer[]) {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({
      url,
      method: init?.method,
      body: init?.body,
      headers: init?.headers,
    });
    const answer = answers.shift() ?? { body: {} };
    const status = answer.status ?? 200;
    const text =
      answer.bytes !== undefined
        ? new TextDecoder().decode(answer.bytes)
        : JSON.stringify(answer.body ?? {});
    const contentType = answer.contentType ?? "application/json";
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type"
            ? contentType
            : (answer.headers?.[name.toLowerCase()] ?? null),
      },
      ...(answer.chunks
        ? {
            body: {
              async *[Symbol.asyncIterator]() {
                for (const chunk of answer.chunks ?? []) yield chunk;
              },
            },
          }
        : {}),
      text: async () => text,
      ...(answer.noArrayBuffer
        ? {}
        : {
            arrayBuffer: async () => {
              const bytes = answer.bytes ?? new TextEncoder().encode(text);
              return bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              ) as ArrayBuffer;
            },
          }),
    };
  };
  return { fetch, seen };
}

function client(fetch: FetchLike, graph = "docs") {
  return new LbbClient({
    baseUrl: "http://h",
    graph,
    fetch,
    retryDelayMs: 0,
  });
}

test("files.upload sends the raw bytes under the name and content type", async () => {
  const { fetch, seen } = filesFetch([
    { body: { file: RECORD, created: true, commit_seq: 12 } },
  ]);
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

  const answer = await client(fetch).files.upload(bytes, {
    name: "room-book.pdf",
    contentType: "application/pdf",
  });

  assert.equal(answer.created, true);
  assert.equal(answer.file.sha256, SHA);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "http://h/v1/files?graph=docs&name=room-book.pdf");
  assert.equal(seen[0].body, bytes, "the bytes are sent as they are");
  assert.equal(seen[0].headers?.["content-type"], "application/pdf");
});

test("files.upload takes a Blob's own type, else octet-stream, and retries a 503", async () => {
  const { fetch, seen } = filesFetch([
    {
      status: 503,
      body: { error: { code: "server_busy", message: "busy" } },
    },
    { body: { file: RECORD, created: false } },
    { body: { file: RECORD, created: false } },
  ]);
  const blob = new Blob(["%PDF"], { type: "application/pdf" });
  const lbb = client(fetch);

  await lbb.files.upload(blob, { name: "a b.pdf" });
  await lbb.files.upload(new ArrayBuffer(3), { name: "raw.bin" });

  assert.equal(
    seen.length,
    3,
    "the 503 was retried: the same bytes change nothing",
  );
  assert.equal(seen[0].body, blob);
  assert.equal(seen[1].body, blob);
  assert.equal(seen[0].url, "http://h/v1/files?graph=docs&name=a%20b.pdf");
  assert.equal(seen[1].headers?.["content-type"], "application/pdf");
  assert.equal(seen[2].headers?.["content-type"], "application/octet-stream");
});

test("files.upload sends the language and schema when given", async () => {
  const { fetch, seen } = filesFetch([
    { body: { file: { ...RECORD, language: "de" }, created: true } },
    { body: { file: RECORD, created: false } },
  ]);
  const lbb = client(fetch);

  const answer = await lbb.files.upload(new Uint8Array([1]), {
    name: "plan.pdf",
    language: "de",
    schema: "urn:x:plan",
  });
  await lbb.files.upload(new Uint8Array([1]), { name: "plan.pdf" });

  assert.equal(answer.file.language, "de");
  assert.equal(
    seen[0].url,
    "http://h/v1/files?graph=docs&name=plan.pdf&language=de&schema=urn%3Ax%3Aplan",
  );
  assert.equal(seen[1].url, "http://h/v1/files?graph=docs&name=plan.pdf");
});

test("files.upload needs a name", async () => {
  const { fetch, seen } = filesFetch([]);
  await assert.rejects(
    () => client(fetch).files.upload(new Uint8Array([1]), { name: " " }),
    (error: unknown) => error instanceof TypeError,
  );
  assert.equal(seen.length, 0);
});

test("files.list and graph(name).files read the graph's files", async () => {
  const { fetch, seen } = filesFetch([
    { body: { files: [RECORD] } },
    { body: { files: [] } },
  ]);
  const lbb = client(fetch);

  const list = await lbb.files.list();
  await lbb.graph("other").files.list();

  assert.equal(list.files[0].name, "room-book.pdf");
  assert.deepEqual(
    seen.map(({ method, url }) => `${method} ${url}`),
    ["GET http://h/v1/files?graph=docs", "GET http://h/v1/files?graph=other"],
  );
});

test("files.list pages with limit and after, and files.counts reads the counts", async () => {
  const { fetch, seen } = filesFetch([
    { body: { files: [RECORD], next: "6162.0123456789abcdef" } },
    { body: { files: [] } },
    {
      body: {
        files: 3,
        by_parse_status: { parsed: 2, waiting: 1 },
        as_of_commit_seq: 41,
      },
    },
  ]);
  const lbb = client(fetch);

  const first = await lbb.files.list({ limit: 1 });
  assert.equal(first.next, "6162.0123456789abcdef");
  const rest = await lbb.files.list({ limit: 50, after: first.next ?? "" });
  assert.equal(rest.next, undefined);
  const counts = await lbb.files.counts();
  assert.equal(counts.files, 3);
  assert.equal(counts.by_parse_status.parsed, 2);
  assert.equal(counts.as_of_commit_seq, 41);
  assert.deepEqual(
    seen.map(({ method, url }) => `${method} ${url}`),
    [
      "GET http://h/v1/files?graph=docs&limit=1",
      "GET http://h/v1/files?graph=docs&limit=50&after=6162.0123456789abcdef",
      "GET http://h/v1/files/counts?graph=docs",
    ],
  );
  for (const limit of [0, 1001, 1.5]) {
    assert.throws(
      () => lbb.files.list({ limit }),
      (error: unknown) => error instanceof RangeError,
    );
  }
  assert.equal(seen.length, 3);
});

test("files.list filters by parse status and name", async () => {
  const { fetch, seen } = filesFetch([
    {
      body: {
        files: [RECORD],
        next: "71.0123456789abcdef",
        as_of_commit_seq: 12,
      },
    },
  ]);
  const lbb = client(fetch);
  const page = await lbb.files.list({
    limit: 50,
    parseStatus: "failed",
    name: "Q3 report",
  });
  assert.equal(page.as_of_commit_seq, 12);
  assert.equal(page.next, "71.0123456789abcdef");
  assert.deepEqual(
    seen.map(({ method, url }) => `${method} ${url}`),
    [
      "GET http://h/v1/files?graph=docs&limit=50&parse_status=failed&name=Q3%20report",
    ],
  );
});

test("files.get reads one file by its SHA-256", async () => {
  const { fetch, seen } = filesFetch([{ body: RECORD }]);
  const lbb = client(fetch);
  const file = await lbb.files.get(SHA.toUpperCase());
  assert.equal(file.name, "room-book.pdf");
  assert.deepEqual(
    seen.map(({ method, url }) => `${method} ${url}`),
    [`GET http://h/v1/files/record?graph=docs&sha256=${SHA}`],
  );
  assert.throws(
    () => lbb.files.get("xyz"),
    (error: unknown) => error instanceof RangeError,
  );
});

test("files.content returns the bytes as they arrived", async () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0x80]);
  const { fetch, seen } = filesFetch([
    { bytes: pdf, contentType: "application/pdf" },
    {
      bytes: new TextEncoder().encode("plain text"),
      contentType: "text/plain",
      noArrayBuffer: true,
    },
  ]);
  const lbb = client(fetch);

  const bytes = await lbb.files.content(SHA.toUpperCase());
  const text = await lbb.files.content(SHA);

  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual([...bytes], [...pdf]);
  assert.equal(new TextDecoder().decode(text), "plain text");
  assert.equal(
    seen[0].url,
    `http://h/v1/files/content?graph=docs&sha256=${SHA}`,
  );
});

test("files.content throws the server's error for a missing file", async () => {
  const { fetch } = filesFetch([
    {
      status: 404,
      body: {
        error: {
          type: "not_found_error",
          code: "file_not_found",
          message: "no file",
        },
      },
    },
  ]);
  await assert.rejects(
    () => client(fetch).files.content(SHA),
    (error: unknown) =>
      error instanceof LbbError &&
      error.status === 404 &&
      error.code === "file_not_found",
  );
});

test("files.pages sends the range and checks it first", async () => {
  const pages = {
    sha256: SHA,
    parser: "poppler-26.03.0",
    page_count: 3,
    from: 1,
    to: 2,
    pages: [
      {
        page: 1,
        width: 595.22,
        height: 842,
        lines: [
          {
            id: "p2-l1",
            text: "S 1.1",
            box: [0.1, 0.2, 0.3, 0.4],
            words: [{ text: "S", box: [0.1, 0.2, 0.15, 0.4] }],
          },
        ],
      },
    ],
  };
  const { fetch, seen } = filesFetch([{ body: pages }, { body: pages }]);
  const lbb = client(fetch);

  const answer = await lbb.files.pages(SHA, { from: 1, to: 2 });
  await lbb.files.pages(SHA);

  assert.equal(answer.pages[0].lines[0].id, "p2-l1");
  assert.deepEqual(answer.pages[0].lines[0].box, [0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(
    seen.map(({ url }) => url),
    [
      `http://h/v1/files/pages?graph=docs&sha256=${SHA}&from=1&to=2`,
      `http://h/v1/files/pages?graph=docs&sha256=${SHA}`,
    ],
  );
  for (const bad of [
    () => lbb.files.pages("abc"),
    () => lbb.files.pages(SHA, { from: 3, to: 1 }),
    () => lbb.files.pages(SHA, { from: -1 }),
    () => lbb.files.pages(SHA, { to: 1.5 }),
  ])
    await assert.rejects(bad, (error: unknown) => error instanceof RangeError);
  assert.equal(seen.length, 2, "a bad range sends nothing");
});

test("files.delete repeats the SHA-256 as confirm", async () => {
  const { fetch, seen } = filesFetch([
    { body: { deleted: true, sha256: SHA } },
    { body: { deleted: true, sha256: SHA, purged_edges: 2 } },
  ]);
  const lbb = client(fetch);

  const answer = await lbb.files.delete(` ${SHA.toUpperCase()} `);
  const purged = await lbb.files.delete(SHA, { purge: true });

  assert.equal(answer.deleted, true);
  assert.equal(purged.purged_edges, 2);
  assert.equal(seen[0].method, "DELETE");
  assert.deepEqual(
    seen.map(({ url }) => url),
    [
      `http://h/v1/files?graph=docs&sha256=${SHA}&confirm=${SHA}`,
      `http://h/v1/files?graph=docs&sha256=${SHA}&confirm=${SHA}&purge=true`,
    ],
  );
});

test("files.get reads a deleted file with the facts that cite it", async () => {
  const citation = {
    statement: "https://littlebigbrain.com/s/9f3c",
    subject: "https://littlebigbrain.com/e/1",
    predicate: "https://littlebigbrain.com/r/calls",
    object: "https://littlebigbrain.com/e/2",
    source: "https://littlebigbrain.com/e/41ab#page=3",
  };
  const { fetch, seen } = filesFetch([
    {
      body: {
        ...RECORD,
        deleted_at: "2026-10-15T09:00:00+00:00",
        cited_by: [citation],
      },
    },
  ]);

  const file = await client(fetch).files.get(SHA, { deleted: true });

  assert.equal(file.deleted_at, "2026-10-15T09:00:00+00:00");
  assert.deepEqual(file.cited_by, [citation]);
  assert.equal(
    seen[0].url,
    `http://h/v1/files/record?graph=docs&sha256=${SHA}&deleted=true`,
  );
});

test("files.content sends one byte range and checks it first", async () => {
  const { fetch, seen } = filesFetch([
    { status: 206, bytes: new Uint8Array([0x37, 0x38, 0x39]) },
    { status: 206, bytes: new Uint8Array([0x39]) },
    { status: 206, bytes: new Uint8Array([0x32]) },
  ]);
  const lbb = client(fetch);

  const last3 = await lbb.files.content(SHA, { range: { suffix: 3 } });
  await lbb.files.content(SHA, { range: { start: 9 } });
  await lbb.files.content(SHA, { range: { start: 2, end: 2 } });

  assert.deepEqual([...last3], [0x37, 0x38, 0x39]);
  assert.deepEqual(
    seen.map(({ headers }) => headers?.range),
    ["bytes=-3", "bytes=9-", "bytes=2-2"],
  );
  for (const range of [
    { start: 5, end: 2 },
    { start: -1 },
    { start: 1.5 },
    { suffix: 0 },
  ])
    await assert.rejects(
      () => lbb.files.content(SHA, { range }),
      (error: unknown) => error instanceof RangeError,
    );
  assert.equal(seen.length, 3, "a bad range sends nothing");
});

test("files.content throws 416 for a range with no byte of the file", async () => {
  const { fetch } = filesFetch([
    {
      status: 416,
      body: {
        error: {
          type: "invalid_request_error",
          code: "range_not_satisfiable",
          message: "no byte",
        },
      },
    },
  ]);
  await assert.rejects(
    () => client(fetch).files.content(SHA, { range: { start: 10 } }),
    (error: unknown) =>
      error instanceof LbbError &&
      error.status === 416 &&
      error.code === "range_not_satisfiable",
  );
});

test("files.contentStream yields the bytes as they arrive", async () => {
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
  const { fetch, seen } = filesFetch([
    { status: 503, body: { error: { code: "server_busy", message: "busy" } } },
    { chunks, contentType: "application/octet-stream" },
    { chunks: [new Uint8Array([5])], status: 206 },
  ]);
  const lbb = client(fetch);

  const got: number[][] = [];
  for await (const chunk of lbb.files.contentStream(SHA)) got.push([...chunk]);
  const tail: number[] = [];
  for await (const chunk of lbb.files.contentStream(SHA, {
    range: { suffix: 1 },
  }))
    tail.push(...chunk);

  assert.deepEqual(got, [
    [1, 2, 3],
    [4, 5],
  ]);
  assert.deepEqual(tail, [5]);
  assert.equal(seen.length, 3, "the 503 before the answer was retried");
  assert.equal(seen[1].method, "GET");
  assert.equal(
    seen[1].url,
    `http://h/v1/files/content?graph=docs&sha256=${SHA}`,
  );
  assert.equal(seen[2].headers?.range, "bytes=-1");
});

test("files.contentStream throws the server's error", async () => {
  const { fetch } = filesFetch([
    {
      status: 404,
      body: { error: { code: "file_not_found", message: "no file" } },
    },
  ]);
  await assert.rejects(
    async () => {
      for await (const chunk of client(fetch).files.contentStream(SHA))
        assert.fail(`unexpected ${chunk.length} bytes`);
    },
    (error: unknown) =>
      error instanceof LbbError && error.code === "file_not_found",
  );
});

test("files.head answers the length, type and digest", async () => {
  const { fetch, seen } = filesFetch([
    {
      bytes: new Uint8Array(),
      contentType: "application/pdf",
      headers: { "content-length": "18510", etag: `"${SHA}"` },
    },
  ]);

  const head = await client(fetch).files.head(SHA.toUpperCase());

  assert.deepEqual(head, {
    bytes: 18510,
    contentType: "application/pdf",
    sha256: SHA,
  });
  assert.equal(seen[0].method, "HEAD");
  assert.equal(
    seen[0].url,
    `http://h/v1/files/content?graph=docs&sha256=${SHA}`,
  );
});

test("files.putPages sends the pages under the file and the parser id", async () => {
  const { fetch, seen } = filesFetch([
    {
      body: {
        sha256: SHA,
        parser: "poppler-26.03.0",
        status: "parsed",
        page_count: 1,
        stored: true,
      },
    },
  ]);
  const pages = [
    {
      page: 0,
      width: 612,
      height: 792,
      lines: [
        {
          id: "p1-l1",
          text: "S 1.1",
          box: [0.1, 0.1, 0.2, 0.12] as [number, number, number, number],
          words: [
            {
              text: "S",
              box: [0.1, 0.1, 0.12, 0.12] as [number, number, number, number],
            },
            {
              text: "1.1",
              box: [0.13, 0.1, 0.2, 0.12] as [number, number, number, number],
            },
          ],
        },
      ],
    },
  ];
  const answer = await client(fetch).files.putPages(
    SHA.toUpperCase(),
    "poppler-26.03.0",
    {
      status: "parsed",
      pages,
      uploaded_at: "2026-10-21T08:00:00.000000Z",
    },
  );
  assert.equal(answer.stored, true);
  assert.equal(seen[0].method, "PUT");
  assert.equal(
    seen[0].url,
    `http://h/v1/files/pages?graph=docs&sha256=${SHA}&parser=poppler-26.03.0`,
  );
  assert.deepEqual(JSON.parse(String(seen[0].body)), {
    status: "parsed",
    pages,
    uploaded_at: "2026-10-21T08:00:00.000000Z",
  });
});
