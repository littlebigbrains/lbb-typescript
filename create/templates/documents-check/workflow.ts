// documents-check: check documents against each other, as candidates for a
// person to check.
//
// The pipeline is made of LBB's own parts, in the order a file travels:
//
// 1. Files. An upload of a PDF is a `Document`.
// 2. `documents.parse` (LBB-run) reads the PDF into pages, with every line and
//    its box, and writes the `Document`'s `parse_status`.
// 3. `documents-texts` (`texts.ts`, your worker) writes the text of each parsed
//    PDF as an instance of its class: a purchase order, a delivery note or an
//    invoice.
// 4. `values.extract` (LBB-run), one workflow per class, reads the `document_text` of
//    the instances and writes `reference`, `quantity`, `price`, `total` and
//    the references to the other documents, each with the quote that states it
//    and each number in the unit of its property (8000 g is 8 kg). A value
//    below the gate goes to a person as a `value` review item.
// 5. SHACL shapes (`checks.ts`) state the rules between the documents. LBB
//    validates them after each publication, in `warn` mode, and lists the
//    differences in the conformance report.
// 6. `documents-check` (`check.ts`, your worker) turns each difference into a
//    `choice` review item with the quotes of both documents as its evidence.
//    A person answers it in the Review inbox.
//
// Nothing here pays, approves or certifies. The output is a list of
// candidates for a person to check.
//
// `npm run setup` creates all of it on your graph; `npm start` serves the two
// workflows of your worker.
import type { LbbActivities, LbbClient, Schemas } from "@littlebigbrain/client";
import {
  CHECK_NAME,
  checkWorkflow,
  createCheckWorkflow,
  defaults as checkDefaults,
  type CheckPorts,
} from "./check.js";
import { checks, publishRequest } from "./checks.js";
import {
  DOCUMENT_CLASS,
  KINDS,
  TEXT_OF,
  SHA_PROPERTY,
  TEXT_PROPERTY,
  TEXTS_NAME,
  createTextsWorkflow,
  textsWorkflow,
} from "./texts.js";

export { CHECK_NAME, TEXTS_NAME, KINDS };
export type { CheckPorts };

export interface Settings {
  /** The support a value needs to be written; a value below it goes to a person. */
  gate: number;
  /** One sentence about what the documents are, for the model. */
  context: string;
  /** Review items one turn files, 1 to 40. A report with more new results files the rest in later turns. */
  candidatesPerTurn: number;
  /**
   * Publish `shapes.ttl` as the graph's shape set. Set it to false once you have
   * merged the rules into shapes of your own and publish them yourself: `setup`
   * then reads and writes no shape set.
   */
  publishShapes: boolean;
}

/** The settings: edit them for your documents. These fit the samples. */
export const defaults: Settings = {
  gate: 0.8,
  context: "Purchase orders, delivery notes and invoices of one purchase, in English.",
  candidatesPerTurn: checkDefaults.candidatesPerTurn,
  publishShapes: true,
};

/** The properties `values.extract` fills, with their types. `quantity` is in kg. */
export const PROPERTIES: Record<string, { type: string; unit?: string }> = {
  reference: { type: "keyword" },
  order: { type: "keyword" },
  delivery: { type: "keyword" },
  quantity: { type: "f64", unit: "kg" },
  price: { type: "f64" },
  total: { type: "f64" },
};

/** The classes, properties and relation the pipeline writes: `lbb.evolve(ontology())`. */
export function ontology(): Schemas["OntologyEvolveOp"][] {
  return [
    { op: "add_entity_type", name: "Document" },
    { op: "add_entity_type", name: DOCUMENT_CLASS },
    ...KINDS.map((kind) => ({ op: "add_entity_type" as const, name: kind.className })),
    ...KINDS.map((kind) => ({
      op: "add_super_types" as const,
      entity_type: kind.className,
      super_types: [DOCUMENT_CLASS],
    })),
    { op: "add_property", name: TEXT_PROPERTY, value_type: "text" },
    { op: "add_property", name: SHA_PROPERTY, value_type: "keyword" },
    ...Object.entries(PROPERTIES).map(([name, { type, unit }]) => ({
      op: "add_property" as const,
      name,
      value_type: type,
      ...(unit ? { unit } : {}),
    })),
    {
      op: "add_relation",
      name: TEXT_OF,
      domain: KINDS.map((kind) => kind.className),
      range: ["Document"],
    },
  ];
}

/**
 * The LBB-run workflows of the pipeline: `documents.parse`, and one
 * `values.extract` per class. `client.workflows.starters.use(request)`
 * creates each.
 */
export function starters(settings: Settings = defaults): Schemas["TriggeredWorkflowRequest"][] {
  return [
    { starter: "documents.parse" },
    ...KINDS.map((kind) => ({
      starter: "values.extract",
      name: `documents-values-${kind.className.toLowerCase()}`,
      watch: { class: kind.className, fields: [TEXT_PROPERTY] },
      params: { properties: kind.properties, context: settings.context },
      gate: { below: settings.gate },
    })),
  ];
}

/** The named workflows of your worker: the texts, and the check. */
export function workflows(): Schemas["NamedWorkflowRequest"][] {
  return [textsWorkflow(), checkWorkflow()];
}

/** The two workflows, for a `WorkflowWorker`. `lbb` is `lbbActivities(client)` and `ports` is `checkPorts(client)`, or mocks in a test. */
export function createWorkflows(
  lbb: LbbActivities,
  ports: CheckPorts,
  settings: Settings = defaults,
) {
  return [
    createTextsWorkflow(lbb),
    createCheckWorkflow(lbb, ports, { candidatesPerTurn: settings.candidatesPerTurn }),
  ] as const;
}

/**
 * The root shapes of a graph's active shape set that this template did not publish.
 * Publishing replaces a graph's whole shape set, so a set with any of these is not
 * ours to replace.
 */
export function foreignShapes(view: Schemas["SchemaBundleView"]): string[] {
  const ours = new Set(checks.map((check) => `<${check.shape}>`));
  return (view.shapes ?? [])
    .filter((shape) => (shape.targets?.length ?? 0) > 0 && !ours.has(shape.id))
    .map((shape) => shape.id);
}

/**
 * Create the pipeline on a graph: its ontology, its shapes, the LBB-run
 * workflows and your two named workflows. Each call is safe to repeat.
 * Returns the names created.
 *
 * The shapes replace the graph's shape set, so `setup` first reads it. A graph
 * with shapes of its own stops the setup before anything is written: merge
 * `shapes.ttl` into your shapes by hand, publish the union, and set
 * `publishShapes: false` so that `setup` leaves the shape set alone. A graph that
 * holds this template's shapes keeps its enforcement mode.
 */
export async function setup(
  client: LbbClient,
  lbb: LbbActivities,
  settings: Settings = defaults,
): Promise<string[]> {
  const view = settings.publishShapes ? await client.schema.view() : undefined;
  const foreign = view ? foreignShapes(view) : [];
  if (foreign.length)
    throw new Error(
      `the graph has a shape set of its own (${foreign.slice(0, 3).join(", ")}): publishing documents-check's shapes would replace it. ` +
        "Merge shapes.ttl into your shapes by hand and publish the union in the mode you want. " +
        "Then set publishShapes to false in the settings, so that setup leaves the shape set alone.",
    );
  await lbb.evolve(ontology());
  if (view)
    await client.schema.publish(publishRequest(view.shape_count > 0 ? view.enforce_mode : "warn"));
  const names: string[] = [];
  for (const request of starters(settings)) {
    const created = await client.workflows.starters.use(request);
    names.push(created.name);
  }
  for (const request of workflows()) {
    const created = await client.workflows.named.put(request);
    names.push(created.name);
  }
  return names;
}
