// The record writes on a graph that stores RDF.
//
// Every new graph is RDF-native. The server refuses the two record routes
// there with `400 rdf_native_graph`: a commit without `replace_owned`, and a
// retract of whole entities. The client sends the same facts in the form the
// graph accepts, so `commit`, `commitDryRun`, `facts.create` and `retract`
// work on both kinds of graph. The rules, in one place:
//
// - A commit becomes an owned commit that owns nothing: `replace_owned` with
//   one subject and no relations or properties. The commit removes no link or
//   field that it does not name. It replaces only what a commit on a graph of
//   records replaces too: the other values of a field it sets (whoever wrote
//   them), the label of a record it names, the target of a relation that keeps
//   one target, and, with `property_merge: "replace"`, the other fields of the
//   records it names. A record left with no field and no link by such a
//   replacement loses its type and label. History stays readable. The one
//   subject only selects the route.
// - Confidence and valid time live on a link's evidence. A link without
//   evidence would lose them, so such a commit is refused before it is sent.
// - A retract of entities becomes `replace_owned.retract_entities`, only when
//   the caller asks for `purge_entity_properties`. That removes the whole
//   record, so it is never done silently.
// - What the graph cannot take stays refused, with a message that names what
//   to do instead: client-computed vectors (`entity_embeddings`) and
//   `preconditions`.
import { LbbError } from "./transport.js";
import type { Schemas } from "./types.js";

export const RDF_NATIVE_GRAPH_CODE = "rdf_native_graph";

const DOC_URL = "https://docs.littlebigbrain.com/sdks/errors/#rdf_native_graph";

/** The sentinel that makes a `key` address a record by its entity id. */
const ENTITY_ID_KEY_SENTINEL = "\u0000lbb-eid:";

const EMBEDDINGS_MESSAGE =
  "entity_embeddings are not accepted on this graph. A new graph stores RDF statements, " +
  "and the platform embeds text with a managed model, so a caller cannot write its own " +
  "vectors. Declare an embedding on a class (embeddings.declare, POST /v1/embeddings). " +
  "Then search with POST /v1/search or a SPARQL search:similarTo pattern. " +
  "Nothing was written.";

const PRECONDITIONS_MESSAGE =
  "preconditions are not accepted on this graph. A new graph stores RDF statements, " +
  "and its commits do not check a head sequence, an ontology version or a snapshot token. " +
  "Send the commit without preconditions. Nothing was written.";

const EMPTY_MESSAGE =
  "this commit has no triplet and no entity_properties row to write on this graph. " +
  "Nothing was written.";

const ENTITY_RETRACT_MESSAGE =
  "retract of entities needs purge_entity_properties: true on this graph. A new graph " +
  "stores RDF statements, so a record has no state of links only: retracting it removes " +
  "all of its statements (links, field values, type and label). A record that is left " +
  "with no link and no field because of it loses its type and label too. History stays " +
  "readable with as_of_commit_seq. Set purge_entity_properties to remove whole records, " +
  "or retract exact links with edges. Nothing was removed.";

/** Entities one `replace_owned` names at most (the server's limit). */
export const MAX_RETRACT_ENTITIES = 1000;

const TOO_MANY_ENTITIES_MESSAGE =
  `retract of entities names more than ${MAX_RETRACT_ENTITIES} records. On this graph the ` +
  `records go in one commit, which takes at most ${MAX_RETRACT_ENTITIES}. Retract them in ` +
  "batches of that size. Nothing was removed.";

const IMPORT_JOB_MESSAGE =
  "an NDJSON import job is not available on this graph. A new graph stores RDF " +
  "statements, and an import job commits JSON records, so it would fail at its first " +
  "commit. Load RDF with importRdf (POST /v1/graph/import/rdf), or add records with " +
  "commit, which adds facts on this graph. Nothing was uploaded.";

/**
 * A commit that no graph can accept, sent as a dry run to learn the kind of
 * graph. A graph that stores RDF refuses it with `rdf_native_graph` before it
 * reads the ontology; a graph of records answers that the type is unknown.
 * Nothing is written either way.
 */
export const PROBE_BODY: Schemas["TripletCommitFile"] = {
  triplets: [
    {
      source: { type: "Probe", name: "probe" },
      relation: "PROBE",
      target: { type: "Probe", name: "probe" },
    },
  ],
};

/** The refusal of an NDJSON import job by a graph that stores RDF. */
export function importJobRefusal(): LbbError {
  return rdfNativeError(IMPORT_JOB_MESSAGE);
}

/** Whether `error` is the refusal of a record route by an RDF-native graph. */
export function isRdfNativeRefusal(error: unknown): error is LbbError {
  return error instanceof LbbError && error.code === RDF_NATIVE_GRAPH_CODE;
}

/**
 * A refusal the client raises itself, in the shape the server sends. When it
 * follows a server refusal (`cause`), the request id of that refusal is kept.
 */
export function rdfNativeError(message: string, cause?: LbbError): LbbError {
  const payload = {
    type: "invalid_request_error",
    code: RDF_NATIVE_GRAPH_CODE,
    message,
    param: null,
    request_id: cause?.requestId ?? null,
    doc_url: DOC_URL,
  };
  return new LbbError(400, JSON.stringify({ error: payload }), payload);
}

/** The record the first fact of a commit is about. */
function firstSubject(
  body: Schemas["TripletCommitFile"],
): Schemas["NamedEntityInput"] | undefined {
  const triplet = body.triplets?.[0];
  if (triplet) return triplet.source;
  const row = body.entity_properties?.[0];
  if (!row) return undefined;
  const key =
    row.entity_id !== undefined && row.entity_id !== null
      ? `${ENTITY_ID_KEY_SENTINEL}${row.entity_id}`
      : row.key;
  return {
    type: row.type,
    name: row.name,
    ...(key !== undefined && key !== null ? { key } : {}),
  };
}

/**
 * Whether a triplet carries evidence: a string, or an object with a `text`.
 * The server stores nothing of a link's confidence or valid time without it.
 */
function hasEvidence(triplet: Schemas["TripletInput"]): boolean {
  const evidence = triplet.evidence as unknown;
  if (typeof evidence === "string") return true;
  return (
    typeof evidence === "object" &&
    evidence !== null &&
    typeof (evidence as { text?: unknown }).text === "string"
  );
}

/** What a triplet without evidence would lose, as words; empty when nothing. */
function lostWithoutEvidence(
  triplet: Schemas["TripletInput"],
  observedAt: boolean,
): string[] {
  const lost: string[] = [];
  if (
    triplet.confidence !== undefined &&
    triplet.confidence !== null &&
    triplet.confidence !== 1
  )
    lost.push("confidence");
  const valid = triplet.valid_time as
    Record<string, unknown> | null | undefined;
  const hasValidTime =
    !!valid &&
    Object.values(valid).some((value) => value !== undefined && value !== null);
  if (hasValidTime) lost.push("valid_time");
  else if (observedAt) lost.push("the valid-time start from observed_at");
  return lost;
}

/**
 * The words of the refusal when some link would lose its confidence or valid
 * time, else undefined. Only a link with evidence keeps them on this graph.
 */
function droppedFieldsMessage(
  body: Schemas["TripletCommitFile"],
): string | undefined {
  const observedAt = !!body.observed_at?.trim();
  const offenders: string[] = [];
  let count = 0;
  for (const [index, triplet] of (body.triplets ?? []).entries()) {
    if (hasEvidence(triplet)) continue;
    const lost = lostWithoutEvidence(triplet, observedAt);
    if (!lost.length) continue;
    count += 1;
    if (offenders.length < 3)
      offenders.push(
        `triplets[${index}] (${triplet.source.type} "${triplet.source.name}" ${triplet.relation} ${triplet.target.type} "${triplet.target.name}": ${lost.join(", ")})`,
      );
  }
  if (!count) return undefined;
  return (
    `${count} link${count === 1 ? "" : "s"} of this commit carry confidence or valid time and no evidence, ` +
    "and this graph would store none of it. A graph that stores RDF statements keeps " +
    "confidence and valid time on the evidence of a link (the observed_at start too). " +
    "Put the reason for each link in evidence, or leave confidence and valid time out. " +
    `First: ${offenders.join("; ")}. Nothing was written.`
  );
}

/**
 * Why the commit `body` cannot go to an RDF-native graph, as words; undefined
 * when it can. The client sends nothing for such a body.
 */
export function ownedFormRefusal(
  body: Schemas["TripletCommitFile"],
): string | undefined {
  if (body.entity_embeddings?.length) return EMBEDDINGS_MESSAGE;
  if (body.preconditions) return PRECONDITIONS_MESSAGE;
  if (!firstSubject(body)) return EMPTY_MESSAGE;
  return droppedFieldsMessage(body);
}

/**
 * The commit `body` in the form an RDF-native graph accepts: the same facts
 * with a `replace_owned` that owns nothing. Throws the refusal for what the
 * graph cannot take, before anything is sent.
 */
export function ownedFormOfCommit(
  body: Schemas["TripletCommitFile"],
  cause?: LbbError,
): Schemas["TripletCommitFile"] {
  const refusal = ownedFormRefusal(body);
  if (refusal) throw rdfNativeError(refusal, cause);
  return {
    ...body,
    replace_owned: {
      subjects: [firstSubject(body)!],
      relations: [],
      properties: [],
    },
  };
}

/** A retract that removes whole entities from an RDF-native graph. */
export interface NativeRetractPlan {
  /** Exact links to retract through `/v1/graph/retract`. */
  edges: Schemas["RetractEdgeInput"][];
  /** The commit that removes the entities. */
  commit: Schemas["TripletCommitFile"];
}

/**
 * Why the retract `body` cannot go to an RDF-native graph, as words;
 * undefined when it can. Both conditions are known before a request.
 */
export function nativeRetractRefusal(
  body: Schemas["GraphRetractRequest"],
): string | undefined {
  if (!body.purge_entity_properties) return ENTITY_RETRACT_MESSAGE;
  if ((body.entities?.length ?? 0) > MAX_RETRACT_ENTITIES)
    return TOO_MANY_ENTITIES_MESSAGE;
  return undefined;
}

/** Plan the retract `body` for an RDF-native graph, or throw its refusal. */
export function nativeRetractPlan(
  body: Schemas["GraphRetractRequest"],
  cause?: LbbError,
): NativeRetractPlan {
  const refusal = nativeRetractRefusal(body);
  if (refusal) throw rdfNativeError(refusal, cause);
  return {
    edges: body.edges ?? [],
    commit: {
      replace_owned: {
        subjects: [],
        relations: [],
        properties: [],
        retract_entities: body.entities ?? [],
      },
    },
  };
}

/** The retract response for a plan: the edges' answer and the commit's. */
export function nativeRetractResponse(
  edges: Schemas["GraphRetractResponse"] | undefined,
  committed: Schemas["GraphCommitResponse"],
): Schemas["GraphRetractResponse"] {
  const owned = committed.owned ?? undefined;
  const removed = owned?.entities_retracted ?? 0;
  const edgeIds = edges?.edge_event_ids ?? [];
  return {
    commit_seq: committed.commit_seq,
    visibility_token: committed.visibility_token,
    retracted_edges:
      (edges?.retracted_edges ?? 0) + (owned?.edges_retracted ?? 0),
    retracted_entities: removed,
    purged_entities: removed,
    ...(edgeIds.length ? { edge_event_ids: edgeIds } : {}),
    ...(committed.no_op && (edges === undefined || edges.no_op)
      ? { no_op: true }
      : {}),
    ...(committed.replayed && (edges === undefined || edges.idempotent_replay)
      ? { idempotent_replay: true }
      : {}),
  };
}

/** Graph keys known to be RDF-native, shared by a client and its scopes. */
export class NativeGraphs {
  private static readonly LIMIT = 256;
  private readonly graphs = new Set<string>();

  has(key: string): boolean {
    return this.graphs.has(key);
  }

  delete(key: string): void {
    this.graphs.delete(key);
  }

  add(key: string): void {
    if (this.graphs.size >= NativeGraphs.LIMIT) {
      const oldest = this.graphs.values().next().value;
      if (oldest !== undefined) this.graphs.delete(oldest);
    }
    this.graphs.add(key);
  }
}
