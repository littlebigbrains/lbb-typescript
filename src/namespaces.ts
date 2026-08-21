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

// SPARQL is the only query surface. The search, embedding, decode,
// groundability, and analytics operations were removed with their routes.

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

  constructor(private readonly client: LbbClient) {
    this.facts = new FactsNamespace(client);
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
}

/**
 * Relevance-label storage. The query surfaces this namespace once fronted were
 * removed with their routes; SPARQL is the only query path now.
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

  /**
   * Return the exact type cardinality and a bounded deterministic sample from
   * the Base family pinned by the published generation.
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
