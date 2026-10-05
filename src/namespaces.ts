import type { WorkflowNamespace } from "./workflows.js";
import type { LbbClient } from "./client.js";
import { parseLbbError, type CallOptions, type LbbError } from "./transport.js";
import {
  attributeFilter,
  firstPatternVariable,
  type EntityAttributeFilterOptions,
  type ImportLine,
  parseSparqlResults,
  profileBody,
  type ReadConsistencyOptions,
  type RdfImportDocument,
  type RdfImportManyResult,
  type RdfImportOptions,
  type Schemas,
} from "./types.js";

// SPARQL is the query language. Search by meaning is `embeddings.search`
// (`POST /v1/search`); the older search, embedding, decode, groundability,
// and analytics operations were removed with their routes.

/** A5: fold read-consistency options into a request body's `consistency` /
 * `min_indexed_seq` fields; a per-call value wins over the client default. */
function withReadConsistency<B extends object>(
  client: LbbClient,
  body: B,
  opts: ReadConsistencyOptions,
): B {
  const consistency = opts.consistency ?? client.defaultConsistency;
  const merged = { ...body } as Record<string, unknown>;
  if (consistency !== undefined && merged.consistency === undefined) {
    merged.consistency = consistency;
  }
  if (
    opts.minIndexedSeq !== undefined &&
    merged.min_indexed_seq === undefined
  ) {
    merged.min_indexed_seq = opts.minIndexedSeq;
  }
  return merged as B;
}

/** Ask the server to return its measurements for one query. */
export interface ProfileOption {
  /** Same as `profile: true` in the request body. */
  profile?: boolean;
}

function withProfile(
  body: Schemas["SparqlTextRequest"],
  opts: ProfileOption,
): Schemas["SparqlTextRequest"] {
  return profileBody(body, opts.profile);
}

export class GraphNamespace {
  readonly facts: FactsNamespace;
  readonly entities: EntityNamespace;
  readonly ontology: OntologyNamespace;
  readonly query: QueryNamespace;
  readonly schema: SchemaNamespace;
  readonly search: SearchNamespace;
  readonly evals: EvalsNamespace;
  readonly checks: ChecksNamespace;
  readonly embeddings: EmbeddingsNamespace;
  readonly workflows: WorkflowNamespace;

  constructor(private readonly client: LbbClient) {
    this.facts = new FactsNamespace(client);
    this.entities = client.entities;
    this.ontology = client.ontology;
    this.query = client.query;
    this.schema = client.schema;
    this.search = client.search;
    this.evals = client.evals;
    this.checks = client.checks;
    this.embeddings = client.embeddings;
    this.workflows = client.workflows;
  }

  /** Publication lifecycle for this graph, including pre-first-publish state. */
  publicationStatus(): Promise<Schemas["PublicationStatusResponse"]> {
    return this.client.publicationStatus();
  }

  /** Background work on this graph. See {@link LbbClient.activity}. */
  activity(): Promise<Schemas["GraphActivityResponse"]> {
    return this.client.activity();
  }

  /**
   * The SPARQL planner's statistics for the published generation latest reads
   * use. See {@link LbbClient.plannerStats}.
   */
  plannerStats(
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<Schemas["PlannerStatsResponse"]> {
    return this.client.plannerStats(opts);
  }

  /** Wait until this graph has an exact generation covering `targetSeq`. */
  waitForPublished(
    targetSeq: number,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<Schemas["PublicationStatusResponse"]> {
    return this.client.waitForPublished(targetSeq, opts);
  }

  create(opts: CallOptions = {}): Promise<Schemas["CreateGraphResponse"]> {
    return this.client.request("POST", "/v1/graph/create", opts);
  }

  delete(
    opts: { confirm: string } & CallOptions,
  ): Promise<Schemas["GraphDeleteResponse"]> {
    const { confirm, ...request } = opts;
    return this.client.request("POST", "/v1/graph/delete", {
      ...request,
      query: { confirm },
      retry: request.retry ?? true,
    });
  }

  /** Retract edges/entities from the scoped graph. See {@link LbbClient.retract}. */
  retract(
    body: Schemas["GraphRetractRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["GraphRetractResponse"]> {
    return this.client.request("POST", "/v1/graph/retract", {
      ...opts,
      idempotencyKey:
        opts.idempotencyKey ?? this.client.idempotencyKey("retract"),
      body,
    });
  }
}

export class FactsNamespace {
  constructor(private readonly client: LbbClient) {}

  create(
    body: Schemas["TripletCommitFile"],
    opts: CallOptions = {},
  ): Promise<Schemas["GraphCommitResponse"]> {
    return this.client.request("POST", "/v1/graph/commit", {
      ...opts,
      body,
      idempotencyKey:
        opts.idempotencyKey ?? this.client.idempotencyKey("facts.create"),
    });
  }

  /** Bulk-load a dataset as NDJSON. See {@link LbbClient.import}. */
  import(
    lines: ImportLine[] | string,
    opts: CallOptions & {
      batch?: number;
      strict?: boolean;
      observedAt?: string;
      idempotencyKey?: string;
    } = {},
  ): Promise<Schemas["GraphImportResponse"]> {
    const { batch, strict, observedAt, ...request } = opts;
    const ndjson =
      typeof lines === "string"
        ? lines
        : lines.map((line) => JSON.stringify(line)).join("\n");
    return this.client.request("POST", "/v1/graph/import", {
      ...request,
      idempotencyKey:
        request.idempotencyKey ?? this.client.idempotencyKey("import"),
      rawBody: ndjson,
      contentType: "application/x-ndjson",
      query: { batch, strict, observed_at: observedAt },
    });
  }

  /**
   * Bulk-load N-Triples, Turtle, N-Quads, or TriG through the native RDF import endpoint.
   *
   * Statements are committed through the fixed RDF_TRIPLE relation; source RDF
   * predicates and literal term details are preserved as edge metadata.
   */
  importRdf(
    rdf: string,
    opts: CallOptions & RdfImportOptions = {},
  ): Promise<Schemas["GraphRdfImportResponse"]> {
    const {
      format = "ntriples",
      baseIri,
      graphUri,
      blankNodeScope,
      batch,
      strict,
      observedAt,
      resourceType,
      edgeIdempotency,
      build,
      ...request
    } = opts;
    return this.client.request("POST", "/v1/graph/import/rdf", {
      ...request,
      idempotencyKey:
        request.idempotencyKey ?? this.client.idempotencyKey("import-rdf"),
      rawBody: rdf,
      contentType: {
        ntriples: "application/n-triples",
        turtle: "text/turtle",
        nquads: "application/n-quads",
        trig: "application/trig",
      }[format],
      query: {
        batch,
        strict,
        observed_at: observedAt,
        format,
        base_iri: baseIri,
        graph_uri: graphUri,
        blank_node_scope: blankNodeScope,
        resource_type: resourceType,
        edge_idempotency: edgeIdempotency,
        build,
      },
    });
  }

  /** Import several RDF documents and enqueue publication only for the final commit. */
  importRdfMany(
    documents: readonly RdfImportDocument[],
    opts: RdfImportOptions = {},
  ): Promise<RdfImportManyResult> {
    return this.client.importRdfMany(documents, opts);
  }
}

/**
 * Relevance-label storage. The query surfaces this namespace once fronted were
 * removed with their routes; search by meaning is `embeddings.search`.
 */
export class SearchNamespace {
  constructor(private readonly client: LbbClient) {}

  feedback(
    body: Schemas["SearchFeedbackRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["SearchFeedbackResponse"]> {
    return this.client.request("POST", "/v1/search/feedback", {
      ...opts,
      body,
    });
  }

  feedbackExport(
    opts: CallOptions = {},
  ): Promise<Schemas["SearchFeedbackExportResponse"]> {
    return this.client.request("GET", "/v1/search/feedback/export", opts);
  }

  feedbackSummary(
    opts: CallOptions = {},
  ): Promise<Schemas["SearchFeedbackSummaryResponse"]> {
    return this.client.request("GET", "/v1/search/feedback/summary", opts);
  }
}

export class EntityNamespace {
  constructor(private readonly client: LbbClient) {}

  detail(
    opts: Parameters<LbbClient["entityDetail"]>[0],
  ): Promise<Schemas["EntityDetailResponse"]> {
    return this.client.entityDetail(opts);
  }

  /**
   * Filter entities already bound by relation patterns using typed attributes,
   * without writing RDF property IRIs by hand. This is a convenience wrapper over
   * the structured SPARQL route: relation `patterns` bind variables, and `where`
   * compares ontology property fields on those bound variables.
   */
  filterByAttributes(
    opts: EntityAttributeFilterOptions,
  ): Promise<Schemas["SparqlSelectResponse"]> {
    const defaultVar = firstPatternVariable(opts.patterns);
    const where = Array.isArray(opts.where) ? opts.where : [opts.where];
    return this.client.sparql({
      patterns: opts.patterns,
      filters: [
        ...(opts.filters ?? []),
        ...where.map((filter) => attributeFilter(filter, defaultVar)),
      ],
      select: opts.select,
      limit: opts.limit,
      offset: opts.offset,
      order_by: opts.orderBy,
      reason: opts.reason,
      max_solutions: opts.maxSolutions,
      max_object_reads: opts.maxObjectReads,
      max_fetched_bytes: opts.maxFetchedBytes,
    });
  }
}

/**
 * Search: embeddings declared on classes of the graph. The platform keeps the
 * vectors in step with the published graph; a search checks every hit against
 * one graph snapshot.
 */
export class EmbeddingsNamespace {
  /** Sessions that test search settings on the graph's own searches. */
  readonly searchTuning: SearchTuningNamespace;

  constructor(private readonly client: LbbClient) {
    this.searchTuning = new SearchTuningNamespace(client);
  }

  /** Every embedding of the graph with its status. */
  list(opts: CallOptions = {}): Promise<Schemas["EmbeddingListResponse"]> {
    return this.client.request("GET", "/v1/embeddings", opts);
  }

  /** One embedding: serving and building version, backfill, lag, recall. */
  get(
    name: string,
    opts: CallOptions = {},
  ): Promise<Schemas["EmbeddingStatus"]> {
    return this.client.request("GET", "/v1/embeddings", {
      ...opts,
      query: { name },
    });
  }

  /**
   * Declare or change the embedding of a class. Without `from` the server
   * picks the fields (the label, frequent text, the names of linked
   * entities). A new recipe builds as a new version while the old one serves.
   */
  declare(
    body: Schemas["EmbeddingDeclareRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["EmbeddingStatus"]> {
    return this.client.request("PUT", "/v1/embeddings", { ...opts, body });
  }

  /**
   * What a declaration would embed: the fields, every candidate fact of the
   * class with its coverage and examples, and sample texts. Calls no model.
   */
  preview(
    body: Schemas["EmbeddingPreviewRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["EmbeddingPreviewResponse"]> {
    return this.client.request("POST", "/v1/embeddings/preview", {
      ...opts,
      body,
    });
  }

  /**
   * Move every embedding of the graph to another model (one model per
   * graph). Each builds a new version; the graph switches at once when
   * every embedding has it ready, so a search never mixes two models.
   */
  setModel(
    body: Schemas["EmbeddingModelRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["EmbeddingListResponse"]> {
    return this.client.request("PUT", "/v1/embeddings/model", {
      ...opts,
      body,
    });
  }

  /** Run one bounded step of the embed job now. */
  refresh(
    name: string,
    opts: CallOptions = {},
  ): Promise<Schemas["EmbeddingRefreshResponse"]> {
    return this.client.request("POST", "/v1/embeddings/refresh", {
      ...opts,
      query: { name },
    });
  }

  /** Remove an embedding. */
  delete(name: string, opts: CallOptions = {}): Promise<unknown> {
    return this.client.request("DELETE", "/v1/embeddings", {
      ...opts,
      query: { name, confirm: name },
    });
  }

  /**
   * Search by meaning over every searchable class of the graph (or one
   * `embedding`). `filter` lists the conditions every hit must meet:
   * `{ class: iri }` (or a list; subclasses too) and
   * `{ via: "calls", to: "payment-service", direction?: "in" }` (`to` an IRI
   * or a name). Every hit carries its class and is checked against one
   * graph snapshot; `include: ["text"]` returns the embedded text of each
   * hit; `explain: true` plans without running. `rerank: true` orders the
   * best hits by the managed rerank model (each hit then carries its
   * `relevance`); without it the graph's search setting decides.
   */
  search(
    body: Schemas["SearchRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["SearchResponse"]> {
    return this.client.request("POST", "/v1/search", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }

  /**
   * The graph's search settings: whether every search reranks its best
   * hits, `rerank_depth`, `blend` and `probe_factor` when they are set, and
   * the rerank model the server has (`rerank_available`).
   */
  searchSettings(opts: CallOptions = {}): Promise<Schemas["SearchSettings"]> {
    return this.client.request("GET", "/v1/search/settings", opts);
  }

  /**
   * Change the graph's search settings. `rerank` turns the rerank on or off
   * for every search; `rerank_depth` (20 to 80) is the hits the rerank model
   * reads; `blend` (0 to 1) mixes the rerank order and the similarity order;
   * `probe_factor` (1 to 4) widens the vector search over big runs. A field
   * left out keeps its value, and `null` sets it back to its default
   * (`{ blend: null }`). Returns the settings after the change.
   */
  setSearchSettings(
    body: Schemas["SearchSettingsRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["SearchSettings"]> {
    return this.client.request("PUT", "/v1/search/settings", {
      ...opts,
      body,
    });
  }
}

/**
 * Search tuning: a session runs the graph's own searches with other search
 * settings, grades the hits with the platform's judge, and proposes the
 * settings that rank best. A person applies the proposal; a session never
 * changes a setting by itself.
 */
export class SearchTuningNamespace {
  constructor(private readonly client: LbbClient) {}

  /**
   * Start a session (`queries` 6 to 40, default 40; `rounds` 1 to 3, default
   * 3). Returns the session, `queued`; read it with {@link get} until its
   * `status` is `done` or `failed`. One session per graph runs at a time
   * (`409 tuning_running`).
   *
   * A session spends the platform's judge budget, so a failed call is not
   * retried unless `retry` is set.
   */
  start(
    body: Schemas["SearchTuningStartRequest"] = {},
    opts: CallOptions = {},
  ): Promise<Schemas["SearchTuningSession"]> {
    return this.client.request("POST", "/v1/search/tuning", {
      ...opts,
      retry: opts.retry ?? false,
      body,
    });
  }

  /** The graph's sessions, newest first (`limit` 1 to 50, default 10). */
  list(
    options: { limit?: number } & CallOptions = {},
  ): Promise<Schemas["SearchTuningListResponse"]> {
    const { limit, ...opts } = options;
    return this.client.request("GET", "/v1/search/tuning", {
      ...opts,
      query: { limit },
    });
  }

  /** One session: its step, the baseline, the variants with their scores,
   * the rounds with the judge's notes, and the proposal. */
  get(
    sessionId: string,
    opts: CallOptions = {},
  ): Promise<Schemas["SearchTuningSession"]> {
    return this.client.request("GET", "/v1/search/tuning/get", {
      ...opts,
      query: { id: sessionId },
    });
  }

  /**
   * Set the graph's search settings to the session's proposal: exactly the
   * settings the session tested. A setting the proposal leaves unset goes
   * back to its default. Returns the session with `applied_at_ms` and
   * `applied_by`. `409 tuning_no_proposal` when the session has none. A
   * retry sets the same settings, so it is safe.
   */
  apply(
    sessionId: string,
    opts: CallOptions = {},
  ): Promise<Schemas["SearchTuningSession"]> {
    return this.client.request("POST", "/v1/search/tuning/apply", {
      ...opts,
      retry: opts.retry ?? true,
      query: { id: sessionId },
    });
  }
}

/** Managed evals: traces, labels (thumbs up or down), goldens, and runs. */
export class EvalsNamespace {
  constructor(private readonly client: LbbClient) {}

  /** Settings, golden counts, unlabeled traces, the latest run, and the score by commit. */
  summary(opts: CallOptions = {}): Promise<Schemas["EvalSummaryResponse"]> {
    return this.client.request("GET", "/v1/evals", opts);
  }

  /** Recent traces, newest first. */
  traces(
    options: { limit?: number; unlabeled?: boolean } & CallOptions = {},
  ): Promise<Schemas["EvalTraceListResponse"]> {
    const { limit, unlabeled, ...opts } = options;
    return this.client.request("GET", "/v1/evals/traces", {
      ...opts,
      query: { limit, unlabeled: unlabeled ? "true" : undefined },
    });
  }

  /** One trace: the request, its query, its results (one item per hit or
   * row), and their labels. */
  trace(id: string, opts: CallOptions = {}): Promise<Schemas["EvalTrace"]> {
    return this.client.request("GET", "/v1/evals/trace", {
      ...opts,
      query: { id },
    });
  }

  /** Thumbs up or down on results of a trace: one result as `item` +
   * `valid`, or several in `items`. The labels become the golden's ground
   * truth. */
  label(
    traceId: string,
    body: Schemas["EvalLabelRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["EvalLabelResponse"]> {
    return this.client.request("POST", "/v1/evals/label", {
      ...opts,
      query: { trace: traceId },
      body,
    });
  }

  /** Let the managed judge label the results of one trace, or of a batch of
   * traces with unlabeled results. */
  judge(
    options: { traceId?: string; limit?: number } & CallOptions = {},
  ): Promise<Schemas["EvalJudgeResponse"]> {
    const { traceId, limit, ...opts } = options;
    return this.client.request("POST", "/v1/evals/judge", {
      ...opts,
      query: { trace: traceId, limit },
    });
  }

  goldens(opts: CallOptions = {}): Promise<Schemas["GoldenSuite"]> {
    return this.client.request("GET", "/v1/evals/goldens", opts);
  }

  /** Freeze a query: every result it returns now is relevant. */
  createGolden(
    body: Schemas["GoldenCreateRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["GoldenResponse"]> {
    return this.client.request("POST", "/v1/evals/goldens", { ...opts, body });
  }

  /** Accept the results a golden returns now as its reference. */
  acceptGolden(
    id: string,
    opts: CallOptions & Pick<ReadConsistencyOptions, "consistency"> = {},
  ): Promise<Schemas["GoldenResponse"]> {
    return this.client.request("POST", "/v1/evals/goldens/accept", {
      ...opts,
      query: { id, consistency: opts.consistency },
    });
  }

  deleteGolden(
    id: string,
    opts: CallOptions = {},
  ): Promise<Schemas["GoldenDeleteResponse"]> {
    return this.client.request("DELETE", "/v1/evals/goldens", {
      ...opts,
      query: { id },
    });
  }

  /** Replay every golden at the current commit. */
  run(
    opts: CallOptions & Pick<ReadConsistencyOptions, "consistency"> = {},
  ): Promise<Schemas["EvalRunResponse"]> {
    return this.client.request("POST", "/v1/evals/run", {
      ...opts,
      query: { consistency: opts.consistency },
    });
  }

  results(
    options: { limit?: number } & CallOptions = {},
  ): Promise<Schemas["EvalResultsListResponse"]> {
    const { limit, ...opts } = options;
    return this.client.request("GET", "/v1/evals/results", {
      ...opts,
      query: { limit },
    });
  }

  settings(opts: CallOptions = {}): Promise<Schemas["EvalSettings"]> {
    return this.client.request("GET", "/v1/evals/settings", opts);
  }

  setSettings(
    body: Schemas["EvalSettings"],
    opts: CallOptions = {},
  ): Promise<Schemas["EvalSettings"]> {
    return this.client.request("PUT", "/v1/evals/settings", { ...opts, body });
  }
}

/** Options of {@link ChecksNamespace.calls}. */
export interface ModelCallListOptions extends CallOptions {
  /** Only the calls of one job. */
  job?: Schemas["ModelJob"];
  /** The newest day of the page, `yyyy-mm-dd` (UTC). Default: today, or the
   * day of `after`. A page reads back at most 31 days. */
  day?: string;
  /** `true` keeps the calls that have a check, `false` those without one. */
  checked?: boolean;
  /** The `next_after` of the previous page. */
  after?: string;
  /** Rows per page: 1 to 100, default 50. */
  limit?: number;
}

/** Options of {@link ChecksNamespace.list}. */
export interface ModelCheckListOptions extends CallOptions {
  /** Only the checks of one job. */
  job?: Schemas["ModelJob"];
  /** `yyyy-mm` (UTC). Default: the current month. */
  month?: string;
  /** Only the checks whose ground truth has this verdict. */
  verdict?: Schemas["CheckVerdict"];
  /** `true` keeps the checks a person reviewed, `false` the others. */
  reviewed?: boolean;
  /** The `next_after` of the previous page. */
  after?: string;
  /** Rows per page: 1 to 100, default 50. */
  limit?: number;
}

/** One line of {@link ChecksNamespace.export}. */
export interface ModelCheckExportLine {
  /** The call, or `null` when the log no longer holds it. Its groundings
   * stay named by their hash. */
  call: Schemas["ModelCall"] | null;
  check: Schemas["ModelCheck"];
}

/**
 * Model checks: the log of the model calls LBB makes for its own work on the
 * graph (rerank, route, rewrite, fit, propose, label, embed), the checks a
 * judge model makes of a sample of them, and the reviews people make of the
 * checks. A review is the call's ground truth.
 *
 * Reading calls and checks and reviewing a check use no model. `checkCall`
 * spends the platform's judge budget.
 */
export class ChecksNamespace {
  constructor(private readonly client: LbbClient) {}

  /**
   * One month of checks (`yyyy-mm`, UTC; the current month by default): per
   * job and model the checks, the mean score, right, partly and wrong, the
   * reviews and corrections; the judge's agreement with people; today's
   * budget; whether the server has a checker; the month's model calls.
   */
  summary(
    options: { month?: string } & CallOptions = {},
  ): Promise<Schemas["ModelChecksSummary"]> {
    const { month, ...opts } = options;
    return this.client.request("GET", "/v1/models/checks/summary", {
      ...opts,
      query: { month },
    });
  }

  /** The checks of a month, newest first. Each carries the judge's verdict,
   * the review when there is one, and the ground truth (`truth`). */
  list(
    options: ModelCheckListOptions = {},
  ): Promise<Schemas["ModelCheckListResponse"]> {
    const { job, month, verdict, reviewed, after, limit, ...opts } = options;
    return this.client.request("GET", "/v1/models/checks", {
      ...opts,
      query: { job, month, verdict, reviewed, after, limit },
    });
  }

  /**
   * Agree with the judge (`{ agree: true }`, with an optional `note`), or
   * correct it (`{ agree: false, verdict, score?, reference?, note? }`). The
   * review becomes the call's ground truth and replaces an earlier review,
   * which moves to `history`. A rerank or label correction may grade the
   * hits: `reference: { grades: { "<hit id>": 0..3 } }`. Returns the check.
   */
  review(
    callId: string,
    body: Schemas["ModelCheckReviewRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["ModelCheck"]> {
    return this.client.request("POST", "/v1/models/checks/review", {
      ...opts,
      query: { id: callId },
      body,
    });
  }

  /** The checks of a month as parsed JSON lines, oldest first: the call and
   * its check, at most 10,000 lines. */
  async export(
    options: { job?: Schemas["ModelJob"]; month?: string } & CallOptions = {},
  ): Promise<ModelCheckExportLine[]> {
    const { job, month, ...opts } = options;
    const lines = await this.client.request<ModelCheckExportLine[] | undefined>(
      "GET",
      "/v1/models/checks/export",
      { ...opts, query: { job, month } },
    );
    return lines ?? [];
  }

  /** The call log, newest first. Each row names the job and the model, a
   * short summary, and the check's verdict when there is one. */
  calls(
    options: ModelCallListOptions = {},
  ): Promise<Schemas["ModelCallListResponse"]> {
    const { job, day, checked, after, limit, ...opts } = options;
    return this.client.request("GET", "/v1/models/calls", {
      ...opts,
      query: { job, day, checked, after, limit },
    });
  }

  /** One call: its input and output, its groundings as text, and its check. */
  call(
    callId: string,
    opts: CallOptions = {},
  ): Promise<Schemas["ModelCallDetailResponse"]> {
    return this.client.request("GET", "/v1/models/calls/get", {
      ...opts,
      query: { id: callId },
    });
  }

  /**
   * Ask the judge to check one call now. The call goes to the graph's checks
   * workflow; a call that has a check is checked again, and its review stays.
   * Returns `{ queued: true }`. `400 model_call_not_checkable` for an `embed`
   * call or a failed call; `503` without a checker.
   *
   * A check spends the platform's judge budget, so a failed call is not
   * retried unless `retry` is set.
   */
  checkCall(
    callId: string,
    opts: CallOptions = {},
  ): Promise<Schemas["ModelCallCheckResponse"]> {
    return this.client.request("POST", "/v1/models/calls/check", {
      ...opts,
      retry: opts.retry ?? false,
      query: { id: callId },
    });
  }
}

/** Active ontology/SHACL bundle metadata and atomic publication. */
export class SchemaNamespace {
  constructor(private readonly client: LbbClient) {}

  /** Read active metadata without running request-time validation. */
  view(opts: CallOptions = {}): Promise<Schemas["SchemaBundleView"]> {
    return this.client.request("GET", "/v1/schema", opts);
  }

  /** Atomically publish a bundle; conformance is produced asynchronously. */
  publish(
    body: Schemas["SchemaPublishRequest"],
    opts: CallOptions & { dryRun?: boolean } = {},
  ): Promise<Schemas["SchemaPublishResponse"]> {
    return this.client.request("POST", "/v1/schema/publish", {
      ...opts,
      query: { dry_run: opts.dryRun },
      idempotencyKey:
        opts.idempotencyKey ?? this.client.idempotencyKey("schema-publish"),
      body,
    });
  }
}

/** Filters for {@link OntologySuggestionsNamespace.list}. */
export interface OntologySuggestionListOptions extends CallOptions {
  status?: Schemas["OntologyChangeSuggestionStatus"];
  originKind?: Schemas["SuggestionOriginKind"];
  /** Producer id, for example an integration connection id. */
  originId?: string;
  /** Class, property or relation name. */
  anchor?: string;
  key?: string;
  /** Default 100, maximum 500. */
  limit?: number;
}

/**
 * Ontology change suggestions: durable proposals from integrations,
 * agents and people. People accept or dismiss them; accepting
 * applies the change to the current ontology.
 */
export class OntologySuggestionsNamespace {
  constructor(private readonly client: LbbClient) {}

  /** Newest update first, with counts per status over the whole graph. */
  list(
    options: OntologySuggestionListOptions = {},
  ): Promise<Schemas["OntologyChangeSuggestionList"]> {
    const { status, originKind, originId, anchor, key, limit, ...opts } =
      options;
    return this.client.request("GET", "/v1/ontology/suggestions", {
      ...opts,
      query: {
        status,
        origin_kind: originKind,
        origin_id: originId,
        anchor,
        key,
        limit,
      },
    });
  }

  /** One suggestion with its evidence, impact and discussion. */
  get(
    suggestionId: string,
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyChangeSuggestion"]> {
    return this.client.request("GET", "/v1/ontology/suggestions/detail", {
      ...opts,
      query: { suggestion_id: suggestionId },
    });
  }

  /**
   * File a suggestion, or update the one with the same `key`. The server
   * dry-runs the change and never changes the ontology here, so a retry is
   * safe.
   */
  create(
    body: Schemas["OntologyChangeSuggestionCreateRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyChangeSuggestion"]> {
    return this.client.request("POST", "/v1/ontology/suggestions", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }

  /** Dry-run the change against the current ontology and store the impact. */
  validate(
    suggestionId: string,
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyChangeSuggestion"]> {
    return this.client.request("POST", "/v1/ontology/suggestions/validate", {
      ...opts,
      retry: opts.retry ?? true,
      query: { suggestion_id: suggestionId },
    });
  }

  /**
   * Apply the change to the current ontology. Pass `change` to accept an
   * edited change. Accepting twice returns the accepted suggestion.
   */
  accept(
    suggestionId: string,
    body: Schemas["OntologyChangeSuggestionAcceptRequest"] = {},
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyChangeSuggestion"]> {
    return this.client.request("POST", "/v1/ontology/suggestions/accept", {
      ...opts,
      retry: opts.retry ?? true,
      query: { suggestion_id: suggestionId },
      body,
    });
  }

  /** Decline with a reason. The ontology does not change. */
  dismiss(
    suggestionId: string,
    body: Schemas["OntologyChangeSuggestionDecisionRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyChangeSuggestion"]> {
    return this.client.request("POST", "/v1/ontology/suggestions/dismiss", {
      ...opts,
      retry: opts.retry ?? true,
      query: { suggestion_id: suggestionId },
      body,
    });
  }

  /** Withdraw as the producer, for example when the source field is gone. */
  supersede(
    suggestionId: string,
    body: Schemas["OntologyChangeSuggestionDecisionRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyChangeSuggestion"]> {
    return this.client.request("POST", "/v1/ontology/suggestions/supersede", {
      ...opts,
      retry: opts.retry ?? true,
      query: { suggestion_id: suggestionId },
      body,
    });
  }

  /** Add a comment to the discussion. */
  comment(
    suggestionId: string,
    body: Schemas["OntologyChangeSuggestionCommentRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyChangeSuggestion"]> {
    return this.client.request("POST", "/v1/ontology/suggestions/comment", {
      ...opts,
      query: { suggestion_id: suggestionId },
      body,
    });
  }
}

/** Options for {@link OntologyStartersNamespace.apply}. */
export interface OntologyStarterApplyOptions extends CallOptions {
  /** Answer what applying would do without writing anything. */
  dryRun?: boolean;
  /** Refuse with `409 conflict` when the graph's ontology version differs. */
  expectedOntologyVersion?: number;
}

/**
 * Ontology starters: versioned base ontologies for a domain (`crm`,
 * `documents`, `work`) that a graph starts from. The status compares a
 * starter's terms with the graph's ontology; the graph does not need to exist
 * for `list` and `get`.
 */
export class OntologyStartersNamespace {
  constructor(private readonly client: LbbClient) {}

  /** Every starter with its status on the graph. */
  list(opts: CallOptions = {}): Promise<Schemas["OntologyStarterList"]> {
    return this.client.request("GET", "/v1/ontology/starters", opts);
  }

  /**
   * One starter's document, its status on the graph and `missing_ops`, the
   * evolve operations applying it would run now.
   */
  get(
    starter: string,
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyStarterDetail"]> {
    return this.client.request("GET", "/v1/ontology/starters/detail", {
      ...opts,
      query: { starter },
    });
  }

  /**
   * Add what the graph lacks of a starter in one ontology version. A
   * relation the graph has is widened. Applying again answers
   * `no_op: true`, so a retry is safe. A term the graph holds differently
   * fails with `409 starter_conflict` and writes nothing.
   */
  apply(
    starter: string,
    options: OntologyStarterApplyOptions = {},
  ): Promise<Schemas["OntologyStarterApplyResponse"]> {
    const { dryRun, expectedOntologyVersion, ...opts } = options;
    return this.client.request("POST", "/v1/ontology/starters/apply", {
      ...opts,
      retry: opts.retry ?? true,
      body: {
        starter,
        ...(dryRun !== undefined ? { dry_run: dryRun } : {}),
        ...(expectedOntologyVersion !== undefined
          ? { expected_ontology_version: expectedOntologyVersion }
          : {}),
      },
    });
  }

  /**
   * File what a graph holding part of a starter lacks as one ontology change
   * suggestion, keyed `starter:<id>/<version>`. Asking again returns the same
   * suggestion, so a retry is safe.
   */
  update(
    starter: string,
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyStarterUpdateResponse"]> {
    return this.client.request("POST", "/v1/ontology/starters/update", {
      ...opts,
      retry: opts.retry ?? true,
      body: { starter },
    });
  }
}

/**
 * Ontology drafts: a proposed ontology built from 1 to 100 sample records at
 * one commit. The samples are not written to the graph. Validate a draft,
 * then promote it (the ontology changes) or reject it.
 */
export class OntologyDraftsNamespace {
  constructor(private readonly client: LbbClient) {}

  /**
   * Build a draft from `samples`: the proposed operations, an analysis per
   * competency question, coverage, structural pitfalls and confidence. The
   * samples are evidence only; no fact is written.
   */
  create(
    body: Schemas["OntologyDraftCreateRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyDraft"]> {
    return this.client.request("POST", "/v1/ontology/drafts", {
      ...opts,
      body,
    });
  }

  /** One draft with its status: `draft`, `validated`, `promoted` or `rejected`. */
  get(
    draftId: string,
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyDraft"]> {
    return this.client.request("GET", "/v1/ontology/drafts", {
      ...opts,
      query: { draft_id: draftId },
    });
  }

  /**
   * Check the proposed operations again at the draft's commit and ontology
   * version. A draft whose ontology has moved on fails; it is not rebased.
   */
  validate(
    draftId: string,
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyDraft"]> {
    return this.client.request("POST", "/v1/ontology/drafts/validate", {
      ...opts,
      retry: opts.retry ?? true,
      query: { draft_id: draftId },
    });
  }

  /**
   * Apply a validated draft to the ontology in one version. The route needs
   * an idempotency key; the client makes one per call unless you pass
   * `idempotencyKey`. A retry returns the promoted draft.
   */
  promote(
    draftId: string,
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyDraft"]> {
    return this.client.request("POST", "/v1/ontology/drafts/promote", {
      ...opts,
      idempotencyKey:
        opts.idempotencyKey ??
        this.client.idempotencyKey("ontology-draft-promote"),
      query: { draft_id: draftId },
    });
  }

  /** Record why the draft is rejected. The ontology does not change. */
  reject(
    draftId: string,
    reason: string,
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyDraft"]> {
    return this.client.request("POST", "/v1/ontology/drafts/reject", {
      ...opts,
      query: { draft_id: draftId, reason },
    });
  }
}

/** Ontology discovery and lifecycle operations. */
export class OntologyNamespace {
  /** Reviewable change suggestions from every producer. */
  readonly suggestions: OntologySuggestionsNamespace;
  /** Base ontologies a graph starts from. */
  readonly starters: OntologyStartersNamespace;
  /** Proposed ontologies built from sample records. */
  readonly drafts: OntologyDraftsNamespace;

  constructor(private readonly client: LbbClient) {
    this.suggestions = new OntologySuggestionsNamespace(client);
    this.starters = new OntologyStartersNamespace(client);
    this.drafts = new OntologyDraftsNamespace(client);
  }

  view(
    options: { counts?: boolean } & CallOptions = {},
  ): Promise<Schemas["OntologyView"]> {
    const { counts, ...request } = options;
    return this.client.request("GET", "/v1/ontology", {
      ...request,
      query: counts ? { counts: true } : undefined,
    });
  }

  /**
   * Read the published SHACL conformance report. `limit` bounds the returned
   * `results` (server default 200, maximum 2,000); `result_count` and
   * `conforms` stay exact, and `truncated` says the window is partial.
   */
  conformance(
    opts: CallOptions &
      Pick<ReadConsistencyOptions, "consistency"> & { limit?: number } = {},
  ): Promise<Schemas["SchemaAuditReport"]> {
    const { limit, ...rest } = opts;
    return this.client.request("GET", "/v1/ontology/conformance", {
      ...rest,
      query: {
        consistency: opts.consistency ?? this.client.defaultConsistency,
        ...(limit !== undefined ? { limit } : {}),
      },
    });
  }

  search(
    body: Schemas["OntologySearchRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["OntologySearchResponse"]> {
    return this.client.request("POST", "/v1/ontology/search", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }

  resolve(
    body: Schemas["OntologyResolveRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyResolveResponse"]> {
    return this.client.request("POST", "/v1/ontology/resolve", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }

  /**
   * Put the scoped graph on an imported ontology, creating the graph when it
   * does not exist yet. Safe to repeat. See {@link LbbClient.ontologyDefine}.
   */
  define(
    body: Schemas["OntologyDefineRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyDefineResponse"]> {
    return this.client.request("POST", "/v1/ontology/define", {
      ...opts,
      body,
    });
  }

  evolve(
    body: Schemas["OntologyEvolveRequest"],
    opts: CallOptions & { dryRun?: boolean } = {},
  ): Promise<Schemas["OntologyEvolveResponse"]> {
    return this.client.request("POST", "/v1/ontology/evolve", {
      ...opts,
      query: { dry_run: opts.dryRun },
      body,
    });
  }
}

/** Options of {@link QueryNamespace.ask}. */
export interface QueryAskOptions
  extends CallOptions, Pick<ReadConsistencyOptions, "consistency"> {
  /**
   * The app's notes for the model: what the data means, units, names to
   * prefer. At most 8,000 characters. Keep it the same across questions, so
   * the model provider's prompt cache reads it.
   */
  context?: string;
  /** Earlier steps of the same question, oldest first; at most 6. */
  previous?: Schemas["QueryRewriteStep"][];
  /** Fix the kind of query. Without it, the router model selects it. */
  route?: Schemas["QueryRoute"];
  /** Rows the run returns: 1 to 1,000, default 100. */
  limit?: number;
  /** Read the graph at this commit. */
  asOfCommitSeq?: number;
  /** Today's date for relative questions, `YYYY-MM-DD`. Default: the server's UTC date. */
  today?: string;
  /**
   * Entity IRIs the user picked in your app, at most 10. The server reads
   * each one, and the rewriter uses the IRIs directly instead of matching
   * their names.
   */
  anchor?: string[];
  /**
   * Dated points that stand for the graph's commits, at most 200: a question
   * about a date reads the commit of the latest point on or before it. For
   * graphs whose commits stand for other dates than the days they were
   * written (a demo's milestones, an import of old records). Without it, the
   * server maps a date to the last commit written by the end of that day.
   */
  timeline?: Schemas["QueryRewriteTimelinePoint"][];
}

/** What {@link QueryNamespace.ask} returns. */
export interface QueryAskResult {
  /** The kind of query, who chose it, and how sure the choice is. */
  route: Schemas["QueryRouteDecision"];
  /** The checked query, or `null` when the graph does not hold the answer. */
  query: Schemas["RewrittenQuery"] | null;
  /** One or two sentences: why this route and this query. */
  rationale: string;
  /** The rows as `{ variable: lexicalValue }`; empty when the query did not run. */
  rows: Record<string, string>[];
  /** The projected variables. */
  vars: string[];
  /** The answer of an `ASK` query, `null` for a `SELECT`. */
  boolean: boolean | null;
  /** The snapshot the rows were read from, when the server names it. */
  snapshot: Schemas["SnapshotView"] | null;
  /** Why the last attempt failed, when the query did not parse or run. */
  error: string | null;
  /** The eval trace of the run. Label its rows with `evals.label`. */
  traceId: string | null;
  /**
   * The names of the question the server linked to entities, for a "Did you
   * mean …?"; empty when nothing linked.
   */
  linked: Schemas["QueryRewriteLink"][];
  /** What the server read about each anchored IRI, with a note when it was not found. */
  anchors: Schemas["QueryRewriteAnchor"][];
  /**
   * For a history question: the date, the commit it resolved to and how,
   * and for a comparison both runs and the rows `added` and `removed`.
   * `null` for other questions.
   */
  history: Schemas["QueryRewriteHistory"] | null;
  /** The whole response of `POST /v1/query/rewrite`. */
  rewrite: Schemas["QueryRewriteResponse"];
}

/**
 * One event of {@link QueryNamespace.rewriteStream}: `grounding`, `route`,
 * `query`, `run`, `rows`, `repair`, and last `done` with the whole response.
 * The stream throws an `error` event as {@link LbbError}; it never yields one.
 */
export type QueryRewriteStreamEvent = Exclude<
  Schemas["QueryRewriteEvent"],
  { event: "error" }
>;

/** The event names of a streamed rewrite. A client skips any other name. */
const REWRITE_STREAM_EVENTS: ReadonlySet<string> = new Set([
  "grounding",
  "route",
  "query",
  "run",
  "rows",
  "repair",
  "done",
  "error",
]);

/** The `type` the server's JSON error carries for a status. */
function errorTypeForStatus(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401 || status === 403) return "auth_error";
  if (status === 404) return "not_found_error";
  if (status === 409) return "conflict_error";
  if (status === 429) return "rate_limit_error";
  return "api_error";
}

/** The {@link LbbError} of an `error` event: the status, code and message of
 * the JSON error the same request without a stream gets. */
function streamError(data: unknown, requestId?: string): LbbError {
  const event = (data ?? {}) as Partial<Schemas["StreamErrorEvent"]>;
  const status = typeof event.status === "number" ? event.status : 500;
  const error = {
    type: errorTypeForStatus(status),
    code: event.code,
    message: event.message,
  };
  return parseLbbError(status, JSON.stringify({ error }), requestId);
}

/** Questions in plain words, and structured and SPARQL-text queries. */
export class QueryNamespace {
  constructor(private readonly client: LbbClient) {}

  /**
   * Turn a question into a SPARQL query (`POST /v1/query/rewrite`). A router
   * model selects the kind of query (the route), and a rewriter model writes
   * the query from a description of the graph. The server checks the query.
   * With `run: true` the server also runs it, returns the rows in `result`,
   * and corrects a query that fails once. `mode: "route"` returns only the
   * route.
   *
   * Each call uses model tokens, so a failed call is not retried unless
   * `retry` is set. A `429 rewrite_limit` means the stack used its rewrites
   * of the day.
   */
  rewrite(
    body: Schemas["QueryRewriteRequest"],
    opts: CallOptions & Pick<ReadConsistencyOptions, "consistency"> = {},
  ): Promise<Schemas["QueryRewriteResponse"]> {
    return this.client.request("POST", "/v1/query/rewrite", {
      ...opts,
      retry: opts.retry ?? false,
      body,
      query: {
        consistency: opts.consistency ?? this.client.defaultConsistency,
      },
    });
  }

  /**
   * {@link rewrite} with progress: the server sends an event for each step,
   * and the last event, `done`, holds the same response as `rewrite`. The
   * order is `grounding`, `route`, then `query`, `run` and `rows` per
   * attempt, with `repair` before a second attempt. A second `route` comes
   * when the rewriter chose another route. A comparison runs twice: `run`
   * (with `point: "before"`) and `rows`, then `run` (`point: "after"`) and
   * `rows`.
   *
   * An `error` event throws {@link LbbError} with the status, code and
   * message that `rewrite` throws. An error before the stream starts (a 400,
   * a `429 rewrite_limit`) throws as `rewrite` does. The call is never
   * retried. Abort `signal` to stop the server's work; leaving the loop
   * early closes the stream too. `timeoutMs` bounds the whole stream.
   *
   * ```ts
   * for await (const event of client.query.rewriteStream({ question, run: true })) {
   *   if (event.event === "done") console.log(event.data.result);
   *   else console.log(event.event);
   * }
   * ```
   */
  async *rewriteStream(
    body: Schemas["QueryRewriteRequest"],
    opts: CallOptions & Pick<ReadConsistencyOptions, "consistency"> = {},
  ): AsyncGenerator<QueryRewriteStreamEvent, void, undefined> {
    let requestId: string | undefined;
    const events = this.client.requestEventStream("POST", "/v1/query/rewrite", {
      ...opts,
      body,
      query: {
        consistency: opts.consistency ?? this.client.defaultConsistency,
      },
      // A server without streams answers with the response itself.
      jsonEvent: "done",
      onOpen: (response) => {
        requestId = response.requestId;
      },
    });
    for await (const { event, data } of events) {
      if (!REWRITE_STREAM_EVENTS.has(event)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch (error) {
        throw new SyntaxError(
          `Little Big Brain sent invalid JSON in a "${event}" event`,
          { cause: error },
        );
      }
      if (event === "error") throw streamError(parsed, requestId);
      yield { event, data: parsed } as QueryRewriteStreamEvent;
      if (event === "done") return;
    }
    throw new Error(
      "Little Big Brain rewrite stream ended before its done or error event",
    );
  }

  /**
   * Answer a question in plain words: {@link rewrite} with `run: true`, and
   * the rows of the run parsed as {@link sparql} parses them.
   */
  async ask(
    question: string,
    options: QueryAskOptions = {},
  ): Promise<QueryAskResult> {
    const {
      context,
      previous,
      route,
      limit,
      asOfCommitSeq,
      today,
      anchor,
      timeline,
      ...opts
    } = options;
    const rewrite = await this.rewrite(
      {
        question,
        run: true,
        context,
        previous,
        route,
        limit,
        as_of_commit_seq: asOfCommitSeq,
        today,
        anchor: anchor?.length ? anchor : undefined,
        timeline: timeline?.length ? timeline : undefined,
      },
      opts,
    );
    const parsed = rewrite.result
      ? parseSparqlResults(rewrite.result)
      : undefined;
    return {
      route: rewrite.route,
      query: rewrite.query ?? null,
      rationale: rewrite.rationale,
      rows: parsed?.rows ?? [],
      vars: parsed?.vars ?? [],
      boolean: parsed?.boolean ?? null,
      snapshot: parsed?.snapshot ?? null,
      error: rewrite.error ?? null,
      traceId: rewrite.result?.trace_id ?? null,
      linked: rewrite.linked ?? [],
      anchors: rewrite.anchors ?? [],
      history: rewrite.history ?? null,
      rewrite,
    };
  }

  /**
   * The graph's rewrite profile (`GET /v1/query/rewrite/profile`): the notes
   * and worked examples the rewriter reads for every question of the graph.
   * `version` is 0 when the graph has none.
   */
  rewriteProfile(
    opts: CallOptions = {},
  ): Promise<Schemas["QueryRewriteProfile"]> {
    return this.client.request("GET", "/v1/query/rewrite/profile", opts);
  }

  /**
   * Store the graph's rewrite profile (`PUT /v1/query/rewrite/profile`):
   * `notes` (at most 8,000 characters) and up to 20 `examples`, each a
   * question and the `SELECT` or `ASK` query that answers it. The server
   * parses each query. Pass the `version` you read as `expected_version`:
   * when another write came first, the call throws `409 conflict` and
   * stores nothing. `dryRun` checks the profile and stores nothing. Empty
   * notes and no examples clear it. The rewriter reads the profile for every
   * question; a call's `context` still adds notes.
   */
  setRewriteProfile(
    body: Schemas["QueryRewriteProfileRequest"],
    opts: CallOptions & { dryRun?: boolean } = {},
  ): Promise<Schemas["QueryRewriteProfile"]> {
    return this.client.request("PUT", "/v1/query/rewrite/profile", {
      ...opts,
      query: { dry_run: opts.dryRun },
      body,
    });
  }

  structured(
    body: Schemas["SparqlSelectRequest"],
    opts: CallOptions & ReadConsistencyOptions = {},
  ): Promise<Schemas["SparqlSelectResponse"]> {
    return this.client.request("POST", "/v1/query/sparql", {
      ...opts,
      retry: opts.retry ?? true,
      body: profileBody(withReadConsistency(this.client, body, opts)),
    });
  }

  /**
   * Run a SPARQL text query and parse its rows. `profile: true` (in `opts` or
   * the body) returns the server's measurements in `profile`; a profiled
   * request never uses the result cache.
   */
  async sparql(
    body: Schemas["SparqlTextRequest"],
    opts: CallOptions & ReadConsistencyOptions & ProfileOption = {},
  ) {
    // The text dialect carries consistency/floor on the URL, not the body.
    const response = await this.client.request<Schemas["SparqlTextResponse"]>(
      "POST",
      "/v1/query/sparql-text",
      {
        ...opts,
        retry: opts.retry ?? true,
        body: withProfile(body, opts),
        query: {
          consistency: opts.consistency ?? this.client.defaultConsistency,
          min_indexed_seq: opts.minIndexedSeq,
        },
      },
    );
    return parseSparqlResults(response);
  }

  /** As {@link sparql}, returning the raw response with its `results` string. */
  sparqlRaw(
    body: Schemas["SparqlTextRequest"],
    opts: CallOptions & ReadConsistencyOptions & ProfileOption = {},
  ): Promise<Schemas["SparqlTextResponse"]> {
    return this.client.request("POST", "/v1/query/sparql-text", {
      ...opts,
      retry: opts.retry ?? true,
      body: withProfile(body, opts),
      query: {
        consistency: opts.consistency ?? this.client.defaultConsistency,
        min_indexed_seq: opts.minIndexedSeq,
      },
    });
  }

  /**
   * Run a SPARQL 1.1 Update on the native `/update` endpoint. The server
   * accepts `INSERT DATA` and answers every other form with 400; one request
   * is one commit. A graph whose first write comes through this route is
   * RDF-native, and an RDF-native graph refuses the JSON write routes with
   * `400 rdf_native_graph`. Under `reject`-mode SHACL shapes, a write that
   * breaks them fails with 400 and writes nothing.
   *
   * The client sends an idempotency key (a new one per call unless you pass
   * `idempotencyKey`), so a retry replays the write. The answer has no body:
   * read the write back with a `strong` read.
   */
  async update(update: string, opts: CallOptions = {}): Promise<void> {
    await this.client.request<void>("POST", "/update", {
      ...opts,
      idempotencyKey:
        opts.idempotencyKey ?? this.client.idempotencyKey("sparql-update"),
      rawBody: update,
      contentType: "application/sparql-update",
    });
  }
}
