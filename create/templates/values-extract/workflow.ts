// values-extract: fill properties of a class from the text of its
// instances, each value with a verbatim quote.
//
// A triggered workflow of the starter workflow `workflow` watches a class and
// its text field, and sends the new and changed instances to this workflow.
// For each instance the workflow:
//
// 1. asks the reasoning model (`reason`) for the values of the properties the
//    text states, each with the words that state it;
// 2. checks each value without a model: it takes its property's type, and its
//    quote is in the text;
// 3. asks the decision model (`decide`) how well each quote supports its
//    value;
// 4. writes the values at or above the gate, each with a `ValueSource` whose
//    evidence is the quote, and files a review item for each value between
//    0.5 and the gate. A value below 0.5 is dropped.
//
// Every model call runs in a step with the step's effect id, so a turn that
// runs again after a crash pays for nothing twice.
import {
  entityIdFromIri,
  entityRef,
  triggeredWorkflow,
  type LbbActivities,
  type Schemas,
  type WorkflowTriggerMessage,
} from "@littlebigbrain/client";

export type ValueType = "text" | "keyword" | "i64" | "f64" | "bool" | "date_time";

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
}

/** The settings: edit them for your class. These fit the samples. */
export const defaults: Settings = {
  className: "EquipmentItem",
  textField: "text",
  properties: { width_cm: "f64", depth_cm: "f64", material: "text", water_supply: "keyword" },
  context: "Entries of the sanitary equipment list of a school building tender, in German.",
  gate: 0.8,
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
  const property = (name: string, value_type: string) => ({
    op: "add_property" as const,
    name,
    value_type,
  });
  return [
    { op: "add_entity_type", name: settings.className },
    { op: "add_entity_type", name: "ValueSource" },
    property(settings.textField, "text"),
    ...Object.entries(settings.properties).map(([name, type]) => property(name, type)),
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

export interface ValuesState {
  instances: number;
  written: number;
  review: number;
  dropped: number;
}

/** A value after the checks: its property, its typed value, its quote and its support. */
interface Value {
  property: string;
  value: string | number | boolean;
  quote: string;
  support?: number;
}

const SYSTEM = `You read the text of one record of a knowledge graph and fill in property values the text states. Rules:
- Give a value only when the text states it. Do not guess and do not compute.
- Give the values of the record's own item in its base version. Leave out the values of a part, an accessory or an alternative the text names (the battery of a drill, the shade of a lamp), and the values of a variant that holds only under a condition ("if …", "when used with …").
- A value the text gives as approximate ("about 40 kg", "approx. 2 m") is stated: give it without the approximation.
- Each value quotes the words of the text that state it in \`quote\`, copied exactly, character for character. A value without an exact quote is dropped.
- Write each value in its property's type: a number for i64 and f64 (digits, a dot for decimals, no unit), true or false for bool, YYYY-MM-DD for date_time, and the words of the text for text and keyword.
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
const PLAIN_IRI = /^[^\s<>"{}|\\^`]+$/;
const LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const normalize = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

/** The value of `raw` in its property's type, or null when it does not take the type. */
export function typed(raw: string, type: ValueType): string | number | boolean | null {
  const text = raw.trim();
  if (!text) return null;
  const number = Number(text.replace(",", ".").replace(/\s+/g, ""));
  switch (type) {
    case "i64":
      return Number.isInteger(number) ? number : null;
    case "f64":
      return Number.isFinite(number) ? number : null;
    case "bool":
      return /^(true|yes|ja)$/i.test(text) ? true : /^(false|no|nein)$/i.test(text) ? false : null;
    case "date_time":
      return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text))
        ? `${text}T00:00:00Z`
        : null;
    default:
      return text;
  }
}

/** A quote must be in the text, with at least three words or the value in it. */
export function quoteHolds(quote: string, value: string, text: string): boolean {
  const q = normalize(quote);
  if (!q || !normalize(text).includes(q)) return false;
  return q.split(" ").length >= 3 || q.toLowerCase().includes(normalize(value).toLowerCase());
}

/** The workflow, for a `WorkflowWorker`. `lbb` is `lbbActivities(client)`, or a mock in a test. */
export function createWorkflow(lbb: LbbActivities, settings: Settings = defaults) {
  const names = Object.keys(settings.properties);
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
          required: ["property", "value", "quote"],
          properties: {
            property: { type: "string", enum: names },
            value: { type: "string", description: "The value in the property's type." },
            quote: {
              type: "string",
              description: "The words of the text that state the value, copied exactly.",
            },
          },
        },
      },
    },
  };

  return triggeredWorkflow<ValuesState>({
    name: workflowType.workflow_type,
    version: workflowType.version,
    initialState: { instances: 0, written: 0, review: 0, dropped: 0 },
    async onInstances(ctx, message, state) {
      // Instances that left the class lose the values this workflow wrote.
      if (message.removed.length)
        await lbb.writeOwned(ctx, "drop", {
          subjects: message.removed.map((iri) => entityRef(iri, settings.className)),
          relations: ["HAS_VALUE_SOURCE"],
          properties: names,
          retract_entities: message.removed.flatMap((iri) => names.map((p) => source(iri, p))),
        });
      const batch = message.instances.slice(0, TURN_INSTANCES);
      const texts = reader(message, batch);
      const read: Value[][] = [];
      for (const [i, iri] of batch.entries()) {
        const proposed = await ctx.step(`values-${i}`, async (s) => {
          const record = (await texts())[iri];
          if (!record?.text.trim()) return [];
          const prompt = JSON.stringify({
            class: settings.className,
            instance: record.label,
            context: settings.context,
            properties: names.map((name) => ({ name, type: settings.properties[name] })),
            text: record.text,
          });
          const answer = await lbb.reason<{
            values: { property: string; value: string; quote: string }[];
          }>(
            { system: SYSTEM, prompt, schema, max_tokens: 8_000 },
            { effectId: s.effectId, label: `${record.label.slice(0, 50)} values` },
          );
          // The checks without a model: one value per property, of its type, quoted from the text.
          const seen = new Set<string>();
          return (answer.value.values ?? []).flatMap((v): Value[] => {
            const type = settings.properties[v.property];
            const value = type ? typed(v.value, type) : null;
            if (
              value === null ||
              seen.has(v.property) ||
              !quoteHolds(v.quote, v.value, record.text)
            )
              return [];
            seen.add(v.property);
            return [{ property: v.property, value, quote: v.quote }];
          });
        });
        read.push(
          await ctx.step(`support-${i}`, async (s) => {
            if (!proposed.length) return [];
            const record = (await texts())[iri]!;
            const questions = Object.fromEntries(
              proposed.map((v, n) => [
                `v${n}`,
                {
                  instructions: `The state holds the text of one record of the class ${settings.className}. A model read the value of a property from the text and quoted the words that state it. How well does the quote support the value?\nProperty: ${v.property} (${settings.properties[v.property]})\nValue: ${v.value}\nQuote: "${v.quote}"`,
                  criteria: SUPPORT,
                },
              ]),
            );
            const { answers } = await lbb.decide(
              {
                state: {
                  class: settings.className,
                  record: record.label,
                  context: settings.context,
                  text: record.text,
                },
                questions,
              },
              { effectId: s.effectId, label: `${record.label.slice(0, 50)} support` },
            );
            return proposed.map((v, n) => {
              const a = answers[`v${n}`];
              const support =
                a?.probabilities?.supported ??
                (a?.choice === "supported" ? (a.confidence ?? 1) : 0);
              return { ...v, support };
            });
          }),
        );
      }

      // The gate: written, review, or dropped.
      const at = (i: number) => ({ iri: batch[i]!, values: read[i]! });
      const below = batch.flatMap((_, i) =>
        at(i)
          .values.filter((v) => v.support! < settings.gate && v.support! >= 0.5)
          .map((v) => ({ i, v })),
      );
      const accepted = await ctx.step("review", async () => {
        const kept: { i: number; property: string }[] = [];
        for (const { i, v } of below) {
          const record = (await texts())[batch[i]!]!;
          const facts = valueFacts(batch[i]!, record.label, v);
          const filed = await lbb.review({
            workflow: message.workflow,
            key: `starter:${message.workflow}:value:${entityIdFromIri(batch[i]!)}:${v.property}`,
            title: `Set ${v.property} of ${record.label} to ${v.value}`.slice(0, 200),
            rationale: `The text supports the value with ${v.support!.toFixed(2)}, below the gate ${settings.gate}: "${v.quote.slice(0, 600)}"`,
            facts: {
              entity_properties: facts.properties,
              triplets: [facts.edge],
              summary: `${v.property} = ${v.value}`,
            },
            evidence: {
              records: 1,
              samples: [{ entity: batch[i], quote: v.quote.slice(0, 600), support: v.support }],
            },
          });
          if (filed.status === "accepted") kept.push({ i, property: v.property });
        }
        return kept;
      });
      await lbb.writeOwned(ctx, "write", async () => {
        const records = await texts();
        const write = {
          subjects: [] as Schemas["NamedEntityInput"][],
          properties: [] as Schemas["EntityPropertiesInput"][],
          triplets: [] as Schemas["TripletInput"][],
          retract: [] as Schemas["NamedEntityInput"][],
        };
        for (const [i, iri] of batch.entries()) {
          const label = records[iri]?.label ?? iri;
          write.subjects.push(entityRef(iri, settings.className, label));
          const kept = at(i).values.filter(
            (v) =>
              v.support! >= settings.gate ||
              accepted.some((a) => a.i === i && a.property === v.property),
          );
          for (const v of kept) {
            const facts = valueFacts(iri, label, v);
            write.properties.push(...facts.properties);
            write.triplets.push(facts.edge);
          }
          write.retract.push(
            ...names.filter((p) => !kept.some((v) => v.property === p)).map((p) => source(iri, p)),
          );
        }
        return {
          subjects: write.subjects,
          relations: ["HAS_VALUE_SOURCE"],
          properties: names,
          entity_properties: write.properties,
          triplets: write.triplets,
          retract_entities: write.retract,
        };
      });
      const values = read.flat();
      const next: ValuesState = {
        instances: state.instances + batch.length,
        written:
          state.written +
          values.filter((v) => v.support! >= settings.gate).length +
          accepted.length,
        review: state.review + below.length - accepted.length,
        dropped: state.dropped + values.filter((v) => v.support! < 0.5).length,
      };
      // More instances than a turn reads: the rest goes to a new turn.
      const rest = message.instances.slice(TURN_INSTANCES);
      return rest.length
        ? ctx.continue(next, { ...message, instances: rest, removed: [] })
        : { state: next };
    },
  });

  /** The label and text of each instance of the turn, read once per attempt at the message's commit. */
  function reader(message: WorkflowTriggerMessage, iris: string[]) {
    let read: Promise<Record<string, { label: string; text: string }>> | undefined;
    return () =>
      (read ??= (async () => {
        const query = `# values-extract: texts
SELECT ?s ?label ?text WHERE {
  VALUES ?s { ${iris
    .filter((iri) => PLAIN_IRI.test(iri))
    .map((iri) => `<${iri}>`)
    .join(" ")} }
  OPTIONAL { ?s <${LABEL}> ?label }
  OPTIONAL { ?s <https://littlebigbrain.com/p/${encodeURIComponent(settings.textField.toLowerCase())}> ?text }
}`;
        const { rows } = await lbb.sparql({ query, as_of_commit_seq: message.as_of_commit_seq });
        const out: Record<string, { label: string; text: string }> = {};
        for (const row of rows) {
          const record = (out[row.s!] ??= { label: row.label ?? row.s!, text: "" });
          if (row.text && !record.text.includes(row.text))
            record.text = `${record.text}\n${row.text}`.trim().slice(0, TEXT_CHARS);
        }
        return out;
      })());
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
  function valueFacts(iri: string, label: string, v: Value) {
    const target = { ...source(iri, v.property), name: `${v.property} = ${v.value}`.slice(0, 200) };
    return {
      properties: [
        { ...entityRef(iri, settings.className, label), properties: { [v.property]: v.value } },
        {
          ...target,
          properties: { property: v.property, value: String(v.value), support: v.support! },
        },
      ],
      edge: {
        source: entityRef(iri, settings.className, label),
        relation: "HAS_VALUE_SOURCE",
        target,
        confidence: v.support!,
        evidence: { text: v.quote, source_id: label.slice(0, 200) },
      },
    };
  }
}
