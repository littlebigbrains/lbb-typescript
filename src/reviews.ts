import type { LbbClient } from "./client.js";
import { LbbError, type CallOptions } from "./transport.js";
import type { Schemas } from "./types.js";

/**
 * Whether an error is a data plane's answer to a route it does not have
 * (its catch-all `404`, "no route for …"), not a handler's not-found.
 */
function missingRoute(error: unknown): boolean {
  return (
    error instanceof LbbError &&
    error.status === 404 &&
    error.message.startsWith("no route for")
  );
}

export interface ReviewListOptions extends CallOptions {
  status?: Schemas["ReviewStatus"];
  /** One kind, or several. */
  kind?: Schemas["ReviewItemKind"] | Schemas["ReviewItemKind"][];
  /** Default `live`. */
  scope?: Schemas["ReviewScope"];
  /** Producer id, for example `starter:areas`. */
  originId?: string;
  /** The workflow that asked. */
  workflow?: string;
  /** The run that asked. */
  run?: string;
  /** Default 100, maximum 500. */
  limit?: number;
  /** `next_cursor` of the page before. */
  cursor?: string;
  /** The items filed under these producer keys (at most 100). */
  key?: string | string[];
}

/**
 * Review: questions for a person (human in the loop). A review item asks
 * to confirm or correct a value, pick an option, grade an output, answer
 * in free text, or accept a change (an ontology suggestion). Its answer
 * writes a value's accept or correction to the graph, is a calibration
 * label, and is sent to the workflow that asked as a `review.answered`
 * event.
 *
 * `/v1/reviews` is the canonical surface; `client.ontology.suggestions` is
 * the view of kind `change`.
 */
export class ReviewsNamespace {
  constructor(private readonly client: LbbClient) {}

  /**
   * Ask a person: file an item of kind `value`, `choice`, `grade` or
   * `answer`. The same `key` again updates the item; an answered one comes
   * back unchanged, with its answer.
   */
  create(
    body: Schemas["ReviewItemCreateRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["ReviewItem"]> {
    return this.client.request("POST", "/v1/reviews", { ...opts, body });
  }

  /**
   * One page of items, the latest update first. Pass `next_cursor` as
   * `cursor` for the next page, or iterate every item with `all`.
   */
  list(options: ReviewListOptions = {}): Promise<Schemas["ReviewItemList"]> {
    const {
      status,
      kind,
      scope,
      originId,
      workflow,
      run,
      limit,
      cursor,
      key,
      ...opts
    } = options;
    return this.client.request("GET", "/v1/reviews", {
      ...opts,
      query: {
        status,
        kind: Array.isArray(kind) ? kind.join(",") : kind,
        scope,
        origin_id: originId,
        workflow,
        run,
        limit,
        cursor,
        key: Array.isArray(key) ? key.join(",") : key,
      },
    });
  }

  /**
   * The live items of every kind grouped by pattern (the items that ask
   * one decision), the largest first, by their `rev_` ids.
   */
  patterns(
    options: CallOptions & {
      status?: Schemas["ReviewStatus"];
      originId?: string;
      type?: Schemas["SuggestionKind"];
    } = {},
  ): Promise<Schemas["OntologySuggestionPatternList"]> {
    const { status, originId, type, ...opts } = options;
    return this.client.request("GET", "/v1/reviews/patterns", {
      ...opts,
      query: { status, origin_id: originId, type },
    });
  }

  /**
   * Every item, the latest update first: `list` page by page, with the
   * same filters (`limit` items a page).
   */
  async *all(
    options: Omit<ReviewListOptions, "cursor"> = {},
  ): AsyncGenerator<Schemas["ReviewItem"]> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...options, cursor });
      yield* page.data;
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor);
  }

  /**
   * One item (`rev_…`) with its question, evidence, answer and effects
   * (`GET /v1/reviews/get`). A data plane older than that route is read at
   * its earlier name, `/v1/reviews/detail`.
   */
  async get(
    id: string,
    opts: CallOptions = {},
  ): Promise<Schemas["ReviewItem"]> {
    try {
      return await this.client.request("GET", "/v1/reviews/get", {
        ...opts,
        query: { id },
      });
    } catch (error) {
      if (!missingRoute(error)) throw error;
      return this.client.request("GET", "/v1/reviews/detail", {
        ...opts,
        query: { id },
      });
    }
  }

  /**
   * Answer an item. `revision` is the revision the person saw: an item
   * revised since answers `409 review_stale`. A retry sends the same
   * `Idempotency-Key` (yours, else one this call makes) and returns the
   * item; the key with another answer answers `409 idempotency_conflict`.
   */
  answer(
    id: string,
    body: Schemas["ReviewAnswerRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["ReviewItem"]> {
    return this.client.request("POST", "/v1/reviews/answer", {
      ...opts,
      idempotencyKey:
        opts.idempotencyKey ?? this.client.idempotencyKey("reviews.answer"),
      query: { id },
      body,
    });
  }

  /**
   * One answer for up to 500 items (`ids`), each checked against its own
   * kind. A retry sends the same `Idempotency-Key` and returns the first
   * response.
   */
  answerBatch(
    body: Schemas["ReviewAnswerBatchRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["ReviewAnswerBatchResponse"]> {
    return this.client.request("POST", "/v1/reviews/answer-batch", {
      ...opts,
      idempotencyKey:
        opts.idempotencyKey ??
        this.client.idempotencyKey("reviews.answerBatch"),
      body,
    });
  }

  /** Withdraw an item as its producer. A retry sends the same `Idempotency-Key`. */
  withdraw(
    id: string,
    reason: string,
    opts: CallOptions = {},
  ): Promise<Schemas["ReviewItem"]> {
    return this.client.request("POST", "/v1/reviews/withdraw", {
      ...opts,
      idempotencyKey:
        opts.idempotencyKey ?? this.client.idempotencyKey("reviews.withdraw"),
      query: { id },
      body: { reason },
    });
  }

  /** Add a comment to an item's discussion. A retry sends the same `Idempotency-Key`. */
  comment(
    id: string,
    body: Schemas["OntologyChangeSuggestionCommentRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["ReviewItem"]> {
    return this.client.request("POST", "/v1/reviews/comment", {
      ...opts,
      idempotencyKey:
        opts.idempotencyKey ?? this.client.idempotencyKey("reviews.comment"),
      query: { id },
      body,
    });
  }
}
