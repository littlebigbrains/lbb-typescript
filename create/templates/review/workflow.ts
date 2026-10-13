// review: decide which fact proposals become facts.
//
// A proposer (documents-map, LBB's documents.map, or any workflow of yours) does not write the
// facts of the graph's own ontology itself: it writes one `FactProposal` per statement, with its
// confidence and evidence. A triggered workflow of the starter workflow `workflow` watches the
// proposals' statements and sends the new ones here. For each proposal, once:
//
// - refused when the graph cannot hold the statement (an unknown predicate, a value of the wrong
//   type, a new instance without its class, a domain or a range the ends do not fit);
// - to a person when a rule of `alwaysReview` names it (`new_instance` or a predicate; by default
//   no rule), when it would replace another writer's value or name, or when its confidence is
//   below the gate;
// - written otherwise: the statement, with the proposal as its evidence (`writeOwned`).
//
// The proposals for a person go into one review item per instance (`review`): the instance a
// proposal is about (its subject, the new object of a link from an instance the graph has, and
// always the object of the trace). The item's facts are each statement and its proposal's
// `fact_status: accepted`; a person can leave facts out of the accept, except the type of a new
// instance. The proposal gets its `fact_status` (`written`, `in_review`, `refused`) and
// `review_note`, owned by this workflow.
import { createHash } from "node:crypto";
import {
  entityRef,
  triggeredWorkflow,
  type LbbActivities,
  type Schemas,
  type WorkflowTriggerMessage,
} from "@littlebigbrain/client";
import * as review from "./decision.js";

export interface Settings {
  /** The class of the proposals. */
  className: string;
  /** A proposal below this confidence goes to a person. */
  gate: number;
  /** What goes to a person whatever its confidence: `new_instance` (a statement about an instance the graph does not have yet) and predicate IRIs. Empty: the gate decides everything. */
  alwaysReview: string[];
}

/** The settings of LBB's review: edit them for your graph. */
export const defaults: Settings = {
  className: "FactProposal",
  gate: 0.8,
  alwaysReview: [],
};

/** The workflow type and version the triggered workflow names. */
export const workflowType = { workflow_type: "review", version: "v1" };

/** The triggered workflow that sends the proposals here: `client.workflows.starters.use(trigger())`. */
export function trigger(settings: Settings = defaults): Schemas["TriggeredWorkflowRequest"] {
  return {
    starter: "workflow",
    name: "review",
    watch: { class: settings.className, fields: ["fact_subject", "fact_predicate", "fact_object"] },
    workflow: workflowType,
    owns: { properties: ["fact_status", "review_note"] },
    batch: 32,
  };
}

/** The class of the proposals and the properties of a proposal and of the review: `lbb.evolve(ontology())`. */
export function ontology(settings: Settings = defaults): Schemas["OntologyEvolveOp"][] {
  return [
    { op: "add_entity_type", name: settings.className },
    ...Object.entries({ ...review.PROPOSAL_FIELDS, ...review.REVIEW_FIELDS }).map(
      ([name, value_type]) => ({ op: "add_property" as const, name, value_type }),
    ),
  ];
}

/** What the workflow decided, over all its turns. */
export interface ReviewState {
  proposals: number;
  written: number;
  held: number;
  in_review: number;
  refused: number;
}

/** Proposals one turn decides: two steps each, and at most one review item each, in a turn of 64 steps. */
const TURN_PROPOSALS = 20;
const PLAIN_IRI = /^[^\s<>"{}|\\^`]+$/;
const values = (iris: Iterable<string>) =>
  [...iris]
    .filter((iri) => PLAIN_IRI.test(iri))
    .map((iri) => `<${iri}>`)
    .join(" ");
const literals = (texts: Iterable<string>) => [...texts].map((t) => JSON.stringify(t)).join(" ");
const P = "PREFIX p: <https://littlebigbrain.com/p/>\n";

/** One proposal as the graph holds it. */
interface Proposal {
  iri: string;
  label?: string;
  statement?: review.Statement;
  confidence: number;
  evidence?: string;
  proposedBy: string;
  status?: string;
}

/** What one proposal's step decided, and the facts that write it. */
interface Outcome {
  status: "written" | "in_review" | "refused" | "decided";
  note?: string;
  facts?: review.Facts;
  holds?: boolean;
  /** For a person: the item's instance, its view, and what the item shows of the fact. */
  item?: {
    instance: string;
    class?: string;
    label?: string;
    isNew: boolean;
    shown: review.Shown;
  };
}

/** The workflow, for a `WorkflowWorker`. `lbb` is `lbbActivities(client)`, or a mock in a test. */
export function createWorkflow(lbb: LbbActivities, settings: Settings = defaults) {
  return triggeredWorkflow<ReviewState>({
    name: workflowType.workflow_type,
    version: workflowType.version,
    initialState: { proposals: 0, written: 0, held: 0, in_review: 0, refused: 0 },
    async onInstances(ctx, message, state) {
      const batch = message.instances.slice(0, TURN_PROPOSALS);
      let cache: Promise<Read> | undefined;
      const read = () => (cache ??= reader(lbb, batch, settings));
      const next = { ...state };
      const forPeople: { iri: string; outcome: Outcome }[] = [];
      for (const [i, iri] of batch.entries()) {
        const outcome = await ctx.step(`decide-${i}`, async (s) => {
          s.progress("deciding proposals", { done: i, total: batch.length, unit: "proposals" });
          return decideOne(lbb, await read(), iri, settings);
        });
        await lbb.writeOwned(ctx, `write-${i}`, async (s) => {
          s.progress("writing facts", { done: i, total: batch.length, unit: "proposals" });
          return statusWrite(await read(), iri, outcome, settings);
        });
        if (outcome.status === "decided") continue;
        next.proposals += 1;
        if (outcome.status === "written") next[outcome.holds ? "held" : "written"] += 1;
        else next[outcome.status] += 1;
        if (outcome.status === "in_review") forPeople.push({ iri, outcome });
      }
      // One review item per instance of this turn.
      const groups = new Map<string, { iri: string; outcome: Outcome }[]>();
      for (const one of forPeople) {
        const instance = one.outcome.item!.instance;
        groups.set(instance, [...(groups.get(instance) ?? []), one]);
      }
      for (const [n, members] of [...groups.values()].entries())
        await ctx.step(`review-${n}`, async (s) => {
          s.progress("filing review items", { done: n, total: groups.size, unit: "instances" });
          await fileItem(lbb, await read(), members, message, settings);
          return true;
        });
      // A proposal its proposer withdrew (message.removed) keeps the fact written for it: see the README.
      const rest = message.instances.slice(TURN_PROPOSALS);
      return rest.length
        ? ctx.continue(next, { ...message, instances: rest, removed: [] })
        : { state: next };
    },
  });
}

type Read = Awaited<ReturnType<typeof reader>>;

/** The proposals of the turn and the ontology, read once per attempt, with the commits not yet published. */
async function reader(lbb: LbbActivities, iris: string[], settings: Settings) {
  const [{ rows }, view] = [
    await lbb.sparql(
      `# review: proposals\n${P}SELECT ?x ?label ?s ?p ?o ?dt ?c ?ev ?by ?status WHERE {
  VALUES ?x { ${values(iris)} }
  OPTIONAL { ?x <${review.RDFS_LABEL}> ?label }
  OPTIONAL { ?x p:fact_subject ?s } OPTIONAL { ?x p:fact_predicate ?p } OPTIONAL { ?x p:fact_object ?o }
  OPTIONAL { ?x p:fact_datatype ?dt } OPTIONAL { ?x p:fact_confidence ?c } OPTIONAL { ?x p:fact_evidence ?ev }
  OPTIONAL { ?x p:proposed_by ?by } OPTIONAL { ?x p:fact_status ?status }
}`,
      { consistency: "strong" },
    ),
    await lbb.ontology(),
  ];
  const proposals = new Map<string, Proposal>();
  for (const r of rows) {
    if (proposals.has(r.x!)) continue;
    proposals.set(r.x!, {
      iri: r.x!,
      ...(r.label ? { label: r.label } : {}),
      ...(r.s && r.p && r.o !== undefined
        ? {
            statement: {
              subject: r.s.trim(),
              predicate: r.p.trim(),
              object: r.o,
              ...(r.dt?.trim() ? { datatype: r.dt.trim() } : {}),
            },
          }
        : {}),
      confidence: Number(r.c ?? 0),
      ...(r.ev ? { evidence: r.ev } : {}),
      proposedBy: r.by ?? "",
      ...(r.status ? { status: r.status } : {}),
    });
  }
  return { proposals, ontology: review.readOntology(view), className: settings.className };
}

/** The entities a statement names: the graph's instances, and new ones with the class and label their proposals give. */
async function entities(
  lbb: LbbActivities,
  read: Read,
  iris: string[],
): Promise<Map<string, review.Known>> {
  const out = new Map<string, review.Known>();
  const named = iris.filter(review.isEntity);
  if (!named.length) return out;
  const { rows } = await lbb.sparql(
    `# review: entities\nSELECT ?s ?type ?label WHERE {
  VALUES ?s { ${values(named)} }
  OPTIONAL { ?s a ?type } OPTIONAL { ?s <${review.RDFS_LABEL}> ?label }
}`,
    { consistency: "strong" },
  );
  for (const iri of named) {
    const found = rows.filter((r) => r.s === iri);
    const cls = found.map((r) => read.ontology.classes.get(r.type ?? "")).find(Boolean);
    if (cls)
      out.set(iri, { iri, class: cls, label: found.find((r) => r.label)?.label, exists: true });
  }
  // A new instance: the class of its rdf:type proposal, and the name its rdfs:label proposals
  // give it (the first in order), so every write names it alike.
  const fresh = named.filter((iri) => !out.has(iri));
  if (fresh.length) {
    const { rows: proposed } = await lbb.sparql(
      `# review: new instances\n${P}SELECT ?s ?p ?o WHERE {
  VALUES ?s { ${literals(fresh)} }
  VALUES ?p { ${literals([review.RDF_TYPE, review.RDFS_LABEL])} }
  ?x p:fact_subject ?s ; p:fact_predicate ?p ; p:fact_object ?o .
}`,
      { consistency: "strong" },
    );
    for (const iri of fresh) {
      const of = (p: string) =>
        proposed
          .filter((r) => r.s === iri && r.p === p)
          .map((r) => r.o!.trim())
          .filter(Boolean)
          .sort();
      const cls = of(review.RDF_TYPE)
        .map((c) => read.ontology.classes.get(c))
        .find(Boolean);
      out.set(iri, {
        iri,
        ...(cls ? { class: cls } : {}),
        label: of(review.RDFS_LABEL)[0],
        exists: false,
      });
    }
  }
  return out;
}

/** Decide one proposal; one for a person carries what its item shows. */
async function decideOne(
  lbb: LbbActivities,
  read: Read,
  iri: string,
  settings: Settings,
): Promise<Outcome> {
  const proposal = read.proposals.get(iri);
  // Gone, or decided once already: a proposer's rewrite of the same statement changes nothing.
  if (!proposal || proposal.status) return { status: "decided" };
  const s = proposal.statement;
  if (!s)
    return {
      status: "refused",
      note: "The proposal has no fact_subject, fact_predicate or fact_object.",
    };
  const seen: review.Seen = { entities: await entities(lbb, read, [s.subject, s.object]) };
  const property = read.ontology.properties.get(s.predicate);
  if (property && review.isEntity(s.subject)) {
    const { rows } = await lbb.sparql(
      `# review: values\nSELECT ?v WHERE { <${s.subject}> <${s.predicate}> ?v } LIMIT 16`,
      { consistency: "strong" },
    );
    seen.current = rows.map((r) => r.v!);
  }
  const terms = review.classify(s, read.ontology, seen, settings.className);
  let edgeHolds = false;
  if (terms.kind === "relation" && terms.subject.exists && terms.object.exists) {
    const { rows } = await lbb.sparql(
      `# review: edge\nSELECT ?s WHERE { VALUES ?s { <${s.subject}> } ?s <${s.predicate}> <${s.object}> } LIMIT 1`,
      { consistency: "strong" },
    );
    edgeHolds = rows.length > 0;
  }
  const decision = review.decide(terms, s.predicate, proposal.confidence, settings, edgeHolds);
  if (decision.status === "refused" || terms.kind === "refused")
    return { status: "refused", note: decision.status === "refused" ? decision.why : "" };
  const facts = review.factsOf(terms, iri, proposal.confidence, proposal.evidence);
  if (decision.status === "written")
    return decision.holds
      ? { status: "written", holds: true }
      : { status: "written", holds: false, facts };
  // To a person: into the item of its instance.
  const instance = review.groupOf(terms, s)!;
  const known = [...seen.entities.values()].find((e) => e.iri === instance) ?? {
    iri: instance,
    exists: false,
  };
  return {
    status: "in_review",
    note: decision.why,
    facts,
    item: {
      instance,
      ...(known.class || terms.kind === "type"
        ? { class: terms.kind === "type" ? terms.class : known.class }
        : {}),
      ...(known.label ? { label: known.label } : {}),
      isNew: !known.exists,
      shown: review.shownOf(terms, s, instance),
    },
  };
}

const proposalRef = (proposal: Proposal, settings: Settings) =>
  entityRef(proposal.iri, settings.className, proposal.label);

/**
 * File the review item of one instance: each fact's statement and its proposal's
 * `fact_status: accepted`, in the item's order (the type, the label, values, links, the trace),
 * with one evidence sample per fact. The key carries the proposals, so other proposals file
 * another item.
 */
async function fileItem(
  lbb: LbbActivities,
  read: Read,
  members: { iri: string; outcome: Outcome }[],
  message: WorkflowTriggerMessage,
  settings: Settings,
) {
  const first = members[0]!.outcome.item!;
  const instance = first.instance;
  const kind = (m: { outcome: Outcome }) => m.outcome.item!.shown.kind;
  const ordered = [...members].sort(
    (a, b) =>
      review.KIND_ORDER.indexOf(kind(a)) - review.KIND_ORDER.indexOf(kind(b)) ||
      a.outcome.item!.shown.text.localeCompare(b.outcome.item!.shown.text),
  );
  const creates = first.isNew && ordered.some((m) => kind(m) === "type");
  const className = ordered.map((m) => m.outcome.item!.class).find(Boolean) ?? "Instance";
  const label =
    ordered.map((m) => m.outcome.item!.label).find(Boolean) ??
    instance.slice(instance.lastIndexOf("/") + 1);
  const triplets: Schemas["TripletInput"][] = [];
  const rows: Schemas["EntityPropertiesInput"][] = [];
  // The rows an accept must keep (`required`, from client 0.24; an older client sends it as is).
  const required: { row: number; reason: string }[] = [];
  const samples: Record<string, unknown>[] = [];
  const whys = new Set<string>();
  for (const { iri, outcome } of ordered) {
    const proposal = read.proposals.get(iri)!;
    const shown = outcome.item!.shown;
    const needed = shown.kind === "source" || (creates && shown.kind === "type");
    const writeTriplets = (outcome.facts?.triplets ?? []).map((t) => triplets.push(t) - 1);
    const writeRows = (outcome.facts?.entity_properties ?? []).map((r) => rows.push(r) - 1);
    const row =
      rows.push({ ...proposalRef(proposal, settings), properties: { fact_status: "accepted" } }) -
      1;
    if (needed)
      for (const at of [...writeRows, row])
        required.push({
          row: at,
          reason:
            shown.kind === "type"
              ? "a new instance needs its type"
              : "the source of an instance goes with it",
        });
    if (outcome.note) whys.add(outcome.note);
    samples.push({
      proposal: iri,
      row,
      ...(writeRows.length ? { rows: writeRows } : {}),
      ...(writeTriplets.length ? { triplets: writeTriplets } : {}),
      kind: shown.kind,
      fact: shown.text,
      confidence: Math.round(proposal.confidence * 1000) / 1000,
      ...(review.place(proposal.evidence) ?? {}),
      ...(needed ? { required: true } : {}),
    });
  }
  const proposalsHash = createHash("sha256")
    .update(
      ordered
        .map((m) => m.iri)
        .sort()
        .join("\n"),
    )
    .digest("hex")
    .slice(0, 12);
  const title = creates
    ? `New ${className} ${label}`
    : `${className} ${label}: ${members.length === 1 ? "1 fact" : `${members.length} facts`} to check`;
  const proposers = [...new Set(ordered.map((m) => read.proposals.get(m.iri)!.proposedBy))].filter(
    Boolean,
  );
  await lbb.review({
    workflow: message.workflow,
    key: `starter:${message.workflow}:instance:${instance.slice(instance.lastIndexOf("/") + 1)}:${proposalsHash}`,
    title: review.clip(title, 200),
    rationale: review.clip(
      `${[...whys].slice(0, 3).join(" ")}${proposers.length ? ` Proposed by ${proposers.join(", ")}.` : ""}`,
      500,
    ),
    facts: {
      triplets,
      entity_properties: rows,
      required,
      summary: review.clip(ordered.map((m) => m.outcome.item!.shown.text).join(" · "), 500),
    } as Schemas["SuggestedFacts"],
    mapping: {
      review: {
        instance,
        class: className,
        label,
        new: creates,
        facts: members.length,
        shown: members.length,
        truncated: false,
      },
    },
    evidence: { records: members.length, samples },
  });
}

/** The owned write of a decision: the proposal's status and note, and the facts of a written statement. */
function statusWrite(read: Read, iri: string, outcome: Outcome, settings: Settings) {
  const proposal = read.proposals.get(iri);
  if (!proposal || outcome.status === "decided") return { subjects: [] };
  const own = proposalRef(proposal, settings);
  const written = outcome.status === "written" ? outcome.facts : undefined;
  return {
    subjects: [own],
    properties: ["fact_status", "review_note"],
    entity_properties: [
      ...(written?.entity_properties ?? []),
      {
        ...own,
        properties: {
          fact_status: outcome.status,
          ...(outcome.note ? { review_note: review.clip(outcome.note, 500) } : {}),
        },
      },
    ],
    triplets: written?.triplets ?? [],
  };
}
