// ontology-fit: read the text of each new or changed instance of a class
// and propose the ontology changes the text supports, as review items.
//
// A triggered workflow of the starter workflow `workflow` watches a class and
// its text field, and sends the new and changed instances to this workflow.
// For each instance the workflow asks the reasoning model (`reason`) which
// classes, properties and relations the text needs that the ontology lacks,
// each with a sentence of the text as its quote. It keeps a proposal when the
// quote is in the text and a dry run of the change (`evolve` with `dryRun`)
// says the ontology does not have it yet. Each kept change becomes a review
// item with the change: a person accepts it, and the ontology changes.
//
// A change's key names it (`fit:<workflow>/add_class/mangel`), so the same
// change from several texts is one review item.
import {
  LbbError,
  triggeredWorkflow,
  type LbbActivities,
  type Schemas,
  type WorkflowTriggerMessage,
} from "@littlebigbrain/client";

export interface Settings {
  /** The class whose instances hold the text. */
  className: string;
  /** The property that holds each instance's text. */
  textField: string;
  /** One sentence about what the text is, for the model. */
  context: string;
}

/** The settings: edit them for your class. These fit the samples. */
export const defaults: Settings = {
  className: "Baustellenbericht",
  textField: "text",
  context: "Site reports and meeting minutes of a school building project, in German",
};

/** The workflow type and version the triggered workflow names. */
export const workflowType = { workflow_type: "ontology-fit", version: "v1" };

/** The triggered workflow that sends the texts to this workflow. Its name starts every key. */
export function trigger(settings: Settings = defaults): Schemas["TriggeredWorkflowRequest"] {
  return {
    starter: "workflow",
    name: "berichte",
    watch: { class: settings.className, fields: [settings.textField] },
    workflow: workflowType,
    batch: 8,
  };
}

/** The class the workflow reads, for `lbb.evolve`. */
export function ontology(settings: Settings = defaults): Schemas["OntologyEvolveOp"][] {
  return [
    { op: "add_entity_type", name: settings.className },
    { op: "add_property", name: settings.textField, value_type: "text" },
  ];
}

export interface FitState {
  texts: number;
  proposals: number;
  filed: number;
}

/** One proposal as the model gives it: every field a string, empty when the kind does not use it. */
interface Raw {
  kind: string;
  name: string;
  parent: string;
  class: string;
  value_type: string;
  domain: string;
  range: string;
  quote: string;
  reason: string;
}

/** A proposal as a change: its key, title and evolve operations, and the quote that supports it. */
export interface Change {
  key: string;
  title: string;
  anchor: Schemas["SuggestionAnchor"];
  change: Schemas["OntologyEvolveOp"][];
  quote: string;
  reason: string;
}

const SYSTEM = `You read text from a knowledge graph and propose changes to its ontology. The ontology has classes, relations between classes, and properties. Propose only changes that the text supports and that the ontology does not have yet:
- add_class: a new kind of thing the text talks about, with its parent class when one in the ontology fits (\`name\`, \`parent\`).
- add_property: a new fact that instances of a class carry (\`name\`, \`class\`, \`value_type\`).
- add_relation: a new link between two classes (\`name\`, \`domain\`, \`range\`).
- widen_relation: an existing relation that should also start at (\`domain\`) or point to (\`range\`) another class (\`name\` is the relation).
Rules:
- Propose kinds of things and links that many texts like this one hold. Do not propose one person, one date, one number, or one event as a class.
- Each proposal quotes one sentence of the text in \`quote\`, copied exactly, character for character. A proposal without an exact quote is dropped.
- Use the ontology's names for existing classes and relations. Name new classes as singular nouns, as the ontology names its classes. Name new relations as verbs and new properties as nouns, in the naming style the ontology states (UPPER_SNAKE_CASE relations and snake_case properties when it states none).
- A list may follow of the changes already proposed and waiting for review. When the text supports one of them, propose it again with exactly the same names: it adds evidence. Never propose a synonym of a relation or property the ontology has or the list holds, and never the inverse of one.
- \`reason\` is one short sentence.
- Leave the fields a kind does not use empty.
- Propose at most 12 changes. An empty list is a good answer when the ontology covers the text.`;

const text = (description: string) => ({ type: "string", description });
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "name",
          "parent",
          "class",
          "value_type",
          "domain",
          "range",
          "quote",
          "reason",
        ],
        properties: {
          kind: {
            type: "string",
            enum: ["add_class", "add_property", "add_relation", "widen_relation"],
          },
          name: text(
            "The new class, property or relation; for widen_relation the existing relation.",
          ),
          parent: text("add_class: the parent class, or empty."),
          class: text("add_property: the class whose instances carry the property."),
          value_type: {
            type: "string",
            enum: ["", "text", "keyword", "i64", "f64", "bool", "date_time"],
            description: "add_property: the type of the values.",
          },
          domain: text("add_relation and widen_relation: the source class."),
          range: text("add_relation and widen_relation: the target class."),
          quote: text("One sentence of the text, copied exactly."),
          reason: text("Why the text needs this change, one short sentence."),
        },
      },
    },
  },
};

/** Texts one turn reads: one step each. */
const TURN_INSTANCES = 48;
const TEXT_CHARS = 40_000;
const PLAIN_IRI = /^[^\s<>"{}|\\^`]+$/;
const normalize = (value: string) => value.split(/\s+/).filter(Boolean).join(" ");

/** A part of a key: lowercase ASCII letters and digits, every other run as one dash. */
export function keyPart(value: string): string {
  const part = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return part || "x";
}

/** The ontology as the model reads it, and its names by lower case. */
export function describe(view: Schemas["OntologyView"]) {
  const types = (view.entity_type_defs ?? []).filter((t) => t.removed_version == null);
  const relations = (view.relation_defs ?? []).filter((r) => r.removed_version == null);
  const properties = view.property_defs ?? [];
  const byId = new Map(types.map((t) => [t.stable_id, t.name]));
  const side = (names: string[]) => (names.length ? names.join(" | ") : "any");
  const lines = [
    "Classes (name: parent classes):",
    ...types.map(
      (t) =>
        `- ${t.name}${t.super_types?.length ? `: ${t.super_types.map((id) => byId.get(id) ?? id).join(", ")}` : ""}`,
    ),
    "Relations (name: domain -> range):",
    ...relations.map((r) => `- ${r.name}: ${side(r.src_types)} -> ${side(r.dst_types)}`),
    "Properties (graph-wide fields, name: value type):",
    ...properties.map((p) => `- ${p.name}: ${p.value_type}`),
  ];
  const index = (names: string[]) => new Map(names.map((n) => [n.toLowerCase(), n]));
  return {
    text: lines.join("\n"),
    classes: index(types.map((t) => t.name)),
    relations: index(relations.map((r) => r.name)),
    properties: index(properties.map((p) => p.name)),
  };
}
type Ontology = ReturnType<typeof describe>;

/** A raw proposal as a change with its key, or null when it has no shape. Adapted from fit_sources.rs. */
export function shape(source: string, raw: Raw, onto: Ontology): Change | null {
  const name = raw.name.trim();
  if (!name || !["add_class", "add_property", "add_relation", "widen_relation"].includes(raw.kind))
    return null;
  const cls = (n: string) => onto.classes.get(n.trim().toLowerCase()) ?? n.trim();
  const declare = (names: string[]): Schemas["OntologyEvolveOp"][] =>
    [...new Set(names.filter((n) => n && !onto.classes.has(n.toLowerCase())))].map((n) => ({
      op: "add_entity_type",
      name: n,
    }));
  const base = { quote: raw.quote, reason: raw.reason.trim() };
  // A new relation with the name of an existing one widens it.
  const relation = onto.relations.get(name.toLowerCase());
  const kind = raw.kind === "add_relation" && relation ? "widen_relation" : raw.kind;
  const prefix = `fit:${source}/${kind}`;
  if (kind === "add_class") {
    const parent =
      raw.parent.trim() && raw.parent.trim().toLowerCase() !== name.toLowerCase()
        ? cls(raw.parent)
        : "";
    const change: Schemas["OntologyEvolveOp"][] = [
      { op: "add_entity_type", name: cls(name) },
      ...declare([parent]),
    ];
    if (parent)
      change.push({ op: "add_super_types", entity_type: cls(name), super_types: [parent] });
    return {
      ...base,
      key: `${prefix}/${keyPart(cls(name))}`,
      title: parent ? `Add class ${cls(name)} under ${parent}` : `Add class ${cls(name)}`,
      anchor: { kind: "class", name: cls(name) },
      change,
    };
  }
  if (kind === "add_property") {
    if (!raw.class.trim()) return null;
    const property = onto.properties.get(name.toLowerCase()) ?? name;
    const type = ["text", "keyword", "i64", "f64", "bool", "date_time"].includes(raw.value_type)
      ? raw.value_type
      : "text";
    return {
      ...base,
      key: `${prefix}/${keyPart(cls(raw.class))}/${keyPart(property)}`,
      title: `Add property ${property} to ${cls(raw.class)}`,
      anchor: { kind: "property", name: property },
      change: [{ op: "add_property", name: property, value_type: type }],
    };
  }
  const [domain, range] = [
    raw.domain.trim() ? cls(raw.domain) : "",
    raw.range.trim() ? cls(raw.range) : "",
  ];
  if (kind === "add_relation") {
    if (!domain || !range) return null;
    return {
      ...base,
      key: `${prefix}/${keyPart(domain)}/${keyPart(name)}/${keyPart(range)}`,
      title: `Add relation ${name} from ${domain} to ${range}`,
      anchor: { kind: "relation", name },
      change: [
        ...declare([domain, range]),
        { op: "add_relation", name, domain: [domain], range: [range] },
      ],
    };
  }
  if (!domain && !range) return null;
  const widened = relation ?? name;
  const title =
    domain && range
      ? `Let ${widened} link ${domain} to ${range}`
      : domain
        ? `Let ${widened} start at ${domain}`
        : `Let ${widened} point to ${range}`;
  const widen: Schemas["OntologyEvolveOp"] = {
    op: "widen_relation",
    relation: widened,
    add_domain: domain ? [domain] : [],
    add_range: range ? [range] : [],
  };
  return {
    ...base,
    key: `${prefix}/${keyPart(widened)}/${keyPart(domain || "-")}/${keyPart(range || "-")}`,
    title,
    anchor: { kind: "relation", name: widened },
    change: [...declare([domain, range]), widen],
  };
}

/** A quote must be in the text, whitespace normalized, with at least three words. */
export const quoteInText = (quote: string, value: string) =>
  normalize(quote).split(" ").length >= 3 && normalize(value).includes(normalize(quote));

/** The workflow, for a `WorkflowWorker`. `lbb` is `lbbActivities(client)`, or a mock in a test. */
export function createWorkflow(lbb: LbbActivities, settings: Settings = defaults) {
  return triggeredWorkflow<FitState>({
    name: workflowType.workflow_type,
    version: workflowType.version,
    initialState: { texts: 0, proposals: 0, filed: 0 },
    async onInstances(ctx, message, state) {
      const batch = message.instances.slice(0, TURN_INSTANCES);
      const texts = reader(message, batch);
      let onto: Promise<Ontology> | undefined;
      const kept: Change[][] = [];
      for (const [i, iri] of batch.entries()) {
        kept.push(
          await ctx.step(`propose-${i}`, async (s) => {
            s.progress("reading texts", { done: i, total: batch.length, unit: "instances" });
            const record = (await texts())[iri];
            if (!record?.text.trim()) return [];
            const ontology = await (onto ??= lbb.ontology().then(describe));
            // The changes the earlier texts of this turn proposed: the model proposes them again by the same names.
            const earlier = [...new Set(kept.flat().map((c) => c.title))];
            const system = [
              SYSTEM,
              `The ontology now:\n${ontology.text}`,
              ...(earlier.length
                ? [
                    `Changes already proposed and waiting for review:\n${earlier.map((t) => `- ${t}`).join("\n")}`,
                  ]
                : []),
            ].join("\n\n");
            const prompt = JSON.stringify({
              class: settings.className,
              context: settings.context,
              instance: record.label,
              text: record.text,
            });
            const answer = await lbb.reason<{ proposals: Raw[] }>(
              { system, prompt, schema: SCHEMA, max_tokens: 16_000 },
              { effectId: s.effectId, label: `${record.label.slice(0, 50)} fit` },
            );
            const out: Change[] = [];
            for (const raw of (answer.value.proposals ?? []).slice(0, 12)) {
              const change = shape(message.workflow, raw, ontology);
              if (
                !change ||
                out.some((c) => c.key === change.key) ||
                !quoteInText(change.quote, record.text)
              )
                continue;
              // A dry run: a change the ontology has already is a no-op.
              const preview = await lbb
                .evolve(change.change, { dryRun: true })
                .catch((error: unknown) => {
                  if (error instanceof LbbError && error.status === 400) return null;
                  throw error;
                });
              if (preview && !preview.no_op && preview.publishable) out.push(change);
            }
            return out;
          }),
        );
      }
      const filed = await ctx.step("review", async (s) => {
        const records = await texts();
        const byKey = new Map<
          string,
          { change: Change; samples: { entity: string; label: string; quote: string }[] }
        >();
        for (const [i, changes] of kept.entries())
          for (const change of changes) {
            const group = byKey.get(change.key) ?? { change, samples: [] };
            group.samples.push({
              entity: batch[i]!,
              label: records[batch[i]!]?.label ?? "",
              quote: change.quote.slice(0, 600),
            });
            byKey.set(change.key, group);
          }
        for (const [n, { change, samples }] of [...byKey.values()].entries()) {
          s.progress("filing review items", { done: n, total: byKey.size, unit: "items" });
          await lbb.review({
            workflow: message.workflow,
            key: change.key,
            title: change.title.slice(0, 200),
            rationale: `${change.reason} "${change.quote.slice(0, 600)}"`.trim().slice(0, 4_000),
            anchor: change.anchor,
            change: change.change,
            evidence: { records: samples.length, samples: samples.slice(0, 20) },
          });
        }
        return byKey.size;
      });
      const next = {
        texts: state.texts + batch.length,
        proposals: state.proposals + kept.flat().length,
        filed: state.filed + filed,
      };
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
        const query = `# ontology-fit: texts
SELECT ?s ?label ?text WHERE {
  VALUES ?s { ${iris
    .filter((iri) => PLAIN_IRI.test(iri))
    .map((iri) => `<${iri}>`)
    .join(" ")} }
  OPTIONAL { ?s <http://www.w3.org/2000/01/rdf-schema#label> ?label }
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
}
