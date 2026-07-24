import type { LbbClient } from "./client.js";
import type { CallOptions } from "./transport.js";
import {
  attributeFilter,
  firstPatternVariable,
  type EntityAttributeFilterOptions,
  type ImportLine,
  parseSparqlResults,
  type ReadConsistencyOptions,
  type RdfImportOptions,
  type Schemas,
} from "./types.js";

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

function transportOptions(options: CallOptions): CallOptions {
  return {
    idempotencyKey: options.idempotencyKey,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    retry: options.retry,
    signal: options.signal,
    headers: options.headers,
  };
}

export interface HybridSearchOptions extends CallOptions {
  topK?: number;
  consistency?: string;
  /** A5 read-your-writes floor (`min_indexed_seq`): the committed sequence a
   * write returned; under eventual, an uncovered floor yields a retryable
   * `read_your_writes_pending` 429. */
  minIndexedSeq?: number;
  lexical?: boolean;
  bm25?: boolean;
  vector?: boolean;
  targets?: string[];
  profile?: string;
  /** Opt-in impression logging for later relevance feedback. */
  logImpression?: boolean;
}

export class GraphNamespace {
  readonly facts: FactsNamespace;
  readonly context: ContextNamespace;
  readonly entities: EntityNamespace;
  readonly ontology: OntologyNamespace;
  readonly query: QueryNamespace;
  readonly schema: SchemaNamespace;
  readonly search: SearchNamespace;

  constructor(private readonly client: LbbClient) {
    this.facts = new FactsNamespace(client);
    this.context = client.context;
    this.entities = client.entities;
    this.ontology = client.ontology;
    this.query = client.query;
    this.schema = client.schema;
    this.search = client.search;
  }

  branch(name: string): GraphNamespace {
    return new GraphNamespace(this.client.withScope({ branch: name }));
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

  deleteBranch(
    opts: { confirm: string } & CallOptions,
  ): Promise<Schemas["GraphBranchDeleteResponse"]> {
    const { confirm, ...request } = opts;
    return this.client.request("DELETE", "/v1/graph/branch", {
      ...request,
      query: { confirm },
    });
  }

  embeddingConfig(
    opts: CallOptions = {},
  ): Promise<Schemas["ManagedEmbeddingConfigResponse"]> {
    return this.client.request("GET", "/v1/graph/embedding", opts);
  }

  /** List the embedding models available on this deployment. */
  embeddingModels(
    opts: CallOptions = {},
  ): Promise<Schemas["ManagedEmbeddingModelsResponse"]> {
    return this.client.request("GET", "/v1/graph/embedding/models", opts);
  }

  /** Choose the model used automatically for writes and vector queries. */
  setEmbeddingModel(
    modelId: string,
    options: CallOptions & { autoEmbedQuery?: boolean } = {},
  ): Promise<Schemas["ManagedEmbeddingConfigResponse"]> {
    const { autoEmbedQuery, ...request } = options;
    return this.client.request("POST", "/v1/graph/embedding", {
      ...request,
      body: {
        model_id: modelId,
        service: "open_router",
        auto_embed_query: autoEmbedQuery ?? true,
      },
    });
  }

  /** Advanced configuration escape hatch. Prefer `setEmbeddingModel`. */
  setEmbeddingConfig(
    body: Schemas["ManagedEmbeddingConfigRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["ManagedEmbeddingConfigResponse"]> {
    return this.client.request("POST", "/v1/graph/embedding", {
      ...opts,
      body,
    });
  }

  backfillEmbeddings(
    options: CallOptions & {
      batchSize?: number;
      limit?: number;
      full?: boolean;
      pollIntervalMs?: number;
    } = {},
  ): Promise<Schemas["ManagedEmbeddingBackfillResponse"]> {
    return this.client.backfillEmbeddings({
      batchSize: options.batchSize,
      limit: options.limit,
      full: options.full,
      idempotencyKey: options.idempotencyKey,
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
    });
  }

  submitEmbeddingBackfill(
    options: CallOptions & {
      batchSize?: number;
      limit?: number;
      full?: boolean;
    } = {},
  ): Promise<Schemas["ManagedEmbeddingBackfillJobStatusResponse"]> {
    return this.client.submitEmbeddingBackfill({
      batchSize: options.batchSize,
      limit: options.limit,
      full: options.full,
      idempotencyKey: options.idempotencyKey,
    });
  }

  embeddingBackfillJob(
    jobId: string,
  ): Promise<Schemas["ManagedEmbeddingBackfillJobStatusResponse"]> {
    return this.client.embeddingBackfillJob(jobId);
  }

  cancelEmbeddingBackfill(
    jobId: string,
  ): Promise<Schemas["ManagedEmbeddingBackfillJobStatusResponse"]> {
    return this.client.cancelEmbeddingBackfill(jobId);
  }

  promoteEmbedding(
    options: CallOptions & { runId: string; allowRegression?: boolean },
  ): Promise<Schemas["ManagedEmbeddingPromoteResponse"]> {
    const { runId, allowRegression, ...request } = options;
    return this.client.request("POST", "/v1/graph/embedding/promote", {
      ...request,
      query: { run_id: runId, allow_regression: allowRegression },
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
      publish?: boolean;
      idempotencyKey?: string;
    } = {},
  ): Promise<Schemas["GraphImportResponse"]> {
    const { batch, strict, observedAt, publish, ...request } = opts;
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
      query: { batch, strict, observed_at: observedAt, publish },
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
      publish,
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
        publish,
      },
    });
  }
}

export class SearchNamespace {
  constructor(private readonly client: LbbClient) {}

  hybrid(
    query: string,
    opts?: HybridSearchOptions,
  ): Promise<Schemas["SemanticGraphSearchResponse"]>;
  hybrid(
    body: Schemas["SemanticGraphSearchRequest"],
    opts?: CallOptions,
  ): Promise<Schemas["SemanticGraphSearchResponse"]>;
  hybrid(
    input: string | Schemas["SemanticGraphSearchRequest"],
    opts: HybridSearchOptions = {},
  ): Promise<Schemas["SemanticGraphSearchResponse"]> {
    if (typeof input !== "string") {
      const search = withReadConsistency(this.client, input.search ?? {}, {
        consistency: opts.consistency as ReadConsistencyOptions["consistency"],
        minIndexedSeq: opts.minIndexedSeq,
      });
      return this.client.request("POST", "/v1/graph/search", {
        ...transportOptions(opts),
        retry: opts.retry ?? true,
        body: { ...input, search },
      });
    }
    return this.client.request("GET", "/v1/search", {
      ...transportOptions(opts),
      query: {
        query: input,
        top_k: opts.topK,
        consistency: opts.consistency ?? this.client.defaultConsistency,
        min_indexed_seq: opts.minIndexedSeq,
        lexical: opts.lexical,
        bm25: opts.bm25,
        vector: opts.vector,
        targets: opts.targets?.join(","),
        profile: opts.profile,
        log_impression: opts.logImpression,
      },
    });
  }

  multi(
    body: Schemas["HybridMultiSearchRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["HybridMultiSearchResponse"]> {
    return this.client.request("POST", "/v1/search/multi", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }

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

  fullText(
    body: Schemas["FullTextSearchRequest"],
    opts: CallOptions & ReadConsistencyOptions = {},
  ): Promise<Schemas["FullTextSearchResponse"]> {
    return this.client.request("POST", "/v1/search/full-text", {
      ...opts,
      retry: opts.retry ?? true,
      body: withReadConsistency(this.client, body, opts),
    });
  }

  vector(
    body: Schemas["EmbeddingSearchRequest"],
    opts: CallOptions & ReadConsistencyOptions = {},
  ): Promise<Schemas["EmbeddingSearchResponse"]> {
    return this.client.request("POST", "/v1/search/embedding", {
      ...opts,
      retry: opts.retry ?? true,
      body: withReadConsistency(this.client, body, opts),
    });
  }
}

export class EntityNamespace {
  constructor(private readonly client: LbbClient) {}

  /**
   * Return the exact type cardinality and a bounded deterministic sample from
   * the ranged adjacency family pinned by the published generation. A missing
   * family fails closed rather than falling back to an exhaustive scan.
   */
  sample(
    opts: { type: string; limit?: number } & CallOptions,
  ): Promise<Schemas["EntityTypeSampleResponse"]> {
    return this.client.entityTypeSample(opts);
  }

  get(opts: {
    id?: string;
    type?: string;
    name?: string;
    asOf?: string;
  }): Promise<Schemas["EntityMetadataResponse"]> {
    return this.client.entityMetadata(opts);
  }

  detail(opts: {
    id?: string;
    type?: string;
    name?: string;
  }): Promise<Schemas["EntityDetailResponse"]> {
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

/** Grounding operations over one pinned published vocabulary. */
export class ContextNamespace {
  constructor(private readonly client: LbbClient) {}

  suggest(
    body: Schemas["SearchSuggestRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["SearchSuggestResponse"]> {
    return this.client.request("POST", "/v1/search/suggest", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }

  resolve(
    body: Schemas["ResolveTermRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["ResolveTermResponse"]> {
    return this.client.request("POST", "/v1/search/resolve-term", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }

  decode(
    body: Schemas["DecodeRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["DecodeResponse"]> {
    return this.client.request("POST", "/v1/decode", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }

  groundability(
    options: { sample?: number } & CallOptions = {},
  ): Promise<Schemas["GroundabilityReport"]> {
    const { sample, ...request } = options;
    return this.client.request("GET", "/v1/graph/groundability", {
      ...request,
      query: sample === undefined ? undefined : { sample },
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
    opts: CallOptions = {},
  ): Promise<Schemas["SchemaPublishResponse"]> {
    return this.client.request("POST", "/v1/schema/publish", {
      ...opts,
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
    opts: CallOptions = {},
  ): Promise<Schemas["OntologyEvolveResponse"]> {
    return this.client.request("POST", "/v1/ontology/evolve", {
      ...opts,
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

/** Structured, SPARQL-text, and analytical query operations. */
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

  analytics(
    body: Schemas["AnalyticQueryRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["AnalyticQueryResponse"]> {
    return this.client.request("POST", "/v1/query/analytics", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }
}
