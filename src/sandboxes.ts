// Sandboxes (`/v1/sandboxes*`): isolated code runs. A sandbox is a VM-like
// workspace with a disk and no network; LBB keeps the records of what ran, on
// which inputs, with which result.
//
// One resource on three levels in this SDK, and the same records on each:
//
//   L1  `sandboxes.run({ code, input })`           one call, the sandbox is destroyed after
//   L2  `sandboxes.run({ template, input })`       a saved template names the code and limits
//   L3  `sandboxes.scoped(spec, fn)`, `create(spec)` the resource API: files, commands, stop, resume
//
// (Level 4, `ctx.sandboxes` in a workflow handler, is not in this SDK yet.)
//
// Every call that runs code carries an `Idempotency-Key`, which the SDK makes
// when the caller gives none, so a retry after a `5xx` or a lost connection
// answers the same record and never runs the code twice.
import type { LbbClient } from "./client.js";
import { LbbError, sleep, type CallOptions } from "./transport.js";
import type { Schemas } from "./types.js";

/** A sandbox record: its status, template, limits, owner, usage and (for an L1 run) its `run`. */
export type Sandbox = Schemas["Sandbox"];
/** A command record: its status, exit code, output tails and (for a `run`) its `result`. */
export type SandboxCommand = Schemas["SandboxCommand"];
/** A saved template version, or a base template (`lbb/python`, `lbb/node`, `lbb/shell`). */
export type SandboxTemplate = Schemas["SandboxTemplate"];
/** A file or directory of a sandbox's `/workspace`. */
export type SandboxFile = Schemas["SandboxFile"];
/** One page of a command's output, by byte offset. */
export type SandboxLog = Schemas["SandboxLog"];
/** One page of sandboxes. */
export type SandboxList = Schemas["SandboxList"];
/** One page of commands. */
export type SandboxCommandList = Schemas["SandboxCommandList"];
/** One page of workspace entries. */
export type SandboxFileList = Schemas["SandboxFileList"];
/** One page of templates. */
export type SandboxTemplateList = Schemas["SandboxTemplateList"];
/** Where a command stands. */
export type SandboxCommandStatus = Schemas["SandboxCommandStatus"];

/** The most a `wait_ms` holds the answer of a create, and the SDK's default. */
export const SANDBOX_WAIT_MS_MAX = 30_000;

/** Resource limits of a sandbox. A field left out keeps the template's value, else the default. */
export interface SandboxLimits {
  /** Virtual CPUs: 1 to 4. */
  vcpus?: number;
  /** Memory in MiB: 128 to 8,192. */
  memoryMib?: number;
  /** Workspace disk in MiB: 256 to 10,240. */
  diskMib?: number;
}

/** What a sandbox is made from: the template, the limits, its life. */
export interface SandboxSpec extends CallOptions {
  /**
   * A base template (`lbb/python`, the default, `lbb/node`, `lbb/shell`), a
   * saved template's name (its newest version) or one version's `sbt_` id.
   */
  template?: string;
  limits?: SandboxLimits;
  /** Idle seconds before the sandbox stops: 30 to 3,600 (default 300). */
  autoStopSeconds?: number;
  /** Seconds before the sandbox is destroyed: 60 to 604,800 (default 3,600). */
  expiresInSeconds?: number;
  /** At most 16 keys of 40 characters, with values of 500. */
  metadata?: Record<string, string>;
}

/** The function a `run` calls: `run(input, config)`. */
export interface SandboxRunInput {
  /**
   * The code, 64 KiB at most, that defines `run(input, config)` (Python) or
   * `function run(input, config)` (Node). A saved template's code is the
   * default.
   */
  code?: string;
  /** JSON of 1 MiB at most. */
  input?: unknown;
  /** JSON of 1 MiB at most; it takes the place of the template's config. */
  config?: unknown;
}

/** An L1 or L2 call: the sandbox spec and the run. */
export interface SandboxRunSpec extends SandboxSpec, SandboxRunInput {
  /** The command's own timeout, in milliseconds: 1 to 3,600,000 (the template's by default). */
  commandTimeoutMs?: number;
  /** How long the first answer waits for the command to end: 0 to 30,000 (default 30,000). */
  waitMs?: number;
  /**
   * How long the SDK waits for a run that outlives `waitMs`, in
   * milliseconds, before it throws {@link SandboxWaitError}. Default 10
   * minutes. The wait is **per attempt**: a run that is lost and goes again
   * (see `lostRetries`) gets a new wait, so one call can wait up to
   * `maxWaitMs` times the number of attempts.
   */
  maxWaitMs?: number;
  /**
   * How often a run whose VM the host lost (`lost`) goes again in a new
   * sandbox under the next key: the effect class of an L1 call is `fresh`.
   * Default 2, which is also the most: the design allows a fresh run twice
   * again at most, so a larger number is 2. 0 turns it off.
   */
  lostRetries?: number;
}

/** The most a lost run goes again: the design says twice for the class `fresh`. */
const LOST_RETRIES_MAX = 2;

/** What an L1 or L2 call comes to. */
export interface SandboxRunResult {
  /** What `run(input, config)` returned (JSON, 48 KiB at most); `undefined` when the run made no result. */
  result: unknown;
  /** The command's status: `exited` with `exitCode` 0 is a run that worked. */
  status: SandboxCommandStatus;
  exitCode?: number;
  /** The command's id (`cmd_`). */
  command: string;
  /** The run exited with code 0. Check it before you use `result`. */
  ok: boolean;
  /** The sandbox record of the run. */
  sandbox: Sandbox;
}

/** The run did not end within `maxWaitMs`. The sandbox and the command stay; read them by their ids. */
export class SandboxWaitError extends Error {
  constructor(
    readonly sandbox: Sandbox,
    readonly waitedMs: number,
  ) {
    super(
      `sandbox ${sandbox.id} did not finish its run within ${waitedMs} ms (status ${sandbox.run?.status ?? sandbox.status})`,
    );
    this.name = "SandboxWaitError";
  }
}

/** A command: `argv` or a `run`. */
export interface SandboxCommandSpec extends CallOptions {
  /** The program and its arguments. A shell is explicit: `["bash", "-lc", "…"]`. */
  argv?: string[];
  /** The function a harness calls, instead of `argv`. */
  run?: SandboxRunInput;
  /** A path under `/workspace`. */
  cwd?: string;
  /** Names that start with `LBB_` are refused. Values are never stored. */
  env?: Record<string, string>;
  /** 1 MiB at most; never stored. */
  stdin?: string;
  /** The command's own timeout, in milliseconds. */
  commandTimeoutMs?: number;
  /** How long the answer waits for the command to end: 0 to 30,000 (default 30,000). */
  waitMs?: number;
}

/** One page of a list. */
export interface SandboxListOptions extends CallOptions {
  /** One status: `running`, `stopped`, … */
  status?: string;
  /** A template name or id. */
  template?: string;
  workflow?: string;
  createdBy?: string;
  /** `run` for the sandboxes of an L1 call, `sandbox` for the others. */
  kind?: "run" | "sandbox";
  /** 1 to 200 (default 50). */
  limit?: number;
  /** The `next_cursor` of the page before. */
  cursor?: string;
}

/** A saved template: a new version of `name`. */
export interface SandboxTemplateSpec extends CallOptions {
  /** 1 to 64 of `a-z`, `0-9`, `.`, `_` and `-`. */
  name: string;
  /** A base template (`lbb/python` by default). */
  base?: string;
  /** The `run` code, 64 KiB at most. */
  code?: string;
  limits?: SandboxLimits;
  /** The default command timeout, in milliseconds. */
  commandTimeoutMs?: number;
  /** The default config of a `run`. */
  config?: unknown;
}

function limitsBody(
  limits: SandboxLimits | undefined,
): Schemas["SandboxLimitsInput"] | undefined {
  if (limits === undefined) return undefined;
  return {
    vcpus: limits.vcpus,
    memory_mib: limits.memoryMib,
    disk_mib: limits.diskMib,
  };
}

function runBody(
  run: SandboxRunInput,
  commandTimeoutMs: number | undefined,
): Schemas["SandboxRunRequest"] {
  return {
    code: run.code,
    input: run.input,
    config: run.config,
    timeout_ms: commandTimeoutMs,
  };
}

/**
 * The key a call that runs code sends: the one the caller gave, else one the
 * SDK makes. An empty string is no key, as in the Python SDK: it would send an
 * `Idempotency-Key` header with nothing in it, which binds nothing.
 */
function keyOf(given: string | undefined, make: () => string): string {
  return given === undefined || given === "" ? make() : given;
}

/** The call options a spec carries, without the fields this module reads. */
function callOptions<T extends CallOptions>(spec: T): CallOptions {
  const {
    idempotencyKey,
    timeoutMs,
    maxRetries,
    retryBudgetMs,
    retry,
    signal,
    headers,
  } = spec;
  return {
    idempotencyKey: idempotencyKey === "" ? undefined : idempotencyKey,
    timeoutMs,
    maxRetries,
    retryBudgetMs,
    retry,
    signal,
    headers,
  };
}

function isFinal(status: SandboxCommandStatus | undefined): boolean {
  return status !== "queued" && status !== "running";
}

function createBody(spec: SandboxSpec): Schemas["SandboxCreateRequest"] {
  return {
    template: spec.template,
    limits: limitsBody(spec.limits),
    auto_stop_seconds: spec.autoStopSeconds,
    expires_in_seconds: spec.expiresInSeconds,
    metadata: spec.metadata,
  };
}

/** Text or bytes, as the bytes a file write sends. */
function bytesOf(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

/** The files of a sandbox's `/workspace`. */
export class SandboxFiles {
  constructor(
    private readonly client: LbbClient,
    private readonly sandbox: string,
  ) {}

  /**
   * A file's bytes (`GET /v1/sandboxes/files/content`), at most 4 MiB; a
   * larger file needs `range`. A path is under `/workspace`; a relative
   * path is.
   */
  read(
    path: string,
    options: CallOptions & { range?: { start: number; end?: number } } = {},
  ): Promise<Uint8Array> {
    const { range, ...opts } = options;
    const headers =
      range === undefined
        ? opts.headers
        : {
            ...opts.headers,
            range: `bytes=${range.start}-${range.end ?? ""}`,
          };
    return this.client.request("GET", "/v1/sandboxes/files/content", {
      ...opts,
      headers,
      query: { sandbox: this.sandbox, path },
      responseType: "bytes",
    });
  }

  /** A file's text, decoded as UTF-8. */
  async readText(path: string, options: CallOptions = {}): Promise<string> {
    return new TextDecoder().decode(await this.read(path, options));
  }

  /**
   * Write a file (`PUT /v1/sandboxes/files/content`), 4 MiB at most, and the
   * directories above it. The same bytes again change nothing, so a retry
   * is safe.
   */
  write(
    path: string,
    data: string | Uint8Array | ArrayBuffer,
    options: CallOptions = {},
  ): Promise<SandboxFile> {
    return this.client.request("PUT", "/v1/sandboxes/files/content", {
      ...options,
      retry: options.retry ?? true,
      query: { sandbox: this.sandbox, path },
      rawBody: bytesOf(data),
      contentType: "application/octet-stream",
    });
  }

  /** One page of a directory (`GET /v1/sandboxes/files`), in path order. */
  list(
    path = "/workspace",
    options: CallOptions & {
      recursive?: boolean;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<SandboxFileList> {
    const { recursive, limit, cursor, ...opts } = options;
    return this.client.request("GET", "/v1/sandboxes/files", {
      ...opts,
      query: {
        sandbox: this.sandbox,
        path,
        recursive: recursive ? true : undefined,
        limit,
        cursor,
      },
    });
  }

  /** Delete a file, or a directory with `recursive` (`DELETE /v1/sandboxes/files`). */
  delete(
    path: string,
    options: CallOptions & { recursive?: boolean } = {},
  ): Promise<Schemas["SandboxFileDeleted"]> {
    const { recursive, ...opts } = options;
    return this.client.request("DELETE", "/v1/sandboxes/files", {
      ...opts,
      retry: opts.retry ?? true,
      query: {
        sandbox: this.sandbox,
        path,
        recursive: recursive ? true : undefined,
      },
    });
  }
}

/** The commands of a sandbox. */
export class SandboxCommands {
  constructor(
    private readonly client: LbbClient,
    private readonly sandbox: string,
  ) {}

  /**
   * Start a command (`POST /v1/sandboxes/commands`) and wait up to `waitMs`
   * for it to end. The call carries an `Idempotency-Key` (made when you
   * give none): a retry answers the same command and never runs it twice. A
   * command whose outcome cannot be settled ends `lost` and is not run
   * again.
   */
  create(spec: SandboxCommandSpec): Promise<SandboxCommand> {
    const body: Schemas["SandboxCommandCreateRequest"] = {
      argv: spec.argv,
      run:
        spec.run === undefined
          ? undefined
          : runBody(spec.run, spec.commandTimeoutMs),
      cwd: spec.cwd,
      env: spec.env,
      stdin: spec.stdin,
      timeout_ms: spec.run === undefined ? spec.commandTimeoutMs : undefined,
      wait_ms: spec.waitMs ?? SANDBOX_WAIT_MS_MAX,
    };
    return this.client.request("POST", "/v1/sandboxes/commands", {
      ...callOptions(spec),
      idempotencyKey: keyOf(spec.idempotencyKey, () =>
        this.client.idempotencyKey("sandboxes.commands.create"),
      ),
      query: { sandbox: this.sandbox },
      body,
    });
  }

  /** One page of commands, the newest first. */
  list(
    options: CallOptions & {
      status?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<SandboxCommandList> {
    const { status, limit, cursor, ...opts } = options;
    return this.client.request("GET", "/v1/sandboxes/commands", {
      ...opts,
      query: { sandbox: this.sandbox, status, limit, cursor },
    });
  }

  /** One command: its status and, once it ended, its exit code, output tails and result. */
  retrieve(id: string, options: CallOptions = {}): Promise<SandboxCommand> {
    return this.client.request("GET", "/v1/sandboxes/commands/get", {
      ...options,
      query: { sandbox: this.sandbox, id },
    });
  }

  /**
   * One page of a command's output by byte offset (`GET
   * /v1/sandboxes/commands/logs`). The server keeps the first 256 KiB and the
   * last 768 KiB of each stream; `gap` marks what lies between them.
   */
  logs(
    id: string,
    options: CallOptions & {
      stream?: "stdout" | "stderr";
      offset?: number;
      limit?: number;
    } = {},
  ): Promise<SandboxLog> {
    const { stream, offset, limit, ...opts } = options;
    return this.client.request("GET", "/v1/sandboxes/commands/logs", {
      ...opts,
      query: { sandbox: this.sandbox, id, stream, offset, limit },
    });
  }

  /**
   * End a command: `SIGTERM` to its processes, then `SIGKILL` after `graceMs`
   * (default 5,000). A repeat on an ended command answers its record.
   */
  cancel(
    id: string,
    options: CallOptions & { graceMs?: number } = {},
  ): Promise<SandboxCommand> {
    const { graceMs, ...opts } = options;
    return this.client.request("POST", "/v1/sandboxes/commands/cancel", {
      ...opts,
      retry: opts.retry ?? true,
      query: { sandbox: this.sandbox, id },
      body: graceMs === undefined ? {} : { grace_ms: graceMs },
    });
  }
}

/**
 * A sandbox you hold: its files, its commands and its life. `scoped` and
 * `create` give one.
 */
export class SandboxHandle {
  readonly files: SandboxFiles;
  readonly commands: SandboxCommands;

  constructor(
    private readonly client: LbbClient,
    /** The last record the SDK read. `refresh` reads it again. */
    public record: Sandbox,
  ) {
    this.files = new SandboxFiles(client, record.id);
    this.commands = new SandboxCommands(client, record.id);
  }

  /** The sandbox id (`sbx_`). */
  get id(): string {
    return this.record.id;
  }

  /**
   * Run `run(input, config)` on this sandbox: `commands.create({ run })`.
   * Answers the command record, whose `result` is what `run` returned. The
   * sandbox keeps its files between calls, so a later call sees what an
   * earlier one wrote.
   */
  run(
    spec: SandboxRunInput &
      CallOptions & {
        commandTimeoutMs?: number;
        waitMs?: number;
        cwd?: string;
      },
  ): Promise<SandboxCommand> {
    const { code, input, config, commandTimeoutMs, waitMs, cwd, ...opts } =
      spec;
    return this.commands.create({
      ...opts,
      run: { code, input, config },
      commandTimeoutMs,
      waitMs,
      cwd,
    });
  }

  /** Read the sandbox again. */
  async refresh(options: CallOptions = {}): Promise<Sandbox> {
    this.record = await this.client.request<Sandbox>(
      "GET",
      "/v1/sandboxes/get",
      {
        ...options,
        query: { id: this.record.id },
      },
    );
    return this.record;
  }

  /** Stop the VM and keep the disk. A repeat answers the sandbox as it is. */
  async stop(options: CallOptions = {}): Promise<Sandbox> {
    this.record = await this.client.request<Sandbox>(
      "POST",
      "/v1/sandboxes/stop",
      {
        ...options,
        retry: options.retry ?? true,
        query: { id: this.record.id },
      },
    );
    return this.record;
  }

  /** Start a stopped sandbox from its disk. */
  async resume(options: CallOptions = {}): Promise<Sandbox> {
    this.record = await this.client.request<Sandbox>(
      "POST",
      "/v1/sandboxes/resume",
      {
        ...options,
        retry: options.retry ?? true,
        query: { id: this.record.id },
      },
    );
    return this.record;
  }

  /** Change `autoStopSeconds` or the whole `metadata`. */
  async update(
    patch: { autoStopSeconds?: number; metadata?: Record<string, string> },
    options: CallOptions = {},
  ): Promise<Sandbox> {
    this.record = await this.client.request<Sandbox>(
      "POST",
      "/v1/sandboxes/update",
      {
        ...options,
        query: { id: this.record.id },
        body: {
          auto_stop_seconds: patch.autoStopSeconds,
          metadata: patch.metadata,
        },
      },
    );
    return this.record;
  }

  /** Destroy the VM and its disk. A repeat answers the sandbox as it is. */
  async delete(options: CallOptions = {}): Promise<Sandbox> {
    this.record = await this.client.request<Sandbox>(
      "DELETE",
      "/v1/sandboxes",
      {
        ...options,
        retry: options.retry ?? true,
        query: { id: this.record.id },
      },
    );
    return this.record;
  }
}

/** Saved templates: each save of a name is a new immutable version. */
export class SandboxTemplatesNamespace {
  constructor(private readonly client: LbbClient) {}

  /** Save a new version of a template (`POST /v1/sandboxes/templates`). */
  create(spec: SandboxTemplateSpec): Promise<SandboxTemplate> {
    const body: Schemas["SandboxTemplateCreateRequest"] = {
      name: spec.name,
      base: spec.base,
      code: spec.code,
      limits: limitsBody(spec.limits),
      timeout_ms: spec.commandTimeoutMs,
      config: spec.config,
    };
    return this.client.request("POST", "/v1/sandboxes/templates", {
      ...callOptions(spec),
      idempotencyKey: keyOf(spec.idempotencyKey, () =>
        this.client.idempotencyKey("sandboxes.templates.create"),
      ),
      body,
    });
  }

  /** One page of saved templates, the newest version first. */
  list(
    options: CallOptions & { limit?: number; cursor?: string } = {},
  ): Promise<SandboxTemplateList> {
    const { limit, cursor, ...opts } = options;
    return this.client.request("GET", "/v1/sandboxes/templates", {
      ...opts,
      query: { limit, cursor },
    });
  }

  /** One version by its `sbt_` id, or a base template (`sbt_lbb_python`). */
  retrieve(id: string, options: CallOptions = {}): Promise<SandboxTemplate> {
    return this.client.request("GET", "/v1/sandboxes/templates/get", {
      ...options,
      query: { id },
    });
  }
}

/**
 * Sandboxes of the graph in scope: `run` (one call), `scoped` and `create`
 * (a handle), and the resource calls.
 */
export class SandboxesNamespace {
  readonly templates: SandboxTemplatesNamespace;

  constructor(private readonly client: LbbClient) {
    this.templates = new SandboxTemplatesNamespace(client);
  }

  /**
   * Level 1 and 2: run code once. The call makes a sandbox, runs
   * `run(input, config)` in it, and the sandbox is destroyed when the run
   * ends. `template` names a saved template instead of passing `code`.
   *
   * The call needs no VM of your own and writes the same records as every
   * other level: a sandbox of kind `run` and its command.
   *
   * The call sends an `Idempotency-Key`: the one you give, else one the SDK
   * makes. A retry after a `5xx` answers the same record. A run whose VM the
   * host lost (status `lost`) goes again in a new sandbox under the key
   * `<key>.2`, at most `lostRetries` times (default 2), because a lost VM took
   * its effects with it. A run that failed in your code is not run again.
   *
   * Check `ok` before you use `result`: a run whose code raised is a result
   * with `exitCode` 1, not an error.
   */
  async run(spec: SandboxRunSpec): Promise<SandboxRunResult> {
    const waitMs = spec.waitMs ?? SANDBOX_WAIT_MS_MAX;
    const maxWaitMs = spec.maxWaitMs ?? 600_000;
    const baseKey = keyOf(spec.idempotencyKey, () =>
      this.client.idempotencyKey("sandboxes.run"),
    );
    // 0 to 2: a run that the host lost goes again twice at most.
    const lostRetries = Math.min(
      LOST_RETRIES_MAX,
      Math.max(0, Math.trunc(spec.lostRetries ?? LOST_RETRIES_MAX) || 0),
    );
    const maxRuns = 1 + lostRetries;
    const body: Schemas["SandboxCreateRequest"] = {
      ...createBody(spec),
      run: runBody(spec, spec.commandTimeoutMs),
      wait_ms: waitMs,
    };
    for (let attempt = 1; ; attempt += 1) {
      const key = attempt === 1 ? baseKey : `${baseKey}.${attempt}`;
      let sandbox = await this.client.request<Sandbox>(
        "POST",
        "/v1/sandboxes",
        {
          ...callOptions(spec),
          idempotencyKey: key,
          body,
        },
      );
      const began = Date.now();
      let pause = 250;
      while (
        sandbox.run !== undefined &&
        sandbox.run !== null &&
        !isFinal(sandbox.run.status)
      ) {
        if (Date.now() - began >= maxWaitMs)
          throw new SandboxWaitError(sandbox, Date.now() - began);
        await sleep(pause);
        pause = Math.min(pause * 2, 2_000);
        sandbox = await this.retrieve(sandbox.id, {
          ...callOptions(spec),
          idempotencyKey: undefined,
        });
      }
      const run = sandbox.run;
      if (run?.status === "lost" && attempt < maxRuns) continue;
      return {
        result: run?.result ?? undefined,
        status: run?.status ?? "failed",
        exitCode: run?.exit_code ?? undefined,
        command: run?.command ?? "",
        ok: run?.status === "exited" && run.exit_code === 0,
        sandbox,
      };
    }
  }

  /**
   * Level 3: make a sandbox, hand its {@link SandboxHandle} to `fn`, and
   * destroy the sandbox when `fn` ends, also after an error. The value of `fn`
   * is the value of the call.
   *
   * The create carries an `Idempotency-Key`, so a retry makes one sandbox. A
   * failure to destroy never hides the error of `fn`; a sandbox that is not
   * destroyed ends at its `expires_at`.
   */
  async scoped<T>(
    spec: SandboxSpec,
    fn: (sandbox: SandboxHandle) => Promise<T> | T,
  ): Promise<T> {
    const handle = await this.create(spec);
    let value: T;
    try {
      value = await fn(handle);
    } catch (error) {
      await handle.delete().catch(() => undefined);
      throw error;
    }
    try {
      await handle.delete();
    } catch (error) {
      // The sandbox is gone already, or it expires by itself.
      if (!(error instanceof LbbError && error.status === 404)) throw error;
    }
    return value;
  }

  /**
   * Level 3: make a sandbox that you keep: stop, resume, files and commands
   * are on the handle. It lives until you delete it or it expires
   * (`expiresInSeconds`, one hour by default).
   */
  async create(spec: SandboxSpec = {}): Promise<SandboxHandle> {
    const record = await this.client.request<Sandbox>("POST", "/v1/sandboxes", {
      ...callOptions(spec),
      idempotencyKey: keyOf(spec.idempotencyKey, () =>
        this.client.idempotencyKey("sandboxes.create"),
      ),
      body: createBody(spec),
    });
    return new SandboxHandle(this.client, record);
  }

  /** The handle of a sandbox that exists, from its record. */
  handle(record: Sandbox): SandboxHandle {
    return new SandboxHandle(this.client, record);
  }

  /** One sandbox. */
  retrieve(id: string, options: CallOptions = {}): Promise<Sandbox> {
    return this.client.request("GET", "/v1/sandboxes/get", {
      ...options,
      query: { id },
    });
  }

  /** One page of sandboxes, the newest first. */
  list(options: SandboxListOptions = {}): Promise<SandboxList> {
    const {
      status,
      template,
      workflow,
      createdBy,
      kind,
      limit,
      cursor,
      ...opts
    } = options;
    return this.client.request("GET", "/v1/sandboxes", {
      ...opts,
      query: {
        status,
        template,
        workflow,
        created_by: createdBy,
        kind,
        limit,
        cursor,
      },
    });
  }

  /** Change `autoStopSeconds` or the whole `metadata` of a sandbox. */
  update(
    id: string,
    patch: { autoStopSeconds?: number; metadata?: Record<string, string> },
    options: CallOptions = {},
  ): Promise<Sandbox> {
    return this.client.request("POST", "/v1/sandboxes/update", {
      ...options,
      query: { id },
      body: {
        auto_stop_seconds: patch.autoStopSeconds,
        metadata: patch.metadata,
      },
    });
  }

  /** Stop a sandbox's VM and keep its disk. */
  stop(id: string, options: CallOptions = {}): Promise<Sandbox> {
    return this.client.request("POST", "/v1/sandboxes/stop", {
      ...options,
      retry: options.retry ?? true,
      query: { id },
    });
  }

  /** Start a stopped sandbox from its disk. */
  resume(id: string, options: CallOptions = {}): Promise<Sandbox> {
    return this.client.request("POST", "/v1/sandboxes/resume", {
      ...options,
      retry: options.retry ?? true,
      query: { id },
    });
  }

  /** Destroy a sandbox's VM and disk. */
  delete(id: string, options: CallOptions = {}): Promise<Sandbox> {
    return this.client.request("DELETE", "/v1/sandboxes", {
      ...options,
      retry: options.retry ?? true,
      query: { id },
    });
  }
}
