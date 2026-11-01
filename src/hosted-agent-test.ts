// An agent test uses ordinary scoped grants for every server check. Only the
// frozen source reader and Review filing are substituted; no stack key or
// caller-owned test marker is sent to the server.
import type { LbbClient } from "./client.js";
import { lbbActivities } from "./activities.js";
import { lbbAgentHost } from "./agent-host.js";
import { runAgent, type AgentSpec, type AgentHost } from "./agent.js";
import { hostedAgentRecord } from "./hosted-agent.js";
import { valueText } from "./run-results.js";
import { LbbError } from "./transport.js";
import type { Schemas } from "./types.js";
import type { WorkflowContext } from "./workflows.js";

/** Run one verified server-bound input without graph or Review mutations. */
export async function runHostedAgentTest(
  client: LbbClient,
  ctx: WorkflowContext,
  key: string,
  spec: Omit<AgentSpec, "input">,
  input: Schemas["WorkflowAgentTestInput"],
): Promise<Schemas["WorkflowTestResult"]> {
  if (
    ctx.origin?.kind !== "test" ||
    ctx.origin.event !== input.test ||
    ctx.origin.target_seq !== input.commit_seq ||
    ctx.origin.requests?.length !== 1 ||
    ctx.origin.requests[0] !== input.iri
  )
    throw new Error(
      "The frozen test input does not match the turn's server origin",
    );
  const base = lbbAgentHost(client, lbbActivities(client), { hosted: true });
  const bytes = new TextEncoder().encode(input.text);
  const pages = input.pages ?? [];
  const source = (sha: string) => {
    if (sha !== input.sha256)
      throw new Error("The file is outside this frozen test input");
  };
  const host: AgentHost = {
    ...base,
    // Head/ontology/query reads still go through the verified server route,
    // which resolves the exact retained generation and fails if it is gone.
    async documentSha(iri) {
      return iri === input.document ? input.sha256 : undefined;
    },
    async fileRecord(sha) {
      source(sha);
      return {
        sha256: input.sha256,
        uploadedAt: input.uploaded_at,
        contentType: input.content_type,
        document: input.document,
        generated: false,
      };
    },
    async fileBytes(sha, range) {
      source(sha);
      return bytes.slice(range.start, range.end);
    },
    async filePages(sha, from, to) {
      source(sha);
      return {
        pageCount: pages.length,
        pages: pages.slice(from, to).map((text) => ({ text })),
      };
    },
    // A model test grades proposals independently of previous human answers.
    async reviewItems() {
      return [];
    },
    // Filing is captured locally. The server independently refuses Review POST
    // on test grants, even if a caller bypasses this adapter.
    async review() {
      return { status: "open" };
    },
    async commit(body, options) {
      const target = options.graph
        ? client.withScope({ graph: options.graph })
        : client;
      try {
        await target.request<Schemas["GraphCommitDryRunResponse"]>(
          "POST",
          "/v1/graph/commit",
          {
            body: options.fence
              ? { ...body, workflow_fence: options.fence }
              : body,
            query: { dry_run: true },
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
            retry: true,
          },
        );
      } catch (error) {
        // This route has already checked frozen ownership and evidence. RDF
        // currently refuses schema dry runs; keep that missing check explicit.
        if (!(
          input.schema_validation === "not_run" &&
          error instanceof LbbError &&
          error.status === 400 &&
          error.code === "rdf_native_graph"
        ))
          throw error;
      }
      return { commitSeq: null, replayed: false };
    },
  };
  const result = await runAgent(
    host,
    ctx,
    key,
    {
      ...spec,
      input: { file: input.sha256, instances: [input.iri] },
    },
    { hosted: true },
  );
  const values: Schemas["WorkflowTestValue"][] = result.proposals.map(
    (proposal) => {
      const value =
        proposal.verdict.typed !== undefined
          ? valueText(proposal.verdict.typed)
          : proposal.value;
      const verified =
        Boolean(proposal.verdict.document) &&
        [
          "grounded",
          "weak_support",
          "unit_unconfirmed",
          "commit_refused",
          "new_evidence",
        ].includes(proposal.verdict.code);
      return {
        subject: proposal.subject,
        property: proposal.property,
        value: String(value),
        quote: verified ? proposal.quote : "",
        support: proposal.support ?? null,
        outcome: proposal.disposition ?? proposal.verdict.code,
        ...(verified
          ? { source: `${proposal.verdict.document}#${proposal.locator}` }
          : {}),
        ...(proposal.verdict.stated ? { stated: proposal.verdict.stated } : {}),
        detail: `${proposal.verdict.code}${proposal.verdict.message ? `: ${proposal.verdict.message}` : ""}`,
      };
    },
  );
  const row = {
    iri: input.iri,
    values,
    failed: result.outcome === "failed",
    ...(result.outcome === "failed" ? { error: result.summary } : {}),
    cost_micro_usd: result.costMicroUsd,
    answers: {},
    agent: hostedAgentRecord(result),
    // The completion route replaces this with its server-owned audit receipt.
    schema_validation: "not_run",
  };
  // This row is the completion receipt. Keep all target/value pairs; long
  // evidence remains in the frozen input and step history.
  if (new TextEncoder().encode(JSON.stringify(row)).length > 60 * 1024)
    for (const value of row.values) {
      value.quote = value.quote.slice(0, 100);
      value.detail = (value.detail ?? "").slice(0, 100);
    }
  if (new TextEncoder().encode(JSON.stringify(row)).length > 60 * 1024) {
    row.values = [];
    row.failed = true;
    row.error =
      "The test values exceed the compact result limit; inspect the retained turn history.";
  }
  return row;
}
