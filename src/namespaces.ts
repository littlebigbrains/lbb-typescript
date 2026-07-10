import type { LbbClient } from "./client.js";
import type { CallOptions } from "./transport.js";
import {
  attributeFilter,
  firstPatternVariable,
  type EntityAttributeFilterOptions,
  type ImportLine,
  type ListResponse,
  parseSparqlResults,
  type RdfExportOptions,
  type RdfImportOptions,
  type Schemas,
} from "./types.js";

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
  source?: string;
  consistency?: string;
  lexical?: boolean;
  bm25?: boolean;
  vector?: boolean;
  targets?: string[];
  profile?: string;
  /** Valid-time cursor (RFC 3339): results reflect facts true at this instant. */
  asOf?: string;
  /** Snapshot pin: results reproduce the graph as of this commit sequence. */
  asOfCommitSeq?: number;
  /** Opt-in impression logging for later relevance feedback. */
  logImpression?: boolean;
}

export class GraphNamespace {
  readonly facts: FactsNamespace;
  readonly context: ContextNamespace;
  readonly entities: EntityNamespace;
  readonly indexes: IndexNamespace;
  readonly ontology: OntologyNamespace;
  readonly query: QueryNamespace;
  readonly schema: SchemaNamespace;
  readonly search: SearchNamespace;

  constructor(private readonly client: LbbClient) {
    this.facts = new FactsNamespace(client);
    this.context = client.context;
    this.entities = client.entities;
    this.indexes = client.indexes;
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

  delete(opts: { confirm: string } & CallOptions): Promise<unknown> {
    const { confirm, ...request } = opts;
    return this.client.request("POST", "/v1/graph/delete", {
      ...request,
      query: { confirm },
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

  /** Export this graph's current snapshot as Turtle, N-Triples, TriG, or N-Quads. */
  exportRdf(opts: RdfExportOptions = {}): Promise<string> {
    return this.client.exportRdf(opts);
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
      index?: boolean;
      idempotencyKey?: string;
    } = {},
  ): Promise<Schemas["GraphImportResponse"]> {
    const { batch, strict, observedAt, index, ...request } = opts;
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
      query: { batch, strict, observed_at: observedAt, index },
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
      return this.client.request("POST", "/v1/graph/search", {
        ...transportOptions(opts),
        retry: opts.retry ?? true,
        body: input,
      });
    }
    return this.client.request("GET", "/v1/search", {
      ...transportOptions(opts),
      query: {
        query: input,
        top_k: opts.topK,
        source: opts.source,
        consistency: opts.consistency,
        lexical: opts.lexical,
        bm25: opts.bm25,
        vector: opts.vector,
        targets: opts.targets?.join(","),
        profile: opts.profile,
        as_of: opts.asOf,
        as_of_commit_seq: opts.asOfCommitSeq,
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

  fullText(
    body: Schemas["FullTextSearchRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["FullTextSearchResponse"]> {
    return this.client.request("POST", "/v1/search/full-text", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }

  vector(
    body: Schemas["EmbeddingSearchRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["EmbeddingSearchResponse"]> {
    return this.client.request("POST", "/v1/search/embedding", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }
}

export class SchemaNamespace {
  constructor(private readonly client: LbbClient) {}

  /** Active graph schema bundle: ontology plus activated SHACL shapes. */
  view(
    opts: { audit?: boolean } & CallOptions = {},
  ): Promise<Schemas["SchemaBundleView"]> {
    const { audit, ...request } = opts;
    return this.client.request("GET", "/v1/schema", {
      ...request,
      query: { audit: audit || undefined },
    });
  }

  /** Preview a proposed RDF/SHACL schema bundle and audit current data. */
  preview(
    body: Schemas["SchemaPreviewRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["SchemaPreviewResponse"]> {
    return this.client.request("POST", "/v1/schema/preview", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }

  /** Activate a previewed SHACL schema bundle for this graph branch. */
  publish(
    body: Schemas["SchemaPublishRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["SchemaPublishResponse"]> {
    return this.client.request("POST", "/v1/schema/publish", { ...opts, body });
  }

  /** Audit current data against the active SHACL schema bundle. */
  audit(opts: CallOptions = {}): Promise<Schemas["SchemaAuditReport"]> {
    return this.client.request("POST", "/v1/schema/audit", {
      ...opts,
      retry: opts.retry ?? true,
    });
  }
}

export class IndexNamespace {
  constructor(private readonly client: LbbClient) {}

  run(
    opts: {
      wait?: boolean;
      background?: boolean;
      body?: unknown;
    } & CallOptions = {},
  ): Promise<unknown> {
    const { wait, background: requestedBackground, body, ...request } = opts;
    const background =
      requestedBackground ?? (wait === false ? true : undefined);
    return this.client.request("POST", "/v1/index/run", {
      ...request,
      query: { background },
      body,
    });
  }

  build(opts: { background?: boolean } & CallOptions = {}): Promise<unknown> {
    const { background, ...request } = opts;
    return this.client.request("POST", "/v1/index/build", {
      ...request,
      query: { background: background || undefined },
    });
  }

  delta(opts: CallOptions = {}): Promise<Schemas["IndexDeltaResponse"]> {
    return this.client.request("POST", "/v1/index/delta", opts);
  }

  gc(
    opts: { keepRuns?: number; dryRun?: boolean } & CallOptions = {},
  ): Promise<Schemas["IndexGcResponse"]> {
    const { keepRuns, dryRun, ...request } = opts;
    return this.client.request("POST", "/v1/index/gc", {
      ...request,
      query: { keep_runs: keepRuns, dry_run: dryRun },
    });
  }
}

export class EntityNamespace {
  constructor(private readonly client: LbbClient) {}

  /**
   * Browse entities as the unified list envelope. Pass `fields` (names or `*`)
   * to inline each row's typed attributes as native JSON (under `attributes`) —
   * "list entities and their titles" in one call instead of a list plus N point
   * lookups — or `ids`
   * to fetch a specific set. Page with `cursor` from the previous `next_cursor`.
   */
  list(
    opts: EntityListOptions = {},
  ): Promise<ListResponse<Schemas["EntityExplorerRow"]>> {
    const csv = (v: string | string[] | undefined) =>
      Array.isArray(v) ? v.join(",") : v;
    return this.client.request("GET", "/v1/graph/entities", {
      ...transportOptions(opts),
      query: {
        type: opts.type,
        limit: opts.limit,
        cursor: opts.cursor,
        offset: opts.offset,
        q: opts.query,
        fields: csv(opts.fields),
        ids: csv(opts.ids),
      },
    });
  }

  /** Yield list envelopes while following `next_cursor` until exhaustion. */
  async *pages(
    opts: EntityListOptions = {},
  ): AsyncGenerator<ListResponse<Schemas["EntityExplorerRow"]>> {
    let cursor = opts.cursor;
    const seen = new Set<string>();
    do {
      const page = await this.list({
        ...opts,
        cursor,
        offset: cursor === undefined ? opts.offset : undefined,
      });
      yield page;
      if (!page.has_more || page.next_cursor === null) return;
      if (seen.has(page.next_cursor)) {
        throw new Error(
          `entity pagination cursor repeated: ${page.next_cursor}`,
        );
      }
      seen.add(page.next_cursor);
      cursor = page.next_cursor;
    } while (true);
  }

  /** Yield entities directly while following the server's stable cursor. */
  async *iterate(
    opts: EntityListOptions = {},
  ): AsyncGenerator<Schemas["EntityExplorerRow"]> {
    for await (const page of this.pages(opts)) {
      for (const entity of page.data) yield entity;
    }
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
      as_of_valid_time: opts.asOfValidTime,
      as_of_commit_seq: opts.asOfCommitSeq,
      order_by: opts.orderBy,
      reason: opts.reason,
      max_solutions: opts.maxSolutions,
      max_object_reads: opts.maxObjectReads,
      max_fetched_bytes: opts.maxFetchedBytes,
    });
  }
}

export interface EntityListOptions extends CallOptions {
  type?: string;
  limit?: number;
  cursor?: string | number;
  /** @deprecated Legacy alias for `cursor`. */
  offset?: number;
  query?: string;
  /** Property names to inline per row (or `"*"` / `["*"]` for all). */
  fields?: string | string[];
  /** Specific entity ids to fetch in one call (bulk lookup). */
  ids?: string | string[];
}

/** Grounding and answer operations over the graph's real vocabulary. */
export class ContextNamespace {
  constructor(private readonly client: LbbClient) {}

  ask(
    body: Schemas["AskRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["AskResponse"]> {
    return this.client.request("POST", "/v1/ask", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }

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

  conformance(opts: CallOptions = {}): Promise<Schemas["SchemaAuditReport"]> {
    return this.client.request("GET", "/v1/ontology/conformance", opts);
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
}

/** Structured, SPARQL-text, reasoning, and analytical query operations. */
export class QueryNamespace {
  constructor(private readonly client: LbbClient) {}

  structured(
    body: Schemas["SparqlSelectRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["SparqlSelectResponse"]> {
    return this.client.request("POST", "/v1/query/sparql", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }

  async sparql(body: Schemas["SparqlTextRequest"], opts: CallOptions = {}) {
    const response = await this.client.request<Schemas["SparqlTextResponse"]>(
      "POST",
      "/v1/query/sparql-text",
      { ...opts, retry: opts.retry ?? true, body },
    );
    return parseSparqlResults(response);
  }

  sparqlRaw(
    body: Schemas["SparqlTextRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["SparqlTextResponse"]> {
    return this.client.request("POST", "/v1/query/sparql-text", {
      ...opts,
      retry: opts.retry ?? true,
      body,
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

  shacl(
    body: Schemas["ShaclQueryRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["ShaclQueryResponse"]> {
    return this.client.request("POST", "/v1/query/shacl", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }

  infer(
    body: Schemas["InferenceRunRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["InferenceRunResponse"]> {
    return this.client.request("POST", "/v1/inference/run", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }

  premises(
    body: Schemas["RetrievalPremiseRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["RetrievalPremiseResponse"]> {
    return this.client.request("POST", "/v1/inference/retrieval-premises", {
      ...opts,
      retry: opts.retry ?? true,
      body,
    });
  }
}
