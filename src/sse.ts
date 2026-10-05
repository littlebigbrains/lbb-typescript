/** One server-sent event: its name and its data lines joined with `\n`. */
export interface ServerSentEvent {
  /** The `event:` field, or `"message"` when the event has none. */
  event: string;
  /** The `data:` lines of the event, joined with `\n`. */
  data: string;
}

/** The most text one event may hold before the parser fails: 64 MiB. */
export const MAX_SERVER_SENT_EVENT_CHARS = 64 * 1024 * 1024;

/**
 * An incremental parser of a `text/event-stream` body, as the HTML standard
 * defines it. Push decoded text in pieces of any size; each call returns the
 * events that completed. A line ends with `\n`, `\r\n` or `\r`, also when the
 * two characters of `\r\n` arrive in different pieces. Comment lines (`:`)
 * and unknown fields are skipped. One event may hold at most `maxEventChars`
 * characters, so a broken stream cannot fill the memory.
 */
export class ServerSentEventParser {
  private pending = "";
  private skipLineFeed = false;
  private eventName = "";
  private dataLines: string[] = [];
  private eventChars = 0;

  constructor(
    private readonly maxEventChars: number = MAX_SERVER_SENT_EVENT_CHARS,
  ) {}

  /** Parse the next piece of text; returns the events it completed. */
  push(text: string): ServerSentEvent[] {
    const events: ServerSentEvent[] = [];
    let start = 0;
    if (this.skipLineFeed && text.length > 0) {
      this.skipLineFeed = false;
      if (text.charCodeAt(0) === 10) start = 1;
    }
    let nextLineFeed = -2;
    let nextReturn = -2;
    while (start < text.length) {
      if (nextLineFeed !== -1 && nextLineFeed < start)
        nextLineFeed = text.indexOf("\n", start);
      if (nextReturn !== -1 && nextReturn < start)
        nextReturn = text.indexOf("\r", start);
      if (nextLineFeed === -1 && nextReturn === -1) break;
      const end =
        nextLineFeed === -1
          ? nextReturn
          : nextReturn === -1
            ? nextLineFeed
            : Math.min(nextLineFeed, nextReturn);
      const line = this.pending + text.slice(start, end);
      this.pending = "";
      this.line(line, events);
      if (text.charCodeAt(end) === 13) {
        if (end + 1 >= text.length) {
          this.skipLineFeed = true;
          start = end + 1;
        } else {
          start = text.charCodeAt(end + 1) === 10 ? end + 2 : end + 1;
        }
      } else {
        start = end + 1;
      }
    }
    if (start < text.length) {
      this.pending += text.slice(start);
      this.checkSize(this.pending.length);
    }
    return events;
  }

  private line(line: string, events: ServerSentEvent[]): void {
    if (line === "") {
      if (this.dataLines.length > 0) {
        events.push({
          event: this.eventName || "message",
          data: this.dataLines.join("\n"),
        });
      }
      this.eventName = "";
      this.dataLines = [];
      this.eventChars = 0;
      return;
    }
    if (line.charCodeAt(0) === 58) return; // `:` starts a comment.
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === "event") {
      this.eventName = value;
    } else if (field === "data") {
      this.eventChars += value.length + 1;
      this.checkSize(0);
      this.dataLines.push(value);
    }
    // `id`, `retry` and unknown fields do not change what a client reads.
  }

  private checkSize(pendingChars: number): void {
    if (this.eventChars + pendingChars > this.maxEventChars) {
      throw new Error(
        `a server-sent event is larger than ${this.maxEventChars} characters; the stream was stopped`,
      );
    }
  }
}

/** A reader of a response body, one chunk at a time. */
export interface BodyChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | string }>;
  cancel(reason?: unknown): Promise<void>;
}

/**
 * A chunk reader over a fetch response: the body's `getReader()` (WHATWG
 * streams), an async-iterable body (Node streams), or `text()` read whole
 * when the response has no body stream (test doubles, some polyfills).
 */
export function bodyChunkReader(response: {
  body?: unknown;
  text(): Promise<string>;
}): BodyChunkReader {
  const body = response.body as
    | {
        getReader?: () => {
          read(): Promise<{ done: boolean; value?: Uint8Array }>;
          cancel(reason?: unknown): Promise<void>;
        };
        [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
      }
    | null
    | undefined;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    return {
      read: () => reader.read(),
      cancel: (reason) => reader.cancel(reason),
    };
  }
  const iterate = body?.[Symbol.asyncIterator];
  if (body && typeof iterate === "function") {
    const iterator = iterate.call(body);
    return {
      read: async () => {
        const next = await iterator.next();
        return next.done
          ? { done: true }
          : { done: false, value: next.value as Uint8Array | string };
      },
      cancel: async () => {
        await iterator.return?.();
      },
    };
  }
  let consumed = false;
  return {
    read: async () => {
      if (consumed) return { done: true };
      consumed = true;
      return { done: false, value: await response.text() };
    },
    cancel: async () => {},
  };
}
