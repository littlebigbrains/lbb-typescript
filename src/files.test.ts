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
          name.toLowerCase() === "content-type" ? contentType : null,
      },
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
  ]);

  const answer = await client(fetch).files.delete(` ${SHA.toUpperCase()} `);

  assert.equal(answer.deleted, true);
  assert.equal(seen[0].method, "DELETE");
  assert.equal(
    seen[0].url,
    `http://h/v1/files?graph=docs&sha256=${SHA}&confirm=${SHA}`,
  );
});
