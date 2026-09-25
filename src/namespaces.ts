import type { LbbClient } from "./client.js";
import type { CallOptions } from "./transport.js";
import {
  attributeFilter,
  firstPatternVariable,
  type EntityAttributeFilterOptions,
  type ImportLine,
  parseSparqlResults,
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

export class GraphNamespace {
  readonly facts: FactsNamespace;
  readonly entities: EntityNamespace;
  readonly ontology: OntologyNamespace;
  readonly query: QueryNamespace;
  readonly schema: SchemaNamespace;
  readonly search: SearchNamespace;
  readonly evals: EvalsNamespace;
  readonly embeddings: EmbeddingsNamespace;

  constructor(private readonly client: LbbClient) {
    this.facts = new FactsNamespace(client);
    this.entities = client.entities;
    this.ontology = client.ontology;
    this.query = client.query;
    this.schema = client.schema;
    this.search = client.search;
    this.evals = client.evals;
    this.embeddings = client.embeddings;
  }

  /** Publication lifecycle for this graph, including pre-first-publish state. */
  publicationStatus(): Promise<Schemas["PublicationStatusResponse"]> {
    return this.client.publicationStatus();
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
  constructor(private readonly client: LbbClient) {}

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
   * hit; `explain: true` plans without running.
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

/** Ontology discovery and lifecycle operations. */
export class OntologyNamespace {
  constructor(private readonly client: LbbClient) {}

  view(
    options: { counts?: boolean } & CallOptions = {},
  ): Promise<Schemas["OntologyView"]> {
    const { counts, ...request } = options;
    return this.client.request("GET", "/v1/ontology", {
      ...request,
      query: counts ? { counts: true } : undefined,
    });
  }

  conformance(
    opts: CallOptions & Pick<ReadConsistencyOptions, "consistency"> = {},
  ): Promise<Schemas["SchemaAuditReport"]> {
    return this.client.request("GET", "/v1/ontology/conformance", {
      ...opts,
      query: {
        consistency: opts.consistency ?? this.client.defaultConsistency,
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

  induce(
    body: Schemas["OntologyInduceRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyInduceResponse"]> {
    return this.client.request("POST", "/v1/ontology/induce", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }
}

/** Structured and SPARQL-text query operations. */
export class QueryNamespace {
  constructor(private readonly client: LbbClient) {}

  structured(
    body: Schemas["SparqlSelectRequest"],
    opts: CallOptions & ReadConsistencyOptions = {},
  ): Promise<Schemas["SparqlSelectResponse"]> {
    return this.client.request("POST", "/v1/query/sparql", {
      ...opts,
      retry: opts.retry ?? true,
      body: withReadConsistency(this.client, body, opts),
    });
  }

  async sparql(
    body: Schemas["SparqlTextRequest"],
    opts: CallOptions & ReadConsistencyOptions = {},
  ) {
    // The text dialect carries consistency/floor on the URL, not the body.
    const response = await this.client.request<Schemas["SparqlTextResponse"]>(
      "POST",
      "/v1/query/sparql-text",
      {
        ...opts,
        retry: opts.retry ?? true,
        body,
        query: {
          consistency: opts.consistency ?? this.client.defaultConsistency,
          min_indexed_seq: opts.minIndexedSeq,
        },
      },
    );
    return parseSparqlResults(response);
  }

  sparqlRaw(
    body: Schemas["SparqlTextRequest"],
    opts: CallOptions & ReadConsistencyOptions = {},
  ): Promise<Schemas["SparqlTextResponse"]> {
    return this.client.request("POST", "/v1/query/sparql-text", {
      ...opts,
      retry: opts.retry ?? true,
      body,
      query: {
        consistency: opts.consistency ?? this.client.defaultConsistency,
        min_indexed_seq: opts.minIndexedSeq,
      },
    });
  }
}
