import type { components } from "./schema.js";
import { LbbCapabilityError } from "./transport.js";

type DemoRun = components["schemas"]["DemoCurrentRunResponse"];
const ids = ["identity-store", "auth-outage", "sso-customer"];
const topIssues = new Set([
  "missing_graph",
  "publication_pending",
  "metadata_unavailable",
  "diagnostic_budget",
  "definition_unavailable",
  "query_unavailable",
  "snapshot_changed",
  "result_budget",
  "timeout",
]);
const caseIssues = new Set([
  "malformed_result",
  "unexpected_binding_shape",
  "unexpected_term_shape",
  "unexpected_rdf_term",
  "duplicate_distinct_row",
  "expected_terms_differ",
  "result_budget",
]);
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const nullableCount = (v: unknown): boolean => v === null || count(v);
function iri(v: unknown): v is string {
  if (
    typeof v !== "string" ||
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v) ||
    /[<>"{}|^`\\]/u.test(v)
  )
    return false;
  for (const character of v) {
    if (character.charCodeAt(0) <= 0x20) return false;
  }
  return true;
}
const size = (v: string): number => new TextEncoder().encode(v).byteLength;
const issue = (v: unknown, allowed: Set<string>): boolean =>
  v === null || (typeof v === "string" && allowed.has(v));
const refuse = (): never => {
  throw new LbbCapabilityError("demo/1 exact RDF checks");
};

function passedTerms(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const result = value.actual_result;
  if (!record(result) || typeof result.document !== "string") return false;
  let document: unknown;
  try {
    document = JSON.parse(result.document);
  } catch {
    return false;
  }
  if (
    !record(document) ||
    !record(document.head) ||
    !Array.isArray(document.head.vars) ||
    document.head.vars.length !== 1 ||
    document.head.vars[0] !== value.variable ||
    !record(document.results) ||
    !Array.isArray(document.results.bindings) ||
    document.results.bindings.length > 2
  )
    return false;
  const actual: string[] = [];
  for (const row of document.results.bindings) {
    if (
      !record(row) ||
      Object.keys(row).length !== 1 ||
      typeof value.variable !== "string"
    )
      return false;
    const term = row[value.variable];
    if (
      !record(term) ||
      Object.keys(term).length !== 2 ||
      term.type !== "uri" ||
      !iri(term.value)
    )
      return false;
    actual.push(term.value);
  }
  return (
    actual.length > 0 &&
    new Set(actual).size === actual.length &&
    actual.length === expected.length &&
    expected.every((v) => actual.includes(v))
  );
}

/** Refuse older servers that silently return a legacy 200, and inconsistent pins or success claims. */
export function checkedDemoRunResponse(
  value: unknown,
  expectedDataset: string,
): DemoRun {
  if (
    !record(value) ||
    value.object !== "demo_run" ||
    value.version !== "demo/1" ||
    typeof value.dataset_id !== "string" ||
    value.dataset_id !== expectedDataset ||
    typeof value.passed !== "boolean" ||
    typeof value.complete !== "boolean" ||
    typeof value.outcome !== "string" ||
    !["passed", "failed", "unavailable"].includes(value.outcome) ||
    !record(value.graph) ||
    !["tenant_id", "graph_id", "branch_id"].every(
      (k) => typeof (value.graph as Record<string, unknown>)[k] === "string",
    ) ||
    !nullableCount(value.epoch) ||
    !nullableCount(value.served_at_seq) ||
    (value.epoch === null && value.served_at_seq !== null) ||
    !nullableCount(value.expected_case_count) ||
    !nullableCount(value.completed_case_count) ||
    !Array.isArray(value.cases) ||
    value.cases.length > 3 ||
    !issue(value.issue, topIssues) ||
    value.class_embedding_checks !== "not_requested" ||
    !record(value.limits)
  )
    return refuse();
  const limits = value.limits;
  if (
    limits.max_cases !== 3 ||
    limits.max_rows_per_case !== 2 ||
    limits.max_query_bytes !== 8192 ||
    limits.max_result_bytes !== 8192 ||
    limits.max_ontology_bytes !== 1048576 ||
    limits.deadline_millis !== 5000
  )
    return refuse();
  if (
    value.dataset_id === "semantic_graph"
      ? value.expected_case_count !== 3
      : value.expected_case_count !== null
  )
    return refuse();
  if (value.case_payloads === "withheld") {
    if (
      value.issue === null ||
      value.completed_case_count !== null ||
      value.cases.length !== 0 ||
      value.epoch !== null ||
      value.served_at_seq !== null ||
      value.complete ||
      value.passed ||
      value.outcome !== "unavailable" ||
      (value.dataset_id !== "semantic_graph" &&
        value.issue !== "definition_unavailable")
    )
      return refuse();
    return value as unknown as DemoRun;
  }
  if (
    value.case_payloads !== "available" ||
    value.issue !== null ||
    value.dataset_id !== "semantic_graph" ||
    value.completed_case_count !== 3 ||
    value.cases.length !== 3 ||
    !count(value.epoch) ||
    !count(value.served_at_seq)
  )
    return refuse();
  const seen = new Set<string>();
  for (const c of value.cases) {
    if (
      !record(c) ||
      typeof c.id !== "string" ||
      !ids.includes(c.id) ||
      seen.has(c.id) ||
      typeof c.label !== "string" ||
      c.query_kind !== "sparql_select" ||
      typeof c.query !== "string" ||
      !c.query ||
      size(c.query) > 8192 ||
      c.variable !== (c.id === "identity-store" ? "database" : "customer") ||
      !Array.isArray(c.expected) ||
      c.expected.length !== 1 ||
      !record(c.expected[0]) ||
      Object.keys(c.expected[0]).length !== 1 ||
      !iri(c.expected[0]["@id"]) ||
      !count(c.epoch) ||
      !count(c.served_at_seq) ||
      c.epoch !== value.epoch ||
      c.served_at_seq !== value.served_at_seq ||
      typeof c.outcome !== "string" ||
      !["passed", "failed", "unavailable"].includes(c.outcome) ||
      !issue(c.issue, caseIssues) ||
      (c.outcome === "passed" ? c.issue !== null : c.issue === null) ||
      !record(c.actual_result) ||
      c.actual_result.format !== "application/sparql-results+json" ||
      typeof c.actual_result.document !== "string" ||
      size(c.actual_result.document) > 8192
    )
      return refuse();
    if (c.outcome === "passed" && !passedTerms(c, [c.expected[0]["@id"]]))
      return refuse();
    seen.add(c.id);
  }
  const completed =
    value.cases.length === 3 &&
    value.cases.every((c) => record(c) && c.outcome !== "unavailable");
  const expectedOutcome =
    value.issue !== null || !completed
      ? "unavailable"
      : value.cases.some((c) => record(c) && c.outcome === "failed")
        ? "failed"
        : "passed";
  if (
    (value.issue === null && value.cases.length < 3) ||
    value.outcome !== expectedOutcome ||
    value.complete !== (value.issue === null && completed) ||
    value.passed !== (expectedOutcome === "passed")
  )
    return refuse();
  return value as unknown as DemoRun;
}

export function checkedLegacyDemoRun(value: unknown): unknown {
  if (
    !record(value) ||
    !record(value.dataset) ||
    typeof value.passed !== "boolean" ||
    !Array.isArray(value.cases) ||
    value.version === "demo/1"
  ) {
    throw new LbbCapabilityError("legacy demo response");
  }
  return value;
}
