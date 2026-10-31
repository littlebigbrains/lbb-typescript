// The agent step's host made from a client: the models, the graph reads, the
// files, the commit and the Review inbox of a worker (`agent.ts`). A
// capture (`captureActivities`) takes this host and swaps the commit for the
// dry run and the Review filing for a kept request.
import type { LbbActivities } from "./activities.js";
import type { AgentFileRecord, AgentHost } from "./agent.js";
import type { LbbClient } from "./client.js";
import type { CallOptions } from "./transport.js";
import { LbbError } from "./transport.js";
import {
  parseSparqlResults,
  type Schemas,
  type SparqlResults,
} from "./types.js";

const FILE_SHA256 = "https://littlebigbrain.com/p/file_sha256";
const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

const call = (signal: AbortSignal | undefined): CallOptions =>
  signal ? { signal } : {};

/** Whether a record is a generated output (it has an `origin`) or has no `Document`. */
const generated = (record: Schemas["FileRecord"]) =>
  Boolean(record.origin) || !record.document;

/**
 * A SPARQL SELECT or ASK with a signal. A read at a commit
 * (`as_of_commit_seq`) is the snapshot the run began at; any other read is
 * strong, so it sees the files and entities the run's own writes made.
 */
async function select(
  client: LbbClient,
  query: string,
  asOfCommitSeq: number | undefined,
  signal: AbortSignal | undefined,
): Promise<SparqlResults> {
  const response = await client.request<Schemas["SparqlTextResponse"]>(
    "POST",
    "/v1/query/sparql-text",
    {
      body:
        asOfCommitSeq !== undefined
          ? { query, as_of_commit_seq: asOfCommitSeq }
          : { query },
      ...(asOfCommitSeq === undefined
        ? { query: { consistency: "strong" } }
        : {}),
      retry: "rate_limited",
      ...call(signal),
    },
  );
  return parseSparqlResults(response);
}

/**
 * The host of an agent step over `client`. `activities` runs the model calls,
 * so their usage adds up for the turn's completion as every activity call's
 * does. `workflow` names the workflow whose `owns` the `ground` check reads
 * when the client holds a stack key; under an execution credential the server
 * takes the workflow from the credential and the body must not name it.
 */
export function lbbAgentHost(
  client: LbbClient,
  activities: LbbActivities,
  options: { workflow?: string; hosted?: boolean } = {},
): AgentHost {
  return {
    reason: (request, reasonOptions) =>
      activities.reason(request, reasonOptions),
    decide: (request, decideOptions) =>
      activities.decide(request, decideOptions),
    ground: (items, groundOptions) =>
      activities.ground(items, {
        ...groundOptions,
        ...(options.workflow && !options.hosted
          ? { workflow: options.workflow }
          : {}),
      }),
    async head() {
      try {
        const meta = await client.metadata();
        const seq = meta.snapshot?.commit_seq;
        return { commitSeq: typeof seq === "number" ? seq : null };
      } catch (error) {
        // A server that cannot say reads at the head.
        if (
          error instanceof LbbError &&
          error.status >= 400 &&
          error.status < 500
        )
          return { commitSeq: null };
        throw error;
      }
    },
    sparql(query, asOfCommitSeq, signal) {
      return select(client, query, asOfCommitSeq, signal);
    },
    async documentSha(iri, signal) {
      if (!/^[^\s<>"{}|\\^`]+$/.test(iri)) return undefined;
      const answer = await select(
        client,
        `SELECT ?sha WHERE { <${iri}> <${FILE_SHA256}> ?sha } LIMIT 1`,
        undefined,
        signal,
      );
      return answer.rows[0]?.sha;
    },
    async fileRecord(sha256, signal): Promise<AgentFileRecord> {
      const record = await client.files.get(sha256, call(signal));
      return {
        sha256: record.sha256,
        uploadedAt: record.uploaded_at,
        contentType: record.content_type,
        ...(record.document ? { document: record.document } : {}),
        generated: generated(record),
      };
    },
    fileBytes(sha256, range, signal) {
      // A byte range includes its end; ours excludes it.
      return client.files.content(sha256, {
        ...call(signal),
        range: { start: range.start, end: range.end - 1 },
      });
    },
    async filePages(sha256, from, to, signal) {
      const read = await client.files.pages(sha256, {
        ...call(signal),
        from,
        to,
      });
      return {
        pageCount: read.page_count,
        pages: read.pages.map((page) => ({
          text: page.lines.map((line) => line.text).join("\n"),
        })),
      };
    },
    async describe(iris, signal) {
      const found = new Map<string, { type: string; name: string }>();
      if (!iris.length) return found;
      const ontology = await activities.ontology(call(signal));
      const classes = new Map<string, string>();
      for (const type of ontology.entity_type_defs ?? [])
        if (type.iri) classes.set(type.iri, type.name);
      const values = iris.map((iri) => `<${iri}>`).join(" ");
      const answer = await select(
        client,
        `SELECT ?s ?label ?class WHERE { VALUES ?s { ${values} } ?s <${RDFS_LABEL}> ?label ; <${RDF_TYPE}> ?class }`,
        undefined,
        signal,
      );
      for (const row of answer.rows) {
        const type = row.class ? classes.get(row.class) : undefined;
        if (row.s && row.label && type && !found.has(row.s))
          found.set(row.s, { type, name: row.label });
      }
      return found;
    },
    reviewItems(keys, signal) {
      return activities.reviewItems(keys, call(signal));
    },
    async review(body, signal) {
      const item = await client.reviews.create(
        body as unknown as Schemas["ReviewItemCreateRequest"],
        call(signal),
      );
      return { id: item.id, status: item.status };
    },
    async commit(body, commitOptions) {
      const { idempotencyKey, fence, graph, signal } = commitOptions;
      const target = graph ? client.withScope({ graph }) : client;
      const response: Schemas["GraphCommitResponse"] = await target.request(
        "POST",
        "/v1/graph/commit",
        {
          body: fence ? { ...body, workflow_fence: fence } : body,
          idempotencyKey,
          ...call(signal),
          retry: true,
        },
      );
      return {
        commitSeq: response.commit_seq ?? null,
        replayed: response.replayed,
      };
    },
  };
}
