# sections

Reads each Markdown file of a graph into its sections. A handbook gives one
`Section` per heading, with its title, its level, its own text, the path of
headings above it and its position. Each section has an edge `PART_OF` to
its parent section, or to the file's `Document` when it has none. The
edge's evidence is the heading line, and its source is the file's IRI with
the section's lines: `https://littlebigbrain.com/e/41ab…#line=39,44` is
lines 40 to 44 (RFC 5147,
[evidence.md](../../../docs/reference/evidence.md#evidence-from-a-file)).

The template has no LBB-run version. It is a named workflow with a
**content trigger**: LBB sends it each upload of `text/markdown`,
`text/x-markdown` and `text/plain` within seconds, without a wait for a
publication ([workflows.md](../../../docs/reference/workflows.md#content-triggers)).
A `text/plain` file is read when its name ends with `.md` or `.markdown`.

## How it runs

Each message holds one file. The first turn of a file:

1. **Check.** Reads the file's name with a strong read, and the
   derivation of the content for `sections@v1` and the settings
   ([Derivations](../../../docs/reference/workflows.md#derivations)). A
   content with a derivation is skipped, so the same bytes under a second
   name are read once. So is a file whose name the settings' `match` does
   not match, and a `text/plain` file without a Markdown name.
2. **Plan.** Reads the bytes (`client.files.content`) and splits them at
   their ATX headings (`#` to `######`, up to 3 spaces before them, a
   space after them). A line in a fenced code block (three or more
   backticks or tildes) is text. Closing hashes (`## Escalation ##`) are
   dropped.
3. **Represents.** With `represents`, when the file's name without its
   extension is the label of exactly one instance of that class, writes
   `Document REPRESENTS <instance>`. `support-handbook.md` represents the
   guide `Support handbook`: the labels compare in lower case, with `-`,
   `_` and spaces as one space. No match, or more than one, writes nothing
   and proposes nothing.

Then each turn writes at most `sectionsPerTurn` sections in owned writes of
100. A section is one instance of the settings' class, keyed
`<sha256>:<position>`:

| Property | Holds |
| --- | --- |
| `title` | The heading's text |
| `level` | 1 to 6 |
| `text` | The lines after the heading up to the next heading, at most 8,000 characters |
| `heading_path` | The titles from the top heading to its own, joined by ` > ` |
| `position` | Its place in the file: 1, 2, … |

The parent of a section is the nearest heading above it of a lower level.
The text before the first heading, when it is not blank, is the section at
position 0, of level 0, titled with the file's name without its extension.
A section's lines run from its heading to its last line that is not
blank. The last turn records the derivation: the sections, their count per
level, the instance the file represents, and the commits of the writes. The record names the upload the check
answered (`content_uploaded_at`). The cursor carries it from turn to turn.
When the file was deleted while the run read it, the record writes nothing
(`409 derivation_upload_changed`). The run ends and counts the file as
skipped. The run of a new upload reads the file again. Say the file was
deleted and not uploaded again. The next read of its bytes answers
`404 file_not_found`. The run ends there too, and counts the file as
skipped.

## Settings

`defaults` in `workflow.ts`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `className` | `Section` | The class of the sections |
| `represents` | none | Write `REPRESENTS` to the one instance of this class that the file's name names. The samples' guides are of the class `Guide` |
| `match` | none | A regular expression on the file's name. Without it, every Markdown file |
| `sectionsPerTurn` | 1,000 | Sections one turn writes, 1 to 5,000 |

`trigger(settings)` names the workflow `sections`, with the content trigger
`sections`. It owns the class, `PART_OF`, `REPRESENTS` when `represents`
is set, and the five properties. `ontology(settings)` adds the class, the
properties and `PART_OF`.

The settings digest is the SHA-256 of the settings' canonical JSON: a
change of any setting reads every file again.

Two content workflows own one relation when no upload can reach both:
`rows` and `sections`, both with `represents`, go on one graph, because no
media type of one meets a media type of the other. A second workflow that
writes `REPRESENTS` for a type that meets one of these, such as `text/*`, is
refused with `409 workflow_owns_conflict`
([starter-workflows.md](../../../docs/reference/starter-workflows.md#cycles-and-conflicts)).

## Commands

`setup.ts`, `worker.ts` and `try.ts` are the template's own:
`npm run setup` creates the named workflow with
`client.workflows.named.put(trigger())`, and `npm start` serves
`createWorkflow(lbbActivities(client), client)`: the client reads the
files' bytes and the derivations. `npm run try` creates the graph
`try-sections`, commits the two sample guides, uploads the sample handbook
and creates the workflow.

## Limits

- Setext headings (a line of `===` or `---` under the text) start no
  section.
- Another `className` in the settings writes the sections again as new
  instances; the instances of the earlier class stay.
- A file deleted later keeps its sections; their `PART_OF` edges to the
  file go with its `Document`.

## Samples and test

`samples/support-handbook.md` is an invented support handbook: text before
the first heading, headings of levels 1 to 3, a heading without text of
its own, a fenced code block with a line that starts with `#`, closing
hashes, and a `#` without a space. `samples/guides.json` holds two guides
the file's name can name. `samples/expected.json` gives the 8 sections a
correct run writes, each with its parent and its lines.

`workflow.test.ts` runs the workflow without a server (`MockContent` holds
the files and the derivations). It checks the answer key, the evidence of
each section, `text/plain` with and without a Markdown name, a file
without a heading, an empty file, a file of more sections than a turn
writes, the skip by derivation, `represents` with zero, one and two
matching instances, the phases, and the heading rules.
