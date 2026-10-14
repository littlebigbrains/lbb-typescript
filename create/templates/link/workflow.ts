// link: connect the mentions of the same thing across the records of a
// graph (general linking, phase L1: identities on records).
//
// The workflow reads records of the classes its settings name (contacts,
// leads, organizations, deals, notes). Each record's names and keys are its
// own mentions; its text fields give the mentions of other things. A mention
// gets block keys (normal forms of its name or key) as graph facts, the
// mentions that share a key are its candidates, and a decision links it to
// the thing it names. The things identity groups the links into things:
// `LinkedThing` entities that every member `REFERS_TO`. Two records are
// never one thing without a person: the workflow proposes them as an
// identity, and a person's accept writes `SAME_AS`.
//
// Without model reads of record values (the default) a strong key (an
// email, a web address, a phone number, a handle, a code) links at
// confidence 1, and every other candidate goes to a person, grouped by
// thing. With `modelsReadRecords: true` the decision model decides, and
// the links at or above the gate are written.
//
// Run it as every template runs: `npm run setup` creates the named
// workflows and the things identity, and `npm start` serves them.
import {
  LbbError,
  parseTriggerMessage,
  workflow,
  type LbbActivities,
  type LbbClient,
  type Schemas,
  type WorkflowContext,
} from "@littlebigbrain/client";
import { emptyShard, sourceTurn, type ShardState } from "./source-turn.js";
import {
  defaults,
  reviewsWorkflowName,
  sourceWorkflowName,
  thingsId,
  workflowType,
  type DecidedMessage,
  type LinkMessage,
  type LinkPorts,
  type Settings,
  type SourceMessage,
} from "./settings.js";
import { roleOf } from "./sources/records.js";
import { emptyThings, thingsTurn, type ThingsState } from "./things-turn.js";
import { LINK_FIELDS, MENTION_FIELDS, THING_FIELDS, isDisplayName } from "./reads.js";

export { defaults, workflowType, thingsId, type Settings, type LinkPorts };

/** The state of an identity of the workflow: a source shard's or the things identity's. */
export type LinkState = Partial<ShardState> & Partial<ThingsState>;

/** The fields a named workflow watches: the fields that give mentions; the display name is `label`. */
const watchedFields = (fields: Settings["fields"][string]) =>
  Object.entries(fields)
    .filter(([, spec]) => roleOf(spec) !== "context")
    .map(([field]) => (isDisplayName(field) ? "label" : field));

/**
 * The named workflows that send the records here: one per class, and one
 * that watches the accepted review items. A named workflow takes one watch
 * trigger in this release, so the classes of the design's one workflow
 * (general linking 3.1) are one named workflow each. The first declares
 * what the workflow owns.
 */
export function workflows(settings: Settings = defaults): Schemas["NamedWorkflowRequest"][] {
  const owns: Schemas["WorkflowOwns"] = {
    classes: ["Mention", "LinkedThing"],
    relations: ["MENTIONED_IN", "SAME_THING_AS", "REFERS_TO", "HAS_RECORD", "MERGED_INTO"],
    properties: [...new Set([...MENTION_FIELDS, ...LINK_FIELDS, ...THING_FIELDS])],
  };
  const sources = Object.entries(settings.fields).map(([cls, fields], i) => ({
    name: sourceWorkflowName(settings, cls),
    workflow: workflowType,
    shards: settings.shards,
    window: settings.window,
    batch: settings.sourcesPerTurn,
    triggers: [{ id: "records", watch: { class: cls, fields: watchedFields(fields) } }],
    ...(i === 0 ? { owns } : {}),
  }));
  return [
    ...sources,
    {
      name: reviewsWorkflowName(settings),
      workflow: workflowType,
      shards: 1,
      window: settings.window,
      batch: 64,
      triggers: [{ id: "accepts", watch: { class: "Mention", fields: ["same_thing_as"] } }],
    },
  ];
}

const property = (name: string, value_type: string) => ({
  op: "add_property" as const,
  name,
  value_type,
});

/** The classes, properties and relations the workflow writes (general linking 2.5): `lbb.evolve(ontology())`. */
export function ontology(settings: Settings = defaults): Schemas["OntologyEvolveOp"][] {
  const classes = Object.keys(settings.fields);
  return [
    { op: "add_entity_type", name: "Mention" },
    { op: "add_entity_type", name: "LinkedThing" },
    property("span", "text"),
    property("role", "keyword"),
    property("kind", "keyword"),
    property("field", "keyword"),
    property("offset", "i64"),
    property("length", "i64"),
    property("block_key", "keyword_set"),
    property("window", "text"),
    property("linked_to", "keyword_set"),
    property("must_link", "keyword_set"),
    property("cannot_link", "keyword_set"),
    property("anchor_key", "keyword"),
    property("alias", "keyword_set"),
    { op: "add_relation", name: "MENTIONED_IN", domain: ["Mention"], range: classes },
    { op: "add_relation", name: "SAME_THING_AS", domain: ["Mention"], range: ["Mention"] },
    { op: "add_relation", name: "REFERS_TO", domain: ["Mention"], range: ["LinkedThing"] },
    { op: "add_relation", name: "HAS_RECORD", domain: ["LinkedThing"], range: classes },
    { op: "add_relation", name: "MERGED_INTO", domain: ["LinkedThing"], range: ["LinkedThing"] },
    { op: "add_relation", name: "SAME_AS", symmetric: true },
  ] as Schemas["OntologyEvolveOp"][];
}

/** The ports of a client: send messages, and read and supersede review items. */
export function linkPorts(client: LbbClient): LinkPorts {
  return {
    send: (workflowId, message, options) => client.workflows.send(workflowId, message, options),
    suggestion: (id) => client.ontology.suggestions.get(id),
    supersede: (id, reason) => client.ontology.suggestions.supersede(id, { reason }),
  };
}

/**
 * The workflow, for a `WorkflowWorker`: a trigger message goes to a source
 * turn, a `decided` message to a things turn. `lbb` is `lbbActivities(client)`
 * and `ports` is `linkPorts(client)`, or mocks in a test.
 */
export function createWorkflow(
  lbb: LbbActivities,
  ports: LinkPorts,
  settings: Settings = defaults,
) {
  if (!(settings.sourcesPerTurn >= 1 && settings.sourcesPerTurn <= 64))
    throw new RangeError("sourcesPerTurn is from 1 to 64: a message holds at most 64 instances");
  if (!(settings.gate > 0 && settings.gate <= 1))
    throw new RangeError("gate is above 0 and at most 1");
  return workflow<LinkState, LinkMessage>({
    name: workflowType.workflow_type,
    version: workflowType.version,
    initialState: {},
    async onMessage(ctx: WorkflowContext, saved: LinkState, raw: LinkMessage) {
      const body = raw as unknown as Record<string, unknown>;
      if (body?.type === "decided") {
        const message = raw as DecidedMessage;
        const state = { ...emptyThings(), ...(saved ?? {}) } as ThingsState;
        const turn = await thingsTurn(ctx, lbb, ports, settings, message, state);
        return turn.next ? ctx.continue(turn.state, turn.next) : { state: turn.state };
      }
      const message = { ...parseTriggerMessage(raw), cursor: body?.cursor } as SourceMessage;
      if (message.cursor === undefined) delete message.cursor;
      const state = { ...emptyShard(), ...(saved ?? {}) } as ShardState;
      const turn = await sourceTurn(ctx, lbb, ports, settings, message, state);
      return turn.next ? ctx.continue(turn.state, turn.next) : { state: turn.state };
    },
  });
}

/**
 * Create the workflow on a graph: its ontology, its named workflows and its
 * things identity. Each call is safe to repeat. Returns the names created.
 */
export async function setup(
  client: LbbClient,
  lbb: LbbActivities,
  settings: Settings = defaults,
): Promise<string[]> {
  await lbb.evolve(ontology(settings));
  const names: string[] = [];
  for (const request of workflows(settings)) {
    const created = await client.workflows.named.put(request);
    names.push(created.name);
  }
  try {
    await client.workflows.create({
      id: thingsId(settings),
      workflow_type: workflowType.workflow_type,
      version: workflowType.version,
      state: {},
      lease_ms: 120_000,
      max_attempts: 3,
    });
  } catch (error) {
    // 409: the identity exists already.
    if (!(error instanceof LbbError && error.status === 409)) throw error;
  }
  names.push(thingsId(settings));
  return names;
}
