// Files of a records graph (`/v1/files*`). A file is a document the graph
// holds: its bytes, stored once under their SHA-256, and a `Document` entity
// the graph's facts can point at. The document workflows read files:
// `documents.parse` reads the text layer of each PDF into pages, with every
// line and word and its box on the page, and `documents.link` links the codes
// the documents mention to the entries that define them.
import type { LbbClient } from "./client.js";
import type { CallOptions } from "./transport.js";
import type { Schemas } from "./types.js";

/** One file of a graph: its SHA-256, name, type, size, `Document` IRI and parse. */
export type FileRecord = Schemas["FileRecord"];
/** The parsed pages of a file, with every line and word box. */
export type FilePages = Schemas["FilePages"];
/** One page of the graph's files and the cursor of the next. */
export type FileList = Schemas["FileList"];
/** The graph's files by parse status, as of a published commit. */
export type FileCounts = Schemas["FileCounts"];
/** A fact whose evidence names a deleted file: its statement node and edge. */
export type FileCitation = Schemas["FileCitation"];

/** The options of `files.get`. */
export interface FileGetOptions extends CallOptions {
  /**
   * Also answer a deleted file whose content is not reclaimed yet (with
   * `deleted_at`), and name the facts whose evidence cites the file
   * (`cited_by`, at most 20): what `delete(sha256, { purge: true })`
   * retracts.
   */
  deleted?: boolean;
}

/** The options of `files.delete`. */
export interface FileDeleteOptions extends CallOptions {
  /**
   * Also retract the edges whose evidence names the file
   * (`purged_edges`), so the reclaim frees the bytes after the grace. A
   * deleted file can be purged. Without it those facts stay, and keep the
   * bytes.
   */
  purge?: boolean;
}

/** The most files one `files.list` page holds, and the default. */
export const FILE_LIST_LIMIT_MAX = 1000;

/** One page of `files.list`. */
export interface FileListOptions extends CallOptions {
  /** Files per page, 1 to 1,000. Default 1,000. */
  limit?: number;
  /** The `next` cursor of the page before. */
  after?: string;
}

/**
 * A `Blob` or `File` (browsers, Node 18+), by its shape, so the SDK needs
 * neither the DOM types nor a runtime's own.
 */
export interface BlobLike {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The bytes `files.upload` sends. */
export type FileBody = BlobLike | ArrayBuffer | Uint8Array;

export interface FileUploadOptions extends CallOptions {
  /** The file's name, as the graph lists it (required). */
  name: string;
  /**
   * The file's content type. Default: a `Blob`'s own type, else
   * `application/octet-stream`; the server recognizes a PDF by its bytes.
   */
  contentType?: string;
  /**
   * The natural language of the content, a BCP 47 tag such as `en` or
   * `de-CH`, at most 64 characters. The
   * `Document` stores it when given, and keeps the earlier upload's when a
   * later one gives none.
   */
  language?: string;
  /**
   * The schema the content follows (a name or a URL), at most 256
   * characters. Stored like `language`.
   */
  schema?: string;
}

/**
 * One byte range of a file: bytes `start` to `end`, both included and
 * 0-based (`end` absent reads to the end of the file), or the last `suffix`
 * bytes.
 */
export type FileByteRange =
  { start: number; end?: number } | { suffix: number };

export interface FileContentOptions extends CallOptions {
  /**
   * One byte range: the answer holds those bytes. A range past the end ends
   * at the end; a range with no byte of the file throws `LbbError` 416
   * `range_not_satisfiable`.
   */
  range?: FileByteRange;
}

/** What `files.head` answers: a file's length, type and digest, without its bytes. */
export interface FileHead {
  /** The number of bytes. */
  bytes: number;
  contentType: string;
  /** The SHA-256 of the bytes (the `ETag`). */
  sha256: string;
}

/** The page range of `files.pages`: 0-based, `to` is the first page not returned. */
export interface FilePagesOptions extends CallOptions {
  /** The first page index. Default 0. */
  from?: number;
  /** The page index after the last one. Default `from + 10`; one call returns at most 50 pages. */
  to?: number;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** A file's SHA-256 as the routes take it: 64 hexadecimal characters, lower case. */
function sha256Of(sha256: string): string {
  const value = sha256.trim().toLowerCase();
  if (!SHA256.test(value))
    throw new RangeError(
      `sha256 must be 64 hexadecimal characters, got ${JSON.stringify(sha256)}`,
    );
  return value;
}

/** The `Range` header of a byte range: `bytes=a-b`, `bytes=a-` or `bytes=-n`. */
function rangeHeader(range: FileByteRange): string {
  const index = (value: number, name: string) => {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(`${name} must be a byte index (0 or more)`);
  };
  if ("suffix" in range) {
    index(range.suffix, "suffix");
    if (range.suffix === 0) throw new RangeError("suffix must be 1 or more");
    return `bytes=-${range.suffix}`;
  }
  index(range.start, "start");
  if (range.end === undefined) return `bytes=${range.start}-`;
  index(range.end, "end");
  if (range.end < range.start)
    throw new RangeError("end must not be below start");
  return `bytes=${range.start}-${range.end}`;
}

/** The headers of a content read: the caller's, and its range. */
function contentHeaders(
  range: FileByteRange | undefined,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (range === undefined) return headers;
  return { ...headers, range: rangeHeader(range) };
}

function pageIndex(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
    throw new RangeError(`${name} must be a page index (0 or more)`);
}

/** The content type of an upload: the caller's, a `Blob`'s own, or bytes. */
function uploadContentType(data: FileBody, contentType?: string): string {
  const named = contentType?.trim();
  if (named) return named;
  const own =
    data instanceof ArrayBuffer || ArrayBuffer.isView(data)
      ? ""
      : (data as BlobLike).type;
  return own || "application/octet-stream";
}

/**
 * Files of the graph in scope: upload, list, read the bytes, read the parsed
 * pages, and delete. Also on `graph(name).files`.
 */
export class FilesNamespace {
  constructor(private readonly client: LbbClient) {}

  /**
   * Upload a file (`POST /v1/files?name=`, at most 1 GiB by default; a
   * larger file throws `LbbError` 413 `file_too_large`). An empty file is a
   * file. The server stores the bytes once and commits a `Document` entity
   * for them, with a `Content` entity for the bytes; a parse starter then
   * reads them. The same bytes under the same name again change
   * nothing (`created: false`), so a failed call is retried. The same bytes
   * under another name rename the file.
   */
  async upload(
    data: FileBody,
    options: FileUploadOptions,
  ): Promise<Schemas["FileUploadResponse"]> {
    const { name, contentType, language, schema, ...opts } = options;
    if (!name?.trim())
      throw new TypeError("files.upload needs the file's name");
    return this.client.request("POST", "/v1/files", {
      ...opts,
      retry: opts.retry ?? true,
      query: { name, language, schema },
      rawBody: data,
      contentType: uploadContentType(data, contentType),
    });
  }

  /**
   * One page of the graph's files, the newest upload first, with what the
   * parse made of each (`GET /v1/files`). Without `limit`, the newest 1,000.
   * Pass the answer's `next` as `after` for the next page; a page can hold
   * fewer than `limit` files while `next` is set, and the list ends when no
   * `next` comes back.
   */
  list(options: FileListOptions = {}): Promise<Schemas["FileList"]> {
    const { limit, after, ...opts } = options;
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > FILE_LIST_LIMIT_MAX)
    )
      throw new RangeError(`limit must be 1 to ${FILE_LIST_LIMIT_MAX}`);
    return this.client.request("GET", "/v1/files", {
      ...opts,
      query: { limit, after: after || undefined },
    });
  }

  /**
   * One file's record (`GET /v1/files/record`), read from one object: its
   * name, type, size, upload time, `Document` IRI and parse. A SHA-256 the
   * graph has no file for, or a deleted file, answers `404 file_not_found`;
   * with `{ deleted: true }` a deleted file answers until its content is
   * reclaimed (`deleted_at`), and every answer names the facts that cite
   * the file (`cited_by`).
   */
  get(
    sha256: string,
    options: FileGetOptions = {},
  ): Promise<Schemas["FileRecord"]> {
    const { deleted, ...opts } = options;
    return this.client.request("GET", "/v1/files/record", {
      ...opts,
      query: { sha256: sha256Of(sha256), deleted: deleted ? true : undefined },
    });
  }

  /**
   * The graph's files by parse status (`GET /v1/files/counts`): a count over
   * the `Document` entities of the published generation, with the commit it
   * holds (`as_of_commit_seq`). A file with no parse yet counts as
   * `waiting`.
   */
  counts(opts: CallOptions = {}): Promise<Schemas["FileCounts"]> {
    return this.client.request("GET", "/v1/files/counts", opts);
  }

  /**
   * A file's bytes (`GET /v1/files/content`), or the bytes of one `range`.
   * The answer is held whole: read a large file with
   * {@link FilesNamespace.contentStream}.
   */
  async content(
    sha256: string,
    options: FileContentOptions = {},
  ): Promise<Uint8Array> {
    const { range, ...opts } = options;
    const headers = contentHeaders(range, opts.headers);
    return this.client.request("GET", "/v1/files/content", {
      ...opts,
      headers,
      query: { sha256: sha256Of(sha256) },
      responseType: "bytes",
    });
  }

  /**
   * A file's bytes (or one `range` of them) as they arrive, in chunks:
   * `for await (const chunk of lbb.files.contentStream(sha256))`. A large
   * file is never held whole. `timeoutMs` bounds the wait for the answer,
   * not the transfer. Leaving the loop early closes the response.
   */
  contentStream(
    sha256: string,
    options: FileContentOptions = {},
  ): AsyncGenerator<Uint8Array, void, undefined> {
    const { range, ...opts } = options;
    const headers = contentHeaders(range, opts.headers);
    return this.client.requestByteStream("GET", "/v1/files/content", {
      ...opts,
      headers,
      query: { sha256: sha256Of(sha256) },
    });
  }

  /**
   * A file's length, content type and SHA-256 without its bytes
   * (`HEAD /v1/files/content`). A missing file throws `LbbError` 404.
   */
  async head(sha256: string, opts: CallOptions = {}): Promise<FileHead> {
    const sha = sha256Of(sha256);
    const response = await this.client.rawRequest<Uint8Array>(
      "HEAD",
      "/v1/files/content",
      {
        ...opts,
        query: { sha256: sha },
        responseType: "bytes",
      },
    );
    const header = (name: string) => response.headers?.get(name) ?? null;
    const length = Number(header("content-length"));
    return {
      bytes: Number.isSafeInteger(length) && length >= 0 ? length : 0,
      contentType: header("content-type") ?? "application/octet-stream",
      sha256: header("etag")?.replace(/^(W\/)?"|"$/g, "") || sha,
    };
  }

  /**
   * The parsed pages `from` to `to` of a file (`GET /v1/files/pages`): each
   * page's size in PDF points and its lines, each line with its id
   * (`p1-l114`), text, box and words. A box is `[x0, y0, x1, y1]` normalized
   * to the page (0 to 1, origin top left). A file the parse starter has not
   * read answers `404 file_not_parsed`.
   */
  async pages(
    sha256: string,
    options: FilePagesOptions = {},
  ): Promise<Schemas["FilePages"]> {
    const { from, to, ...opts } = options;
    pageIndex(from, "from");
    pageIndex(to, "to");
    if (from !== undefined && to !== undefined && to < from)
      throw new RangeError("to must not be below from");
    return this.client.request("GET", "/v1/files/pages", {
      ...opts,
      query: { sha256: sha256Of(sha256), from, to },
    });
  }

  /**
   * Remove a file from the list and retract its `Document` entity; the
   * client repeats the SHA-256 as `confirm`. An installed `documents.link`
   * retracts the entries and mentions it wrote for the document. The bytes
   * and what the workflows stored stay for the grace (30 days by default),
   * then the reclaim frees them, unless a fact's evidence still names the
   * file. `{ purge: true }` also retracts those facts (`purged_edges`).
   */
  async delete(
    sha256: string,
    options: FileDeleteOptions = {},
  ): Promise<Schemas["FileDeleteResponse"]> {
    const { purge, ...opts } = options;
    const sha = sha256Of(sha256);
    return this.client.request("DELETE", "/v1/files", {
      ...opts,
      query: { sha256: sha, confirm: sha, purge: purge ? true : undefined },
    });
  }
}
