import type { LbbClient } from "./client.js";
import type { CallOptions } from "./transport.js";
import type { Schemas } from "./types.js";

/** What to erase: subjects, files and follow rules. */
export type ErasureScope = Omit<Schemas["ErasureCreateRequest"], "dry_run">;

/**
 * Subject erasure (GDPR): remove what a person said from a graph.
 *
 * An erasure retracts every statement that names a subject, as subject or
 * object, in one commit. From that commit on, every read at every
 * `as_of_commit_seq` hides those statements. A background purge then
 * deletes them from storage, backups included, before the erasure's
 * `deadline`. An erasure cannot be undone.
 *
 * Text is not searched. A passage or quote that only mentions the person
 * goes when you name it, or when a `follow` rule reaches it through a link.
 * Call {@link preview} first to see the scope.
 */
export class ErasuresNamespace {
  constructor(private readonly client: LbbClient) {}

  /**
   * The scope of an erasure at the head (counts, up to 50 statements, the
   * shape results it would create). Writes nothing.
   */
  preview(
    scope: ErasureScope,
    opts: CallOptions = {},
  ): Promise<Schemas["ErasurePreview"]> {
    // A dry run writes nothing and carries no idempotency key.
    const call: CallOptions = { ...opts };
    delete call.idempotencyKey;
    return this.client.request("POST", "/v1/erasures", {
      ...call,
      retry: call.retry ?? true,
      body: { ...scope, dry_run: true },
    });
  }

  /**
   * Erase the scope. The client sends an `Idempotency-Key` (pass your own to
   * make a rerun of your code answer the first erasure); a retry with the
   * same key answers the same erasure with `idempotent_replay: true`.
   */
  erase(
    scope: ErasureScope,
    opts: CallOptions = {},
  ): Promise<Schemas["Erasure"]> {
    return this.client.request("POST", "/v1/erasures", {
      ...opts,
      idempotencyKey:
        opts.idempotencyKey ?? this.client.idempotencyKey("erase"),
      body: { ...scope, dry_run: false },
    });
  }

  /** One erasure by its id (`ers_`). */
  get(id: string, opts: CallOptions = {}): Promise<Schemas["Erasure"]> {
    return this.client.request("GET", "/v1/erasures/get", {
      ...opts,
      query: { id },
    });
  }

  /** The graph's erasures, newest first. */
  list(opts: CallOptions = {}): Promise<Schemas["ErasureList"]> {
    return this.client.request("GET", "/v1/erasures", opts);
  }
}
