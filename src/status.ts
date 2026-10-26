import type { components } from "./schema.js";
import { LbbCapabilityError } from "./transport.js";

type Check = (value: unknown) => boolean;
type Fields = Record<string, Check>;
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const text: Check = (v) => typeof v === "string";
const boolean: Check = (v) => typeof v === "boolean";
const count: Check = (v) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const finite: Check = (v) => typeof v === "number" && Number.isFinite(v);
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);
const list =
  (check: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(check);
const enumeration =
  (...values: string[]): Check =>
  (v) =>
    typeof v === "string" && values.includes(v);
function object(
  v: unknown,
  required: Fields,
  optional: Fields = {},
): v is Record<string, unknown> {
  return (
    record(v) &&
    Object.entries(required).every(
      ([key, check]) => Object.hasOwn(v, key) && check(v[key]),
    ) &&
    Object.entries(optional).every(
      ([key, check]) => !Object.hasOwn(v, key) || check(v[key]),
    )
  );
}
const availability = enumeration("available", "unavailable");
const issue = nullable(
  enumeration(
    "missing",
    "invalid_metadata",
    "changed",
    "budget",
    "storage_unavailable",
  ),
);
const field: Check = (v) =>
  object(v, { path: list(text), name: text, max: count });
const recipe: Check = (v) =>
  object(
    v,
    { class: text, fields: list(field), model_id: text, dim: count },
    { metric: enumeration("cosine", "dot", "l2"), title: list(text) },
  );
const usage: Check = (v) =>
  object(v, {
    texts: count,
    tokens_estimate: count,
    cost_usd_estimate: finite,
  });
const backfill: Check = (v) =>
  object(
    v,
    {
      target_seq: count,
      scanned: count,
      embedded: count,
      reused: count,
      removed: count,
    },
    { cursor: nullable(text), rescan: boolean },
  );
const recall: Check = (v) =>
  object(
    v,
    { samples: count, recall_at_k: finite, last: finite },
    { last_at: nullable(text) },
  );
const version: Check = (v) =>
  object(
    v,
    {
      version: count,
      state: enumeration("backfilling", "ready"),
      model_id: text,
      dim: count,
      fields: list(field),
      entries: count,
      runs: count,
      usage,
    },
    {
      stored_bytes: count,
      embedded_through_seq: nullable(count),
      backfill: nullable(backfill),
      recall: nullable(recall),
    },
  );
const embedding: Check = (v) =>
  object(
    v,
    { name: text, class: text, recipe, created_at: text, updated_at: text },
    {
      serving: nullable(version),
      building: nullable(version),
      previous: nullable(count),
      published_seq: nullable(count),
      head_seq: nullable(count),
      lag_commits: nullable(count),
    },
  );
const snapshot: Check = (v) =>
  object(
    v,
    { commit_seq: count, compacted_seq: count },
    {
      as_of_commit_seq: nullable(count),
      served_at_seq: nullable(count),
      stale: boolean,
      stale_reason: nullable(text),
    },
  );
const row: Check = (v) =>
  object(v, { name: text, availability, issue, status: nullable(embedding) });
const rdf: Check = (v) =>
  object(v, {
    availability,
    issue,
    snapshot: nullable(snapshot),
    publication_caught_up: nullable(boolean),
    published_lag_commits: nullable(count),
  });
const classes: Check = (v) =>
  object(v, {
    availability,
    issue,
    complete: boolean,
    configured_count: nullable(count),
    attempted_count: count,
    inspected_count: count,
    model_id: nullable(text),
    next_model_id: nullable(text),
    embeddings: list(row),
    max_embeddings: count,
    metadata_budget_bytes: count,
  });
const graph: Check = (v) =>
  object(v, {
    epoch: nullable(count),
    complete: boolean,
    rdf,
    class_embeddings: classes,
  });

/** Validate the complete status/1 shape without coercing or defaulting missing observations. */
export function checkedCurrentStatus(
  value: unknown,
): components["schemas"]["CurrentStatusResponse"] {
  const refuse = (): never => {
    throw new LbbCapabilityError("status/1 diagnostics");
  };
  if (
    !object(value, {
      object: (v) => v === "status",
      version: (v) => v === "status/1",
      ok: (v) => v === true,
      complete: boolean,
      service: text,
      mode: text,
      uptime_seconds: count,
      bind: text,
      storage: text,
      auth_required: boolean,
      graph: (v) =>
        object(v, { tenant_id: text, graph_id: text, branch_id: text }),
      graph_status: graph,
      snapshot_cache: (v) =>
        object(v, {
          entries: count,
          total_bytes: count,
          pinned_bytes: count,
          pinned_ceiling_bytes: count,
          budget_bytes: count,
        }),
    })
  )
    return refuse();
  const diagnostic = value.graph_status as Record<string, unknown>;
  const publication = diagnostic.rdf as Record<string, unknown>;
  const roster = diagnostic.class_embeddings as Record<string, unknown>;
  const rows = roster.embeddings as Array<Record<string, unknown>>;
  const configured = roster.configured_count as number | null;
  const attempted = roster.attempted_count as number;
  const inspected = roster.inspected_count as number;
  if (
    value.complete !== diagnostic.complete ||
    diagnostic.complete !==
      (publication.availability === "available" && roster.complete === true) ||
    attempted !== rows.length ||
    inspected > attempted ||
    attempted > (roster.max_embeddings as number) ||
    new Set(rows.map((item) => item.name)).size !== rows.length
  )
    return refuse();
  let successes = 0;
  for (const item of rows) {
    if (item.availability === "available") {
      if (
        item.issue !== null ||
        !record(item.status) ||
        item.status.name !== item.name ||
        !record(item.status.recipe) ||
        item.status.class !== item.status.recipe.class
      )
        return refuse();
      successes++;
    } else if (item.issue === null || item.status !== null) return refuse();
  }
  if (inspected !== successes) return refuse();
  if (configured === null) {
    if (
      roster.availability !== "unavailable" ||
      roster.issue === null ||
      roster.complete ||
      attempted !== 0
    )
      return refuse();
  } else if (
    roster.availability !== "available" ||
    attempted > configured ||
    roster.complete !== (inspected === configured) ||
    (roster.complete ? roster.issue !== null : roster.issue === null)
  )
    return refuse();
  if (publication.availability === "available") {
    if (
      publication.issue !== null ||
      !record(publication.snapshot) ||
      typeof publication.publication_caught_up !== "boolean" ||
      !count(publication.published_lag_commits)
    )
      return refuse();
    const served = publication.snapshot.served_at_seq ?? null;
    const committed = publication.snapshot.commit_seq as number;
    if (served !== null && (!count(served) || (served as number) > committed))
      return refuse();
    if (
      publication.publication_caught_up !==
        (served !== null && served === committed) ||
      publication.published_lag_commits !==
        committed - ((served as number | null) ?? 0)
    )
      return refuse();
  } else if (
    publication.issue === null ||
    publication.snapshot !== null ||
    publication.publication_caught_up !== null ||
    publication.published_lag_commits !== null
  )
    return refuse();
  if (
    diagnostic.epoch === null &&
    (publication.availability !== "unavailable" || configured !== null)
  )
    return refuse();
  return value as unknown as components["schemas"]["CurrentStatusResponse"];
}
