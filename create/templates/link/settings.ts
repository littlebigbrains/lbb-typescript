// The settings of the link workflow, the names of its parts, and the
// messages between them (general linking 8.1).
//
// One named workflow per watched class sends the class's records to its
// source shards (`<name>-<class>`, `S` shards each). A source turn finds the
// mentions of its records, decides them and sends one `decided` message to
// the things identity (`<name>-things`), which groups the decided pairs into
// things. A named workflow `<name>-reviews` watches `Mention` and its
// `same_thing_as`, so an accepted review item reaches the things identity.
import {
  ENTITY_IRI_NAMESPACE,
  WorkflowError,
  type Schemas,
  type WorkflowTriggerMessage,
} from "@littlebigbrain/client";
import type { Decision } from "./decide.js";
import type { FieldSpec } from "./sources/records.js";
import type { IdentityPair } from "./things.js";

export interface Settings {
  /**
   * The workflow's name. Its named workflows are `<name>-<class>` and
   * `<name>-reviews`, its things identity `<name>-things`, and its review
   * items have the origin `starter:<name>`.
   */
  name: string;
  /** The role of each field of each watched class (general linking 3.2). */
  fields: Record<string, Record<string, FieldSpec>>;
  /** A link at or above this confidence is written; a link below it goes to a person. */
  gate: number;
  /**
   * Orders and groups the identity items only: a person accepts every
   * identity (decision 2). An identity at or above it is marked `above_gate`.
   */
  identityGate: number;
  /**
   * Whether the models may read record values (decision 1). Off: records
   * link by keys and rules alone; a strong key links at confidence 1, and
   * every other candidate goes to a person. On: the decision model reads the
   * names, keys and context fields of the records, and the reasoning model
   * reads the text fields that opt in (`{ role: "text", extract: true }`).
   */
  modelsReadRecords: boolean;
  /** Source shards of each named workflow, 1 to 16. */
  shards: number;
  /** Records per trigger message, 1 to 64: one turn reads at most this many. */
  sourcesPerTurn: number;
  /** Characters of text one turn reads; the rest of a message continues in a new turn. */
  textPerTurn: number;
  /** Messages the watch keeps queued per shard. */
  window: number;
}

/** The settings: edit them for your graph. These fit the samples, an invented CRM. */
export const defaults: Settings = {
  name: "link",
  fields: {
    Person: { name: "name", email: "key:email", job_title: "context" },
    Lead: {
      first_name: "name:given",
      last_name: "name:family",
      email: "key:email",
      company_name: "context",
    },
    Organization: { name: "name", website: "key:web" },
    Deal: { name: "text" },
    Note: { body: { role: "text", extract: true } },
  },
  gate: 0.8,
  identityGate: 0.99,
  modelsReadRecords: false,
  shards: 4,
  sourcesPerTurn: 16,
  textPerTurn: 8_000,
  window: 4,
};

/** The workflow type and version every part of the workflow runs. */
export const workflowType = { workflow_type: "link", version: "v1" };

/** A class name as part of a workflow name: lower case letters, digits and dashes. */
export const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "class";

export const sourceWorkflowName = (settings: Settings, cls: string) =>
  `${settings.name}-${slug(cls)}`;
export const reviewsWorkflowName = (settings: Settings) => `${settings.name}-reviews`;
/** The engine identity that groups the decided pairs: one per workflow (dogfooding G9). */
export const thingsId = (settings: Settings) => `${settings.name}-things`;

/** The watched class of a named workflow's messages; a name of no source workflow throws. */
export function classOf(settings: Settings, workflow: string): string {
  const cls = Object.keys(settings.fields).find(
    (c) => sourceWorkflowName(settings, c) === workflow,
  );
  if (!cls)
    throw new WorkflowError(
      `the message of the named workflow ${workflow} names no class of the settings (${Object.keys(settings.fields).join(", ")})`,
    );
  return cls;
}

/** An entity IRI from the 32-hex id a message carries. */
export const iriOf = (id: string) => (id.startsWith("http") ? id : ENTITY_IRI_NAMESPACE + id);
/** The 32-hex id of an entity IRI, for a message. */
export const idIn = (iri: string) =>
  iri.startsWith(ENTITY_IRI_NAMESPACE) ? iri.slice(ENTITY_IRI_NAMESPACE.length) : iri;

/** A source turn's message: a trigger message, and the part of it a continued turn reads. */
export type SourceMessage = WorkflowTriggerMessage & { cursor?: number };

/**
 * What a source turn sends the things identity. Its id is
 * `decided-<shard>-<turn>` (and `.1`, `.2`, … for the parts of a large
 * one), so a repeat is admitted once. Entities are named by their 32-hex
 * ids.
 */
export interface DecidedMessage {
  type: "decided";
  workflow: string;
  graph: string;
  as_of_commit_seq: number;
  /** The shard that sent it, and its turn. */
  from: string;
  turn: number;
  part: number;
  /** The mentions the turn wrote. */
  mentions: string[];
  /** The mentions it retracted, and the things they were in. */
  removed: string[];
  things: string[];
  decisions: Decision[];
  identities: IdentityPair[];
  /** A continued things turn: the mentions it has still to write. */
  round?: number;
}

/** A message of the workflow type: a trigger message, or a decided message. */
export type LinkMessage = SourceMessage | DecidedMessage;

/** Bytes of one decided message, at most: under the engine's 32 KiB. */
export const DECIDED_BYTES = 24_000;

/**
 * The calls of the workflow that the LBB activities do not make: send a
 * message to the things identity, and read and supersede the review items
 * it filed. `linkPorts(client)` makes them from a client; a test gives its
 * own.
 */
export interface LinkPorts {
  send(
    workflowId: string,
    message: DecidedMessage,
    options: { id: string; origin?: Schemas["WorkflowMessageOrigin"] },
  ): Promise<unknown>;
  suggestion(suggestionId: string): Promise<Schemas["OntologyChangeSuggestion"]>;
  supersede(suggestionId: string, reason: string): Promise<unknown>;
}
