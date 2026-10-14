// The samples of link, for `npm run try`: an invented CRM (samples/records.json)
// of organizations, contacts, leads, deals and notes, committed with the
// classes, fields and relations it needs. Every name, company and address
// is invented.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LbbClient, Schemas } from "@littlebigbrain/client";

interface SampleRecord {
  id: string;
  class: string;
  name: string;
  fields?: Record<string, string>;
  relations?: Record<string, string[]>;
}

/** The ontology of the samples: their classes, fields and relations. */
export function sampleOntology(records: SampleRecord[]): Schemas["OntologyEvolveOp"][] {
  const classes = [...new Set(records.map((r) => r.class))];
  const fields = [...new Set(records.flatMap((r) => Object.keys(r.fields ?? {})))];
  const relations = new Map<string, { domain: Set<string>; range: Set<string> }>();
  const classOf = new Map(records.map((r) => [r.id, r.class]));
  for (const r of records)
    for (const [relation, targets] of Object.entries(r.relations ?? {})) {
      const entry = relations.get(relation) ?? { domain: new Set(), range: new Set() };
      entry.domain.add(r.class);
      for (const t of targets) entry.range.add(classOf.get(t)!);
      relations.set(relation, entry);
    }
  return [
    ...classes.map((name) => ({ op: "add_entity_type" as const, name })),
    ...fields.map((name) => ({
      op: "add_property" as const,
      name,
      value_type: name === "body" ? "text" : "keyword",
    })),
    ...[...relations].map(([name, { domain, range }]) => ({
      op: "add_relation" as const,
      name,
      domain: [...domain],
      range: [...range],
    })),
  ] as Schemas["OntologyEvolveOp"][];
}

/** Add the classes of the samples, then commit the records and their relations to the client's graph. */
export async function loadSamples(client: LbbClient, dir: string): Promise<void> {
  const records = JSON.parse(await readFile(join(dir, "records.json"), "utf8")) as SampleRecord[];
  await client.ontology.evolve({ ops: sampleOntology(records) });
  const ref = (r: SampleRecord) => ({ type: r.class, name: r.name, key: r.id });
  const byId = new Map(records.map((r) => [r.id, r]));
  await client.commit(
    {
      entity_properties: records.map((r) => ({ ...ref(r), properties: { ...(r.fields ?? {}) } })),
      triplets: records.flatMap((r) =>
        Object.entries(r.relations ?? {}).flatMap(([relation, targets]) =>
          targets.map((t) => ({ source: ref(r), relation, target: ref(byId.get(t)!) })),
        ),
      ),
    },
    { idempotencyKey: "link-samples" },
  );
  console.log(`Committed ${records.length} records`);
}
