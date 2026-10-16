// sections: the sections of each Markdown file, split at its headings, as
// instances with an edge to their parent whose evidence is their lines.
//
// A named workflow with a content trigger sends each upload of
// `text/markdown` (and `text/plain` with a `.md` name) here within seconds,
// one file per message, without a wait for a publication. For each file the
// workflow:
//
// 1. reads the file's name and checks its derivation: a file this version
//    already read with these settings is skipped, so identical bytes under
//    two names are read once;
// 2. splits the file at its ATX headings (`#` to `######`; a line in a
//    fenced code block is no heading);
// 3. writes one instance of the settings' class per section, with `title`,
//    `level`, `text`, `heading_path` and `position`, and an edge `PART_OF`
//    to its parent section or to the file's `Document`. The edge's evidence
//    is the heading line, with the source
//    `<Document IRI>#line=<from>,<to>` (RFC 5147: `#line=39,44` is lines 40
//    to 44);
// 4. with `represents`, writes `Document REPRESENTS <instance>` when the
//    file's name names exactly one instance of that class;
// 5. records the derivation, for the upload its check named. When the file
//    was deleted (or deleted and uploaded again) since, nothing is recorded,
//    and the run of the new upload reads the file again. A file deleted and
//    not uploaded again answers 404 to the next read of its bytes: the run
//    ends there and counts the file as skipped.
//
// A turn writes at most `sectionsPerTurn` sections; the rest goes to a new
// turn (`ctx.continue`).
import { createHash } from "node:crypto";
import {
  LbbError,
  entityRef,
  isDerivationUploadChanged,
  triggeredWorkflow,
  type LbbActivities,
  type Schemas,
  type WorkflowTriggerMessage,
} from "@littlebigbrain/client";
import { lineFragment, markdownSections, type Section } from "./markdown.js";

export interface Settings {
  /** The class of the sections. */
  className: string;
  /** Also write `Document REPRESENTS <instance>` when the file's name, without its extension, is the label of exactly one instance of this class. */
  represents?: { class: string };
  /** Only files whose name matches this regular expression. Default: every file. */
  match?: string;
  /** Sections one turn writes, 1 to 5,000. */
  sectionsPerTurn: number;
}

/** The settings: edit them for your files. These fit the samples. */
export const defaults: Settings = {
  className: "Section",
  sectionsPerTurn: 1_000,
};

/** The workflow type and version the named workflow names, and the derivations record. */
export const workflowType = { workflow_type: "sections", version: "v1" };

/** The media types the content trigger sends. `text/plain` counts with a `.md` or `.markdown` name. */
export const MEDIA_TYPES = ["text/markdown", "text/x-markdown", "text/plain"];

/** The relation from each section to its parent section or its file. */
export const PART_OF = "PART_OF";
const REPRESENTS = "REPRESENTS";
/** The properties of a section. */
export const PROPERTIES = ["title", "level", "text", "heading_path", "position"];

/** The named workflow with its content trigger: `client.workflows.named.put(trigger())`. */
export function trigger(settings: Settings = defaults): Schemas["NamedWorkflowRequest"] {
  return {
    name: "sections",
    workflow: workflowType,
    triggers: [{ id: "sections", content: { media_types: MEDIA_TYPES } }],
    owns: {
      classes: [settings.className],
      relations: [PART_OF, ...(settings.represents ? [REPRESENTS] : [])],
      properties: PROPERTIES,
    },
  };
}

/** The class, properties and relations the workflow writes: `lbb.evolve(ontology())`. */
export function ontology(settings: Settings = defaults): Schemas["OntologyEvolveOp"][] {
  const property = (name: string, value_type: string) => ({
    op: "add_property" as const,
    name,
    value_type,
  });
  return [
    { op: "add_entity_type", name: settings.className },
    { op: "add_entity_type", name: "Document" },
    property("title", "text"),
    property("level", "i64"),
    property("text", "text"),
    property("heading_path", "text"),
    property("position", "i64"),
    {
      op: "add_relation",
      name: PART_OF,
      domain: [settings.className],
      range: [settings.className, "Document"],
    },
    // The relation an upload adds (from `Document` to any class); adding it again changes nothing.
    ...(settings.represents
      ? [{ op: "add_relation" as const, name: REPRESENTS, domain: ["Document"], range: [] }]
      : []),
  ];
}

/** What a client reads for the workflow beside the activities. An `LbbClient` has both. */
export interface ContentPorts {
  files: { content(sha256: string): Promise<Uint8Array> };
  workflows: {
    derivations: {
      check(key: Schemas["DerivationKey"]): Promise<Schemas["DerivationCheckResponse"]>;
      record(
        request: Schemas["DerivationRecordRequest"],
      ): Promise<Schemas["DerivationRecordResponse"]>;
    };
  };
}

/** What the workflow has done, over all its turns. */
export interface SectionsState {
  /** Files read to their end. */
  contents: number;
  /** Files skipped: read before with these settings, another name or type, no file, or deleted while read. */
  skipped: number;
  sections: number;
  represents: number;
}

/** A file of the graph: its content's SHA-256, its `Document`, its name and media type. */
interface FileInfo {
  sha256: string;
  document: string;
  name: string;
  mediaType: string;
}

/** What the check of a file found: the file to read and its upload, or why it is skipped. */
interface Checked {
  file?: FileInfo;
  /** The `content_uploaded_at` of the check: absent without a file record. */
  uploadedAt?: string;
  skip?: string;
}

/** What the first turn of a file decides, carried by its later turns. */
interface Plan {
  sha256: string;
  document: string;
  name: string;
  count: number;
  represents: string | null;
  /** The upload of the file the check named: the record names it. */
  uploadedAt?: string;
}

/** Where a file's next turn starts, and the commits of its writes so far. */
interface Cursor {
  /** The index of the next section. */
  next: number;
  plan: Plan;
  commits: number[];
}

/** A trigger message; a file's later turns carry the cursor. */
type SectionsMessage = WorkflowTriggerMessage & { cursor?: Cursor };

/** Sections one owned write holds. */
const PART = 100;
/** Characters of a section's text the instance keeps. */
export const TEXT_CHARS = 8_000;
const SHA256 = /^[0-9a-f]{64}$/;
const PLAIN_IRI = /^[^\s<>"{}|\\^`]+$/;
const MARKDOWN_NAME = /\.(md|markdown)$/i;
const P = "PREFIX p: <https://littlebigbrain.com/p/>\n";
const LABEL = "http://www.w3.org/2000/01/rdf-schema#label";

/** The media type without parameters, in lower case. */
const baseType = (mediaType: string) => mediaType.split(";")[0]!.trim().toLowerCase();

/** Whether an error is the 404 of a file's bytes: the file was deleted and not uploaded again. */
export const fileGone = (error: unknown) =>
  error instanceof LbbError && error.status === 404 && error.code === "file_not_found";

/** A file name without its last extension. */
export const stem = (name: string) => name.replace(/\.[^./\\]*$/, "");

/** A label for comparing a file name with labels: lower case, and runs of `-`, `_` and spaces as one space. */
export const labelKey = (text: string) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[-_\s]+/g, " ")
    .trim();

/** JSON with its object keys sorted, so equal settings give one digest. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The settings digest of the derivations: the hex SHA-256 of the settings' canonical JSON. */
export function settingsDigest(settings: Settings): string {
  return createHash("sha256").update(canonical(settings)).digest("hex");
}

/** The derivation key of one content with these settings. */
export function derivationKey(sha256: string, settings: Settings): Schemas["DerivationKey"] {
  return { sha256, ...workflowType, settings_digest: settingsDigest(settings) };
}

/** Whether a file is Markdown: by its media type, or `text/plain` and other types with a `.md` name. */
export function isMarkdown(mediaType: string, name: string): boolean {
  return (
    mediaType === "text/markdown" || mediaType === "text/x-markdown" || MARKDOWN_NAME.test(name)
  );
}

/** The workflow, for a `WorkflowWorker`. `lbb` is `lbbActivities(client)` and `ports` the client, or mocks in a test. */
export function createWorkflow(
  lbb: LbbActivities,
  ports: ContentPorts,
  settings: Settings = defaults,
) {
  if (!(Number.isSafeInteger(settings.sectionsPerTurn) && settings.sectionsPerTurn >= 1))
    throw new RangeError("sectionsPerTurn is a whole number from 1");
  if (settings.sectionsPerTurn > 5_000)
    throw new RangeError("sectionsPerTurn is at most 5,000: a turn holds 64 steps");
  const match = settings.match ? new RegExp(settings.match, "u") : null;

  return triggeredWorkflow<SectionsState>({
    name: workflowType.workflow_type,
    version: workflowType.version,
    initialState: { contents: 0, skipped: 0, sections: 0, represents: 0 },
    async onInstances(ctx, message: SectionsMessage, state) {
      /** The state after this file: the message's next instance goes to a new turn. */
      const rest = (next: SectionsState) => {
        const others = message.instances.slice(1);
        if (!others.length) return { state: next };
        const plain: SectionsMessage = {
          ...message,
          instances: others,
          removed: [],
          origin: null,
        };
        delete plain.cursor;
        return ctx.continue(next, plain);
      };
      try {
        const document = message.instances[0];
        if (!document) return { state };
        let split: Promise<Section[]> | undefined;
        const sectionsOf = (sha256: string, name: string) =>
          (split ??= ports.files
            .content(sha256)
            .then((bytes) => markdownSections(new TextDecoder().decode(bytes), stem(name))));

        let cursor = message.cursor;
        if (!cursor) {
          const checked = await ctx.step("check", async (s): Promise<Checked> => {
            s.progress("checking the file", { done: 0, total: 1, unit: "documents" });
            const file = await readDocument(message, document);
            if (!file) return { skip: "no file" };
            if (!isMarkdown(file.mediaType, file.name)) return { skip: "media type" };
            if (match && !match.test(file.name)) return { skip: "name" };
            const found = await ports.workflows.derivations.check(
              derivationKey(file.sha256, settings),
            );
            if (found.exists) return { skip: "derived" };
            const uploadedAt = found.content_uploaded_at ?? undefined;
            return uploadedAt ? { file, uploadedAt } : { file };
          });
          if (!checked.file) return rest({ ...state, skipped: state.skipped + 1 });
          const file = checked.file;
          const planned = await ctx.step("plan", async (s) => {
            s.progress("reading sections", { done: 0, unit: "sections" });
            const count = (await sectionsOf(file.sha256, file.name)).length;
            s.progress("reading sections", { done: count, total: count, unit: "sections" });
            const found = settings.represents ? await representsOf(file.name) : null;
            const plan: Plan = {
              ...file,
              count,
              represents: found?.iri ?? null,
              ...(checked.uploadedAt ? { uploadedAt: checked.uploadedAt } : {}),
            };
            return { plan, label: found?.label ?? null };
          });
          const commits: number[] = [];
          const p = planned.plan;
          if (p.represents) {
            const written = await lbb.writeOwned(ctx, "represents", (s) => {
              s.progress("writing facts", { done: 0, total: 1, unit: "documents" });
              return {
                subjects: [entityRef(p.document, "Document", p.name)],
                relations: [REPRESENTS],
                triplets: [
                  {
                    source: entityRef(p.document, "Document", p.name),
                    relation: REPRESENTS,
                    target: entityRef(
                      p.represents!,
                      settings.represents!.class,
                      planned.label ?? undefined,
                    ),
                    confidence: 1,
                    evidence: { text: p.name, source_id: p.document },
                  },
                ],
              };
            });
            if (written.commit_seq !== null) commits.push(written.commit_seq);
          }
          cursor = { next: 0, plan: p, commits };
        }

        // The sections of this turn, written in parts.
        const { plan, next: from } = cursor;
        const to = Math.min(plan.count, from + settings.sectionsPerTurn);
        const commits = [...cursor.commits];
        for (let n = 0; from + n * PART < to; n++) {
          const written = await lbb.writeOwned(ctx, `write-${n}`, async (s) => {
            s.progress("writing facts", { done: n * PART, total: to - from, unit: "sections" });
            const all = await sectionsOf(plan.sha256, plan.name);
            const start = from + n * PART;
            return partWrite(plan, all, all.slice(start, Math.min(to, start + PART)));
          });
          if (written.commit_seq !== null) commits.push(written.commit_seq);
        }
        const counted = { ...state, sections: state.sections + (to - from) };
        if (to < plan.count)
          return ctx.continue(counted, {
            ...message,
            removed: [],
            cursor: { next: to, plan, commits: commits.slice(0, 256) },
          });

        const recorded = await ctx.step("record", async (s) => {
          s.progress("recording the derivation", { done: 0, total: 1, unit: "documents" });
          const all = plan.count ? await sectionsOf(plan.sha256, plan.name) : [];
          const levels: Record<string, number> = {};
          for (const section of all) levels[section.level] = (levels[section.level] ?? 0) + 1;
          try {
            const answer = await ports.workflows.derivations.record({
              ...derivationKey(plan.sha256, settings),
              run_id: ctx.messageId,
              outputs: {
                sections: plan.count,
                levels,
                represents: plan.represents,
                commits: commits.slice(0, 256),
              },
              ...(plan.uploadedAt ? { content_uploaded_at: plan.uploadedAt } : {}),
            });
            return answer.recorded;
          } catch (error) {
            // The file was deleted while this run read it: nothing is
            // recorded, and the run of a new upload reads it again.
            if (isDerivationUploadChanged(error)) return "upload changed";
            throw error;
          }
        });
        if (recorded === "upload changed")
          return rest({ ...counted, skipped: counted.skipped + 1 });
        return rest({
          ...counted,
          contents: counted.contents + 1,
          represents: counted.represents + (plan.represents ? 1 : 0),
        });
      } catch (error) {
        // The file was deleted while this run read it, and not uploaded
        // again: its bytes answer 404. Nothing is recorded, and the file
        // counts as skipped.
        if (!fileGone(error)) throw error;
        return rest({ ...state, skipped: state.skipped + 1 });
      }
    },
  });

  /** The file of a `Document`: its SHA-256, name and media type, read with a strong read. */
  async function readDocument(
    message: SectionsMessage,
    document: string,
  ): Promise<FileInfo | null> {
    if (!PLAIN_IRI.test(document)) return null;
    const query = `# sections: document\n${P}SELECT ?name ?sha ?type WHERE {
  VALUES ?doc { <${document}> }
  OPTIONAL { ?doc p:name ?name } OPTIONAL { ?doc p:file_sha256 ?sha } OPTIONAL { ?doc p:content_type ?type }
}`;
    const { rows } = await lbb.sparql(query, { consistency: "strong" });
    const row = rows[0] ?? {};
    const origin =
      message.instances.length === 1 && message.origin?.kind === "content" ? message.origin : null;
    const sha256 = (origin?.sha256 ?? row.sha ?? "").toLowerCase();
    if (!SHA256.test(sha256)) return null;
    return {
      sha256,
      document,
      name: row.name ?? sha256.slice(0, 12),
      mediaType: baseType(origin?.media_type ?? row.type ?? ""),
    };
  }

  /** The one instance of the `represents` class whose label is the file's name without its extension; null for none or several. */
  async function representsOf(name: string) {
    const wanted = labelKey(stem(name));
    if (!wanted) return null;
    const cls = `https://littlebigbrain.com/class/${encodeURIComponent(settings.represents!.class.toLowerCase())}`;
    const query = `# sections: represents
SELECT DISTINCT ?s ?label WHERE {
  ?s a <${cls}> ; <${LABEL}> ?label .
  FILTER(REPLACE(REPLACE(LCASE(STR(?label)), "[-_\\\\s]+", " "), "^ | $", "") = ${JSON.stringify(wanted)})
}
LIMIT 2`;
    const { rows } = await lbb.sparql(query, { consistency: "strong" });
    const iris = [...new Set(rows.map((r) => r.s).filter(Boolean))];
    if (iris.length !== 1) return null;
    return { iri: iris[0]!, label: rows[0]!.label ?? stem(name) };
  }

  /** The entity of a section: keyed by the content and its position. */
  function sectionRef(plan: Plan, section: Section) {
    const name = (section.title || `${stem(plan.name)} section ${section.position}`).slice(0, 200);
    return { type: settings.className, name, key: `${plan.sha256}:${section.position}` };
  }

  /** The owned write of a part of the sections: their properties replaced, and each one's edge to its parent. */
  function partWrite(plan: Plan, all: Section[], part: Section[]) {
    const document = entityRef(plan.document, "Document", plan.name);
    const byPosition = new Map(all.map((section) => [section.position, section]));
    const subjects: Schemas["NamedEntityInput"][] = [];
    const entity_properties: Schemas["EntityPropertiesInput"][] = [];
    const triplets: Schemas["TripletInput"][] = [];
    for (const section of part) {
      const ref = sectionRef(plan, section);
      const parent = section.parent === null ? null : byPosition.get(section.parent);
      subjects.push(ref);
      entity_properties.push({
        ...ref,
        properties: {
          ...(section.title ? { title: section.title } : {}),
          level: section.level,
          ...(section.text ? { text: section.text.slice(0, TEXT_CHARS) } : {}),
          ...(section.headingPath.length ? { heading_path: section.headingPath.join(" > ") } : {}),
          position: section.position,
        },
      });
      triplets.push({
        source: ref,
        relation: PART_OF,
        target: parent ? sectionRef(plan, parent) : document,
        confidence: 1,
        evidence: {
          text: section.quote.slice(0, 1_000),
          source_id: `${plan.document}#${lineFragment(section)}`,
        },
      });
    }
    return { subjects, relations: [PART_OF], properties: PROPERTIES, entity_properties, triplets };
  }
}
