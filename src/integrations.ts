import type { LbbClient } from "./client.js";
import type { CallOptions } from "./transport.js";
import type { Schemas } from "./types.js";

/**
 * Hosted integrations for a developer's end customers: one graph per end
 * customer in a developer stack, called from the developer's backend with a
 * stack API key. The routes live on the integrations API
 * (`integrationsUrl`, `https://api.littlebigbrain.com` by default); their
 * contract is `contracts/integrations-openapi.json`. Ontology suggestions
 * stay on the data plane (`baseUrl`).
 */

/** The integrations API host. */
export const DEFAULT_INTEGRATIONS_URL = "https://api.littlebigbrain.com";

/** The status kinds of a connection's `status.kind`. */
export type IntegrationStatusKind =
  | "syncing"
  | "working"
  | "starting"
  | "delayed"
  | "retrying"
  | "attention"
  | "review"
  | "paused"
  | "new"
  | "current";

/** One status per connection: `kind` for code, `detail` for a person. */
export interface IntegrationStatus {
  kind: IntegrationStatusKind;
  /** One or two sentences for a person. */
  detail: string;
}

/** The connection's last run. */
export interface IntegrationRun {
  status: "idle" | "running" | "blocked";
  started_at_ms: number | null;
  finished_at_ms: number | null;
  records: number;
  deleted: number;
  message: string | null;
}

/** Records written and deleted over every run. */
export interface IntegrationTotals {
  records: number;
  deleted: number;
  runs: number;
}

/** How the source fits the graph's ontology. */
export interface IntegrationFit {
  checked_at_ms: number | null;
  streams: { total: number; mapped: number; waiting: number; ignored: number };
  open_suggestions: number;
}

/** The connection's current turn. */
export interface IntegrationTurn {
  number: number;
  type: string | null;
  status: string;
  attempt: number;
  error: string | null;
  ready_at_ms: number;
}

/**
 * Connector settings: strings, numbers, booleans, lists of strings or null.
 * `sealedCredentials` is reserved.
 */
export type IntegrationConfig = Record<
  string,
  string | number | boolean | string[] | null
>;

/** The connector's credential fields by name, for example `HUBSPOT_TOKEN`. */
export type IntegrationCredentials = Record<string, string>;

/** One connection in a list. */
export interface IntegrationConnection {
  id: string;
  kind: string;
  label: string;
  status: IntegrationStatus;
  run: IntegrationRun;
  totals: IntegrationTotals;
  fit: IntegrationFit | null;
}

/** One connection with its settings (never its credentials) and turn. */
export interface IntegrationConnectionDetail extends IntegrationConnection {
  graph: string;
  account: string | null;
  ontology_mode: "auto" | "review";
  every_ms: number | null;
  config: IntegrationConfig;
  paused: boolean;
  turn: IntegrationTurn | null;
}

/** A reclaim pass of a deleted graph. `apply` deletes; `plan` only counts. */
export interface IntegrationReclaim {
  branch: string;
  job_id: string;
  mode: string;
  not_before: string;
  retired_epoch: number;
}

/** A value an end customer enters to connect. */
export interface IntegrationCredentialField {
  /** The key in `credentials`, for example `HUBSPOT_TOKEN`. */
  name: string;
  label: string;
  /** The value is a secret. */
  secret: boolean;
  /** Where to create or find the value. */
  help?: string;
  optional?: boolean;
}

/** A connector of the catalog. It holds no secret value. */
export interface IntegrationConnector {
  kind: string;
  label: string;
  description: string;
  credentialFields: IntegrationCredentialField[];
  /** The connection settings, the keys of `config`. */
  settings: ({
    name: string;
    type: string;
    label: string;
    required: boolean;
  } & Record<string, unknown>)[];
  /** The starter ontology the connector maps onto. */
  starter: { id: string; version: string; label: string } & Record<
    string,
    unknown
  >;
}

export interface IntegrationConnectorsAnswer {
  ok: true;
  connectors: IntegrationConnector[];
}

export interface IntegrationCreateAnswer {
  ok: true;
  id: string;
  graph: string;
  kind: string;
  status: IntegrationStatus;
}

export interface IntegrationListAnswer {
  ok: true;
  graph: string;
  connections: IntegrationConnection[];
}

export interface IntegrationConnectionAnswer {
  ok: true;
  connection: IntegrationConnectionDetail;
}

export interface IntegrationRefAnswer {
  ok: true;
  id: string;
  graph: string;
}

export interface IntegrationSyncAnswer {
  ok: true;
  id: string;
  graph: string;
  turn: { number: number; status: string; message_id: string };
}

export interface IntegrationStatusAnswer {
  ok: true;
  id: string;
  graph: string;
  status: IntegrationStatus;
}

export interface IntegrationDeleteAnswer {
  ok: true;
  id: string;
  graph: string;
  /** False when no connection had the id, or a retry finished the delete. */
  deleted: boolean;
  target_removed: boolean;
}

export interface IntegrationEraseAnswer {
  ok: true;
  graph: string;
  connections_deleted: number;
  graph_deleted: boolean;
  reclaims: IntegrationReclaim[];
}

/** Names the end customer's graph. */
export interface IntegrationGraphOptions extends CallOptions {
  graph: string;
}

export type IntegrationCdcAction =
  | "pause_capture"
  | "resume_capture"
  | "pause_apply"
  | "resume_apply"
  | "retire";
export interface IntegrationCdcOperation {
  id: string;
  action: IntegrationCdcAction;
  requested_at_ms: number;
  status: "pending" | "applied" | "failed";
  error?: string;
}
export interface IntegrationCdcOverview {
  ok: true;
  graph: string;
  enabled: boolean;
  discovery: IntegrationCdcDiscoveryAnswer | null;
  connection: IntegrationCdcStatusAnswer | null;
}
export interface IntegrationCdcStatusAnswer {
  ok: true;
  id: string;
  graph: string;
  state:
    | "retired"
    | "blocked"
    | "capture_paused"
    | "apply_paused"
    | "initial_load_incomplete"
    | "catching_up"
    | "streaming"
    | "source_status_unknown";
  progress: Schemas["CdcBindingStatus"];
  health: {
    state: "unknown" | "starting" | "running" | "stopped" | "failed";
    code?: string;
    observed_at_ms?: number;
    captured_sequence?: number;
    source?: {
      state: "unknown" | "reachable" | "unreachable";
      ageMs: number;
      slot: {
        state:
          | "missing"
          | "unknown"
          | "reserved"
          | "extended"
          | "unreserved"
          | "lost";
        active: boolean;
        retainedWalBytes: string | null;
        unconfirmedWalBytes: string | null;
        safeWalBytes: string | null;
      } | null;
    };
    snapshot?: {
      attempt: string;
      complete: boolean;
      tables: { relationId: string; capturedRows: string | null }[];
    };
    /** Advisory process/cgroup sample; counters reset when the reader restarts. */
    resources?: {
      cpuNanos: string | null;
      cgroupMemoryBytes: string | null;
      cgroupPeakBytes: string | null;
      heapUsedBytes: string | null;
    };
  };
  operations: IntegrationCdcOperation[];
  /** Optional when reading a server predating durable CDC alerts. */
  alerts?: IntegrationCdcAlerts;
}
export type IntegrationCdcAlertCode =
  | "capture_capacity"
  | "source_unavailable"
  | "source_wal_risk"
  | "source_wal_backlog"
  | "apply_stalled";
export interface IntegrationCdcAlerts {
  settings_revision: number;
  muted: boolean;
  evaluated_at_ms: number | null;
  stale: boolean;
  active: { code: IntegrationCdcAlertCode; since_ms: number }[];
  notifications: {
    id: number;
    code: IntegrationCdcAlertCode;
    transition: "firing" | "resolved";
    at_ms: number;
  }[];
}
export interface IntegrationCdcMuteAlertsOptions extends IntegrationGraphOptions {
  expectedRevision: number;
  muted: boolean;
}
export interface IntegrationCdcAlertsAnswer {
  ok: true;
  id: string;
  graph: string;
  alerts: IntegrationCdcAlerts;
}
export interface IntegrationCdcControlOptions extends IntegrationGraphOptions {
  /** Keep this id when retrying across processes; 1–100 letters, digits, `_`, `-`, `.`. */
  operationId: string;
  action: IntegrationCdcAction;
  /** Retirement requires the connection id again. */
  confirm?: string;
}
export interface IntegrationCdcControlAnswer {
  ok: true;
  id: string;
  graph: string;
  operation: IntegrationCdcOperation;
}

export interface IntegrationCdcDiscoveryAnswer {
  ok: true;
  id: string;
  graph: string;
  job: {
    id: string;
    graph_epoch: number;
    revision: number;
    attempts: number;
    created_at_ms: number;
    expires_at_ms: number;
    state:
      | "queued"
      | "discovering"
      | "retrying"
      | "ready"
      | "approved"
      | "failed"
      | "cancelled"
      | "expired";
    error?: Schemas["DiscoveryFailure"] | "discovery_attempts_exhausted";
  };
  source: Schemas["DiscoverySource"];
  catalog: Schemas["PostgresCatalog"] | null;
  catalog_digest: string | null;
  approval: {
    intent: string;
    prepared: boolean;
    scope: Schemas["CaptureScope"];
    mapping: Schemas["MappingPlan"];
    max_capture_bytes: number;
  } | null;
  activation: {
    state:
      "unknown" | "preparing" | "activating" | "starting" | "ready" | "failed";
    code?: string;
    observed_at_ms?: number;
  } | null;
}
export interface IntegrationCdcApprovalOptions extends IntegrationCdcCancelDiscoveryOptions {
  catalogDigest: string;
  mapping: Schemas["DiscoveryMapping"];
  maxCaptureBytes: number;
}
export interface IntegrationCdcReviewAnswer {
  ok: true;
  id: string;
  graph: string;
  job_id: string;
  graph_epoch: number;
  expected_revision: number;
  catalog_digest: string;
  scope: Schemas["CaptureScope"];
  mapping: Schemas["MappingPlan"];
  max_capture_bytes: number;
}
export interface IntegrationCdcDiscoverOptions extends IntegrationGraphOptions {
  /** Stable across retries. A changed request requires a new job id. */
  jobId: string;
  expectedRevision: number;
  source: Schemas["DiscoverySource"];
  credentials: { username: string; password: string; rootCertificate?: string };
}
export interface IntegrationCdcCancelDiscoveryOptions extends IntegrationGraphOptions {
  jobId: string;
  graphEpoch: number;
  expectedRevision: number;
}

/** The body of {@link IntegrationsNamespace.create}. */
export interface IntegrationCreateInput extends IntegrationGraphOptions {
  /** The connection id: 1 to 128 letters, digits, `_`, `-` or `.`. */
  id: string;
  /** A connector kind, for example `hubspot`. */
  kind: string;
  credentials: IntegrationCredentials;
  config?: IntegrationConfig;
  /** Sync interval in ms, at least 60,000. Default one hour; null syncs only on request. */
  everyMs?: number | null;
  /** Default: the stack's `integrations-api.ontology_mode`, else `auto`. */
  ontologyMode?: "auto" | "review";
  /** Apply the connector's starter ontology first. Default `apply`. */
  starter?: "apply" | "skip";
  /** Send the first sync. Default true. */
  start?: boolean;
}

export interface IntegrationSyncOptions extends IntegrationGraphOptions {
  /** Read every stream in full. */
  full?: boolean;
  /**
   * 1 to 100 letters, digits, `_`, `-` or `.`. A request with the same key
   * answers the same turn and sends nothing new. The client makes one per
   * call when absent, so its own retries send one sync.
   */
  idempotencyKey?: string;
}

export interface IntegrationSuggestionsOptions extends IntegrationGraphOptions {
  status?: Schemas["OntologyChangeSuggestionStatus"];
  /** Default 100, maximum 500. */
  limit?: number;
}

export interface IntegrationAcceptOptions extends IntegrationGraphOptions {
  /** An edited change that replaces the proposed one. */
  change?: Schemas["OntologyEvolveOp"][];
  /** Added to the discussion with the acceptance. */
  comment?: string;
  author?: string;
  /**
   * After the accept, send the connection that filed the suggestion a sync
   * under the message id `sync-after-<suggestion id>`, so the records that
   * waited are written now. Accepting twice queues one sync.
   */
  sync?: boolean;
}

export interface IntegrationDismissOptions extends IntegrationGraphOptions {
  /** Required, at most 1,000 characters. */
  reason: string;
  author?: string;
}

export interface IntegrationAcceptResult {
  suggestion: Schemas["OntologyChangeSuggestion"];
  /**
   * The sync turn `sync: true` queued. Null without `sync`, when the
   * suggestion is not accepted, when no integration filed it, or when it
   * links identities (records the graph holds already).
   */
  sync: Schemas["WorkflowTurn"] | null;
}

const BASE = "/v1/integrations";
const connectionPath = (id: string) =>
  `${BASE}/connections/${encodeURIComponent(id)}`;

/** `sync-<ms>-<random>`: an `Idempotency-Key` the route accepts. */
function syncKey(): string {
  return `sync-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * `client.integrations`: connect your end customers' sources to their graphs.
 * Each method names the end customer's `graph`. Errors throw `LbbError` with
 * `status`, `code`, `details` and, on a `429`, `retryAfterSeconds`.
 */
export class IntegrationsNamespace {
  constructor(private readonly client: LbbClient) {}

  /** Discover the graph's setup/connection without storing its id in the browser. */
  cdcOverview(
    options: IntegrationGraphOptions,
  ): Promise<IntegrationCdcOverview> {
    const { graph, ...opts } = options;
    return this.client.integrationsRequest("GET", `${BASE}/cdc`, {
      ...opts,
      query: { graph },
    });
  }

  cdcDiscovery(
    id: string,
    options: IntegrationGraphOptions,
  ): Promise<IntegrationCdcDiscoveryAnswer> {
    const { graph, ...opts } = options;
    return this.client.integrationsRequest(
      "GET",
      `${connectionPath(id)}/cdc/discovery`,
      { ...opts, query: { graph } },
    );
  }

  /** Persist discovery intent on an existing graph; capture still needs mapping approval. */
  cdcDiscover(
    id: string,
    options: IntegrationCdcDiscoverOptions,
  ): Promise<IntegrationCdcDiscoveryAnswer & { created: boolean }> {
    const { graph, jobId, expectedRevision, source, credentials, ...opts } =
      options;
    return this.client.integrationsRequest(
      "POST",
      `${connectionPath(id)}/cdc/discovery`,
      {
        ...opts,
        retry: opts.retry ?? true,
        body: {
          graph,
          job_id: jobId,
          expected_revision: expectedRevision,
          source,
          credentials,
        },
      },
    );
  }

  /** Validate and normalize the exact catalog/mapping without starting capture. */
  cdcReviewDiscovery(
    id: string,
    options: IntegrationCdcApprovalOptions,
  ): Promise<IntegrationCdcReviewAnswer> {
    return this.cdcApprovalRequest("review", id, options);
  }

  /** Keep the entire reviewed body when retrying, including its original revision. */
  cdcApproveDiscovery(
    id: string,
    options: IntegrationCdcApprovalOptions,
  ): Promise<IntegrationCdcDiscoveryAnswer> {
    return this.cdcApprovalRequest("approve", id, options);
  }

  private cdcApprovalRequest<T>(
    action: "review" | "approve",
    id: string,
    options: IntegrationCdcApprovalOptions,
  ): Promise<T> {
    const {
      graph,
      jobId,
      graphEpoch,
      expectedRevision,
      catalogDigest,
      mapping,
      maxCaptureBytes,
      ...opts
    } = options;
    return this.client.integrationsRequest(
      "POST",
      `${connectionPath(id)}/cdc/discovery/${action}`,
      {
        ...opts,
        retry: opts.retry ?? true,
        body: {
          graph,
          job_id: jobId,
          graph_epoch: graphEpoch,
          expected_revision: expectedRevision,
          catalog_digest: catalogDigest,
          mapping,
          max_capture_bytes: maxCaptureBytes,
        },
      },
    );
  }

  cdcCancelDiscovery(
    id: string,
    options: IntegrationCdcCancelDiscoveryOptions,
  ): Promise<IntegrationCdcDiscoveryAnswer> {
    const { graph, jobId, graphEpoch, expectedRevision, ...opts } = options;
    return this.client.integrationsRequest(
      "POST",
      `${connectionPath(id)}/cdc/discovery/cancel`,
      {
        ...opts,
        retry: opts.retry ?? true,
        body: {
          graph,
          job_id: jobId,
          graph_epoch: graphEpoch,
          expected_revision: expectedRevision,
        },
      },
    );
  }

  /** Experimental: independent captured/applied/published counters and expiring source health. */
  cdcStatus(
    id: string,
    options: IntegrationGraphOptions,
  ): Promise<IntegrationCdcStatusAnswer> {
    const { graph, ...opts } = options;
    return this.client.integrationsRequest("GET", `${connectionPath(id)}/cdc`, {
      ...opts,
      query: { graph },
    });
  }

  /** Version-fenced notification preferences; health remains visible while muted. */
  cdcMuteAlerts(
    id: string,
    options: IntegrationCdcMuteAlertsOptions,
  ): Promise<IntegrationCdcAlertsAnswer> {
    const { graph, expectedRevision, muted, ...opts } = options;
    return this.client.integrationsRequest(
      "POST",
      `${connectionPath(id)}/cdc/alerts`,
      {
        ...opts,
        retry: opts.retry ?? true,
        body: { graph, expected_revision: expectedRevision, muted },
      },
    );
  }

  /** Experimental: acknowledge durable intent; pending work is reconciled by the CDC host. */
  cdcControl(
    id: string,
    options: IntegrationCdcControlOptions,
  ): Promise<IntegrationCdcControlAnswer> {
    const { graph, operationId, action, confirm, ...opts } = options;
    return this.client.integrationsRequest(
      "POST",
      `${connectionPath(id)}/cdc/control`,
      {
        ...opts,
        retry: opts.retry ?? true,
        body: {
          graph,
          operation_id: operationId,
          action,
          ...(confirm === undefined ? {} : { confirm }),
        },
      },
    );
  }

  /** The connector catalog: credential fields, settings and starter per kind. */
  connectors(opts: CallOptions = {}): Promise<IntegrationConnectorsAnswer> {
    return this.client.integrationsRequest("GET", `${BASE}/connectors`, opts);
  }

  /**
   * Create a connection: seal the credentials, apply the connector's starter
   * ontology, and send the first sync. The same request again answers success
   * and queues one first sync, so a retry is safe. `409 starter_conflict`
   * (with `details.conflicts`) and `409 integration_exists` create nothing.
   */
  create(input: IntegrationCreateInput): Promise<IntegrationCreateAnswer> {
    const {
      graph,
      id,
      kind,
      credentials,
      config,
      everyMs,
      ontologyMode,
      starter,
      start,
      ...opts
    } = input;
    return this.client.integrationsRequest("POST", `${BASE}/connections`, {
      ...opts,
      retry: opts.retry ?? true,
      body: {
        graph,
        id,
        kind,
        credentials,
        ...(config !== undefined ? { config } : {}),
        ...(everyMs !== undefined ? { everyMs } : {}),
        ...(ontologyMode !== undefined ? { ontologyMode } : {}),
        ...(starter !== undefined ? { starter } : {}),
        ...(start !== undefined ? { start } : {}),
      },
    });
  }

  /** Every connection of the graph with its status, last run, totals and fit. */
  list(options: IntegrationGraphOptions): Promise<IntegrationListAnswer> {
    const { graph, ...opts } = options;
    return this.client.integrationsRequest("GET", `${BASE}/connections`, {
      ...opts,
      query: { graph },
    });
  }

  /** One connection: status, settings, current turn and its error, and fit. */
  get(
    id: string,
    options: IntegrationGraphOptions,
  ): Promise<IntegrationConnectionAnswer> {
    const { graph, ...opts } = options;
    return this.client.integrationsRequest("GET", connectionPath(id), {
      ...opts,
      query: { graph },
    });
  }

  /** Replace the credentials, then check them with a `configure` and `check`. */
  setCredentials(
    id: string,
    options: IntegrationGraphOptions & { credentials: IntegrationCredentials },
  ): Promise<IntegrationRefAnswer> {
    const { graph, credentials, ...opts } = options;
    return this.client.integrationsRequest(
      "PUT",
      `${connectionPath(id)}/credentials`,
      {
        ...opts,
        retry: opts.retry ?? "rate_limited",
        body: { graph, credentials },
      },
    );
  }

  /**
   * Replace the connector settings. `409 credentials_required` when the
   * stored credentials do not open under them: replace the credentials first.
   */
  setSettings(
    id: string,
    options: IntegrationGraphOptions & { config: IntegrationConfig },
  ): Promise<IntegrationRefAnswer> {
    const { graph, config, ...opts } = options;
    return this.client.integrationsRequest(
      "PUT",
      `${connectionPath(id)}/settings`,
      {
        ...opts,
        retry: opts.retry ?? "rate_limited",
        body: { graph, config },
      },
    );
  }

  /** Send the connection a sync. The answer names the queued turn. */
  sync(
    id: string,
    options: IntegrationSyncOptions,
  ): Promise<IntegrationSyncAnswer> {
    const { graph, full, idempotencyKey, ...opts } = options;
    return this.client.integrationsRequest(
      "POST",
      `${connectionPath(id)}/sync`,
      {
        ...opts,
        idempotencyKey: idempotencyKey ?? syncKey(),
        body: { graph, ...(full !== undefined ? { full } : {}) },
      },
    );
  }

  /** Scheduled syncs and queued work wait until the connection resumes. */
  pause(
    id: string,
    options: IntegrationGraphOptions,
  ): Promise<IntegrationStatusAnswer> {
    return this.control(id, "pause", options);
  }

  /** Queued work and the schedule continue. */
  resume(
    id: string,
    options: IntegrationGraphOptions,
  ): Promise<IntegrationStatusAnswer> {
    return this.control(id, "resume", options);
  }

  /**
   * Delete the connection's state, sealed credentials and turn history. The
   * records it wrote stay in the graph. Deleting again answers `deleted: false`.
   */
  delete(
    id: string,
    options: IntegrationGraphOptions,
  ): Promise<IntegrationDeleteAnswer> {
    const { graph, ...opts } = options;
    return this.client.integrationsRequest("DELETE", connectionPath(id), {
      ...opts,
      retry: opts.retry ?? true,
      query: { graph },
    });
  }

  /**
   * Erase an end customer: delete every connection of the graph, then the
   * graph itself. `confirm` repeats the graph id. Erasing again answers zero
   * counts.
   */
  erase(
    graph: string,
    options: { confirm: string } & CallOptions,
  ): Promise<IntegrationEraseAnswer> {
    const { confirm, ...opts } = options;
    return this.client.integrationsRequest(
      "POST",
      `${BASE}/graphs/${encodeURIComponent(graph)}/erase`,
      { ...opts, retry: opts.retry ?? true, query: { confirm } },
    );
  }

  /**
   * The ontology change suggestions a connection filed, from the data plane
   * (`baseUrl`). Pass `status: "open"` for the ones that wait for a decision.
   */
  suggestions(
    connectionId: string,
    options: IntegrationSuggestionsOptions,
  ): Promise<Schemas["OntologyChangeSuggestionList"]> {
    const { graph, status, limit, ...opts } = options;
    return this.client.withScope({ graph }).ontology.suggestions.list({
      ...opts,
      originKind: "integration",
      originId: connectionId,
      status,
      limit,
    });
  }

  /**
   * Accept a suggestion on the data plane, with an edited `change` when
   * given. With `sync: true`, then send the connection that filed it a sync
   * under the message id `sync-after-<suggestion id>`. Both steps are safe to
   * repeat: after an error, call `accept` again.
   */
  async accept(
    suggestionId: string,
    options: IntegrationAcceptOptions,
  ): Promise<IntegrationAcceptResult> {
    const { graph, change, comment, author, sync, ...opts } = options;
    const scoped = this.client.withScope({ graph });
    const suggestion = await scoped.ontology.suggestions.accept(
      suggestionId,
      {
        ...(change !== undefined ? { change } : {}),
        ...(comment !== undefined ? { comment } : {}),
        ...(author !== undefined ? { author } : {}),
      },
      opts,
    );
    const origin = suggestion.origin;
    const links =
      Boolean(suggestion.identities?.length) ||
      Boolean(suggestion.proposed_identities?.length);
    if (
      !sync ||
      suggestion.status !== "accepted" ||
      links ||
      origin.kind !== "integration" ||
      !origin.id
    ) {
      return { suggestion, sync: null };
    }
    const turn = await scoped.workflows.send(
      origin.id,
      { type: "sync" },
      { ...opts, id: `sync-after-${suggestion.suggestion_id}` },
    );
    return { suggestion, sync: turn };
  }

  /** Dismiss a suggestion on the data plane with a reason. */
  dismiss(
    suggestionId: string,
    options: IntegrationDismissOptions,
  ): Promise<Schemas["OntologyChangeSuggestion"]> {
    const { graph, reason, author, ...opts } = options;
    return this.client
      .withScope({ graph })
      .ontology.suggestions.dismiss(
        suggestionId,
        { reason, ...(author !== undefined ? { author } : {}) },
        opts,
      );
  }

  private control(
    id: string,
    action: "pause" | "resume",
    options: IntegrationGraphOptions,
  ): Promise<IntegrationStatusAnswer> {
    const { graph, ...opts } = options;
    return this.client.integrationsRequest(
      "POST",
      `${connectionPath(id)}/${action}`,
      { ...opts, retry: opts.retry ?? true, body: { graph } },
    );
  }
}
