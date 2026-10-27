// documents-texts: the text of each parsed PDF, as an instance of its class.
//
// LBB's `documents.parse` reads an upload into pages and writes the
// `Document`'s `parse_status`. A named workflow watches that field and sends
// each parsed document here. For each document the workflow:
//
// 1. reads the file's name and SHA-256, and the first page of its parse, to
//    pick the class from the first line: "PURCHASE ORDER", "DELIVERY NOTE" or
//    "INVOICE" (`kindOf`). A document with another first line is skipped;
// 2. in the owned write, reads the pages and joins their lines into one text
//    (`documentText`). It writes one instance of the class with the properties
//    `document_text` and `read_sha256` (the file's SHA-256), and an edge `TEXT_OF` to
//    the `Document`. A rerun replaces them. The pages are read inside the write,
//    so no step saves a text;
// 3. drops the instances it wrote for files that are gone or not parsed any
//    more. An instance it did not write (no `read_sha256`) is never touched,
//    though the workflow owns the three classes.
//
// `values.extract` reads the `document_text` property from there on.
//
// The names of what the workflow owns (the property `document_text`, the relation
// `TEXT_OF`) are its own on purpose: `rows` and `sections` own `READ_FROM` and `text`,
// and the server counts a workflow that watches `Document` and a content workflow as
// overlapping, so a shared name is refused (`workflow_owns_conflict`).
import {
  LbbError,
  entityRef,
  triggeredWorkflow,
  type LbbActivities,
  type Schemas,
  type WorkflowContext,
  type WorkflowTriggerMessage,
} from "@littlebigbrain/client";

/** The workflow type and version the named workflow names. */
export const textsType = { workflow_type: "documents-texts", version: "v1" };
export const TEXTS_NAME = "documents-texts";

/** A kind of document: its class, and the first line that names it. */
export interface Kind {
  className: string;
  /** The first line of the document, in lower case. */
  title: string;
  /** The properties `values.extract` fills for the class. */
  properties: string[];
}

/** The kinds of the samples: edit them for your documents. */
export const KINDS: Kind[] = [
  {
    className: "PurchaseOrder",
    title: "purchase order",
    properties: ["reference", "quantity", "price", "total"],
  },
  {
    className: "DeliveryNote",
    title: "delivery note",
    properties: ["reference", "order", "quantity"],
  },
  {
    className: "Invoice",
    title: "invoice",
    properties: ["reference", "order", "delivery", "quantity", "price", "total"],
  },
];

/** What goes between the lines of a page in a document's text. */
export const SEPARATOR = " | ";
/** Characters of a text the instance keeps. */
export const TEXT_CHARS = 20_000;

/**
 * The class every kind is a subclass of. `documents-check` watches it: a change of
 * any field of an instance of a kind, or the removal of an instance, wakes the
 * check, whichever class the instance is.
 */
export const DOCUMENT_CLASS = "BusinessDocument";

/** The property that holds the SHA-256 of the file an instance was read from: it marks the instances this workflow wrote. */
export const SHA_PROPERTY = "read_sha256";

/** The property that holds the text of a document. */
export const TEXT_PROPERTY = "document_text";

/** The relation from an instance to the file it was read from. */
export const TEXT_OF = "TEXT_OF";

/** One line of a parsed page, as much as the workflow reads of it. */
export interface PageLine {
  text: string;
  box: number[];
}
export interface PageOf {
  page: number;
  lines: PageLine[];
}

/** The text of a document: the lines of its pages, one after the other, joined by {@link SEPARATOR}. */
export function documentText(pages: readonly PageOf[]): string {
  return pages
    .flatMap((page) => page.lines.map((line) => line.text))
    .join(SEPARATOR)
    .slice(0, TEXT_CHARS);
}

/** The kind a text is: the one whose title is its first line, or undefined. */
export function kindOf(text: string, kinds: readonly Kind[] = KINDS): Kind | undefined {
  const first = (text.split(SEPARATOR)[0] ?? "").trim().toLowerCase();
  return kinds.find((kind) => first === kind.title);
}

/** The named workflow with its watch: `client.workflows.named.put(textsWorkflow())`. */
export function textsWorkflow(): Schemas["NamedWorkflowRequest"] {
  return {
    name: TEXTS_NAME,
    workflow: textsType,
    batch: 8,
    triggers: [{ id: "documents", watch: { class: "Document", fields: ["parse_status"] } }],
    owns: {
      classes: KINDS.map((kind) => kind.className),
      relations: [TEXT_OF],
      properties: [TEXT_PROPERTY, SHA_PROPERTY],
    },
  };
}

/** What the workflow has done, over all its turns. */
export interface TextsState {
  /** Instances written. */
  texts: number;
  /** Documents skipped: not parsed, or of no known kind. */
  skipped: number;
  /** Instances dropped. */
  dropped: number;
}

interface Doc {
  iri: string;
  name: string;
  sha256: string;
  parsed: boolean;
}

const P = "PREFIX p: <https://littlebigbrain.com/p/>\nPREFIX r: <https://littlebigbrain.com/r/>\n";
const iris = (list: string[]) =>
  list
    .filter((iri) => /^[^\s<>"{}|\\^`]+$/.test(iri))
    .map((iri) => `<${iri}>`)
    .join(" ");

/**
 * A SPARQL read at commit `seq`, without `strong`: a strong read waits for the
 * head to publish and can starve under other writers, and it can be newer than
 * what a workflow set out to read. A commit the server no longer retains is read
 * at the published head instead. Without `seq`, the published head.
 */
export async function sparqlAt(lbb: LbbActivities, query: string, seq?: number) {
  if (seq === undefined) return lbb.sparql(query);
  try {
    return await lbb.sparql({ query, as_of_commit_seq: seq });
  } catch (error) {
    if (error instanceof LbbError && error.code === "historical_generation_unavailable")
      return lbb.sparql(query);
    throw error;
  }
}

/** The key of the instance a file's text is written to. */
export const instanceKey = (sha256: string) => `text:${sha256}`;

/** The workflow, for a `WorkflowWorker`. `lbb` is `lbbActivities(client)`, or a mock in a test. */
export function createTextsWorkflow(lbb: LbbActivities) {
  return triggeredWorkflow<TextsState>({
    name: textsType.workflow_type,
    version: textsType.version,
    initialState: { texts: 0, skipped: 0, dropped: 0 },
    async onInstances(ctx, message, state) {
      const docs = await ctx.step("documents", () => readDocuments(lbb, message));
      const parsed = docs.filter((doc) => doc.parsed);
      const unparsed = docs.filter((doc) => !doc.parsed && doc.sha256).map((doc) => doc.sha256);
      const dropped =
        message.removed.length || docs.some((doc) => !doc.parsed)
          ? await dropTexts(ctx, lbb, unparsed, message.as_of_commit_seq)
          : 0;

      // The class of each parsed document, from the first line of its first page.
      const classes = await ctx.step("kinds", async () => {
        const out: (string | null)[] = [];
        for (const doc of parsed) {
          const { pages } = await lbb.pages(doc.sha256, { to: 1 });
          out.push(kindOf(documentText(pages))?.className ?? null);
        }
        return out;
      });
      const found = parsed.flatMap((doc, index) => {
        const kind = KINDS.find((k) => k.className === classes[index]);
        return kind ? [{ doc, kind }] : [];
      });
      if (found.length) {
        await lbb.writeOwned(ctx, "texts", async () => {
          const texts: string[] = [];
          for (const { doc } of found)
            texts.push(documentText((await lbb.pages(doc.sha256)).pages));
          const refs = found.map(({ doc, kind }) => ({
            type: kind.className,
            key: instanceKey(doc.sha256),
            name: doc.name,
          }));
          return {
            subjects: refs,
            relations: [TEXT_OF],
            properties: [TEXT_PROPERTY, SHA_PROPERTY],
            entity_properties: found.map(({ kind, doc }, i) => ({
              type: kind.className,
              key: instanceKey(doc.sha256),
              name: doc.name,
              properties: { [TEXT_PROPERTY]: texts[i]!, [SHA_PROPERTY]: doc.sha256 },
            })),
            triplets: found.map(({ doc }, i) => ({
              source: refs[i]!,
              relation: TEXT_OF,
              target: entityRef(doc.iri, "Document", doc.name),
            })),
          };
        });
      }
      return {
        state: {
          texts: state.texts + found.length,
          skipped: state.skipped + parsed.length - found.length,
          dropped: state.dropped + dropped,
        },
      };
    },
  });
}

/** The name, file and parse of each document, at the message's commit. */
async function readDocuments(lbb: LbbActivities, message: WorkflowTriggerMessage): Promise<Doc[]> {
  if (!message.instances.length) return [];
  const query = `# documents-texts: documents\n${P}SELECT ?doc ?name ?sha ?status WHERE {
  VALUES ?doc { ${iris(message.instances)} }
  OPTIONAL { ?doc p:name ?name } OPTIONAL { ?doc p:file_sha256 ?sha } OPTIONAL { ?doc p:parse_status ?status }
}`;
  const { rows } = await lbb.sparql({ query, as_of_commit_seq: message.as_of_commit_seq });
  return message.instances.map((iri) => {
    const row = rows.find((r) => r.doc === iri) ?? {};
    return {
      iri,
      name: row.name ?? iri,
      sha256: row.sha ?? "",
      parsed: row.status === "parsed" && Boolean(row.sha),
    };
  });
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Retract the instances this workflow wrote for files that are gone, or that are
 * not parsed any more (`unparsed` lists their SHA-256). An instance of the
 * classes that carries no `read_sha256` is somebody else's and stays: a retracted
 * entity loses every statement, whoever wrote it. Deleting a file retracts the
 * `Document` and the edges to it, so a file is gone when no `Document` holds its
 * SHA-256. The read is at the message's commit: it sees the delete, and no
 * instance a later message writes.
 */
async function dropTexts(
  ctx: WorkflowContext,
  lbb: LbbActivities,
  unparsed: string[],
  seq: number,
): Promise<number> {
  const found = await ctx.step("drop-find", async () => {
    const classes = KINDS.map(
      (kind) => `<https://littlebigbrain.com/class/${kind.className.toLowerCase()}>`,
    );
    const listed = unparsed.filter((sha) => SHA256.test(sha)).map((sha) => `"${sha}"`);
    const query = `# documents-texts: instances\n${P}SELECT ?instance ?class WHERE {
  VALUES ?class { ${classes.join(" ")} }
  { ?instance a ?class ; p:${SHA_PROPERTY} ?sha . FILTER NOT EXISTS { ?document p:file_sha256 ?sha } }${
    listed.length
      ? `\n  UNION { ?instance a ?class ; p:${SHA_PROPERTY} ?sha . VALUES ?sha { ${listed.join(" ")} } }`
      : ""
  }
}`;
    const { rows } = await sparqlAt(lbb, query, seq);
    return rows.flatMap((row) => {
      const kind = KINDS.find(
        (k) => `https://littlebigbrain.com/class/${k.className.toLowerCase()}` === row.class,
      );
      return kind && row.instance ? [{ iri: row.instance, type: kind.className }] : [];
    });
  });
  if (found.length)
    await lbb.writeOwned(ctx, "drop", {
      subjects: [],
      retract_entities: found.map((e) => entityRef(e.iri, e.type)),
    });
  return found.length;
}
