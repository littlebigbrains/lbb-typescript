// Run results: what a turn did with each input, in the shape a workflow
// test gives its inputs. The worker fills them from three calls, without new
// calls in a workflow's code: `writeOwned` (each subject is `written`, or
// `no_value` when the write sets nothing on it), `review` with a subject
// (`review`, with the item's id) and `requeue` (`failed`, with its error).
// It sends them with the turn's completion or failure (`results`) when the
// claim names `results_max`, cut to 512 KiB. A step keeps what it reported
// in its saved output, so a replay reports it again: as it was in the same
// run (a resume), or as `duplicate` writes of an earlier attempt. A capture
// (`captureActivities`) derives them the same way, so a local test and a
// live run show the same records. The Python worker does the same, byte for
// byte (`sdk/python/lbb/workflows/_results.py`).
// Design: docs/architecture/run-results.md.
import type { Schemas } from "./client.js";

/** What a run did with one input. */
export type WorkflowRunInput = Schemas["WorkflowRunInput"];
/** `written`, `review`, `no_value`, `failed` or `duplicate`. */
export type WorkflowRunResultOutcome = Schemas["WorkflowRunResultOutcome"];
/** The inputs of a run by outcome. */
export type WorkflowRunResultCounts = Schemas["WorkflowRunResultCounts"];
/** What a completion or a failure reports. */
export type WorkflowRunResultsReport = Schemas["WorkflowRunResultsReport"];
/** One value of an input: a test's value shape. */
type RunValue = Schemas["WorkflowTestValue"];

/** Inputs a run keeps whole, at most, when the claim names no bound. */
export const WORKFLOW_RUN_RESULTS_MAX = 200;
/** Values one input keeps, at most. */
export const WORKFLOW_RUN_RESULT_VALUES_MAX = 32;
/**
 * Bytes of a report, at most (UTF-8 of its JSON): the server takes at most
 * 1 MiB for a whole completion, so the results never cost the completion.
 */
export const WORKFLOW_RUN_RESULTS_MAX_BYTES = 512 * 1024;
const QUOTE_MAX = 600;
const TEXT_MAX = 512;
const ERROR_MAX = 500;
const IRI_MAX = 2048;
const OUTCOME_MAX = 64;
/** Bytes of the results a step keeps in its saved output, at most. */
const STEP_RESULTS_MAX_BYTES = 32 * 1024;
/** Bytes of a step's saved output, at most (the engine keeps 64 KiB). */
const STEP_OUTPUT_MAX_BYTES = 60 * 1024;
const encoder = new TextEncoder();

/** The size of a value as the server reads it: UTF-8 of its JSON. */
export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? "null").length;
}
const IRI_NAMESPACE = "https://littlebigbrain.com/e/";
const ID_KEY_SENTINEL = "\u0000lbb-eid:";

const RANK: Record<WorkflowRunResultOutcome, number> = {
  no_value: 0,
  duplicate: 1,
  written: 2,
  review: 3,
  failed: 4,
};
const OUTCOMES = Object.keys(RANK) as WorkflowRunResultOutcome[];

const clip = (text: string, max: number) =>
  [...text].length > max ? [...text].slice(0, max).join("") : text;

/** What names an input within a run: its IRI, else its label. */
const keyOf = (input: WorkflowRunInput) => input.iri ?? input.label ?? "";

/**
 * The inputs of one run as it goes: each input once (a second report
 * merges into the first: the outcome that asks more of a person, the values
 * of both), in the order the run first named them. Past `max` inputs it
 * keeps only each input's outcome, for the counts.
 * @internal
 */
export class RunResultsCollector {
  private readonly kept: WorkflowRunInput[] = [];
  private readonly positions = new Map<string, number>();
  private readonly rest = new Map<string, WorkflowRunResultOutcome>();
  /** What the step that runs now reported, for its saved output. */
  private stepLog: WorkflowRunInput[] | null = null;

  constructor(readonly max: number = WORKFLOW_RUN_RESULTS_MAX) {}

  /** A step starts: what it reports is kept for its saved output too. */
  beginStep(): void {
    this.stepLog = [];
  }

  /** The step ended: what it reported, in order. */
  endStep(): WorkflowRunInput[] {
    const log = this.stepLog ?? [];
    this.stepLog = null;
    return log;
  }

  add(input: WorkflowRunInput): void {
    this.stepLog?.push(input);
    const key = keyOf(input);
    const at = this.positions.get(key);
    if (at !== undefined) {
      this.kept[at] = mergeInputs(this.kept[at]!, input);
      return;
    }
    const outcome = this.rest.get(key);
    if (outcome !== undefined) {
      if (RANK[input.outcome] > RANK[outcome])
        this.rest.set(key, input.outcome);
      return;
    }
    if (this.kept.length < this.max) {
      this.positions.set(key, this.kept.length);
      this.kept.push(fitInput(input));
    } else this.rest.set(key, input.outcome);
  }

  /** Whether an input was reported. */
  has(key: string): boolean {
    return this.positions.has(key) || this.rest.has(key);
  }

  get size(): number {
    return this.kept.length + this.rest.size;
  }

  /**
   * The report a completion sends, or null when nothing was reported: the
   * inputs in order and the counts of every input, at most
   * {@link WORKFLOW_RUN_RESULTS_MAX_BYTES}.
   */
  report(): WorkflowRunResultsReport | null {
    if (!this.size) return null;
    const counts = Object.fromEntries(
      OUTCOMES.map((outcome) => [outcome, 0]),
    ) as WorkflowRunResultCounts;
    const count = (outcome: WorkflowRunResultOutcome) => {
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    };
    for (const input of this.kept) count(input.outcome);
    for (const outcome of this.rest.values()) count(outcome);
    return fitReport({
      inputs: this.kept.map((input) => ({ ...input })),
      counts,
    });
  }
}

/**
 * A report cut to {@link WORKFLOW_RUN_RESULTS_MAX_BYTES}, as the server cuts
 * its stored results: while it is larger, the values of the last half of
 * the inputs that still have them go, then the last half of the inputs. The
 * counts stay whole.
 */
export function fitReport(
  report: WorkflowRunResultsReport,
): WorkflowRunResultsReport {
  const inputs = (report.inputs ?? []).map(fitInput);
  const out = { ...report, inputs };
  let cut = inputs.length;
  while (jsonBytes(out) > WORKFLOW_RUN_RESULTS_MAX_BYTES && inputs.length) {
    if (cut > 0) {
      const from = Math.floor(cut / 2);
      for (let at = from; at < inputs.length; at++)
        inputs[at] = { ...inputs[at]!, values: [] };
      cut = from;
    } else inputs.length = Math.floor(inputs.length / 2);
  }
  return out;
}

/** A value's identity for the merge: the same value reported twice is one. */
const valueKey = (value: RunValue) => JSON.stringify(value);

/** Two reports of one input, as one. */
export function mergeInputs(
  a: WorkflowRunInput,
  b: WorkflowRunInput,
): WorkflowRunInput {
  const values = [...(a.values ?? [])];
  const seen = new Set(values.map(valueKey));
  for (const value of b.values ?? []) {
    if (values.length >= WORKFLOW_RUN_RESULT_VALUES_MAX) break;
    const key = valueKey(value);
    if (!seen.has(key)) {
      seen.add(key);
      values.push(value);
    }
  }
  const cost = (a.cost_micro_usd ?? 0) + (b.cost_micro_usd ?? 0);
  return fitInput({
    ...a,
    outcome: RANK[b.outcome] > RANK[a.outcome] ? b.outcome : a.outcome,
    label: a.label || b.label || "",
    values,
    ...((a.region ?? b.region) ? { region: a.region ?? b.region } : {}),
    ...((a.error ?? b.error) ? { error: a.error ?? b.error } : {}),
    ...(cost ? { cost_micro_usd: cost } : {}),
  });
}

/** An optional text cut to `max`, or left out when absent. */
const clipped = <K extends string>(
  name: K,
  text: string | null | undefined,
  max: number,
): Partial<Record<K, string>> =>
  text ? ({ [name]: clip(text, max) } as Record<K, string>) : {};

/** An input cut to its bounds: its values, and the length of each text. */
function fitInput(input: WorkflowRunInput): WorkflowRunInput {
  const values = (input.values ?? [])
    .slice(0, WORKFLOW_RUN_RESULT_VALUES_MAX)
    .map((value) => ({
      ...value,
      property: clip(value.property, TEXT_MAX),
      value: clip(value.value, TEXT_MAX),
      quote: clip(value.quote, QUOTE_MAX),
      outcome: clip(value.outcome, OUTCOME_MAX),
      ...clipped("detail", value.detail, TEXT_MAX),
      ...clipped("stated", value.stated, TEXT_MAX),
      ...clipped("unconfirmed", value.unconfirmed, TEXT_MAX),
      ...clipped("source", value.source, TEXT_MAX),
      ...clipped("review_item", value.review_item, TEXT_MAX),
    }));
  return {
    ...input,
    ...clipped("iri", input.iri, IRI_MAX),
    label: clip(input.label ?? "", TEXT_MAX),
    values,
    ...clipped("error", input.error, ERROR_MAX),
  };
}

/** The marker of a step output that keeps the step's results. */
const STEP_MARKER = "lbb_step_results";

/**
 * The output a step saves: its value as it is, or, when the step reported
 * inputs, its value with those inputs and the run that reported them
 * (`{lbb_step_results: 1, run, results, value}`), so a replay of the step
 * reports them again. The inputs keep their values while they fit in 32
 * KiB, then only their IRI, label and outcome; the whole output stays under
 * the engine's 64 KiB.
 * @internal
 */
export function stepOutputWithResults(
  value: unknown,
  run: string,
  inputs: readonly WorkflowRunInput[],
): unknown {
  if (!inputs.length) return value;
  const budget = Math.min(
    STEP_RESULTS_MAX_BYTES,
    STEP_OUTPUT_MAX_BYTES - jsonBytes(value),
  );
  const results: WorkflowRunInput[] = [];
  let bytes = 2;
  for (const input of inputs) {
    const whole = fitInput(input);
    const brief: WorkflowRunInput = {
      ...(whole.iri ? { iri: whole.iri } : {}),
      label: whole.label ?? "",
      outcome: whole.outcome,
    };
    const size = jsonBytes(whole) + 1;
    if (bytes + size <= budget) {
      results.push(whole);
      bytes += size;
      continue;
    }
    const small = jsonBytes(brief) + 1;
    if (bytes + small > budget) break;
    results.push(brief);
    bytes += small;
  }
  if (!results.length) return value;
  return { [STEP_MARKER]: 1, run, results, value };
}

/**
 * A saved step output read back: its value, and the inputs the step
 * reported with the run that reported them (none for an output without
 * them).
 * @internal
 */
export function stepOutputResults(saved: unknown): {
  value: unknown;
  run: string | null;
  results: WorkflowRunInput[];
} {
  if (
    saved &&
    typeof saved === "object" &&
    !Array.isArray(saved) &&
    (saved as Record<string, unknown>)[STEP_MARKER] === 1 &&
    Object.keys(saved).length === 4 &&
    "value" in saved &&
    typeof (saved as { run?: unknown }).run === "string" &&
    Array.isArray((saved as { results?: unknown }).results)
  ) {
    const kept = saved as {
      run: string;
      results: WorkflowRunInput[];
      value: unknown;
    };
    return { value: kept.value, run: kept.run, results: kept.results };
  }
  return { value: saved, run: null, results: [] };
}

/** A property value as text: a number, a word, or the items of a list. */
function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map(valueText).join(", ");
  const entries = Object.entries(value as Record<string, unknown>);
  // A typed value (`{"f64": 1.5}`) is its one entry.
  if (entries.length === 1) return valueText(entries[0]![1]);
  return JSON.stringify(value);
}

/** The IRI a commit's entity reference names, when it names one by id. */
function iriOf(entity: {
  key?: string | null;
  entity_id?: string | null;
}): string | undefined {
  if (entity.entity_id) return `${IRI_NAMESPACE}${entity.entity_id}`;
  if (entity.key?.startsWith(ID_KEY_SENTINEL))
    return `${IRI_NAMESPACE}${entity.key.slice(ID_KEY_SENTINEL.length)}`;
  return undefined;
}

/** Whether two commit references name the same entity. */
function sameEntity(
  a: {
    type?: string;
    name?: string;
    key?: string | null;
    entity_id?: string | null;
  },
  b: {
    type?: string;
    name?: string;
    key?: string | null;
    entity_id?: string | null;
  },
): boolean {
  const ia = iriOf(a);
  const ib = iriOf(b);
  if (ia || ib) return ia === ib;
  if (a.key || b.key) return a.type === b.type && a.key === b.key;
  return a.type === b.type && a.name === b.name;
}

/** The fields of an `entity_properties` item, by name. */
function fieldsOf(properties: unknown): Array<[string, unknown]> {
  if (Array.isArray(properties))
    return properties.flatMap((item) =>
      item && typeof item === "object" && "field" in item
        ? [
            [
              String((item as { field: unknown }).field),
              (item as { value?: unknown }).value,
            ],
          ]
        : [],
    );
  if (properties && typeof properties === "object")
    return Object.entries(properties as Record<string, unknown>);
  return [];
}

/** A page box from a commit's or a review item's region. */
function regionOf(
  region:
    | { page?: number; x0?: number; y0?: number; x1?: number; y1?: number }
    | null
    | undefined,
): Schemas["WorkflowTestRegion"] | undefined {
  if (
    !region ||
    ![region.page, region.x0, region.y0, region.x1, region.y1].every(
      (n) => typeof n === "number",
    )
  )
    return undefined;
  return {
    page: region.page!,
    x0: region.x0!,
    y0: region.y0!,
    x1: region.x1!,
    y1: region.y1!,
  };
}

function value(
  property: string,
  text: string,
  outcome: string,
  more: Partial<RunValue> = {},
): RunValue {
  return { property, value: text, quote: "", outcome, ...more };
}

/** The shape of an owned write this module reads. */
export interface OwnedWriteShape {
  subjects?: Schemas["NamedEntityInput"][];
  entity_properties?: Schemas["EntityPropertiesInput"][];
  triplets?: Schemas["TripletInput"][];
}

/**
 * The inputs of an owned write: each subject `outcome` (`written`, or
 * `duplicate` when an earlier attempt wrote it), with the fields the write
 * sets on it and its out-edges (an edge's evidence gives the quote, the
 * support, the source and the page box). A subject the write sets nothing
 * on has no value.
 */
export function ownedWriteInputs(
  write: OwnedWriteShape,
  outcome: "written" | "duplicate",
): WorkflowRunInput[] {
  return (write.subjects ?? []).map((subject) => {
    const values: RunValue[] = [];
    for (const item of write.entity_properties ?? [])
      if (sameEntity(item, subject))
        for (const [field, fieldValue] of fieldsOf(item.properties))
          values.push(value(field, valueText(fieldValue), outcome));
    for (const triplet of write.triplets ?? []) {
      if (!sameEntity(triplet.source, subject)) continue;
      const evidence =
        triplet.evidence && typeof triplet.evidence === "object"
          ? triplet.evidence
          : undefined;
      const quote =
        typeof triplet.evidence === "string"
          ? triplet.evidence
          : (evidence?.text ?? "");
      const region = regionOf(evidence?.region);
      values.push(
        value(triplet.relation, triplet.target.name, outcome, {
          quote,
          ...(typeof triplet.confidence === "number"
            ? { support: triplet.confidence }
            : {}),
          ...(evidence?.source_id ? { source: evidence.source_id } : {}),
          ...(region ? { region } : {}),
        }),
      );
    }
    const iri = iriOf(subject);
    return fitInput({
      ...(iri ? { iri } : {}),
      label: subject.name ?? "",
      outcome: values.length ? outcome : "no_value",
      values,
    });
  });
}

/** The shape of a review request this module reads. */
export interface ReviewRequestShape {
  kind?: string | null;
  subject?: Schemas["ReviewSubject"] | null;
  question?: Schemas["ReviewQuestion"] | null;
  evidence?: Schemas["ReviewEvidence"][] | null;
  title?: string;
}

/**
 * The input of a review item filed about a subject: `review`, with the
 * question's property and value, the first evidence's quote and place, and
 * the item's id. An item answered already is `answered`: the write that
 * follows reports the input. `null` for an item without a subject.
 */
export function reviewInput(
  request: ReviewRequestShape,
  item: { id?: string; status?: string | null } | null,
): WorkflowRunInput | null {
  const subject = request.subject;
  if (!subject || (!subject.iri && !subject.name)) return null;
  const evidence = request.evidence?.[0];
  const question = request.question;
  const answered =
    item?.status !== undefined &&
    item.status !== null &&
    item.status !== "open";
  const region = regionOf(evidence?.region);
  const support = question?.confidence ?? evidence?.confidence;
  return fitInput({
    ...(subject.iri ? { iri: subject.iri } : {}),
    label: subject.name ?? "",
    outcome: answered ? "no_value" : "review",
    values: [
      value(
        question?.property ?? request.kind ?? "review",
        valueText(question?.value ?? request.title ?? ""),
        answered ? "answered" : "review",
        {
          quote: evidence?.quote ?? "",
          ...(typeof support === "number" ? { support } : {}),
          ...(item?.id ? { review_item: item.id } : {}),
          ...(evidence?.source_id ? { source: evidence.source_id } : {}),
          ...(region ? { region } : {}),
        },
      ),
    ],
  });
}

/** The inputs a turn requeued: each `failed`, with its error. */
export function requeuedInputs(
  failed: readonly { instance: string; error?: string }[],
): WorkflowRunInput[] {
  return failed.map(({ instance, error }) =>
    fitInput({
      iri: instance,
      label: "",
      outcome: "failed",
      values: [],
      ...(error ? { error } : {}),
    }),
  );
}

/**
 * The inputs a step saved, reported again by another run (a later attempt
 * replays the step): what it wrote is the earlier attempt's, so each
 * written input is `duplicate`.
 */
export function replayedInputs(
  inputs: readonly WorkflowRunInput[],
): WorkflowRunInput[] {
  return inputs.map((input) =>
    input.outcome === "written"
      ? {
          ...input,
          outcome: "duplicate",
          values: (input.values ?? []).map((v) =>
            v.outcome === "written" ? { ...v, outcome: "duplicate" } : v,
          ),
        }
      : input,
  );
}
