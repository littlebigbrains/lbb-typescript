// ontology-fit: read the text of each new or changed instance of a class
// and propose the ontology changes the text supports, as review items. The
// rules are those of LBB's fit from text (`ontology.fit@v1`, the fit sources
// of lbb-graph-query/src/fit_sources.rs); its eval (sdk/templates/_evals)
// runs both on the same recorded model answers.
//
// A triggered workflow of the starter workflow `workflow` watches a class and
// its text field, and sends the new and changed instances to this workflow.
// For each instance the workflow:
//
// 1. asks the reasoning model (`reason`), one call per chunk of the text,
//    which classes, properties and relations the text needs that the
//    ontology lacks, each with a sentence of the text as its quote. The model
//    reads the ontology and the changes already proposed and waiting for
//    review, so it proposes them again by the same names;
// 2. checks each proposal without a model: its shape (with the ontology's
//    name style), one per change, its quote in the text, and a dry run of the
//    change (`evolve` with `dryRun`): a change the ontology has is
//    `already_covered`;
// 3. asks the decision model (`decide`) how well each quote supports its
//    change; a change below 0.5 is dropped (`weak_support`);
// 4. merges the kept changes into the review items: one per change, keyed by
//    it (`fit:<workflow>/add_class/mangel`), with the best supported samples
//    of every text that supports it.
import {
  isActivityRefused,
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
  /** One sentence about what the text is, for the models. */
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

/** The counters of the workflow: those of LBB's fit sources. */
export interface FitState {
  instances: number;
  chunks: number;
  failed_chunks: number;
  proposals: number;
  kept: number;
  filed: number;
  updated: number;
  reopened: number;
  quote_not_found: number;
  invalid: number;
  already_covered: number;
  weak_support: number;
  skipped: number;
}

const ZERO: FitState = {
  instances: 0,
  chunks: 0,
  failed_chunks: 0,
  proposals: 0,
  kept: 0,
  filed: 0,
  updated: 0,
  reopened: 0,
  quote_not_found: 0,
  invalid: 0,
  already_covered: 0,
  weak_support: 0,
  skipped: 0,
};

/** One proposal as the model gives it: every field a string, empty when the kind does not use it. */
export interface Raw {
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

type Kind = "add_class" | "add_property" | "add_relation" | "widen_relation";

/** A proposal as a change: its kind, name, key, title, anchor and evolve operations. */
export interface Change {
  kind: Kind;
  name: string;
  key: string;
  title: string;
  anchor: Schemas["SuggestionAnchor"];
  change: Schemas["OntologyEvolveOp"][];
}

/** What one proposal became. */
export interface Proposal {
  key: string;
  title: string;
  kind: Kind;
  anchor?: Schemas["SuggestionAnchor"];
  change?: Schemas["OntologyEvolveOp"][];
  quote: string;
  reason: string;
  support?: number;
  outcome: "kept" | "quote_not_found" | "invalid" | "already_covered" | "weak_support";
  detail?: string;
}

/** The system prompt of LBB's fit (`SYSTEM_PROMPT`). */
export const SYSTEM = `You read text from a knowledge graph and propose changes to its ontology. The ontology has classes, relations between classes, and properties. Propose only changes that the text supports and that the ontology does not have yet:
- add_class: a new kind of thing the text talks about, with its parent class when one in the ontology fits (\`name\`, \`parent\`).
- add_property: a new fact that instances of a class carry (\`name\`, \`class\`, \`value_type\`).
- add_relation: a new link between two classes (\`name\`, \`domain\`, \`range\`).
- widen_relation: an existing relation that should also start at (\`domain\`) or point to (\`range\`) another class (\`name\` is the relation).
Rules:
- Propose kinds of things and links that many texts like this one hold. Do not propose one person, one date, one number, or one event as a class.
- Each proposal quotes one sentence of the text in \`quote\`, copied exactly, character for character. A proposal without an exact quote is dropped.
- Use the ontology's names for existing classes and relations. Name new classes as singular nouns, as the ontology names its classes. Name new relations as verbs and new properties as nouns, in the naming style the ontology states (UPPER_SNAKE_CASE relations and snake_case properties when it states none).
- A list may follow of the changes already proposed from this source and waiting for review. When the text supports one of them, propose it again with exactly the same names: it adds evidence. Never propose a synonym of a relation or property the ontology has or the list holds (\`holds\` beside \`holds_certificate\`, \`uses\` beside \`uses_system\`), and never the inverse of one (\`contract_with\` beside \`has_contract\`). Never propose a change the rejected list names.
- \`reason\` is one short sentence.
- Leave the fields a kind does not use empty.
- Propose at most 12 changes. An empty list is a good answer when the ontology covers the text.`;

const SCORE_INSTRUCTIONS =
  "The state holds the ontology of a knowledge graph and the class whose text was read. A model proposed a change to the ontology and quoted a sentence of the text to support it. How well does the quote support the change?";
const SCORE_CRITERIA: Record<string, string> = {
  already_covered: "The ontology already has a class, property or relation that holds this.",
  not_supported: "The quote does not say what the change needs.",
  supported:
    "The quote states that this kind of thing, fact or link exists in the domain, so the ontology needs the change.",
  weak: "The quote mentions it only in passing, or it fits one case and not a kind of thing.",
};

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

/** Texts one turn reads: two steps each, after the step that reads the inbox. */
const TURN_INSTANCES = 24;
/** Characters of an instance's text, and of one chunk the model reads, and their overlap. */
const TEXT_CHARS = 400_000;
const CHUNK_CHARS = 40_000;
const CHUNK_OVERLAP_CHARS = 1_000;
const PROPOSALS_PER_CHUNK = 12;
const SCORE_BATCH = 20;
const SUPPORT_MIN = 0.5;
const SAMPLES = 20;
const QUOTE_MIN_WORDS = 3;
const ONTOLOGY_MAX_CHARS = 24_000;
const ONTOLOGY_MAX_TERMS = 400;
const KEY_PART_CHARS = 48;
const PROPOSED_MAX = 200;
const REJECTED_MAX = 100;
const VALUE_TYPES = ["bool", "i64", "f64", "date_time", "keyword", "text", "bytes"];
const PLAIN_IRI = /^[^\s<>"{}|\\^`]+$/;
const ENTITY_IRI = /^https:\/\/littlebigbrain\.com\/e\/[0-9a-fA-F]{32}$/;
const LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const P = "https://littlebigbrain.com/p/";
const CLASS_NS = "https://littlebigbrain.com/class/";
const normalize = (value: string) => value.split(/\s+/).filter(Boolean).join(" ");
/** Cut at `max` characters with an ellipsis, as LBB cuts a title or a quote. */
const clip = (value: string, max: number) => {
  const all = [...value];
  return all.length <= max ? value : `${all.slice(0, max - 1).join("")}…`;
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The IRI a records graph gives a class name. */
export const classIri = (name: string) =>
  CLASS_NS + encodeURIComponent(name.trim().toLowerCase().split(/\s+/).join(" "));

/** A class's name as LBB's fit gives it to the models: the words of its IRI's local name, in lower case. */
export function displayName(local: string): string {
  let out = "";
  let previousLower = false;
  for (const c of local) {
    if (c === "_" || c === "-" || c === ".") {
      if (out && !out.endsWith(" ")) out += " ";
      previousLower = false;
      continue;
    }
    const upper = c !== c.toLowerCase() && c === c.toUpperCase();
    if (upper && previousLower) out += " ";
    previousLower = (c !== c.toUpperCase() && c === c.toLowerCase()) || /[0-9]/.test(c);
    out += c.toLowerCase();
  }
  return out.trim() || local;
}

/** A part of a key: lowercase ASCII letters and digits, every other run as one dash. */
export function keyPart(value: string): string {
  const part = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return [...part].slice(0, KEY_PART_CHARS).join("").replace(/-+$/, "") || "x";
}

type Style = "lower" | "upper";

/** The words of a name: `SENDS_INVOICE`, `sendsInvoice`, `sends invoice`, `HTTPServer`. */
function nameWords(name: string): string[] {
  const chars = [...name];
  const words: string[] = [];
  let word = "";
  const isUpper = (c?: string) => c !== undefined && c !== c.toLowerCase() && c === c.toUpperCase();
  const isLower = (c?: string) => c !== undefined && c !== c.toUpperCase() && c === c.toLowerCase();
  for (const [i, c] of chars.entries()) {
    if (!/[\p{L}\p{N}]/u.test(c)) {
      if (word) words.push(word);
      word = "";
      continue;
    }
    const previous = chars[i - 1];
    const next = chars[i + 1];
    const hump =
      isUpper(c) &&
      previous !== undefined &&
      (isLower(previous) || /[0-9]/.test(previous) || (isUpper(previous) && isLower(next)));
    if (hump && word) {
      words.push(word);
      word = "";
    }
    word += c;
  }
  if (word) words.push(word);
  return words;
}

/** The style most names share, when at least 60% have it. */
function nameStyle(names: string[]): Style | null {
  if (!names.length) return null;
  const lower = names.filter((n) => /^[a-z][a-z0-9_]*$/.test(n)).length;
  const upper = names.filter((n) => /^[A-Z][A-Z0-9_]*$/.test(n)).length;
  if (lower * 10 >= names.length * 6) return "lower";
  if (upper * 10 >= names.length * 6) return "upper";
  return null;
}

const styled = (style: Style, name: string) => {
  const words = nameWords(name).join("_");
  return style === "lower" ? words.toLowerCase() : words.toUpperCase();
};

/** The ontology as LBB's fit reads it: a text for the models, its names by lower case, and its name styles. */
export function describe(view: Schemas["OntologyView"]) {
  const types = (view.entity_type_defs ?? []).filter((t) => t.removed_version == null);
  const byId = new Map((view.entity_type_defs ?? []).map((t) => [t.stable_id, t.name]));
  const classes = new Map<string, string>();
  const relations = new Map<string, string>();
  const properties = new Map<string, string>();
  const lines = ["Classes (name: parent classes):"];
  for (const t of types.slice(0, ONTOLOGY_MAX_TERMS)) {
    classes.set(t.name.toLowerCase(), t.name);
    const parents = (t.super_types ?? []).map((id) => byId.get(id) ?? id);
    lines.push(parents.length ? `- ${t.name}: ${parents.join(", ")}` : `- ${t.name}`);
  }
  lines.push("Relations (name: domain -> range):");
  const side = (names: string[]) => (names.length ? names.join(" | ") : "any");
  for (const r of (view.relation_defs ?? [])
    .filter((r) => r.removed_version == null)
    .slice(0, ONTOLOGY_MAX_TERMS)) {
    relations.set(r.name.toLowerCase(), r.name);
    lines.push(`- ${r.name}: ${side(r.src_types)} -> ${side(r.dst_types)}`);
  }
  lines.push("Properties (graph-wide fields, name: value type):");
  for (const p of (view.property_defs ?? []).slice(0, ONTOLOGY_MAX_TERMS)) {
    properties.set(p.name.toLowerCase(), p.name);
    lines.push(`- ${p.name}: ${p.value_type}`);
  }
  // As LBB's maps keep them: in name order.
  const sorted = (m: Map<string, string>) =>
    [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
  const relationStyle = nameStyle(sorted(relations));
  const propertyStyle = nameStyle(sorted(properties));
  const describeStyle = (s: Style) =>
    s === "lower" ? "lower snake_case (works_in)" : "upper snake_case (WORKS_IN)";
  const naming = ["Naming: classes as the ontology names them."];
  if (relationStyle)
    naming.push(
      `Relations are ${describeStyle(relationStyle)} like the ontology's; a new relation must be too.`,
    );
  if (propertyStyle)
    naming.push(
      `Properties are ${describeStyle(propertyStyle)} like the ontology's; a new property must be too.`,
    );
  lines.push(naming.join(" "));
  let out = "";
  for (const line of lines) {
    if (
      new TextEncoder().encode(out).length + new TextEncoder().encode(line).length + 1 >
      ONTOLOGY_MAX_CHARS
    ) {
      out += "- … (more elements not shown)\n";
      break;
    }
    out += `${line}\n`;
  }
  const relation = (name: string) => relations.get(name.trim().toLowerCase());
  return {
    text: out,
    classes,
    relations,
    properties,
    relation,
    className: (name: string) => classes.get(name.trim().toLowerCase()) ?? name.trim(),
    relationName: (name: string) => {
      const n = name.trim();
      const s = relationStyle ? styled(relationStyle, n) : n;
      return relation(n) ?? relation(s) ?? s;
    },
    propertyName: (name: string) => {
      const n = name.trim();
      const s = propertyStyle ? styled(propertyStyle, n) : n;
      return properties.get(n.toLowerCase()) ?? properties.get(s.toLowerCase()) ?? s;
    },
  };
}
type Ontology = ReturnType<typeof describe>;

/** An evolve operation with every field, as LBB writes and describes it. */
type Op = Schemas["OntologyEvolveOp"];
const addEntityType = (name: string): Op => ({ op: "add_entity_type", name });

/** A raw proposal as a change with its key, or why it has none (LBB's `shape_proposal`). */
export function shape(source: string, raw: Raw, onto: Ontology): Change | { error: string } {
  const kinds: Kind[] = ["add_class", "add_property", "add_relation", "widen_relation"];
  let kind = kinds.find((k) => k === raw.kind.trim());
  if (!kind) return { error: `unknown kind \`${raw.kind}\`` };
  const rawName = raw.name.trim();
  if (!rawName) return { error: "the proposal has no name" };
  const name =
    kind === "add_relation" || kind === "widen_relation"
      ? onto.relationName(rawName)
      : kind === "add_property"
        ? onto.propertyName(rawName)
        : rawName;
  // A new relation with the name of an existing one widens it.
  if (kind === "add_relation" && onto.relation(name)) kind = "widen_relation";
  const declare = (cls: string, ops: Op[]) => {
    const declared = ops.some(
      (op) => op.op === "add_entity_type" && same((op as { name: string }).name, cls),
    );
    if (!onto.classes.has(cls.trim().toLowerCase()) && !declared) ops.push(addEntityType(cls));
  };
  const prefix = `fit:${source}/${kind}`;
  const done = (c: Change): Change => ({ ...c, title: clip(c.title, 200) });
  if (kind === "add_class") {
    const cls = onto.className(name);
    const parent = raw.parent.trim();
    const change: Op[] = [addEntityType(cls)];
    let title = `Add class ${cls}`;
    if (parent && !same(parent, cls)) {
      const p = onto.className(parent);
      declare(p, change);
      change.push({ op: "add_super_types", entity_type: cls, super_types: [p] });
      title = `Add class ${cls} under ${p}`;
    }
    return done({
      kind,
      name: cls,
      key: `${prefix}/${keyPart(cls)}`,
      title,
      anchor: { kind: "class", name: cls },
      change,
    });
  }
  if (kind === "add_property") {
    if (!raw.class.trim()) return { error: "the property names no class" };
    const cls = onto.className(raw.class);
    const type = raw.value_type.trim().toLowerCase();
    return done({
      kind,
      name,
      key: `${prefix}/${keyPart(cls)}/${keyPart(name)}`,
      title: `Add property ${name} to ${cls}`,
      anchor: { kind: "property", name },
      change: [
        {
          op: "add_property",
          name,
          value_type: VALUE_TYPES.includes(type) ? type : "text",
          required: false,
          allowed_values: [],
        },
      ],
    });
  }
  if (kind === "add_relation") {
    if (!raw.domain.trim() || !raw.range.trim())
      return { error: "the relation needs a domain and a range" };
    const [domain, range] = [onto.className(raw.domain), onto.className(raw.range)];
    const change: Op[] = [];
    declare(domain, change);
    declare(range, change);
    change.push({
      op: "add_relation",
      name,
      domain: [domain],
      range: [range],
      cardinality: null,
      temporal_semantics: null,
      reducer: null,
      inverse_name: null,
      transitive: false,
      symmetric: false,
    } as Op);
    return done({
      kind,
      name,
      key: `${prefix}/${keyPart(domain)}/${keyPart(name)}/${keyPart(range)}`,
      title: `Add relation ${name} from ${domain} to ${range}`,
      anchor: { kind: "relation", name },
      change,
    });
  }
  const relation = onto.relation(name) ?? name;
  if (!raw.domain.trim() && !raw.range.trim()) return { error: "the widening adds no class" };
  const domain = raw.domain.trim() ? onto.className(raw.domain) : "";
  const range = raw.range.trim() ? onto.className(raw.range) : "";
  const change: Op[] = [];
  for (const cls of [domain, range].filter(Boolean)) declare(cls, change);
  change.push({
    op: "widen_relation",
    relation,
    add_domain: domain ? [domain] : [],
    add_range: range ? [range] : [],
  });
  const title =
    domain && range
      ? `Let ${relation} link ${domain} to ${range}`
      : domain
        ? `Let ${relation} start at ${domain}`
        : `Let ${relation} point to ${range}`;
  return done({
    kind,
    name: relation,
    key: `${prefix}/${keyPart(relation)}/${keyPart(domain || "-")}/${keyPart(range || "-")}`,
    title,
    anchor: { kind: "relation", name: relation },
    change,
  });
}

/** An operation as LBB writes it in a change's description: every field, in its order. */
export function opJson(op: Op): string {
  const o = op as Record<string, unknown>;
  switch (op.op) {
    case "add_entity_type":
      return JSON.stringify({ op: o.op, name: o.name });
    case "add_super_types":
      return JSON.stringify({ op: o.op, entity_type: o.entity_type, super_types: o.super_types });
    case "add_property":
      return JSON.stringify({
        op: o.op,
        name: o.name,
        value_type: o.value_type ?? null,
        required: o.required ?? false,
        allowed_values: o.allowed_values ?? [],
      });
    case "add_relation":
      return JSON.stringify({
        op: o.op,
        name: o.name,
        domain: o.domain ?? [],
        range: o.range ?? [],
        cardinality: o.cardinality ?? null,
        temporal_semantics: o.temporal_semantics ?? null,
        reducer: o.reducer ?? null,
        inverse_name: o.inverse_name ?? null,
        transitive: o.transitive ?? false,
        symmetric: o.symmetric ?? false,
      });
    case "widen_relation":
      return JSON.stringify({
        op: o.op,
        relation: o.relation,
        add_domain: o.add_domain ?? [],
        add_range: o.add_range ?? [],
      });
    default:
      return JSON.stringify(op);
  }
}

/** Why a quote does not hold, or null: it has at least three words and is in the text, whitespace normalized. */
export function quoteProblem(quote: string, value: string): string | null {
  const q = normalize(quote);
  if ((q ? q.split(" ").length : 0) < QUOTE_MIN_WORDS)
    return `the quote has fewer than ${QUOTE_MIN_WORDS} words`;
  return normalize(value).includes(q) ? null : "the quote is not in the text";
}

/** A quote must be in the text, whitespace normalized, with at least three words. */
export const quoteInText = (quote: string, value: string) => quoteProblem(quote, value) === null;

/** The chunks of a text: at most `max` characters, cut after a sentence end or a space in the last tenth, `overlap` shared. */
export function chunkText(value: string, max = CHUNK_CHARS, overlap = CHUNK_OVERLAP_CHARS) {
  const chars = [...value];
  if (chars.length <= max) return [value];
  overlap = Math.min(overlap, Math.floor(max / 2));
  const space = (c: string) => /\s/.test(c);
  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + max, chars.length);
    if (end < chars.length) {
      const floor = Math.max(start + Math.floor((max * 9) / 10), start + 1);
      let cut: number | undefined;
      for (let i = end - 1; i >= floor; i--)
        if (/[.!?\n]/.test(chars[i - 1]!) && space(chars[i]!)) {
          cut = i;
          break;
        }
      if (cut === undefined)
        for (let i = end - 1; i >= floor; i--)
          if (space(chars[i]!)) {
            cut = i;
            break;
          }
      if (cut !== undefined) end = cut;
    }
    chunks.push(chars.slice(start, end).join(""));
    if (end >= chars.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

/** The changes already proposed and the rejected names, as the reasoning model reads them. */
class Proposed {
  constructor(
    readonly open: string[] = [],
    readonly rejected: string[] = [],
  ) {}
  text(): string {
    let out = "";
    if (this.open.length)
      out += `Changes already proposed from this source and waiting for review (newest support first):\n${this.open.map((t) => `- ${t}\n`).join("")}`;
    if (this.rejected.length)
      out += `Already rejected, do not propose: ${this.rejected.join(", ")}\n`;
    return out;
  }
  addOpen(title: string) {
    const at = this.open.indexOf(title);
    if (at >= 0) this.open.splice(at, 1);
    this.open.unshift(title);
    this.open.length = Math.min(this.open.length, PROPOSED_MAX);
  }
}

/** What one instance's proposal step gave. */
interface Read {
  missing?: boolean;
  chunks: number;
  failed_chunks: number;
  proposals: Proposal[];
}

/** The workflow, for a `WorkflowWorker`. `lbb` is `lbbActivities(client)`, or a mock in a test. */
export function createWorkflow(lbb: LbbActivities, settings: Settings = defaults) {
  const iri = classIri(settings.className);
  const className = displayName(iri.slice(iri.lastIndexOf("/") + 1));
  return triggeredWorkflow<FitState, { counters: FitState }>({
    name: workflowType.workflow_type,
    version: workflowType.version,
    initialState: ZERO,
    async onInstances(ctx, message, state) {
      const source = message.workflow;
      const batch = message.instances.slice(0, TURN_INSTANCES);
      const texts = reader(message, batch);
      let onto: Promise<Ontology> | undefined;
      const ontology = () => (onto ??= lbb.ontology().then(describe));
      // The changes this workflow proposed before: its open review items, newest first, and the
      // names of the dismissed ones.
      const inbox = await ctx.step("inbox", async () => {
        const { suggestions } = await lbb.listReviews({ originId: `fit:${source}`, limit: 500 });
        const open: string[] = [];
        const rejected: string[] = [];
        for (const item of suggestions) {
          if (item.status === "open" && open.length < PROPOSED_MAX) open.push(item.title);
          if (item.status === "dismissed" && rejected.length < REJECTED_MAX) {
            const name = item.anchor?.name ?? item.title;
            if (!rejected.includes(name)) rejected.push(name);
          }
        }
        return { open, rejected };
      });
      const proposed = new Proposed([...inbox.open], [...inbox.rejected]);
      const tally: FitState = { ...ZERO };
      for (const [i, entity] of batch.entries()) {
        const read = await ctx.step(`propose-${i}`, async (s): Promise<Read> => {
          s.progress("reading texts", { done: i, total: batch.length, unit: "instances" });
          const record = (await texts())[entity];
          if (!record) return { missing: true, chunks: 0, failed_chunks: 0, proposals: [] };
          const out: Read = { chunks: 0, failed_chunks: 0, proposals: [] };
          if (!record.text.trim()) return out;
          const onto = await ontology();
          const listed = proposed.text();
          const system = [
            SYSTEM,
            `The ontology now:\n${onto.text}`,
            ...(listed ? [listed] : []),
          ].join("\n\n");
          const chunks = chunkText(record.text);
          const raw: Raw[] = [];
          for (const [n, chunk] of chunks.entries()) {
            const prompt = JSON.stringify({
              class: className,
              class_iri: iri,
              context: settings.context,
              instance: record.label,
              chunk: `${n + 1} of ${chunks.length}`,
              text: chunk,
            });
            out.chunks += 1;
            try {
              const answer = await lbb.reason<{ proposals?: Raw[] }>(
                { system, prompt, schema: SCHEMA, max_tokens: 16_000 },
                {
                  effectId: n ? `${s.effectId}.${n}` : s.effectId,
                  label: `${record.label.slice(0, 50)} fit`,
                },
              );
              raw.push(...(answer.value.proposals ?? []).slice(0, PROPOSALS_PER_CHUNK));
            } catch (error) {
              // No usable answer for the chunk: it counts as failed, and the instance goes on.
              if (!isActivityRefused(error)) throw error;
              out.failed_chunks += 1;
            }
          }
          // The checks that need no model: the shape, one per change, the quote, the dry run.
          const seen = new Set<string>();
          const passed: { proposal: Proposal; change: Change }[] = [];
          for (const r of raw) {
            const shaped = shape(source, r, onto);
            const base = {
              quote: r.quote,
              reason: clip(r.reason.trim(), 1_000),
            };
            if ("error" in shaped) {
              out.proposals.push({
                ...base,
                key: "",
                title: "",
                kind: "add_class",
                outcome: "invalid",
                detail: shaped.error,
              });
              continue;
            }
            const proposal: Proposal = {
              ...base,
              key: shaped.key,
              title: shaped.title,
              kind: shaped.kind,
              anchor: shaped.anchor,
              change: shaped.change,
              outcome: "invalid",
            };
            if (seen.has(shaped.key)) continue;
            seen.add(shaped.key);
            const problem = quoteProblem(r.quote, record.text);
            if (problem) {
              out.proposals.push({ ...proposal, outcome: "quote_not_found", detail: problem });
              continue;
            }
            const preview = await lbb
              .evolve(shaped.change, { dryRun: true })
              .catch((error: unknown) => {
                if (error instanceof LbbError && error.status === 400)
                  return { invalid: error.message.slice(0, 300) };
                throw error;
              });
            if ("invalid" in preview)
              out.proposals.push({ ...proposal, detail: String(preview.invalid) });
            else if (preview.no_op) out.proposals.push({ ...proposal, outcome: "already_covered" });
            else if (!preview.publishable)
              out.proposals.push({
                ...proposal,
                ...(preview.messages?.[0] ? { detail: preview.messages[0] } : {}),
              });
            else {
              passed.push({ proposal, change: shaped });
              out.proposals.push(proposal);
            }
          }
          // The support of the ones that passed: the decision model, 20 at a time.
          const support: (number | undefined)[] = [];
          for (let b = 0; b * SCORE_BATCH < passed.length; b++) {
            const items = passed.slice(b * SCORE_BATCH, (b + 1) * SCORE_BATCH);
            const { answers } = await lbb.decide(
              {
                state: { ontology: onto.text, class: className, context: settings.context },
                questions: Object.fromEntries(
                  items.map(({ proposal, change }, n) => [
                    `p${n}`,
                    {
                      instructions: `${SCORE_INSTRUCTIONS}\nInstance: ${record.label}\nChange: ${change.title} (${change.change.map(opJson).join("; ")})\nQuote: "${proposal.quote}"`,
                      criteria: SCORE_CRITERIA,
                    },
                  ]),
                ),
              },
              { effectId: `${s.effectId}.s${b}`, label: `${record.label.slice(0, 50)} support` },
            );
            for (const n of items.keys()) {
              const a = answers[`p${n}`];
              support.push(
                a?.probabilities?.supported ??
                  (a?.choice == null
                    ? undefined
                    : a.choice === "supported"
                      ? (a.confidence ?? 1)
                      : 0),
              );
            }
          }
          for (const [n, { proposal }] of passed.entries()) {
            const p = support[n];
            proposal.support = p;
            if (p !== undefined && p >= SUPPORT_MIN) proposal.outcome = "kept";
            else {
              proposal.outcome = "weak_support";
              if (p === undefined) proposal.detail = "the decision model did not answer";
            }
          }
          return out;
        });
        // The kept changes into the review items, one per change.
        const filed = await ctx.step(`file-${i}`, async (s) => {
          s.progress("filing review items", { done: i, total: batch.length, unit: "instances" });
          const result = { filed: 0, updated: 0, supported: [] as string[] };
          const record = (await texts())[entity];
          for (const p of read.proposals.filter((p) => p.outcome === "kept")) {
            const existing = await lbb.reviewItem(p.key);
            if (existing && ["accepted", "superseded", "dismissed"].includes(existing.status))
              continue;
            const previous = (existing?.evidence?.samples ?? []) as Record<string, unknown>[];
            // The instances that support the change: the item's count, and this one when it is new.
            const known = previous.some((sample) => sample.entity === entity);
            const records = (existing?.evidence?.records ?? 0) + (known ? 0 : 1);
            const sample = {
              entity,
              label: clip(record?.label ?? "", 120),
              quote: clip(normalize(p.quote), 600),
              support: Math.round((p.support ?? 0) * 100) / 100,
            };
            const samples = [...previous.filter((x) => x.entity !== entity), sample]
              .sort(
                (a, b) =>
                  Number(b.support ?? 0) - Number(a.support ?? 0) ||
                  (String(a.entity) < String(b.entity)
                    ? -1
                    : String(a.entity) > String(b.entity)
                      ? 1
                      : 0),
              )
              .slice(0, SAMPLES);
            const title = existing?.title ?? p.title;
            result.supported.push(title);
            await lbb.review({
              workflow: source,
              key: p.key,
              title,
              rationale: clip(
                `The text of ${records} instance${records === 1 ? "" : "s"} of ${className} supports this change. Model's reason: ${p.reason || "none given"}`,
                4_000,
              ),
              anchor: p.anchor!,
              origin: { kind: "agent", id: `fit:${source}`, label: `Fit from text (${source})` },
              change: existing?.change ?? p.change!,
              mapping: { fit_source: source, kind: p.kind },
              evidence: { records, samples, source_fields: [settings.textField] },
            });
            if (existing) result.updated += 1;
            else result.filed += 1;
          }
          return result;
        });
        for (const title of filed.supported) proposed.addOpen(title);
        if (read.missing) continue;
        tally.instances += 1;
        tally.chunks += read.chunks;
        tally.failed_chunks += read.failed_chunks;
        tally.proposals += read.proposals.length;
        for (const p of read.proposals) tally[p.outcome] += 1;
        tally.filed += filed.filed;
        tally.updated += filed.updated;
      }
      const next = Object.fromEntries(
        Object.keys(ZERO).map((k) => [
          k,
          (state[k as keyof FitState] ?? 0) + tally[k as keyof FitState],
        ]),
      ) as unknown as FitState;
      const result = { counters: tally };
      const rest = message.instances.slice(TURN_INSTANCES);
      return rest.length
        ? { ...ctx.continue(next, { ...message, instances: rest, removed: [] }), result }
        : { state: next, result };
    },
  });

  /** The label and text of each instance of the turn, read once per attempt at the message's commit. */
  function reader(message: WorkflowTriggerMessage, iris: string[]) {
    let read: Promise<Record<string, { label: string; text: string }>> | undefined;
    return () =>
      (read ??= (async () => {
        const plain = iris.filter((x) => PLAIN_IRI.test(x) && ENTITY_IRI.test(x));
        const query = `# ontology-fit: texts
SELECT ?s ?label ?text WHERE {
  VALUES ?s { ${plain.map((x) => `<${x}>`).join(" ")} }
  ?s a ?class .
  OPTIONAL { ?s <${LABEL}> ?label }
  OPTIONAL { ?s <${P}${encodeURIComponent(settings.textField.toLowerCase())}> ?text }
}`;
        const { rows } = await lbb.sparql({ query, as_of_commit_seq: message.as_of_commit_seq });
        const found = new Map<string, { labels: Set<string>; texts: Set<string> }>();
        for (const row of rows) {
          const at = found.get(row.s!) ?? { labels: new Set(), texts: new Set() };
          found.set(row.s!, at);
          if (row.label && normalize(row.label)) at.labels.add(normalize(row.label));
          if (row.text && normalize(row.text)) at.texts.add(normalize(row.text));
        }
        const out: Record<string, { label: string; text: string }> = {};
        for (const [x, at] of found) {
          // As LBB composes a text from its fields: `<field>: <values>`.
          const values = [...at.texts].sort();
          const value = values.length ? `${settings.textField}: ${values.join(", ")}` : "";
          out[x] = {
            label: [...at.labels].sort()[0] ?? x.slice(x.lastIndexOf("/") + 1),
            text: [...value].slice(0, TEXT_CHARS).join(""),
          };
        }
        return out;
      })());
  }
}
