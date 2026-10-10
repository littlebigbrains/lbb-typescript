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
   * Upload a file (`POST /v1/files?name=`, at most 64 MiB). The server
   * stores the bytes once and commits a `Document` entity for them; a parse
   * starter then reads them. The same bytes under the same name again change
   * nothing (`created: false`), so a failed call is retried. The same bytes
   * under another name rename the file.
   */
  async upload(
    data: FileBody,
    options: FileUploadOptions,
  ): Promise<Schemas["FileUploadResponse"]> {
    const { name, contentType, ...opts } = options;
    if (!name?.trim())
      throw new TypeError("files.upload needs the file's name");
    return this.client.request("POST", "/v1/files", {
      ...opts,
      retry: opts.retry ?? true,
      query: { name },
      rawBody: data,
      contentType: uploadContentType(data, contentType),
    });
  }

  /** The graph's files, the newest upload first, with what the parse made of each. */
  list(opts: CallOptions = {}): Promise<Schemas["FileList"]> {
    return this.client.request("GET", "/v1/files", opts);
  }

  /** A file's bytes (`GET /v1/files/content`). */
  async content(sha256: string, opts: CallOptions = {}): Promise<Uint8Array> {
    return this.client.request("GET", "/v1/files/content", {
      ...opts,
      query: { sha256: sha256Of(sha256) },
      responseType: "bytes",
    });
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
   * client repeats the SHA-256 as `confirm`. The bytes and what the document
   * starters stored stay in storage; an installed `documents.link` retracts
   * the entries and mentions it wrote for the document.
   */
  async delete(
    sha256: string,
    opts: CallOptions = {},
  ): Promise<Schemas["FileDeleteResponse"]> {
    const sha = sha256Of(sha256);
    return this.client.request("DELETE", "/v1/files", {
      ...opts,
      query: { sha256: sha, confirm: sha },
    });
  }
}
