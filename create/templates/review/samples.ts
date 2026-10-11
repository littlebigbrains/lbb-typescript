// The samples of review, for `npm run try`: a small graph of the invented school building (two
// rooms and their equipment) and fourteen fact proposals about it (samples/proposals.json), one
// for each case the review decides. This file commits the instances, reads their IRIs back, and
// commits the proposals as a proposer would. samples/README.md in the repository describes them.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ENTITY_IRI_NAMESPACE, type LbbClient, type Schemas } from "@littlebigbrain/client";
import * as review from "./decision.js";
import { defaults } from "./workflow.js";

/** The graph's own ontology: rooms, their equipment, and a room's area. */
export const sampleOntology: Schemas["OntologyEvolveOp"][] = [
  { op: "add_entity_type", name: "Room" },
  { op: "add_entity_type", name: "Equipment" },
  { op: "add_property", name: "identifier", value_type: "keyword" },
  { op: "add_property", name: "area_m2", value_type: "f64" },
  { op: "add_relation", name: "HAS_EQUIPMENT", domain: ["Room"], range: ["Equipment"] },
];

/** The samples of proposals.json. */
export interface SampleProposals {
  instances: { id: string; class: string; name: string; identifier: string }[];
  edges: { source: string; relation: string; target: string }[];
  new: string[];
  proposals: {
    id: string;
    subject: string;
    predicate: string;
    object: string;
    datatype?: string;
    confidence: number;
    line: string;
  }[];
}

/** The proposer the samples name. */
export const PROPOSER = "samples/review";

const PREFIXES: Record<string, string> = {
  "rdf:": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  "rdfs:": "http://www.w3.org/2000/01/rdf-schema#",
  "owl:": "http://www.w3.org/2002/07/owl#",
};
const RELATIONS = new Set(
  sampleOntology.flatMap((op) => (op.op === "add_relation" ? [op.name] : [])),
);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The IRI of an instance the graph does not have yet: minted from its id. */
export const mintedIri = (id: string) =>
  ENTITY_IRI_NAMESPACE + sha256(`samples:${id}`).slice(0, 32);

/** The commit of the sample instances and the edge the graph holds before the run. */
export function instancesCommit(samples: SampleProposals): Schemas["TripletCommitFile"] {
  const ref = (id: string) => {
    const i = samples.instances.find((x) => x.id === id)!;
    return { type: i.class, name: i.name, key: `sample:${i.id}` };
  };
  return {
    entity_properties: samples.instances.map((i) => ({
      ...ref(i.id),
      properties: { identifier: i.identifier },
    })),
    triplets: samples.edges.map((e) => ({
      source: ref(e.source),
      relation: e.relation,
      target: ref(e.target),
    })),
  };
}

/** The statement of a sample proposal; `iris` gives each instance's IRI by its id. */
export function statementOf(
  p: SampleProposals["proposals"][number],
  iris: Map<string, string>,
): review.Statement {
  const iri = (id: string) => (id.startsWith("new:") ? mintedIri(id.slice(4)) : iris.get(id));
  const prefix = Object.keys(PREFIXES).find((k) => p.predicate.startsWith(k));
  const predicate = prefix
    ? PREFIXES[prefix] + p.predicate.slice(prefix.length)
    : /^https?:/.test(p.predicate)
      ? p.predicate
      : RELATIONS.has(p.predicate)
        ? review.relationIri(p.predicate)
        : review.propertyIri(p.predicate);
  const subject = iri(p.subject)!;
  if (predicate === review.RDF_TYPE)
    return { subject, predicate, object: review.classIri(p.object) };
  const object = iri(p.object);
  return object
    ? { subject, predicate, object }
    : { subject, predicate, object: p.object, ...(p.datatype ? { datatype: p.datatype } : {}) };
}

/** The commit of the proposals, as a proposer writes them: one `FactProposal` per statement. */
export function proposalsCommit(
  samples: SampleProposals,
  iris: Map<string, string>,
): Schemas["TripletCommitFile"] {
  return {
    entity_properties: samples.proposals.map((p) => {
      const s = statementOf(p, iris);
      const key = `proposal:${sha256(
        ["fact_proposal_v1", s.subject, s.predicate, s.object, s.datatype ?? "", PROPOSER].join(
          "\u0000",
        ),
      ).slice(0, 32)}`;
      return {
        type: defaults.className,
        name: key,
        key,
        properties: {
          fact_subject: s.subject,
          fact_predicate: s.predicate,
          fact_object: s.object,
          ...(s.datatype ? { fact_datatype: s.datatype } : {}),
          fact_confidence: p.confidence,
          fact_evidence: JSON.stringify({ sample: p.id, line: p.line }),
          proposed_by: PROPOSER,
        },
      };
    }),
  };
}

/** Commit the instances, read their IRIs, then commit the proposals to the client's graph. */
export async function loadSamples(client: LbbClient, dir: string): Promise<void> {
  const samples = JSON.parse(
    await readFile(join(dir, "proposals.json"), "utf8"),
  ) as SampleProposals;
  await client.ontology.evolve({ ops: sampleOntology });
  await client.commit(instancesCommit(samples), { idempotencyKey: "review-samples-instances" });
  const { rows } = await client.sparqlRows(
    {
      query: `SELECT ?s ?identifier WHERE { ?s <${review.propertyIri("identifier")}> ?identifier }`,
    },
    { consistency: "strong" },
  );
  const iris = new Map(
    samples.instances.flatMap((i) => {
      const found = rows.find((r) => r.identifier === i.identifier);
      return found ? [[i.id, found.s!] as const] : [];
    }),
  );
  if (iris.size !== samples.instances.length)
    throw new Error("The sample instances are not readable yet: run npm run try again.");
  await client.commit(proposalsCommit(samples, iris), {
    idempotencyKey: "review-samples-proposals",
  });
  console.log(
    `Committed ${samples.instances.length} instances and ${samples.proposals.length} proposals`,
  );
}
