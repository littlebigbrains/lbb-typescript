// values-extract: fill properties of a class from the text of its
// instances, each value with a verbatim quote. The rules are those of LBB's
// `values.extract@v1` (lbb-graph-query/src/infer_llm.rs); its eval
// (eval.test.ts) runs both on the same recorded model answers.
//
// A triggered workflow of the starter workflow `workflow` watches a class and
// its text field, and sends the new and changed instances to this workflow.
// For each instance the workflow:
//
// 1. asks the reasoning model (`reason`) for the values of the properties the
//    text states, each with the words that state it;
// 2. checks each value without a model, in this order: its property is one
//    the workflow fills, it is the first value of its property, it takes its
//    property's type, and its quote is in the text. A number of a property
//    with a unit must come in that unit, with the unit in its quote;
//    otherwise it goes to review at most (the LBB-run values.extract converts
//    a number in another unit instead: the one rule the template leaves to
//    it);
// 3. asks the decision model (`decide`) how well each quote supports its
//    value;
// 4. writes the values at or above the gate, each with a `ValueSource` whose
//    evidence is the quote (with the instance's page box as its region, when
//    the instance has one), and asks a person about each value between 0.5
//    and the gate: a `value` review item in the property's unit, one per
//    property of an instance. A value below 0.5 is dropped.
//
// A person's answer wins over the model, for the evidence it was given on
// (the value's quote and the unit the text states). A value a person
// accepted or corrected is written as answered (a correction is a number in
// the property's unit, as entered); one a person rejected, or one the graph
// refused, is not written again. New evidence with another value asks again,
// and the answered value and its source stay until the person answers. A
// value an earlier version filed as a suggestion keeps working: an accepted
// one is written again, an open one stays the question, and a dismissed one
// is a reject of its value.
//
// Every model call runs in a step with the step's effect id, so a turn that
// runs again after a crash pays for nothing twice. The write's request id is
// its step's effect id, which no other turn repeats: a value that changes
// back (A, then B, then A) is written again. An instance whose model call is
// refused goes back to the watch (`lbb.requeue`, at most 3 times) and keeps
// its values; the turn completes, so the shard goes on. A spent budget fails
// the turn with the time to retry, and the worker waits without an attempt.
import {
  entityIdFromIri,
  entityRef,
  isActivityRefused,
  stableHashHex,
  triggeredWorkflow,
  type LbbActivities,
  type Schemas,
  type WorkflowTriggerMessage,
} from "@littlebigbrain/client";

export type ValueType = "text" | "keyword" | "i64" | "f64" | "bool" | "date_time" | "datetime";

export interface Settings {
  /** The class whose instances the workflow reads. */
  className: string;
  /** The property that holds each instance's text. */
  textField: string;
  /** The properties to fill, with their types. */
  properties: Record<string, ValueType>;
  /** One sentence about what the text is, for the models. */
  context: string;
  /** A value whose support is below this goes to review (from 0.5) or is dropped. */
  gate: number;
  /** The unit of each number property (`cm`, `mm`, `kg`, `m2`, …), declared in the ontology by `ontology()`. */
  units?: Record<string, string>;
}

/** The settings: edit them for your class. These fit the samples. */
export const defaults: Settings = {
  className: "EquipmentItem",
  textField: "text",
  properties: { width_cm: "f64", depth_cm: "f64", material: "text", water_supply: "keyword" },
  context: "Entries of the sanitary equipment list of a school building tender, in German.",
  gate: 0.8,
  units: { width_cm: "cm", depth_cm: "cm" },
};

/** The workflow type and version the triggered workflow names. */
export const workflowType = { workflow_type: "values-extract", version: "v1" };

/** The triggered workflow that sends the instances to this workflow: `client.workflows.starters.use(trigger())`. */
export function trigger(settings: Settings = defaults): Schemas["TriggeredWorkflowRequest"] {
  return {
    starter: "workflow",
    name: "values-extract",
    watch: { class: settings.className, fields: [settings.textField] },
    workflow: workflowType,
    owns: {
      classes: ["ValueSource"],
      relations: ["HAS_VALUE_SOURCE"],
      properties: Object.keys(settings.properties),
    },
    batch: 8,
  };
}

/** The classes, properties and relation the workflow reads and writes, for `lbb.evolve`. */
export function ontology(settings: Settings = defaults): Schemas["OntologyEvolveOp"][] {
  const property = (name: string, value_type: string, unit?: string) => ({
    op: "add_property" as const,
    name,
    value_type,
    ...(unit ? { unit } : {}),
  });
  return [
    { op: "add_entity_type", name: settings.className },
    { op: "add_entity_type", name: "ValueSource" },
    property(settings.textField, "text"),
    ...Object.entries(settings.properties).map(([name, type]) =>
      property(name, type, unitOf(settings, name)),
    ),
    property("property", "keyword"),
    property("value", "text"),
    property("support", "f64"),
    {
      op: "add_relation",
      name: "HAS_VALUE_SOURCE",
      domain: [settings.className],
      range: ["ValueSource"],
    },
  ];
}

/** What a value became: the outcomes of LBB's `values.extract`. */
export type Outcome =
  | "written"
  | "review"
  | "weak_support"
  | "quote_not_found"
  | "invalid_value"
  | "unknown_property"
  | "duplicate";

/** The counters of the workflow, those of LBB's `values.extract`. */
export interface ValuesState {
  instances: number;
  values_proposed: number;
  written: number;
  review: number;
  weak_support: number;
  quote_not_found: number;
  invalid_value: number;
  unknown_property: number;
  duplicate: number;
  failed: number;
  commits: number;
  removed: number;
}

const ZERO: ValuesState = {
  instances: 0,
  values_proposed: 0,
  written: 0,
  review: 0,
  weak_support: 0,
  quote_not_found: 0,
  invalid_value: 0,
  unknown_property: 0,
  duplicate: 0,
  failed: 0,
  commits: 0,
  removed: 0,
};

/** A proposed value after the checks: its outcome, and its typed value when it passed them. */
export interface Checked {
  property: string;
  /** The value as the model wrote it, or its canonical text once it took its type. */
  value: string;
  quote: string;
  outcome: Outcome | "";
  detail?: string;
  typed?: string | number | boolean;
  support?: number;
  /** Why the unit of a number is not confirmed: the value goes to review at most. */
  unconfirmed?: string;
  /**
   * The unit the text states, folded (`cm` for `CM`): part of the value's evidence. LBB maps the
   * names of a unit (`centimetres`) to its symbol too.
   */
  statedUnit?: string;
}

/** What a person's answer decides for a value. */
type Decision =
  /** Write the answered value. */
  | { kind: "write"; value: string | number | boolean; corrected: boolean }
  /** Keep the property as it is in the graph (and ask again when `ask`). */
  | { kind: "hold"; ask: boolean }
  /** Write nothing for the value. */
  | { kind: "skip" }
  /** Write the facts of a suggestion an earlier version filed and a person accepted. */
  | { kind: "facts"; facts: Schemas["SuggestedFacts"] };

/** The text of one instance as the workflow reads it. */
interface Instance {
  label: string;
  text: string;
  box: Schemas["RegionAnchorInput"] | null;
}

/** What the models made of one instance. */
interface Read {
  values: Checked[];
  /** The instance was not found at the message's commit: nothing is written for it. */
  missing?: boolean;
  /** A model call was refused: the instance goes back to the watch. */
  failed?: string;
}

export const SYSTEM = `You read the text of one record of a knowledge graph and fill in property values the text states. Rules:
- Give a value only when the text states it. Do not guess and do not compute.
- Give the values of the record's own item in its base version. Leave out the values of a part, an accessory or an alternative the text names (the battery of a drill, the shade of a lamp), and the values of a variant that holds only under a condition ("if …", "when used with …").
- A value the text gives as approximate ("about 40 kg", "approx. 2 m") is stated: give it without the approximation.
- Each value quotes the words of the text that state it in \`quote\`, copied exactly, character for character. A value without an exact quote is dropped.
- Write each value in its property's type: a number for i64 and f64 (digits, a dot for decimals, without its unit), true or false for bool, YYYY-MM-DD for datetime, and the words of the text for text and keyword.
- Give a number as the text states it, and in \`unit\` the unit the text states it in, as a symbol (mm, cm, m, m2, l, kg, kW, h). Do not convert it to the property's unit. Give an empty \`unit\` when the text states no unit, and for a value that is not a number.
- Give at most one value per property. Leave a property out when the text does not state it.`;

const SUPPORT: Record<string, string> = {
  supported:
    "The quote states this value of this property for the record's own item. A value stated as approximate counts: 'approx. 40 kg' supports a weight of 40.",
  weak: "The text implies the value but does not state it.",
  not_supported:
    "The quote does not state this value, or it states the value of a part, an accessory, an alternative or a variant under a condition, not of the record's own item.",
};

/** Instances one turn reads: two steps each, in a turn of 64 steps. */
const TURN_INSTANCES = 24;
/** Characters of a text the models read. */
const TEXT_CHARS = 40_000;
/** Below this support a value is dropped. */
const SUPPORT_MIN = 0.5;
const PLAIN_IRI = /^[^\s<>"{}|\\^`]+$/;
const ENTITY_IRI = /^https:\/\/littlebigbrain\.com\/e\/[0-9a-fA-F]{32}$/;
const LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const P = "https://littlebigbrain.com/p/";
const BOX = ["page", "x0", "y0", "x1", "y1"] as const;
const normalize = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");
/** The first `n` characters (code points, as Rust counts them). */
const chars = (text: string, n: number) => [...text].slice(0, n).join("");
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** The value of `raw` in its property's type, or why it does not take the type. */
export function coerce(
  raw: string,
  type: ValueType,
): { value: string | number | boolean } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: "the value is empty" };
  const cleaned = text.replaceAll(",", ".").replace(/\s+/g, "");
  const number = NUMBER.test(cleaned) ? Number(cleaned) : NaN;
  switch (type) {
    case "i64":
      if (!Number.isFinite(number)) return { error: `\`${text}\` is not a number` };
      return Number.isInteger(number)
        ? { value: number }
        : { error: `\`${text}\` is not a whole number` };
    case "f64":
      return Number.isFinite(number) ? { value: number } : { error: `\`${text}\` is not a number` };
    case "bool": {
      const lower = text.toLowerCase();
      if (["true", "yes", "ja"].includes(lower)) return { value: true };
      if (["false", "no", "nein"].includes(lower)) return { value: false };
      return { error: `\`${text}\` is not true or false` };
    }
    case "date_time":
    case "datetime": {
      const value = new TextEncoder().encode(text).length === 10 ? `${text}T00:00:00Z` : text;
      return RFC3339.test(value) && !Number.isNaN(Date.parse(value))
        ? { value }
        : { error: `\`${text}\` is not a date` };
    }
    default:
      return { value: text };
  }
}

/** The value of `raw` in its property's type, or null when it does not take the type. */
export function typed(raw: string, type: ValueType): string | number | boolean | null {
  const coerced = coerce(raw, type);
  return "value" in coerced ? coerced.value : null;
}

/** Why a quote does not hold, or null when it does: it is in the text, with at least three words or the value in it. */
export function quoteProblem(quote: string, value: string, text: string): string | null {
  const q = normalize(quote);
  const words = q ? q.split(" ").length : 0;
  if (!words) return "the quote is empty";
  if (!normalize(text).includes(q)) return "the quote is not in the text";
  const v = normalize(value).toLowerCase();
  return words >= 3 || (v !== "" && q.toLowerCase().includes(v))
    ? null
    : "the quote has fewer than 3 words and does not hold the value";
}

/** A quote must be in the text, with at least three words or the value in it. */
export function quoteHolds(quote: string, value: string, text: string): boolean {
  return quoteProblem(quote, value, text) === null;
}

/** The unit a number property holds, from the settings; none for other types. */
export function unitOf(settings: Settings, property: string): string | undefined {
  const type = settings.properties[property];
  return type === "i64" || type === "f64" ? settings.units?.[property] : undefined;
}

const unitText = (text: string) =>
  text.trim().replace(/\.+$/, "").toLowerCase().replace(/²/g, "2").replace(/³/g, "3");

/**
 * Why a number of a property that holds `unit` cannot be confirmed in that unit: the text states
 * no unit or another one, or the quote does not hold it. Undefined when it is confirmed. The
 * messages are those of LBB's `values.extract`; a number in another unit is LBB's to convert.
 */
export function unitProblem(unit: string, stated: string, quote: string): string | undefined {
  const want = unitText(unit);
  const got = unitText(stated);
  if (!got) return `the text states no unit; the property holds ${unit}`;
  if (got !== want) return `the text states ${stated.trim()}; the property holds ${unit}`;
  const token = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!\\p{L})${token}(?![\\p{L}\\p{N}])`, "u").test(unitText(quote))
    ? undefined
    : `the quote does not state the unit ${unit}`;
}

/**
 * A number and the unit after it, read apart (`600 mm` gives `600` and `mm`), as LBB does when
 * a model gives the unit in `value`; undefined when the text does not start with a number or has
 * no unit after it.
 */
export function splitNumberUnit(text: string): { number: string; unit: string } | undefined {
  const trimmed = text.trim();
  const end = [...trimmed].findIndex((c) => !/[0-9.,+\- ]/.test(c));
  if (end < 0) return undefined;
  const points = [...trimmed];
  const number = points.slice(0, end).join("").trim();
  const unit = points.slice(end).join("").trim();
  return /[0-9]/.test(number) && unit ? { number, unit } : undefined;
}

/** The checks without a model, in the order of LBB's `values.extract`. */
export function check(
  values: { property?: string; value?: string; unit?: string; quote?: string }[],
  properties: Record<string, ValueType>,
  text: string,
  units: Record<string, string> = {},
): Checked[] {
  const seen = new Set<string>();
  return values.map((item): Checked => {
    const property = item.property ?? "";
    let raw = item.value ?? "";
    let stated = (item.unit ?? "").trim();
    const quote = item.quote ?? "";
    // A number given with its unit in `value` (`600 mm`), against the
    // rules: read the two apart.
    const split = stated ? undefined : splitNumberUnit(raw);
    if (split) ({ number: raw, unit: stated } = split);
    const out: Checked = { property, value: raw, quote, outcome: "" };
    const type = Object.hasOwn(properties, property) ? properties[property] : undefined;
    if (!type) return { ...out, outcome: "unknown_property" };
    if (seen.has(property)) return { ...out, outcome: "duplicate" };
    seen.add(property);
    const coerced = coerce(raw, type);
    if ("error" in coerced) return { ...out, outcome: "invalid_value", detail: coerced.error };
    const problem = quoteProblem(quote, raw, text);
    if (problem) return { ...out, outcome: "quote_not_found", detail: problem };
    const unit =
      (type === "i64" || type === "f64") && Object.hasOwn(units, property)
        ? units[property]
        : undefined;
    const unconfirmed = unit ? unitProblem(unit, stated, quote) : undefined;
    return {
      ...out,
      value: String(coerced.value),
      typed: coerced.value,
      ...(unconfirmed ? { unconfirmed } : {}),
      ...(stated ? { statedUnit: unitText(stated) } : {}),
    };
  });
}

/** The key of the value item of a property of an instance, as LBB's values.extract gives it. */
export function valueItemKey(workflow: string, iri: string, property: string): string {
  const hash = stableHashHex(["value_item_v2", entityIdFromIri(iri), property]).slice(0, 24);
  return `starter:${workflow}:value:${hash}`;
}

/** The key an earlier version filed a value under, as a suggestion: one per value. */
export function legacyValueKey(workflow: string, iri: string, v: Checked): string {
  const hash = stableHashHex([entityIdFromIri(iri), v.property, v.value]).slice(0, 24);
  return `starter:${workflow}:value:${hash}`;
}

/** The evidence a value is read from, as LBB marks it: its quote and the unit the text states. */
export function evidenceOf(v: Checked): string {
  return stableHashHex(["values_evidence_v2", normalize(v.quote), v.statedUnit ?? ""]).slice(0, 32);
}

/** The workflow, for a `WorkflowWorker`. `lbb` is `lbbActivities(client)`, or a mock in a test. */
export function createWorkflow(lbb: LbbActivities, settings: Settings = defaults) {
  // The properties in name order, each with the name the property registry
  // gives its type, as LBB's values.extract sends them.
  const names = Object.keys(settings.properties).sort();
  const typeName = (name: string) => {
    const type = settings.properties[name];
    return type === "date_time" ? "datetime" : type;
  };
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["values"],
    properties: {
      values: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["property", "value", "unit", "quote"],
          properties: {
            property: { type: "string", enum: names },
            value: {
              type: "string",
              description: "The value in the property's type; a number as the text states it.",
            },
            unit: {
              type: "string",
              description:
                "The unit the text states a number in, as a symbol; empty when it states none or the value is not a number.",
            },
            quote: {
              type: "string",
              description: "The words of the text that state the value, copied exactly.",
            },
          },
        },
      },
    },
  };

  return triggeredWorkflow<ValuesState, { counters: Partial<ValuesState> }>({
    name: workflowType.workflow_type,
    version: workflowType.version,
    initialState: ZERO,
    async onInstances(ctx, message, state) {
      const tally: ValuesState = { ...ZERO };
      // An instance that left the class keeps what was written for it; its
      // values go with its fields when it is retracted.
      tally.removed = message.removed.length;
      const batch = message.instances.slice(0, TURN_INSTANCES);
      const texts = reader(message, batch);
      const reads: Read[] = [];
      for (const [i, iri] of batch.entries()) {
        const proposed = await ctx.step(`values-${i}`, async (s): Promise<Read> => {
          s.progress("reading values", { done: i, total: batch.length, unit: "instances" });
          const record = (await texts())[iri];
          if (!record) return { values: [], missing: true };
          if (!record.text.trim() || !names.length) return { values: [] };
          const prompt = JSON.stringify({
            class: settings.className,
            instance: record.label,
            context: settings.context,
            properties: names.map((name) => {
              const unit = unitOf(settings, name);
              return { name, type: typeName(name), ...(unit ? { unit } : {}) };
            }),
            text: record.text,
          });
          try {
            const answer = await lbb.reason<{
              values?: { property?: string; value?: string; unit?: string; quote?: string }[];
            }>(
              { system: SYSTEM, prompt, schema, max_tokens: 8_000 },
              { effectId: s.effectId, label: `${chars(record.label, 50)} values` },
            );
            return {
              values: check(
                answer.value.values ?? [],
                settings.properties,
                record.text,
                Object.fromEntries(
                  names.flatMap((name) => {
                    const unit = unitOf(settings, name);
                    return unit ? [[name, unit]] : [];
                  }),
                ),
              ),
            };
          } catch (error) {
            if (!isActivityRefused(error)) throw error;
            return { values: [], failed: String((error as Error).message ?? error) };
          }
        });
        reads.push(
          await ctx.step(`support-${i}`, async (s): Promise<Read> => {
            const asked = proposed.values.flatMap((v, n) => (v.typed !== undefined ? [n] : []));
            if (!asked.length) return proposed;
            s.progress("asking the decision model", {
              done: i,
              total: batch.length,
              unit: "instances",
            });
            const record = (await texts())[iri]!;
            const questions = Object.fromEntries(
              asked.map((n) => {
                const v = proposed.values[n]!;
                return [
                  `v${n}`,
                  {
                    instructions: `The state holds the text of one record of the class ${settings.className}. A model read the value of a property from the text and quoted the words that state it. How well does the quote support the value?\nProperty: ${v.property} (${typeName(v.property)})\nValue: ${v.value}\nQuote: "${v.quote}"`,
                    criteria: SUPPORT,
                  },
                ];
              }),
            );
            let answers: Awaited<ReturnType<LbbActivities["decide"]>>["answers"];
            try {
              ({ answers } = await lbb.decide(
                {
                  state: {
                    class: settings.className,
                    record: record.label,
                    context: settings.context,
                    text: record.text,
                  },
                  questions,
                },
                { effectId: s.effectId, label: `${chars(record.label, 50)} support` },
              ));
            } catch (error) {
              if (!isActivityRefused(error)) throw error;
              return { values: [], failed: String((error as Error).message ?? error) };
            }
            return {
              values: proposed.values.map((v, n): Checked => {
                if (v.typed === undefined) return v;
                const a = answers[`v${n}`];
                const support =
                  a?.probabilities?.supported ??
                  (a?.choice == null
                    ? undefined
                    : a.choice === "supported"
                      ? (a.confidence ?? 1)
                      : 0);
                // A value whose unit is not confirmed goes to review at most.
                const outcome: Outcome =
                  support === undefined
                    ? "weak_support"
                    : support >= settings.gate && !v.unconfirmed
                      ? "written"
                      : support >= SUPPORT_MIN
                        ? "review"
                        : "weak_support";
                const detail =
                  outcome === "review" && v.detail === undefined && v.unconfirmed
                    ? { detail: v.unconfirmed }
                    : {};
                return {
                  ...v,
                  outcome,
                  ...detail,
                  ...(support !== undefined ? { support } : {}),
                };
              }),
            };
          }),
        );
      }

      // A person's answer wins over the model, for the evidence it was given
      // on. One read of the items of the turn's values: the value item of each
      // property of an instance, and the suggestion an earlier version filed
      // for each value.
      const candidates = reads.flatMap((read, i) =>
        read.values
          .filter((v) => v.outcome === "written" || v.outcome === "review")
          .map((v) => ({ i, v })),
      );
      const keyOf = (i: number, property: string) =>
        valueItemKey(message.workflow, batch[i]!, property);
      const legacyKeyOf = (i: number, v: Checked) => legacyValueKey(message.workflow, batch[i]!, v);
      const known = await ctx.step("answers", async () => {
        const items: Record<string, Schemas["ReviewItem"]> = {};
        const legacy: Record<string, { status: string; facts: Schemas["SuggestedFacts"] | null }> =
          {};
        if (!candidates.length) return { items, legacy };
        const found = await lbb.reviewItems(
          candidates.flatMap(({ i, v }) => [keyOf(i, v.property), legacyKeyOf(i, v)]),
        );
        for (const item of found) {
          if (item.kind === "value") items[item.key] = item;
          else if (item.kind === "change") {
            const accepted = item.status === "answered" && item.answer?.decision === "accept";
            const status = accepted
              ? "accepted"
              : item.status === "answered"
                ? "dismissed"
                : item.status;
            // An accepted suggestion is written again with its facts.
            const filed = accepted ? await lbb.reviewItem(item.key) : null;
            legacy[item.key] = { status, facts: filed?.facts ?? null };
          }
        }
        return { items, legacy };
      });
      const decide = (i: number, v: Checked): Decision | undefined => {
        const item = known.items[keyOf(i, v.property)];
        if (item) {
          // The same evidence, the value in force, or the value the item proposed when it was
          // answered (the person decided on it) asks nothing.
          const inForce = valueInForce(item);
          if (inForce !== undefined) {
            const same = !item.evidence_hash || item.evidence_hash === evidenceOf(v);
            return same || inForce.value === v.typed || item.question?.value === v.typed
              ? { kind: "write", ...inForce }
              : { kind: "hold", ask: true };
          }
          // Asked again: hold, and update the question only for a value it does not ask yet.
          if (item.previous_answer)
            return {
              kind: "hold",
              ask: item.question?.value !== v.typed && rejectedValue(item) !== v.typed,
            };
          // A value a person rejected, or one the graph refused, is not written again.
          if (rejectedValue(item) === v.typed || refusedValue(item) === v.typed)
            return { kind: "skip" };
          return undefined;
        }
        const legacy = known.legacy[legacyKeyOf(i, v)];
        if (legacy?.status === "accepted")
          return legacy.facts ? { kind: "facts", facts: legacy.facts } : { kind: "skip" };
        if (legacy?.status === "dismissed") return { kind: "skip" };
        // An open suggestion stays the question.
        if (legacy?.status === "open" && v.outcome === "review") return { kind: "skip" };
        return undefined;
      };

      // The value items: one per property of an instance, for a value between
      // 0.5 and the gate, or new evidence against an answer in force.
      const asking = candidates.filter(({ i, v }) => {
        const decision = decide(i, v);
        return decision ? decision.kind === "hold" && decision.ask : v.outcome === "review";
      });
      const answered = await ctx.step("review", async (s) => {
        const kept: {
          i: number;
          property: string;
          value: string | number | boolean;
          corrected: boolean;
        }[] = [];
        for (const [n, { i, v }] of asking.entries()) {
          s.progress("filing review items", { done: n, total: asking.length, unit: "items" });
          const iri = batch[i]!;
          const record = (await texts())[iri]!;
          const facts = valueFacts(iri, record, v);
          const unit = unitOf(settings, v.property);
          const support = v.support ?? 0;
          const item = await lbb.review({
            kind: "value",
            workflow: { name: message.workflow },
            origin: { kind: "agent", id: `starter:${message.workflow}`, label: "values.extract" },
            key: keyOf(i, v.property),
            title: chars(`Set ${v.property} of ${record.label} to ${v.value}`, 200),
            rationale: v.unconfirmed
              ? `The unit is not confirmed: ${v.unconfirmed}. The text supports the value with ${support.toFixed(2)}.`
              : `The text supports the value with ${support.toFixed(2)}, below the gate ${settings.gate}.`,
            subject: { iri, type: settings.className, name: record.label },
            question: {
              property: v.property,
              value: v.typed!,
              ...(unit ? { unit } : {}),
              confidence: support,
            },
            // The quote, with the instance's page box as its region.
            evidence: [
              {
                quote: chars(v.quote, 600),
                source_id: iri,
                ...(facts.edge.evidence.region ? { region: facts.edge.evidence.region } : {}),
                confidence: support,
              },
            ],
            evidence_hash: evidenceOf(v),
            facts: {
              triplets: [facts.edge],
              entity_properties: [facts.onInstance, facts.onSource],
              summary: chars(`${v.property} = ${v.value}`, 500),
            },
          });
          if (decide(i, v)) continue; // asked again: the answered value holds
          // Answered already (a person answered between the read and now).
          const inForce = valueInForce(item);
          if (inForce) kept.push({ i, property: v.property, ...inForce });
        }
        return kept;
      });

      /** What the write sets on instance `i`, and the properties it keeps as they are in the graph. */
      const plan = (i: number, record: Instance) => {
        const entity_properties: Schemas["EntityPropertiesInput"][] = [];
        const triplets: Schemas["TripletInput"][] = [];
        const written = new Set<string>();
        const held = new Set<string>();
        for (const v of reads[i]!.values) {
          if (v.outcome !== "written" && v.outcome !== "review") continue;
          const decision = decide(i, v);
          if (decision?.kind === "hold") held.add(v.property);
          if (decision?.kind === "facts") {
            entity_properties.push(...(decision.facts.entity_properties ?? []));
            triplets.push(...(decision.facts.triplets ?? []));
            written.add(v.property);
            continue;
          }
          const answer =
            decision?.kind === "write"
              ? decision
              : decision
                ? undefined
                : answered.find((a) => a.i === i && a.property === v.property);
          const kept =
            answer !== undefined
              ? answeredAs(v, answer)
              : !decision && v.outcome === "written"
                ? v
                : undefined;
          if (!kept) continue;
          const facts = valueFacts(batch[i]!, record, kept);
          entity_properties.push(facts.onInstance, facts.onSource);
          triplets.push(facts.edge);
          written.add(v.property);
        }
        return { entity_properties, triplets, written, held };
      };
      /** The properties of instance `i` whose answered value stays as it is in the graph. */
      const heldOf = (i: number) =>
        new Set(
          reads[i]!.values.filter(
            (v) =>
              (v.outcome === "written" || v.outcome === "review") && decide(i, v)?.kind === "hold",
          ).map((v) => v.property),
        );
      /** One owned write of instances; a held property is neither set nor replaced. */
      const ownedWrite = async (indexes: number[], held: Set<string>) => {
        const records = await texts();
        const out = {
          subjects: [] as Schemas["NamedEntityInput"][],
          entity_properties: [] as Schemas["EntityPropertiesInput"][],
          triplets: [] as Schemas["TripletInput"][],
          retract: [] as Schemas["NamedEntityInput"][],
        };
        for (const i of indexes) {
          const iri = batch[i]!;
          const record = records[iri];
          if (!record) continue;
          out.subjects.push(entityRef(iri, settings.className, record.label));
          const planned = plan(i, record);
          out.entity_properties.push(...planned.entity_properties);
          out.triplets.push(...planned.triplets);
          out.retract.push(
            ...names
              .filter((p) => !planned.written.has(p) && !held.has(p))
              .map((p) => source(iri, p)),
          );
        }
        return {
          subjects: out.subjects,
          // A held property keeps its source link: an instance that holds one
          // does not replace its links (a source it no longer has is retracted
          // whole, with its link).
          relations: held.size ? [] : ["HAS_VALUE_SOURCE"],
          properties: names.filter((p) => !held.has(p)),
          entity_properties: out.entity_properties,
          triplets: out.triplets,
          retract_entities: out.retract,
        };
      };

      const failed = batch.flatMap((iri, i) =>
        reads[i]!.failed !== undefined ? [{ instance: iri, error: reads[i]!.failed }] : [],
      );
      const writable = batch
        .map((_, i) => i)
        .filter((i) => !reads[i]!.missing && reads[i]!.failed === undefined);
      const holding = writable.filter((i) => heldOf(i).size > 0);
      const writes = [
        await lbb.writeOwned(ctx, "write", async (s) => {
          s.progress("writing facts", { done: 0, total: batch.length, unit: "instances" });
          return ownedWrite(
            writable.filter((i) => !holding.includes(i)),
            new Set(),
          );
        }),
      ];
      // An instance that holds an answered value is written on its own, so
      // the held property stays out of its replace.
      for (const i of holding)
        writes.push(await lbb.writeOwned(ctx, `write-held-${i}`, () => ownedWrite([i], heldOf(i))));
      // Refused instances go back to the watch; the turn completes.
      await lbb.requeue(ctx, "requeue", failed, { graph: message.graph });

      for (const read of reads) {
        if (read.missing) continue;
        tally.instances += 1;
        if (read.failed !== undefined) tally.failed += 1;
        for (const v of read.values) {
          tally.values_proposed += 1;
          if (v.outcome) tally[v.outcome] += 1;
        }
      }
      for (const write of writes)
        if (write.commit_seq !== null && !write.replayed) tally.commits += 1;
      const next = Object.fromEntries(
        Object.entries(ZERO).map(([key]) => [
          key,
          (state[key as keyof ValuesState] ?? 0) + tally[key as keyof ValuesState],
        ]),
      ) as unknown as ValuesState;
      const result = { counters: tally };
      // More instances than a turn reads: the rest goes to a new turn.
      const rest = message.instances.slice(TURN_INSTANCES);
      return rest.length
        ? { ...ctx.continue(next, { ...message, instances: rest, removed: [] }), result }
        : { state: next, result };
    },
  });

  /** The label, text and page box of each instance of the turn, read once per attempt at the message's commit. */
  function reader(message: WorkflowTriggerMessage, iris: string[]) {
    let read: Promise<Record<string, Instance>> | undefined;
    return () =>
      (read ??= (async () => {
        // An instance that is no entity of the graph is not read (LBB skips it too).
        const plain = iris.filter((iri) => PLAIN_IRI.test(iri) && ENTITY_IRI.test(iri));
        const query = `# values-extract: texts
SELECT ?s ?label ?text ${BOX.map((b) => `?${b}`).join(" ")} WHERE {
  VALUES ?s { ${plain.map((iri) => `<${iri}>`).join(" ")} }
  ?s a ?class .
  OPTIONAL { ?s <${LABEL}> ?label }
  OPTIONAL { ?s <${P}${encodeURIComponent(settings.textField.toLowerCase())}> ?text }
${BOX.map((b) => `  OPTIONAL { ?s <${P}${b}> ?${b} }`).join("\n")}
}`;
        const { rows } = await lbb.sparql({ query, as_of_commit_seq: message.as_of_commit_seq });
        const found = new Map<
          string,
          { labels: Set<string>; texts: Set<string>; box: Record<string, string> }
        >();
        for (const row of rows) {
          const at = found.get(row.s!) ?? { labels: new Set(), texts: new Set(), box: {} };
          found.set(row.s!, at);
          if (row.label && normalize(row.label)) at.labels.add(normalize(row.label));
          if (row.text && normalize(row.text)) at.texts.add(normalize(row.text));
          for (const b of BOX) if (row[b] !== undefined) at.box[b] ??= row[b]!;
        }
        const out: Record<string, Instance> = {};
        for (const [iri, at] of found) {
          // As LBB composes a text from its fields: `<field>: <values>`, each
          // value's whitespace as single spaces, the values in order.
          const values = [...at.texts].sort();
          const text = values.length
            ? chars(`${settings.textField}: ${values.join(", ")}`, TEXT_CHARS)
            : "";
          const label = [...at.labels].sort()[0] ?? entityIdFromIri(iri);
          out[iri] = { label, text, box: region(at.box) };
        }
        return out;
      })());
  }

  /** The instance's page box as a region, when it has a valid one (`page`, `x0`, `y0`, `x1`, `y1`). */
  function region(box: Record<string, string>): Schemas["RegionAnchorInput"] | null {
    const [page, x0, y0, x1, y1] = BOX.map((b) => (box[b] === undefined ? NaN : Number(box[b])));
    if (![page, x0, y0, x1, y1].every(Number.isFinite)) return null;
    if (page! < 0 || ![x0, y0, x1, y1].every((v) => v! >= 0 && v! <= 1)) return null;
    if (x0! > x1! || y0! > y1!) return null;
    return { page: Math.trunc(page!), x0: x0!, y0: y0!, x1: x1!, y1: y1!, confidence: 0 };
  }

  /** The value of an answered item that holds in the graph: an accept or a correction the graph took. */
  function valueInForce(
    item: Schemas["ReviewItem"],
  ): { value: string | number | boolean; corrected: boolean } | undefined {
    const answer = item.answer;
    if (!answer || item.status !== "answered" || item.effects?.commit_error) return undefined;
    const value =
      answer.decision === "correct"
        ? answer.value
        : answer.decision === "accept"
          ? (answer.value ?? item.question?.value)
          : undefined;
    return value === undefined || value === null
      ? undefined
      : { value: value as string | number | boolean, corrected: answer.decision === "correct" };
  }

  /** The proposed value a person rejected on an item. */
  function rejectedValue(item: Schemas["ReviewItem"]): unknown {
    return item.answer?.decision === "reject" ? item.question?.value : undefined;
  }

  /** The value of an answer the graph refused to write: the item is open again for the person. */
  function refusedValue(item: Schemas["ReviewItem"]): unknown {
    if (!item.effects?.commit_error) return undefined;
    if (item.answer?.decision === "correct") return item.answer.value;
    if (item.answer?.decision === "accept") return item.answer.value ?? item.question?.value;
    return undefined;
  }

  /** A value as a person answered it: a correction in place of the read value, with support 1. */
  function answeredAs(
    v: Checked,
    answer: { value: string | number | boolean; corrected: boolean },
  ): Checked {
    return answer.corrected
      ? { ...v, typed: answer.value, value: String(answer.value), support: 1 }
      : { ...v, typed: answer.value, value: String(answer.value) };
  }

  /** The source entity of a property's value on an instance. */
  function source(iri: string, property: string): Schemas["NamedEntityInput"] {
    return {
      type: "ValueSource",
      name: property,
      key: `value:${entityIdFromIri(iri)}:${property}`,
    };
  }

  /** The facts of one value: the property on the instance, its source, and the edge with the quote. */
  function valueFacts(iri: string, record: Instance, v: Checked) {
    const support = v.support ?? 0;
    const target = { ...source(iri, v.property), name: chars(`${v.property} = ${v.value}`, 200) };
    const instance = entityRef(iri, settings.className, record.label);
    const region = record.box
      ? { ...record.box, confidence: Math.min(1, Math.max(0, support)) }
      : undefined;
    return {
      onInstance: { ...instance, properties: { [v.property]: v.typed! } },
      onSource: {
        ...target,
        properties: { property: v.property, value: v.value, support },
      },
      edge: {
        source: instance,
        relation: "HAS_VALUE_SOURCE",
        target,
        confidence: support,
        evidence: {
          text: v.quote,
          source_id: chars(record.label, 200),
          ...(region ? { region } : {}),
        },
      },
    };
  }
}
