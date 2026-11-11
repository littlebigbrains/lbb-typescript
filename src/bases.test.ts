import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { iriSegment } from "./bases.js";
import { LbbClient, baseTerms, type FetchLike, type Schemas } from "./index.js";

// The fixed developer document of contracts/ontology-bases/ pins the terms the
// SDKs build at run time, the file the generator writes and the names the
// server qualifies. Locate it by walking up from the package directory; the
// public repository carries only the SDK, so the pin skips there.
function findFixture(name: string): string | null {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, "contracts/ontology-bases", name);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

const documentPath = findFixture("acme.json");
const termsPath = findFixture("acme.terms.json");

test(
  "the terms of the fixed base are the committed pin",
  {
    skip: documentPath === null || termsPath === null,
  },
  () => {
    const document = JSON.parse(
      readFileSync(documentPath ?? "", "utf8"),
    ) as Schemas["OntologyStarterDocument"];
    const pinned: unknown = JSON.parse(readFileSync(termsPath ?? "", "utf8"));
    assert.deepEqual(baseTerms(document), pinned);
  },
);

test("a qualified name keeps its dot in the IRI segment", () => {
  assert.equal(iriSegment("acme.Agreement"), "acme.agreement");
  assert.equal(iriSegment("acme.OWNED_BY"), "acme.owned_by");
  assert.equal(iriSegment("acme.a b"), "acme.a%20b");
});

function recordingFetch(body: unknown): {
  fetch: FetchLike;
  urls: string[];
  methods: string[];
  bodies: Array<string | undefined>;
} {
  const urls: string[] = [];
  const methods: string[] = [];
  const bodies: Array<string | undefined> = [];
  const fetch: FetchLike = async (url, init) => {
    urls.push(url);
    methods.push(init?.method ?? "GET");
    bodies.push(typeof init?.body === "string" ? init.body : undefined);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    };
  };
  return { fetch, urls, methods, bodies };
}

test("the bases namespace maps each operation to its route", async () => {
  const document = {
    format: 1,
    id: "acme",
    version: "1.0.0",
    label: "Acme",
    description: "",
    sources: [],
    classes: [{ name: "Agreement", description: "", properties: [] }],
    properties: [],
    relations: [],
    shared: [],
    questions: [],
  } as unknown as Schemas["OntologyStarterDocument"];
  const { fetch, urls, methods, bodies } = recordingFetch({
    id: "acme",
    version: "1.0.0",
    checksum: "blake3:x",
    document,
    bases: [],
  });
  const client = new LbbClient({ baseUrl: "http://h", graph: "crm", fetch });

  await client.ontology.bases.store(document);
  await client.ontology.bases.list();
  await client.ontology.bases.get("acme");
  await client.ontology.bases.get("acme", { version: "1.0.0" });
  const terms = await client.ontology.bases.terms("acme");
  await client.ontology.starters.get("acme", { version: "1.0.0" });
  await client.ontology.starters.apply("acme", { version: "1.0.0" });
  await client.ontology.starters.update("acme", { version: "1.0.0" });

  assert.deepEqual(methods, [
    "POST",
    "GET",
    "GET",
    "GET",
    "GET",
    "GET",
    "POST",
    "POST",
  ]);
  assert.deepEqual(urls, [
    "http://h/v1/ontology/bases?graph=crm",
    "http://h/v1/ontology/bases?graph=crm",
    "http://h/v1/ontology/bases/detail?graph=crm&base=acme",
    "http://h/v1/ontology/bases/detail?graph=crm&base=acme&version=1.0.0",
    "http://h/v1/ontology/bases/detail?graph=crm&base=acme",
    "http://h/v1/ontology/starters/detail?graph=crm&starter=acme&version=1.0.0",
    "http://h/v1/ontology/starters/apply?graph=crm",
    "http://h/v1/ontology/starters/update?graph=crm",
  ]);
  assert.deepEqual(JSON.parse(bodies[0] ?? ""), { document });
  assert.deepEqual(JSON.parse(bodies[6] ?? ""), {
    starter: "acme",
    version: "1.0.0",
  });
  assert.deepEqual(JSON.parse(bodies[7] ?? ""), {
    starter: "acme",
    version: "1.0.0",
  });
  assert.equal(terms.classes["Agreement"]?.name, "acme.Agreement");
});
