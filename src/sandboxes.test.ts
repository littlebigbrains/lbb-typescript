import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LbbClient, LbbError, type FetchLike } from "./client.js";
import { SandboxWaitError } from "./sandboxes.js";

// A stand-in for the sandbox routes of the server. It keeps sandboxes,
// commands and files in memory and answers the way the server does for the
// calls these tests make. It runs no code: a `run` whose code holds
// `sum(input)` answers the sum of its input, and any other code answers
// `{ input, config }`. The server's own tests run the same calls against a
// real guest agent.

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  rawBody: unknown;
}

interface Answer {
  status?: number;
  body?: unknown;
  bytes?: Uint8Array;
}

type Responder = (call: Call) => Answer | undefined;

/** Run summary statuses a test scripts, oldest answer first. */
interface Service {
  fetch: FetchLike;
  calls: Call[];
  /** Answer a call before the default behaviour sees it. */
  respond(responder: Responder): void;
  files: Map<string, Uint8Array>;
}

function service(): Service {
  const calls: Call[] = [];
  const responders: Responder[] = [];
  const sandboxes = new Map<string, Record<string, unknown>>();
  const commands = new Map<string, Record<string, unknown>>();
  const files = new Map<string, Uint8Array>();
  let counter = 0;
  const next = (prefix: string) =>
    `${prefix}_${String(1_793_174_400_000 + counter++).padStart(13, "0")}a1b2c3d4e5f6`;

  const sandboxRecord = (id: string, body: Record<string, unknown>) => ({
    id,
    object: "sandbox",
    created: 1_793_174_400,
    status: "running",
    kind: body.run ? "run" : "sandbox",
    template: { id: "sbt_lbb_python", name: body.template ?? "lbb/python" },
    limits: { vcpus: 1, memory_mib: 1024, disk_mib: 4096 },
    auto_stop_seconds: 300,
    expires_at: 1_793_178_000,
    owner: null,
    created_by: "key:test",
    usage: { vcpu_seconds: 0, memory_gib_seconds: 0, disk_gib_seconds: 0 },
    metadata: (body.metadata as Record<string, string> | undefined) ?? {},
  });

  const commandRecord = (
    id: string,
    sandbox: string,
    body: Record<string, unknown>,
  ) => {
    const run = body.run as Record<string, unknown> | undefined;
    const code = String(run?.code ?? "");
    const input = run?.input;
    const result =
      run === undefined
        ? undefined
        : code.includes("sum(input)")
          ? (input as number[]).reduce((a, b) => a + b, 0)
          : { input: input ?? null, config: run.config ?? null };
    return {
      id,
      object: "sandbox_command",
      created: 1_793_174_400,
      sandbox,
      status: "exited",
      argv: body.argv,
      run: run
        ? { code_bytes: code.length, input_bytes: 2, config_bytes: 2 }
        : undefined,
      env_names: Object.keys((body.env as object | undefined) ?? {}),
      stdin_bytes: 0,
      timeout_ms: 60_000,
      exit_code: 0,
      stdout: { bytes: 0, truncated_bytes: 0, tail: "" },
      stderr: { bytes: 0, truncated_bytes: 0, tail: "" },
      result,
    };
  };

  const fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init?.headers ?? {}))
      headers[key.toLowerCase()] = String(value);
    const rawBody = init?.body;
    let body: Record<string, unknown> | undefined;
    if (typeof rawBody === "string" && rawBody.length > 0)
      body = JSON.parse(rawBody) as Record<string, unknown>;
    const call: Call = {
      method: init?.method ?? "GET",
      path: parsed.pathname,
      query: parsed.searchParams,
      headers,
      body,
      rawBody,
    };
    calls.push(call);
    let answer: Answer | undefined;
    for (const responder of responders) {
      answer = responder(call);
      if (answer !== undefined) break;
    }
    answer ??= defaultAnswer(call);
    const status = answer.status ?? 200;
    const text =
      answer.bytes !== undefined
        ? new TextDecoder().decode(answer.bytes)
        : JSON.stringify(answer.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type"
            ? answer.bytes
              ? "application/octet-stream"
              : "application/json"
            : null,
      },
      text: async () => text,
      arrayBuffer: async () => {
        const bytes = answer.bytes ?? new TextEncoder().encode(text);
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
      },
    };
  };

  const notFound = (code: string): Answer => ({
    status: 404,
    body: { error: { type: "invalid_request_error", code, message: code } },
  });

  const defaultAnswer = (call: Call): Answer => {
    const route = `${call.method} ${call.path}`;
    const id = call.query.get("id") ?? "";
    const sandbox = call.query.get("sandbox") ?? "";
    switch (route) {
      case "POST /v1/sandboxes": {
        const created = sandboxRecord(next("sbx"), call.body ?? {});
        if (call.body?.run) {
          const command = next("cmd");
          const record = commandRecord(command, created.id, call.body);
          created.status = "destroyed";
          (created as Record<string, unknown>).status_reason = "run_ended";
          (created as Record<string, unknown>).run = {
            status: "exited",
            command,
            result: record.result,
            exit_code: 0,
          };
        }
        sandboxes.set(created.id, created);
        return { body: created };
      }
      case "GET /v1/sandboxes/get":
        return sandboxes.has(id)
          ? { body: sandboxes.get(id) }
          : notFound("sandbox_not_found");
      case "DELETE /v1/sandboxes": {
        const found = sandboxes.get(id);
        if (!found) return notFound("sandbox_not_found");
        found.status = "destroyed";
        return { body: found };
      }
      case "POST /v1/sandboxes/stop":
      case "POST /v1/sandboxes/resume":
      case "POST /v1/sandboxes/update": {
        const found = sandboxes.get(id);
        if (!found) return notFound("sandbox_not_found");
        if (call.path.endsWith("stop")) found.status = "stopped";
        if (call.path.endsWith("resume")) found.status = "running";
        if (call.path.endsWith("update") && call.body?.metadata)
          found.metadata = call.body.metadata;
        return { body: found };
      }
      case "GET /v1/sandboxes":
        return {
          body: {
            object: "list",
            data: [...sandboxes.values()],
            has_more: false,
          },
        };
      case "POST /v1/sandboxes/commands": {
        const command = next("cmd");
        const record = commandRecord(command, sandbox, call.body ?? {});
        commands.set(command, record);
        return { body: record };
      }
      case "GET /v1/sandboxes/commands/get":
        return commands.has(id)
          ? { body: commands.get(id) }
          : notFound("sandbox_command_not_found");
      case "GET /v1/sandboxes/commands":
        return {
          body: {
            object: "list",
            data: [...commands.values()],
            has_more: false,
          },
        };
      case "GET /v1/sandboxes/commands/logs":
        return {
          body: {
            object: "sandbox_log",
            data: [],
            next_offset: 0,
            done: true,
          },
        };
      case "POST /v1/sandboxes/commands/cancel":
        return commands.has(id)
          ? {
              body: {
                ...commands.get(id),
                status: "cancelled",
                reason: "request",
              },
            }
          : notFound("sandbox_command_not_found");
      case "PUT /v1/sandboxes/files/content": {
        const path = call.query.get("path") ?? "";
        const bytes = rawBody2Bytes(call.rawBody);
        files.set(`${sandbox}:${path}`, bytes);
        return {
          body: {
            object: "sandbox_file",
            path: `/workspace/${path}`,
            type: "file",
            bytes: bytes.length,
            modified: 1_793_174_400,
          },
        };
      }
      case "GET /v1/sandboxes/files/content": {
        const bytes = files.get(`${sandbox}:${call.query.get("path") ?? ""}`);
        return bytes ? { bytes } : notFound("sandbox_file_not_found");
      }
      case "GET /v1/sandboxes/files":
        return {
          body: {
            object: "list",
            data: [...files.keys()]
              .filter((key) => key.startsWith(`${sandbox}:`))
              .map((key) => ({
                object: "sandbox_file",
                path: `/workspace/${key.slice(sandbox.length + 1)}`,
                type: "file",
                bytes: 1,
                modified: 1_793_174_400,
              })),
            has_more: false,
          },
        };
      case "DELETE /v1/sandboxes/files": {
        const path = call.query.get("path") ?? "";
        files.delete(`${sandbox}:${path}`);
        return {
          body: {
            object: "sandbox_file_deleted",
            path: `/workspace/${path}`,
            deleted: true,
          },
        };
      }
      case "POST /v1/sandboxes/templates":
        return {
          body: {
            id: next("sbt"),
            object: "sandbox_template",
            created: 1_793_174_400,
            name: call.body?.name,
            base: call.body?.base ?? "lbb/python",
            builtin: false,
            code: call.body?.code,
            files: [],
            limits: { vcpus: 1, memory_mib: 1024, disk_mib: 4096 },
            timeout_ms: call.body?.timeout_ms ?? 60_000,
            config: call.body?.config ?? null,
            revoked: false,
          },
        };
      case "GET /v1/sandboxes/templates":
        return { body: { object: "list", data: [], has_more: false } };
      case "GET /v1/sandboxes/templates/get":
        return { body: { id, object: "sandbox_template", name: "lbb/python" } };
      default:
        return {
          status: 404,
          body: { error: { code: "unknown_route", message: route } },
        };
    }
  };

  return {
    fetch,
    calls,
    respond: (responder) => responders.push(responder),
    files,
  };
}

function rawBody2Bytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return new TextEncoder().encode(String(raw ?? ""));
}

function clientOf(fetch: FetchLike) {
  return new LbbClient({
    baseUrl: "http://h",
    graph: "main",
    fetch,
    retryDelayMs: 0,
  });
}

const CODE = "def run(input, config):\n    return sum(input)";
const CSV = "1,2\n3,4\n";

// ---- level 1 and 2 ---------------------------------------------------------------

test("run sends one create with the code, the input and a key, and returns the result", async () => {
  const host = service();
  const lbb = clientOf(host.fetch);

  const answer = await lbb.sandboxes.run({ code: CODE, input: [1, 2, 3] });

  assert.equal(answer.result, 6);
  assert.equal(answer.ok, true);
  assert.equal(answer.status, "exited");
  assert.equal(answer.exitCode, 0);
  assert.match(answer.command, /^cmd_/);
  assert.equal(answer.sandbox.status, "destroyed");
  assert.equal(host.calls.length, 1);
  const call = host.calls[0]!;
  assert.equal(`${call.method} ${call.path}`, "POST /v1/sandboxes");
  assert.equal(call.query.get("graph"), "main");
  assert.match(
    call.headers["idempotency-key"] ?? "",
    /^sandboxes\.run:/,
    "the SDK makes a key when the caller gives none",
  );
  assert.deepEqual(call.body, {
    run: { code: CODE, input: [1, 2, 3] },
    wait_ms: 30_000,
  });
});

test("run takes the caller's key, a saved template, limits and the command timeout", async () => {
  const host = service();
  const lbb = clientOf(host.fetch);

  await lbb.sandboxes.run({
    template: "normalize",
    input: { file: "a.csv" },
    config: { unit: "mm" },
    limits: { vcpus: 2, memoryMib: 512, diskMib: 1024 },
    commandTimeoutMs: 5_000,
    waitMs: 10_000,
    expiresInSeconds: 600,
    metadata: { job: "x" },
    idempotencyKey: "mine-1",
  });

  const call = host.calls[0]!;
  assert.equal(call.headers["idempotency-key"], "mine-1");
  assert.deepEqual(call.body, {
    template: "normalize",
    limits: { vcpus: 2, memory_mib: 512, disk_mib: 1024 },
    expires_in_seconds: 600,
    metadata: { job: "x" },
    run: {
      input: { file: "a.csv" },
      config: { unit: "mm" },
      timeout_ms: 5_000,
    },
    wait_ms: 10_000,
  });
});

test("a run whose code failed is a result with ok false and no value, not an error", async () => {
  const host = service();
  host.respond((call) =>
    call.method === "POST" && call.path === "/v1/sandboxes"
      ? {
          body: {
            id: "sbx_1793174400000a1b2c3d4e5f6",
            status: "destroyed",
            run: { status: "exited", command: "cmd_1", exit_code: 1 },
          },
        }
      : undefined,
  );

  const answer = await clientOf(host.fetch).sandboxes.run({
    code: "def run(i, c):\n    raise ValueError()",
  });

  assert.equal(answer.ok, false);
  assert.equal(answer.exitCode, 1);
  assert.equal(answer.result, undefined);
});

test("a retry after a 503 sends the same key, so the server runs the code once", async () => {
  const host = service();
  let first = true;
  host.respond((call) => {
    if (call.method === "POST" && first) {
      first = false;
      return {
        status: 503,
        body: {
          error: {
            code: "sandbox_unavailable",
            message: "no host",
            retryable: true,
          },
        },
      };
    }
    return undefined;
  });

  await clientOf(host.fetch).sandboxes.run({ code: CODE, input: [1] });

  const posts = host.calls.filter((call) => call.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(
    posts[0]!.headers["idempotency-key"],
    posts[1]!.headers["idempotency-key"],
  );
});

test("a run that outlives its wait is polled by the sandbox until it ends", async () => {
  const host = service();
  let reads = 0;
  host.respond((call) => {
    if (call.method === "POST" && call.path === "/v1/sandboxes")
      return {
        body: {
          id: "sbx_1793174400000a1b2c3d4e5f6",
          status: "running",
          run: { status: "running", command: "cmd_1" },
        },
      };
    if (call.method === "GET" && call.path === "/v1/sandboxes/get") {
      reads += 1;
      return {
        body: {
          id: "sbx_1793174400000a1b2c3d4e5f6",
          status: reads < 2 ? "running" : "destroyed",
          run:
            reads < 2
              ? { status: "running", command: "cmd_1" }
              : {
                  status: "exited",
                  command: "cmd_1",
                  exit_code: 0,
                  result: 42,
                },
        },
      };
    }
    return undefined;
  });

  const answer = await clientOf(host.fetch).sandboxes.run({ code: CODE });

  assert.equal(answer.result, 42);
  assert.equal(reads, 2);
  assert.equal(
    host.calls.filter((call) => call.method === "POST").length,
    1,
    "polling never creates a second sandbox",
  );
});

test("a run that never ends throws SandboxWaitError with the sandbox", async () => {
  const host = service();
  host.respond((call) =>
    call.path === "/v1/sandboxes" || call.path === "/v1/sandboxes/get"
      ? {
          body: {
            id: "sbx_1793174400000a1b2c3d4e5f6",
            status: "running",
            run: { status: "running", command: "cmd_1" },
          },
        }
      : undefined,
  );

  await assert.rejects(
    clientOf(host.fetch).sandboxes.run({ code: CODE, maxWaitMs: 50 }),
    (error: unknown) =>
      error instanceof SandboxWaitError &&
      error.sandbox.id === "sbx_1793174400000a1b2c3d4e5f6",
  );
});

test("a lost run goes again in a new sandbox under the next key, twice at most", async () => {
  const host = service();
  let lost = 2;
  host.respond((call) => {
    if (call.method === "POST" && call.path === "/v1/sandboxes" && lost > 0) {
      lost -= 1;
      return {
        body: {
          id: `sbx_179317440000${lost}a1b2c3d4e5f6`,
          status: "lost",
          run: { status: "lost", command: "cmd_1" },
        },
      };
    }
    return undefined;
  });

  const answer = await clientOf(host.fetch).sandboxes.run({
    code: CODE,
    input: [4, 5],
    idempotencyKey: "job",
  });

  assert.equal(answer.result, 9, "the third run worked");
  const keys = host.calls
    .filter((call) => call.method === "POST")
    .map((call) => call.headers["idempotency-key"]);
  assert.deepEqual(keys, ["job", "job.2", "job.3"]);
});

test("a run that stays lost is returned lost after the retries, and lostRetries 0 turns them off", async () => {
  const lostHost = () => {
    const host = service();
    host.respond((call) =>
      call.method === "POST" && call.path === "/v1/sandboxes"
        ? {
            body: {
              id: "sbx_1793174400000a1b2c3d4e5f6",
              status: "lost",
              run: { status: "lost", command: "cmd_1" },
            },
          }
        : undefined,
    );
    return host;
  };
  const stubborn = lostHost();
  const answer = await clientOf(stubborn.fetch).sandboxes.run({ code: CODE });
  assert.equal(answer.status, "lost");
  assert.equal(answer.ok, false);
  assert.equal(stubborn.calls.length, 3, "one run and two more");

  const once = lostHost();
  await clientOf(once.fetch).sandboxes.run({ code: CODE, lostRetries: 0 });
  assert.equal(once.calls.length, 1);
});

test("lostRetries is 0 to 2, whatever is asked: the design allows a fresh run twice again", async () => {
  const lostHost = () => {
    const host = service();
    host.respond((call) =>
      call.method === "POST" && call.path === "/v1/sandboxes"
        ? {
            body: {
              id: "sbx_1793174400000a1b2c3d4e5f6",
              status: "lost",
              run: { status: "lost", command: "cmd_1" },
            },
          }
        : undefined,
    );
    return host;
  };
  for (const [asked, runs] of [
    [5, 3],
    [2, 3],
    [1, 2],
    [0, 1],
    [-4, 1],
    [Infinity, 3],
    [1.9, 2],
  ] as const) {
    const host = lostHost();
    await clientOf(host.fetch).sandboxes.run({
      code: CODE,
      lostRetries: asked,
    });
    assert.equal(host.calls.length, runs, `lostRetries ${asked}`);
  }
});

test("an empty key is no key: every call that runs code makes one", async () => {
  const host = service();
  const lbb = clientOf(host.fetch);
  await lbb.sandboxes.run({ code: CODE, input: [1], idempotencyKey: "" });
  const sb = await lbb.sandboxes.create({ idempotencyKey: "" });
  await sb.commands.create({ argv: ["true"], idempotencyKey: "" });
  await lbb.sandboxes.scoped({ idempotencyKey: "" }, () => undefined);
  await lbb.sandboxes.templates.create({ name: "t", idempotencyKey: "" });
  const posts = host.calls.filter((call) => call.method === "POST");
  assert.equal(posts.length, 5);
  for (const call of posts)
    assert.ok(
      (call.headers["idempotency-key"] ?? "").length > 0,
      `${call.path} sent a key that was empty`,
    );
});

test("the reads of a wait carry the options of the call", async () => {
  const host = service();
  host.respond((call) => {
    if (call.method === "POST" && call.path === "/v1/sandboxes")
      return {
        body: {
          id: "sbx_1793174400000a1b2c3d4e5f6",
          status: "running",
          run: { status: "running", command: "cmd_1" },
        },
      };
    if (call.method === "GET" && call.path === "/v1/sandboxes/get")
      return {
        body: {
          id: "sbx_1793174400000a1b2c3d4e5f6",
          status: "destroyed",
          run: { status: "exited", command: "cmd_1", exit_code: 0, result: 1 },
        },
      };
    return undefined;
  });
  await clientOf(host.fetch).sandboxes.run({
    code: CODE,
    headers: { "x-trace": "t-1" },
  });
  const read = host.calls.find((call) => call.method === "GET")!;
  assert.equal(read.headers["x-trace"], "t-1");
  assert.equal(
    host.calls.find((call) => call.method === "POST")!.headers["x-trace"],
    "t-1",
  );
});

test("a run that failed in the sandbox is not run again", async () => {
  const host = service();
  host.respond((call) =>
    call.method === "POST" && call.path === "/v1/sandboxes"
      ? {
          body: {
            id: "sbx_1793174400000a1b2c3d4e5f6",
            status: "destroyed",
            run: { status: "failed", command: "cmd_1" },
          },
        }
      : undefined,
  );
  const answer = await clientOf(host.fetch).sandboxes.run({ code: CODE });
  assert.equal(answer.status, "failed");
  assert.equal(host.calls.length, 1);
});

test("an error of the server is an LbbError", async () => {
  const host = service();
  host.respond((call) =>
    call.method === "POST"
      ? {
          status: 409,
          body: {
            error: {
              type: "invalid_request_error",
              code: "sandbox_not_enabled",
              message: "off",
            },
          },
        }
      : undefined,
  );
  await assert.rejects(
    clientOf(host.fetch).sandboxes.run({ code: CODE }),
    (error: unknown) =>
      error instanceof LbbError && error.code === "sandbox_not_enabled",
  );
});

// ---- level 3 ----------------------------------------------------------------------

test("scoped makes a sandbox, hands over the handle and destroys it after the work", async () => {
  const host = service();
  const lbb = clientOf(host.fetch);

  const value = await lbb.sandboxes.scoped(
    { template: "normalize", expiresInSeconds: 600 },
    async (sb) => {
      assert.match(sb.id, /^sbx_/);
      await sb.files.write("data.csv", CSV);
      return 7;
    },
  );

  assert.equal(value, 7);
  const routes = host.calls.map((call) => `${call.method} ${call.path}`);
  assert.deepEqual(routes, [
    "POST /v1/sandboxes",
    "PUT /v1/sandboxes/files/content",
    "DELETE /v1/sandboxes",
  ]);
  assert.match(
    host.calls[0]!.headers["idempotency-key"] ?? "",
    /^sandboxes\.create:/,
  );
  assert.deepEqual(host.calls[0]!.body, {
    template: "normalize",
    expires_in_seconds: 600,
  });
});

test("scoped destroys the sandbox after an error and rethrows that error", async () => {
  const host = service();
  host.respond((call) =>
    call.method === "DELETE"
      ? {
          status: 503,
          body: { error: { code: "sandbox_unavailable", message: "x" } },
        }
      : undefined,
  );
  const lbb = new LbbClient({
    baseUrl: "http://h",
    graph: "main",
    fetch: host.fetch,
    retryDelayMs: 0,
    maxRetries: 0,
  });

  await assert.rejects(
    lbb.sandboxes.scoped({}, async () => {
      throw new Error("the work failed");
    }),
    /the work failed/,
  );
  assert.equal(
    host.calls.filter((call) => call.method === "DELETE").length,
    1,
    "the destroy was tried, and its failure did not hide the error",
  );
});

test("scoped ignores a sandbox that is gone and reports another failure of the destroy", async () => {
  const gone = service();
  gone.respond((call) =>
    call.method === "DELETE"
      ? {
          status: 404,
          body: { error: { code: "sandbox_not_found", message: "gone" } },
        }
      : undefined,
  );
  assert.equal(
    await clientOf(gone.fetch).sandboxes.scoped({}, async () => "done"),
    "done",
  );

  const broken = service();
  broken.respond((call) =>
    call.method === "DELETE"
      ? { status: 403, body: { error: { code: "forbidden", message: "no" } } }
      : undefined,
  );
  await assert.rejects(
    clientOf(broken.fetch).sandboxes.scoped({}, async () => "done"),
    (error: unknown) => error instanceof LbbError && error.status === 403,
  );
});

test("the handle reads and writes files, and lists and deletes them", async () => {
  const host = service();
  const sb = await clientOf(host.fetch).sandboxes.create({});

  const written = await sb.files.write("data/a.csv", CSV);
  assert.equal(written.bytes, CSV.length);
  const put = host.calls.at(-1)!;
  assert.equal(put.method, "PUT");
  assert.equal(put.query.get("sandbox"), sb.id);
  assert.equal(put.query.get("path"), "data/a.csv");
  assert.equal(put.headers["content-type"], "application/octet-stream");
  assert.deepEqual(rawBody2Bytes(put.rawBody), new TextEncoder().encode(CSV));

  assert.equal(await sb.files.readText("data/a.csv"), CSV);
  assert.deepEqual(
    await sb.files.read("data/a.csv", { range: { start: 2, end: 4 } }),
    new TextEncoder().encode(CSV),
  );
  assert.equal(host.calls.at(-1)!.headers["range"], "bytes=2-4");

  const listing = await sb.files.list("/workspace", {
    recursive: true,
    limit: 10,
  });
  assert.equal(listing.data[0]!.path, "/workspace/data/a.csv");
  const listed = host.calls.at(-1)!;
  assert.equal(listed.query.get("recursive"), "true");
  assert.equal(listed.query.get("limit"), "10");

  await sb.files.delete("data", { recursive: true });
  const deleted = host.calls.at(-1)!;
  assert.equal(deleted.method, "DELETE");
  assert.equal(deleted.query.get("recursive"), "true");
});

test("the handle runs code and commands with keys, and reads, lists and cancels them", async () => {
  const host = service();
  const sb = await clientOf(host.fetch).sandboxes.create({});

  const rows = await sb.run({ code: CODE, input: [1, 2], waitMs: 5_000 });
  assert.equal(rows.result, 3);
  const run = host.calls.at(-1)!;
  assert.equal(run.path, "/v1/sandboxes/commands");
  assert.equal(run.query.get("sandbox"), sb.id);
  assert.match(
    run.headers["idempotency-key"] ?? "",
    /^sandboxes\.commands\.create:/,
  );
  assert.deepEqual(run.body, {
    run: { code: CODE, input: [1, 2] },
    wait_ms: 5_000,
  });

  const command = await sb.commands.create({
    argv: ["python", "check.py"],
    cwd: "/workspace",
    env: { MODE: "fast" },
    stdin: "x",
    commandTimeoutMs: 2_000,
    idempotencyKey: "check-1",
  });
  const sent = host.calls.at(-1)!;
  assert.equal(sent.headers["idempotency-key"], "check-1");
  assert.deepEqual(sent.body, {
    argv: ["python", "check.py"],
    cwd: "/workspace",
    env: { MODE: "fast" },
    stdin: "x",
    timeout_ms: 2_000,
    wait_ms: 30_000,
  });

  assert.equal((await sb.commands.retrieve(command.id)).id, command.id);
  assert.equal(
    (await sb.commands.list({ status: "exited", limit: 5 })).data.length >= 2,
    true,
  );
  assert.equal(host.calls.at(-1)!.query.get("status"), "exited");
  const logs = await sb.commands.logs(command.id, {
    stream: "stderr",
    offset: 10,
    limit: 20,
  });
  assert.equal(logs.done, true);
  const logCall = host.calls.at(-1)!;
  assert.equal(logCall.query.get("stream"), "stderr");
  assert.equal(logCall.query.get("offset"), "10");
  const cancelled = await sb.commands.cancel(command.id, { graceMs: 100 });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(host.calls.at(-1)!.body, { grace_ms: 100 });
});

test("the handle stops, resumes, updates, reads and deletes its sandbox and keeps the record", async () => {
  const host = service();
  const sb = await clientOf(host.fetch).sandboxes.create({
    limits: { memoryMib: 256 },
    autoStopSeconds: 60,
  });
  assert.deepEqual(host.calls[0]!.body, {
    limits: { memory_mib: 256 },
    auto_stop_seconds: 60,
  });
  assert.equal((await sb.stop()).status, "stopped");
  assert.equal(sb.record.status, "stopped");
  assert.equal((await sb.resume()).status, "running");
  assert.deepEqual((await sb.update({ metadata: { a: "b" } })).metadata, {
    a: "b",
  });
  assert.equal((await sb.refresh()).id, sb.id);
  assert.equal((await sb.delete()).status, "destroyed");
});

test("the namespace lists, retrieves and saves templates with the filters of the wire", async () => {
  const host = service();
  const lbb = clientOf(host.fetch);

  await lbb.sandboxes.list({
    status: "running",
    kind: "run",
    createdBy: "key:a",
    limit: 3,
  });
  const list = host.calls.at(-1)!;
  assert.equal(list.query.get("status"), "running");
  assert.equal(list.query.get("kind"), "run");
  assert.equal(list.query.get("created_by"), "key:a");
  assert.equal(list.query.get("limit"), "3");

  const template = await lbb.sandboxes.templates.create({
    name: "normalize",
    base: "lbb/python",
    code: CODE,
    limits: { memoryMib: 2048 },
    commandTimeoutMs: 60_000,
    config: { unit: "cm" },
  });
  assert.equal(template.name, "normalize");
  const saved = host.calls.at(-1)!;
  assert.match(
    saved.headers["idempotency-key"] ?? "",
    /^sandboxes\.templates\.create:/,
  );
  assert.deepEqual(saved.body, {
    name: "normalize",
    base: "lbb/python",
    code: CODE,
    limits: { memory_mib: 2048 },
    timeout_ms: 60_000,
    config: { unit: "cm" },
  });
  await lbb.sandboxes.templates.list({ limit: 2 });
  await lbb.sandboxes.templates.retrieve("sbt_lbb_python");
  assert.equal(host.calls.at(-1)!.query.get("id"), "sbt_lbb_python");
});

// ---- the examples of the guide, run ---------------------------------------------------

const AsyncFunction = Object.getPrototypeOf(async () => undefined)
  .constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

/** `docs/guides/sandboxes.md` in an ancestor of the working directory. */
function guide(): string | undefined {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, "docs/guides/sandboxes.md");
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The ladder's examples, as the guide shows them. The guide must hold each one as written. */
const EXAMPLES: Record<string, string> = {
  "level 1": `const { result } = await client.sandboxes.run({ code, input: [1, 2, 3] });`,
  "level 2": `await client.sandboxes.templates.create({
  name: "normalize",
  base: "lbb/python",
  code,
  limits: { memoryMib: 2048 },
  commandTimeoutMs: 60_000,
  config: { unit: "cm" },
});
await client.sandboxes.run({ template: "normalize", input: [1, 2, 3] });`,
  "level 3, scoped": `const out = await client.sandboxes.scoped({ template: "normalize" }, async (sb) => {
  await sb.files.write("data.csv", csv);
  const rows = await sb.run({ input: { file: "data.csv" } });
  return sb.commands.create({ argv: ["python", "check.py"], waitMs: 30_000 });
});`,
  "level 3, a handle you keep": `const sb = await client.sandboxes.create({ template: "normalize", expiresInSeconds: 600 });
await sb.files.write("data.csv", csv);
await sb.stop();
await sb.resume();
await sb.delete();`,
};

test("the ladder's examples are in the guide as written, and they run against the client", async (t) => {
  const text = guide();
  if (text === undefined) {
    t.skip("the guide is not in this checkout");
    return;
  }
  for (const [name, source] of Object.entries(EXAMPLES)) {
    assert.ok(
      text.includes(source),
      `docs/guides/sandboxes.md holds the example "${name}" as the test runs it`,
    );
    const host = service();
    const lbb = clientOf(host.fetch);
    const run = new AsyncFunction("client", "code", "csv", source);
    await run(lbb, CODE, CSV);
    assert.ok(host.calls.length > 0, `the example "${name}" made calls`);
  }
});
