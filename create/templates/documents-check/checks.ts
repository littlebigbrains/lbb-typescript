// checks: the rules of documents-check, as the words of a review item for a person.
//
// The rules themselves are SHACL shapes, in `shapes.ttl`. A shape selects the
// documents of a class and reports a result for each document that breaks the
// rule. Each rule here compares values of two documents (or of one document
// with itself), so it is a SHACL-SPARQL constraint (`sh:sparql`): its `sh:select`
// returns `$this`, the document that breaks the rule, and `?value`, the document
// it was compared with (a number, for a rule inside one document). The shapes run
// in `warn` mode. They report; they never refuse a write.
//
// `checks` names each shape again with the quotes a person needs and the
// sentences of the review item, so one rule has one id in both places. A test
// holds the two together, and an lbb-server test runs `shapes.ttl` on the sample
// facts.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Schemas } from "@littlebigbrain/client";

/** The namespace of the shapes. */
export const NAMESPACE = "https://littlebigbrain.com/checks#";

/** The document classes and their IRIs (the lower-case local name of the class). */
export const CLASS_IRI: Record<string, string> = {
  PurchaseOrder: "https://littlebigbrain.com/class/purchaseorder",
  DeliveryNote: "https://littlebigbrain.com/class/deliverynote",
  Invoice: "https://littlebigbrain.com/class/invoice",
};

/** What a person calls each class. */
export const CLASS_LABEL: Record<string, string> = {
  PurchaseOrder: "Order",
  DeliveryNote: "Delivery note",
  Invoice: "Invoice",
};

/** A value the check read from a document, with the quote that supports it. */
export interface Fact {
  value: string | number;
  quote?: string;
}

/** A document the check read: its class, its extracted values and the file it came from. */
export interface Doc {
  iri: string;
  className: string;
  name: string;
  /** The `Document` of the file the text was read from, and the file's SHA-256. */
  file?: { iri: string; sha256: string };
  values: Record<string, Fact>;
}

/** One rule: its shape, the quotes a person sees, and its sentences. */
export interface Check {
  /** The id of the rule, in the key of its review items. */
  id: string;
  /** The IRI of the rule's `sh:NodeShape`. */
  shape: string;
  /** The values whose quotes a person sees: of the document that breaks the rule, and of the one it was compared with. */
  evidence: { side: "focus" | "other"; property: string }[];
  /** The rule in one sentence. */
  rule: string;
  /** The question: what the two documents say. */
  title(focus: Doc, other?: Doc): string;
}

const reference = (doc: Doc) => String(doc.values.reference?.value ?? doc.name);
const label = (doc: Doc) => `${CLASS_LABEL[doc.className] ?? doc.className} ${reference(doc)}`;
const kg = (doc: Doc) => `${Number(doc.values.quantity?.value)} kg`;
const eur = (value: number) => `${value.toFixed(2)} EUR`;
const money = (doc: Doc, property: string) => eur(Number(doc.values[property]?.value));

export const checks: Check[] = [
  {
    id: "invoice-quantity-vs-delivery",
    shape: `${NAMESPACE}InvoiceQuantityVsDelivery`,
    evidence: [
      { side: "focus", property: "quantity" },
      { side: "other", property: "quantity" },
    ],
    rule: "An invoice must not bill more than the delivery note it names shows. Quantities are compared in kg.",
    title: (focus, other) =>
      `${label(focus)} bills ${kg(focus)}. ${label(other ?? focus)} shows ${other ? kg(other) : "no quantity"}.`,
  },
  {
    id: "invoice-quantity-vs-order",
    shape: `${NAMESPACE}InvoiceQuantityVsOrder`,
    evidence: [
      { side: "focus", property: "quantity" },
      { side: "other", property: "quantity" },
    ],
    rule: "An invoice must not bill more than the order it names asks for. Quantities are compared in kg.",
    title: (focus, other) =>
      `${label(focus)} bills ${kg(focus)}. ${label(other ?? focus)} asks for ${other ? kg(other) : "no quantity"}.`,
  },
  {
    id: "invoice-price-vs-order",
    shape: `${NAMESPACE}InvoicePriceVsOrder`,
    evidence: [
      { side: "focus", property: "price" },
      { side: "other", property: "price" },
    ],
    rule: "An invoice must use the price of the order it names, to the cent.",
    title: (focus, other) =>
      `${label(focus)} has a price of ${money(focus, "price")}. ${label(other ?? focus)} has ${other ? money(other, "price") : "none"}.`,
  },
  {
    id: "total-matches-quantity-times-price",
    shape: `${NAMESPACE}TotalMatchesQuantityTimesPrice`,
    evidence: [
      { side: "focus", property: "quantity" },
      { side: "focus", property: "price" },
      { side: "focus", property: "total" },
    ],
    rule: "The total of an order or an invoice must equal quantity times price, within one cent.",
    title: (focus) => {
      const expected = Number(focus.values.quantity?.value) * Number(focus.values.price?.value);
      return `${label(focus)} totals ${money(focus, "total")}. Quantity times price is ${eur(expected)}.`;
    },
  },
];

/** The check of a shape (the IRI of the report's `source_node_shape`, without its angle brackets). */
export function checkOfShape(shape: string): Check | undefined {
  return checks.find((check) => check.shape === shape);
}

/**
 * Where `shapes.ttl` is. In a project it sits beside this module (`src/`), or beside
 * `src/` when the project's test runs the compiled copy (`dist/`). In the repository the
 * tests run the compiled copy in `test-dist/documents-check/`.
 */
function shapesFile(): string {
  for (const relative of [
    "./shapes.ttl",
    "../src/shapes.ttl",
    "../../documents-check/shapes.ttl",
  ]) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error("shapes.ttl is not beside checks.ts");
}

/** The shapes, in Turtle: the contents of `shapes.ttl`. */
export const shapesTurtle = readFileSync(shapesFile(), "utf8");

/**
 * The request that publishes the shapes. The default mode is `warn`: the shapes
 * report, and refuse no write. A graph that holds these shapes already keeps its mode.
 */
export function publishRequest(
  mode: Schemas["SchemaEnforceMode"] = "warn",
): Schemas["SchemaPublishRequest"] {
  return { desired_mode: mode, shapes: { source: shapesTurtle, format: "turtle" } };
}
