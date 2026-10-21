// Developer workflows (`workflow@v1`). A triggered workflow of the starter
// workflow `workflow` sends the new and changed instances of the class it
// watches to a workflow of your worker, as trigger messages of type
// `instances`. `triggeredWorkflow()` defines that workflow: it checks each
// message and hands it to `onInstances` with the workflow's state.
// `writeOwned()` commits what your code owns on the instances with
// `replace_owned`, inside a named step, with the step's effect id as the
// commit's idempotency key.
import type { LbbClient, Schemas } from "./client.js";
import {
  isFanInIdentity,
  workflow,
  WorkflowError,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowStepContext,
  type WorkflowStepOptions,
} from "./workflows.js";

/** The trigger message a developer workflow receives. */
export type WorkflowTriggerMessage = Schemas["WorkflowTriggerMessage"];
/** Why a developer workflow received the instances. */
export type WorkflowTriggerReason = Schemas["WorkflowTriggerReason"];

/** The `type` of every trigger message. */
export const TRIGGER_MESSAGE_TYPE = "instances";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * Check that `value` is a trigger message and return it. `workflow` names
 * the triggered workflow; a message stored before that field had its name
 * carries it as `starter`, which is read when `workflow` is absent and
 * returned as `workflow`. `removed` may be absent (read as empty). A
 * `reason` this SDK does not know passes through, so a worker keeps running
 * when the server adds one. Anything else throws a {@link WorkflowError},
 * which fails the turn without a retry: a message of another shape does not
 * become valid on a retry.
 */
export function parseTriggerMessage(
  value: unknown,
  where = "message",
): WorkflowTriggerMessage {
  const refuse = (problem: string): never => {
    throw new WorkflowError(
      `The ${where} is not a trigger message: ${problem}`,
    );
  };
  if (!isObject(value)) return refuse("it is not a JSON object");
  if (value.type !== TRIGGER_MESSAGE_TYPE)
    return refuse(
      `type is ${JSON.stringify(value.type ?? null)}, not "${TRIGGER_MESSAGE_TYPE}"`,
    );
  let fields: Record<string, unknown> = value;
  if (value.workflow === undefined && isName(value.starter)) {
    const { starter, ...rest } = value;
    fields = { ...rest, workflow: starter };
  }
  if (!isName(fields.workflow)) return refuse("workflow is not a name");
  if (!isName(fields.graph)) return refuse("graph is not a graph id");
  const seq = fields.as_of_commit_seq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0)
    return refuse("as_of_commit_seq is not a commit number");
  if (!isName(fields.reason)) return refuse("reason is not a string");
  if (!isStringList(fields.instances))
    return refuse("instances is not a list of IRIs");
  const removed = fields.removed ?? [];
  if (!isStringList(removed)) return refuse("removed is not a list of IRIs");
  return { ...fields, removed } as WorkflowTriggerMessage;
}

/**
 * What `onInstances` returns. Without `state` (or with nothing at all) the
 * workflow keeps its state. `result` is the turn's reply. A continuation
 * from `ctx.continue(state, nextMessage)` queues the rest of a large
 * message behind the messages already waiting.
 */
export interface TriggeredWorkflowTurn<S, R = unknown> {
  state?: S;
  result?: R;
  continuation?: { message: WorkflowTriggerMessage };
}

export interface TriggeredWorkflowDefinition<S, R = unknown> {
  /** The `workflow_type` the triggered workflow names. */
  name: string;
  /** The `version` the triggered workflow names. */
  version: string;
  /**
   * The state a handler starts from. Default `{}`. Creating the triggered
   * workflow creates the instance `starter.<name>` with the state `{}`, so
   * each turn merges these keys under the saved state: a saved key wins,
   * and a null or empty saved state gives `initialState`.
   */
  initialState?: S;
  /**
   * Handle one message: read `message.instances` at
   * `message.as_of_commit_seq` (or later), do the work inside `ctx.step`,
   * and write with {@link writeOwned}. Drop what you wrote for
   * `message.removed`.
   */
  onInstances(
    ctx: WorkflowContext,
    message: WorkflowTriggerMessage,
    state: S,
  ): Promise<TriggeredWorkflowTurn<S, R> | void>;
  /**
   * Handle one message of the workflow's fan-in identity
   * (`starter.<name>.<fan_in>`, `fan_in` of `PUT /v1/workflows/named`):
   * the shards' turns send it their outputs (`generated`, `decided`) with
   * deterministic ids. Read what the message names from where the outputs
   * are kept (the graph, a blob), so the turns after a build find nothing
   * new. A fan-in message without this handler fails the turn.
   */
  onFanIn?(
    ctx: WorkflowContext,
    message: unknown,
    state: S,
  ): Promise<TriggeredWorkflowTurn<S, R> | void>;
}

/** A JSON copy, so a handler that changes its state never changes the definition. */
const jsonCopy = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

/**
 * The state a developer workflow's handler receives: `initialState` merged
 * under the saved state. The server creates the instance `starter.<name>`
 * with the state `{}`, so the first turn would otherwise read no keys at
 * all. Keys of the saved state win. A null, absent or empty saved state
 * gives `initialState`. When either side is not a JSON object, a saved
 * state other than those wins as it is.
 */
export function triggeredWorkflowState<S>(initialState: S, saved: unknown): S {
  const empty =
    saved === null ||
    saved === undefined ||
    (isObject(saved) && Object.keys(saved).length === 0);
  if (empty) return jsonCopy(initialState);
  if (isObject(initialState) && isObject(saved))
    return { ...jsonCopy(initialState), ...saved } as S;
  return saved as S;
}

/**
 * Define the workflow of a developer workflow. Register the result with a
 * `WorkflowWorker`; create the triggered workflow with `workflow: {
 * workflow_type: name, version }` (`client.workflows.starters.use`).
 * Creating it creates the instance `starter.<name>`, so the definition is
 * never started by hand.
 */
export function triggeredWorkflow<S = Record<string, unknown>, R = unknown>(
  definition: TriggeredWorkflowDefinition<S, R>,
): WorkflowDefinition<S, WorkflowTriggerMessage> {
  const initialState = (definition.initialState ?? {}) as S;
  return workflow<S, WorkflowTriggerMessage, R>({
    name: definition.name,
    version: definition.version,
    initialState,
    async onMessage(ctx, saved, message) {
      const state = triggeredWorkflowState(initialState, saved);
      if (isFanInIdentity(ctx.workflowId)) {
        if (!definition.onFanIn)
          throw new WorkflowError(
            `${ctx.workflowId} is a fan-in identity, and the workflow has no onFanIn`,
          );
        const turn = await definition.onFanIn(ctx, message, state);
        return {
          state: turn?.state !== undefined ? turn.state : state,
          ...(turn?.result !== undefined ? { result: turn.result } : {}),
        };
      }
      const turn = await definition.onInstances(
        ctx,
        parseTriggerMessage(message),
        state,
      );
      return {
        state: turn?.state !== undefined ? turn.state : state,
        ...(turn?.result !== undefined ? { result: turn.result } : {}),
        ...(turn?.continuation
          ? {
              continuation: {
                message: parseTriggerMessage(
                  turn.continuation.message,
                  "continuation",
                ),
              },
            }
          : {}),
      };
    },
  });
}

/** The namespace of entity IRIs: an entity's IRI is this and its 32-hex id. */
export const ENTITY_IRI_NAMESPACE = "https://littlebigbrain.com/e/";

/**
 * A commit endpoint `key` that starts with this addresses the entity by its
 * id: the rest of the key is the 32-hex id.
 */
export const ENTITY_ID_KEY_SENTINEL = "\u0000lbb-eid:";

const ENTITY_ID = /^[0-9a-f]{32}$/;

/**
 * The 32-hex id of an entity IRI (`https://littlebigbrain.com/e/<id>`), in
 * lower case. Throws a `RangeError` for an IRI of another namespace or a
 * malformed id.
 */
export function entityIdFromIri(iri: string): string {
  if (typeof iri !== "string" || !iri.startsWith(ENTITY_IRI_NAMESPACE))
    throw new RangeError(
      `not an entity IRI (expected ${ENTITY_IRI_NAMESPACE}<32 hex>): ${JSON.stringify(iri)}`,
    );
  const id = iri.slice(ENTITY_IRI_NAMESPACE.length).toLowerCase();
  if (!ENTITY_ID.test(id))
    throw new RangeError(
      `the id of an entity IRI is 32 hexadecimal characters: ${JSON.stringify(iri)}`,
    );
  return id;
}

/**
 * The commit reference of the entity an IRI names, for an entity you know
 * by its IRI (a trigger message's `instances`, a SPARQL answer). Its `key`
 * is {@link ENTITY_ID_KEY_SENTINEL} and the entity's id, so the commit
 * addresses that entity directly, a keyed one included. `type` is the
 * entity's class.
 *
 * `name` is the entity's display name; the default is its id. In
 * `replace_owned` (`subjects`, `retract_entities`) only the id counts. A
 * triplet endpoint or a field row writes its name as the entity's display
 * name, so pass the entity's current name when you use the reference
 * there.
 *
 * ```ts
 * const subjects = message.instances.map((iri) => entityRef(iri, "DocEntry"));
 * ```
 */
export function entityRef(
  iri: string,
  type: string,
  name?: string,
): Schemas["NamedEntityInput"] {
  const id = entityIdFromIri(iri);
  if (typeof type !== "string" || !type.trim())
    throw new TypeError("entityRef needs the entity's class as its type");
  return {
    type,
    name: name?.trim() ? name : id,
    key: `${ENTITY_ID_KEY_SENTINEL}${id}`,
  };
}

/**
 * What a writer owns on its instances, and what it writes there now. The
 * shapes are those of `POST /v1/graph/commit`.
 */
export interface OwnedWrite {
  /**
   * The instances this write is for. For the instances of a trigger
   * message, `message.instances.map((iri) => entityRef(iri, type))`.
   */
  subjects: Schemas["NamedEntityInput"][];
  /** Owned out-edge relations of the subjects. */
  relations?: string[];
  /** Owned property fields of the subjects. */
  properties?: string[];
  /** Entities the writer made and no longer makes. */
  retract_entities?: Schemas["NamedEntityInput"][];
  /** The owned edges to write now. */
  triplets?: Schemas["TripletInput"][];
  /** The owned fields to write now. */
  entity_properties?: Schemas["EntityPropertiesInput"][];
}

export interface OwnedWriteOptions extends WorkflowStepOptions {
  /** The graph to write. Default: the client's graph. Pass `message.graph`. */
  graph?: string;
  /**
   * How an edge that is current already is written. Default
   * `skip_unchanged`, so a rerun that writes the same output commits no
   * new edge events.
   */
  edgeIdempotency?: Schemas["EdgeIdempotencyMode"];
}

/** What {@link writeOwned} saved as its step's result. */
export interface OwnedWriteResult {
  /** The commit, or null when there was nothing to write. */
  commit_seq: number | null;
  /** The step's effect id, sent as the commit's idempotency key. */
  idempotency_key: string;
  /** The server answered with an earlier commit of the same key. */
  replayed: boolean;
  /** What `replace_owned` removed; null on a replay or without subjects. */
  owned: Schemas["OwnedOutputsOutcome"] | null;
  entities_written: number;
  edges_written: number;
}

/**
 * The commit body of an owned write, or null when it writes nothing. The
 * `replace_owned` part is present when the write names subjects or
 * entities to retract.
 */
export function ownedCommitBody(
  write: OwnedWrite,
  edgeIdempotency: Schemas["EdgeIdempotencyMode"] = "skip_unchanged",
): Schemas["TripletCommitFile"] | null {
  const subjects = write.subjects ?? [];
  const retract = write.retract_entities ?? [];
  const triplets = write.triplets ?? [];
  const properties = write.entity_properties ?? [];
  if (
    !subjects.length &&
    !retract.length &&
    !triplets.length &&
    !properties.length
  )
    return null;
  return {
    ...(triplets.length ? { triplets } : {}),
    ...(properties.length ? { entity_properties: properties } : {}),
    edge_idempotency: edgeIdempotency,
    ...(subjects.length || retract.length
      ? {
          replace_owned: {
            subjects,
            ...(write.relations?.length ? { relations: write.relations } : {}),
            ...(write.properties?.length
              ? { properties: write.properties }
              : {}),
            ...(retract.length ? { retract_entities: retract } : {}),
          },
        }
      : {}),
  };
}

/**
 * Commit an owned write inside the step `stepKey`. In the same commit the
 * server removes the owned edges and fields of `subjects` that this write
 * does not set again, so a rerun replaces the earlier output. The step's
 * effect id is the commit's idempotency key: a turn that runs again after
 * a crash sends the same key, and the server answers with the first
 * commit (`replayed: true`) instead of writing twice. A replayed turn
 * whose step was saved does not call the server at all.
 *
 * Build the write from the step's inputs only (the message and earlier
 * step results), so a second attempt sends the same body. `write` can be a
 * function that returns the write: it runs inside the step, so it can read
 * inputs the turn does not save (a file's parsed pages, which never
 * change), and it gets the step's context, so it can report progress
 * (`(s) => { s.progress("writing facts", {done: 0}); return write; }`). A
 * replayed step does not call it.
 *
 * ```ts
 * await writeOwned(client, ctx, "counts", {
 *   subjects: message.instances.map((iri) => entityRef(iri, "Note")),
 *   properties: ["word_count"],
 *   entity_properties: counted.map(({ iri, name, words }) => ({
 *     ...entityRef(iri, "Note", name),
 *     properties: { word_count: words },
 *   })),
 * }, { graph: message.graph });
 * ```
 */
export function writeOwned(
  client: LbbClient,
  ctx: WorkflowContext,
  stepKey: string,
  write:
    | OwnedWrite
    | ((step: WorkflowStepContext) => OwnedWrite | Promise<OwnedWrite>),
  options: OwnedWriteOptions = {},
): Promise<OwnedWriteResult> {
  const { graph, edgeIdempotency, ...stepOptions } = options;
  return ctx.step(
    stepKey,
    async (step): Promise<OwnedWriteResult> => {
      const { effectId, signal } = step;
      const body = ownedCommitBody(
        typeof write === "function" ? await write(step) : write,
        edgeIdempotency,
      );
      if (!body)
        return {
          commit_seq: null,
          idempotency_key: effectId,
          replayed: false,
          owned: null,
          entities_written: 0,
          edges_written: 0,
        };
      const target = graph ? client.withScope({ graph }) : client;
      // The fence: a worker whose lease ended commits nothing new. It names
      // a turn of the turn's graph, so a write to another graph carries
      // none: that graph's engine holds no such turn. A worker whose client
      // names no graph takes the write's graph (`message.graph`) for the
      // turn's.
      const fenced =
        step.fence &&
        (graph === undefined ||
          step.graph === undefined ||
          graph === step.graph);
      const response: Schemas["GraphCommitResponse"] = await target.request(
        "POST",
        "/v1/graph/commit",
        {
          body: fenced ? { ...body, workflow_fence: step.fence } : body,
          idempotencyKey: effectId,
          signal,
          retry: true,
        },
      );
      return {
        commit_seq: response.commit_seq,
        idempotency_key: response.idempotency_key ?? effectId,
        replayed: response.replayed,
        owned: response.owned ?? null,
        entities_written: response.entities_written,
        edges_written: response.edges_written,
      };
    },
    stepOptions,
  );
}

/** One instance a turn could not do, and why. */
export interface FailedInstance {
  /** The instance IRI, as the message named it. */
  instance: string;
  /** Why it failed, at most 1,000 characters. */
  error?: string;
}

/**
 * Ask the watch to send instances again later (`POST
 * /v1/workflows/named/requeue`), inside the step `stepKey`: the instances
 * this turn could not do go back into the queue on this shard, with origin
 * `requeue`, after a backoff (1, 4, then 16 minutes). The server takes the
 * attempt from this turn's message; past 3 the instances are exhausted and
 * not sent again (the answer's `exhausted`). Record the failure in the
 * turn's result and counters and complete the turn: the shard goes on.
 * Without failed instances it calls nothing.
 *
 * ```ts
 * const failed = [{ instance: iri, error: String(error) }];
 * await requeueFailed(client, ctx, "requeue", failed, { graph: message.graph });
 * return { state, result: { counters: { failed: failed.length } } };
 * ```
 */
export async function requeueFailed(
  client: LbbClient,
  ctx: WorkflowContext,
  stepKey: string,
  failed: readonly FailedInstance[],
  options: { graph?: string } = {},
): Promise<Schemas["WorkflowRequeueResponse"] | null> {
  if (!failed.length) return null;
  const name = ctx.workflowName;
  if (!name)
    throw new WorkflowError(
      `${ctx.workflowId} is no shard of a named workflow: only a watch sends instances again`,
    );
  const target = options.graph
    ? client.withScope({ graph: options.graph })
    : client;
  return ctx.step(stepKey, () =>
    target.workflows.named.requeue(name, {
      workflow_id: ctx.workflowId,
      turn: ctx.turn,
      items: failed.map(({ instance, error }) => ({
        instance,
        ...(error !== undefined ? { error: error.slice(0, 1_000) } : {}),
      })),
    }),
  );
}
