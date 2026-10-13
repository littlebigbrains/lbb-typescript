# documents-link

Connects mentions of the same thing across the documents of a graph. It
finds the identifiers the documents define (the codes of a parts list, the
sections of a specification) and the spans that refer to them. Each
mention links to the entry of the same thing, in the same document or in
another one. A manual's `P114` gets a `REFERS_TO` link to `P 114` of the
parts list, with the line as evidence and the span's box on the page as
its region.

The LBB-run version is the starter workflow `documents.link@v1`
(`docs/reference/starter-workflows.md`, "Document workflows"). This
template is the same pipeline in TypeScript: the workflow in `workflow.ts`, its
prompts, rules and facts in `link.ts`.

## How it runs

The triggered workflow watches the class `Document` and its field
`parse_status`, which LBB's `documents.parse` writes when it has read a
PDF's text layer. Each trigger message names the documents to read. The
workflow reads them in windows of pages (`pagesPerWindow`, default 12),
one window per turn, and continues with the next window in a new turn
(`ctx.continue`). A turn holds at most 64 steps, and a window of 12 pages
uses 28.

1. **Define** (`workflow.ts`, `define`). Per page, a step asks the reasoning
   model which identifiers the page defines. The prompt and its schema come
   from the LBB link stage: the page as rows of `[line id] text`, lines on
   one baseline joined by ` | `. A definition is kept when its line holds
   the identifier. The window's entries are written as `DocEntry` entities
   (`identifier`, `context`, `line_id`, `page` and the line's box)
   `DEFINED_IN` the document, owned per entry. Every defining window of a
   message runs before its first link window.
2. **Mentions.** Per page, a step asks the reasoning model which spans may
   be codes. A span is kept when its line holds it.
3. **Candidates.** The catalogue is every `DocEntry` of the graph, read with
   a strong SPARQL read so it holds the entries this workflow wrote a turn
   ago. A mention's candidates are the 30 entries closest in characters
   (first the entries with the span's identifier key: no whitespace, no
   case, and no dot between leading letters and a digit, so `S1.1`, `s 1.1`
   and `S.1.1` find `S 1.1`), up to 10 whose context holds the span as a
   word, and the 10 closest in meaning: one step embeds the entries (`identifier: context`) and the
   mentions (`span — row`). A mention never links to the entry its own line
   defines.
4. **Decide.** Per page, a step asks the decision model two questions per
   mention: its kind (`identifier`, `abbreviation`, `value`, `own_number`,
   `external`) and which candidate it is a name for, or none. A request
   holds at most 32 mentions and 60,000 characters. A request the model
   refuses (`422 activity_request_refused`) is split in halves, each with
   its own effect id (`<step effect id>.0`, `.1`), down to one mention.
5. **Link rule and gate.** A mention links when `identifier` and
   `abbreviation` together have a probability of at least 0.5 and the names
   answer chose an entry. The confidence is the smaller of the two. A link
   at or above the gate (default 0.8) is written; one below the gate
   becomes a review item with the link as its facts, one per document,
   span and entry, with at most 100 links per item.
6. **Write.** The window's mentions are written as `DocMention` entities
   (`span`, `kind`, `line_id`, `line_text`, `page` and the span's box)
   `MENTIONED_IN` the document, with their `REFERS_TO` links, owned per
   mention: a rerun replaces the earlier links. A commit names at most
   1,000 entities, so the entries and the mentions of a window are written
   in parts of 900.

A document that leaves the graph (a deleted file) or loses its parse loses
the entries and mentions this workflow wrote for it.

## Settings

`defaults` in `workflow.ts`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `gate` | 0.8 | A link below this confidence goes to review |
| `roles` | the samples' | The part of each document by file name: `defines` (its entries join the catalogue, its mentions are not read), `refers` (its mentions are linked, it adds no entries) or `both` (a document the map does not name) |
| `pagesPerWindow` | 12 | Pages one turn reads, 1 to 20 |

The triggered workflow (`trigger()`) is named `documents-link` and owns the
classes `DocEntry` and `DocMention` and the relations `DEFINED_IN`,
`MENTIONED_IN` and `REFERS_TO`. Do not run it beside an LBB-run
`documents.link` on the same graph: they own the same relations.

## What the LBB-run version adds

- **Retries of empty answers.** An answer whose items all fail the line
  check is asked once more, with a note on what went wrong; an answer of
  blank items says the page holds nothing.
- **Span repair.** A span cited on the wrong line moves to the one line of
  its row that holds it.
- **Contents entries.** The entries of a table of contents join the
  catalogue only when no body entry has their identifier.
- **Uses versus definitions.** An identifier that several documents define
  belongs to the one that defines it on the fewest lines; the others use
  it.
- **Running header rows.** A row that repeats on many pages (a header, a
  page footer) is left out of the contexts.
- **Short documents in one call.** A document of up to 6 pages is read in
  one definitions call.
- **Contexts across pages.** An entry's context runs to the next
  definition across the whole document; here it stops at the end of the
  window.
- **Number tokens and page heads.** Candidates also come from the number
  tokens of a span (`Section 2.4` finds `Ref. 2.4`), and an own number
  gets candidates by the meaning of its page head.
- **Roles as a setting.** `params.roles` of the triggered workflow, so a
  request changes them without new code.
- **Same-item questions.** A span that is the number of the item its page
  is about (a product sheet's own number) is asked which entry describes the
  same item, and links with `SAME_ITEM_AS`. Here `own_number` does not
  link.
- **Request size estimate.** A decide request is packed by an estimate of
  its tokens (letters, digits, spaces and other characters at their own
  rates), within 28,000 tokens.
- **No-link review.** A span that can link but named no entry, below the
  gate, goes to review with the entry the model gave the highest
  probability.
- **Accepted items.** An accepted review item's links are written again on
  every later load.
- **Stored stage outputs.** The outputs of each stage are stored under the
  file once per link version and model, so a rerun pays only for what is
  missing.
- **The catalogue follows.** When the catalogue changes, the documents
  already loaded are resolved again from their stored mentions. Here a
  document read before the entries it names keeps its mentions unlinked
  until it is read again (`client.workflows.triggered.refresh`).
- **Stale outputs.** A rerun retracts the entries and mentions an earlier
  load wrote that this one does not write again, and supersedes stale
  review items.
- **Budget and status.** A monthly budget per workflow, and counters per
  stage in the workflow's status.

## Samples and test

`samples/` holds three invented PDFs of a school building tender and the
answer key `expected.json` ([`../_samples/README.md`](../_samples/README.md)).
`samples/pages/` holds their parsed pages, as `GET /v1/files/pages` returns
them; `node sdk/templates/_samples/make-pages.mjs` makes them again with
`pdftotext`.

`workflow.test.ts` runs the workflow on the pages with mock models: a row
that starts with a code and a capitalized word defines the code, every code
of a line is a mention, a span with a digit is an identifier, and the names
question picks the candidate with the same identifier key. With the roles of
the answer key, the run makes the 15 links of the key and no other. The test
also checks a turn that runs again (every request repeats under its effect
id), a turn stopped part way, a 30-page document over five turns, the gate,
a refused request split in halves, and a deleted document.
