// Hosted agent result projection: one source input per turn. The interpreter's
// developer-facing result keeps its camelCase API; retained results use the
// compact, snake_case wire record in docs/architecture/agent-step.md §6.1.
import { agentWorkKey, type AgentResult } from "./agent.js";
import { stableHashHex } from "./hash.js";
import type { Schemas } from "./types.js";
import { RunResultsCollector, valueText } from "./run-results.js";
import { turnRunOf, type WorkflowContext } from "./workflows.js";

export function recordHostedAgentResult(
  ctx: WorkflowContext,
  source: { iri: string; label?: string },
  result: AgentResult,
): void {
  const turn = turnRunOf(ctx);
  if (!turn?.results) return;
  const old = turn.results.report()?.inputs ?? [];
  const values: Schemas["WorkflowTestValue"][] = result.proposals.map(
    (proposal) => {
      const previous = old
        .find((input) => input.iri === proposal.subject)
        ?.values?.find((value) => value.property === proposal.property);
      const verified =
        Boolean(proposal.verdict.document) &&
        [
          "grounded",
          "weak_support",
          "unit_unconfirmed",
          "new_evidence",
          "commit_refused",
        ].includes(proposal.verdict.code);
      return {
        ...previous,
        subject: proposal.subject,
        property: proposal.property,
        value:
          proposal.verdict.typed !== undefined
            ? valueText(proposal.verdict.typed)
            : (previous?.value ?? proposal.value),
        quote: verified ? previous?.quote || proposal.quote : "",
        support: proposal.support ?? null,
        outcome:
          previous?.outcome === "duplicate" &&
          proposal.disposition === "written"
            ? "duplicate"
            : (proposal.disposition ?? proposal.verdict.code),
        source: verified
          ? `${proposal.verdict.document}#${proposal.locator}`
          : null,
        ...(proposal.verdict.stated ? { stated: proposal.verdict.stated } : {}),
        detail: `${proposal.verdict.code}${proposal.verdict.message ? `: ${proposal.verdict.message}` : ""}`,
      };
    },
  );
  const agent = hostedAgentRecord(result);
  // A failed/limited agent completes its turn. The retained input explains why;
  // failing the engine turn here would block later messages on this shard.
  const outcome =
    result.outcome === "failed"
      ? "failed"
      : result.counts.failed > 0
        ? "failed"
        : result.counts.review > 0
          ? "review"
          : values.some(
                (value) =>
                  value.outcome === "written" || value.outcome === "answered",
              )
            ? "written"
            : values.some((value) => value.outcome === "duplicate")
              ? "duplicate"
              : "no_value";
  const collector = new RunResultsCollector(1);
  collector.add({
    iri: source.iri,
    label: source.label ?? source.iri,
    outcome,
    values,
    cost_micro_usd: result.costMicroUsd,
    agent,
    ...(result.outcome === "failed" ? { error: result.summary } : {}),
  });
  turn.results = collector;
}

/** A removed source has no work to execute. Keep an inspectable terminal input
 * without asking a model, acquiring a grant, or blocking the shard. */
export function recordHostedAgentRemoval(
  ctx: WorkflowContext,
  source: { iri: string },
  workflow: string,
): AgentResult {
  const result: AgentResult = {
    outcome: "failed",
    code: "agent_input_invalid",
    summary: "The input left the watched class.",
    iterations: 0,
    maxIterations: 0,
    tools: {},
    costMicroUsd: 0,
    pin: stableHashHex(["lbb.agent@v1", "removed-input"]),
    workKey: agentWorkKey(workflow, ctx.workflowId, ctx.messageId),
    proposals: [],
    counts: { written: 0, review: 0, failed: 0, dropped: 0 },
    trace: [],
  };
  recordHostedAgentResult(ctx, source, result);
  return result;
}

/** The compact retained wire record, shared by live runs and read-only tests. */
export function hostedAgentRecord(
  result: AgentResult,
): Schemas["WorkflowAgentRecord"] {
  return {
    outcome: result.outcome,
    ...(result.limit ? { limit: result.limit } : {}),
    ...(result.code ? { code: result.code } : {}),
    summary: result.summary,
    iterations: result.iterations,
    max_iterations: result.maxIterations,
    tools: result.tools,
    cost_micro_usd: result.costMicroUsd,
    ...(result.model ? { model: result.model } : {}),
    pin: result.pin,
    work_key: result.workKey,
    proposals: result.counts,
    trace: result.trace,
  };
}
