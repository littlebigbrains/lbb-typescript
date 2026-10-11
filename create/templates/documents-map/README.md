# documents-map

Maps the links of `documents-link` into the graph's own ontology. A room
sheet's line `T1 Einzeltisch, 28 Stück` links the span `T1` to the entry
`T 1` of the equipment list. This workflow asks which instance each entry
is and which statement the line makes, and proposes the fact
`room 0.12 HAS_EQUIPMENT equipment T 1`. It writes each statement as a
`FactProposal`; a `review` workflow (LBB's `review`, or the
[`review`](../review/README.md) template) decides which become facts.

The LBB-run version is the starter workflow `documents.map@v1`
(`docs/reference/starter-workflows.md`, `documents.map`; design
`docs/architecture/document-output-mapping.md`). This template is the same
pipeline in TypeScript: the workflow in `workflow.ts`, its questions, rules
and proposals in `map.ts`.

## How it runs

The triggered workflow watches the class `DocMention` and its links
`REFERS_TO` and `SAME_ITEM_AS`. A new, changed or withdrawn link sends a
message. A message is a signal: each one maps every link of the graph
again, in one turn. The decision model's calls take an effect id made from
the content of their request, so a question asked again in a later message
gets its first answer from LBB's effect cache at no cost. Only new and
changed questions cost.

1. **Read the trace** (`readTrace`). The links with their confidence (on the
   link's evidence statement node), the mentions of the documents that hold
   them, and the entries, with SPARQL at the message's commit.
2. **The subject of each link** (`map.subjects`). The object is the entry
   the span names. The subject is what the line belongs to, in the line's
   own document. The first mention of a page heads the page when all of
   these are true: the page has at least two mentions, the mention starts in
   the top 30% of the page, no entry the document defines on the page is on
   its row or above it, and it is written unlike most of the page's other
   mentions (a room sheet's `0.12` above codes like `S 1.1`). Then its
   link's entry, or else a page entry made from it (the span is the
   identifier, the rest of its line the description), is the subject of
   every other mention of the page, and of the next page when that has
   neither a head nor an entry. Otherwise the subject is the last anchor at
   or before the line (the document's own entries written like its first
   one, such as the positions of a bill).
3. **Ground the entries.** Each end of a link gets candidates: the
   instances whose `identifier`, `rdfs:label`, `skos:notation`,
   `skos:prefLabel`, `schema:identifier` or `dcterms:identifier` is the
   identifier as written, without spaces, or with one space after its
   letters (at most 10, each with its class, label and four facts). The
   decision model answers which instance the entry is: a candidate,
   `new_instance` or `none`. A new instance gets a second question, its
   class among at most 12 classes, or `no_class`. Its IRI is minted from the
   document and the identifier, so the same entry always proposes the same
   instance.
4. **Type the links.** For a link whose two ends are instances with a
   class, the options are the relations whose domain and range fit the two
   classes (superclasses included, both ways round, an inverse written the
   right way round), at most 12, and `same_item`, `no_fact` and
   `missing_property`. The state holds the page's rows (the parsed page, or
   the lines of its mentions when the file has no parse), the two instances
   and the part of the ontology the questions use. A declared mapping types
   its links without a question.
5. **Propose.** One `FactProposal` per statement (its key is
   `proposal:<hash>` of the statement and the proposer, `proposed_by` is
   `workflow/<name>`): a typed link with the link's confidence times the
   typing answer's probability; `same_item` as `owl:sameAs`; an entry
   grounded to an instance as `DENOTES` from the entry (or from the mention
   of a page head) to the instance; a new instance with a class as its
   `rdf:type` (the grounding answer's probability times the class answer's),
   its `rdfs:label`, its `identifier` and its `DENOTES`. `fact_evidence` holds
   the line, the page, the box, the link and every option with its
   probability. The answers `no_class` and `missing_property` with a
   probability of at least 0.5 become ontology suggestions, one per pattern
   (`Add a class for entries of …`, `Add a relation from Room to …`).
6. **Write.** The proposals that changed since the graph's copy, owned with
   `replace_owned` over the proposal's seven fields, in parts of 900. The
   proposals of this workflow that no link states any more are retracted.

The questions go in requests of at most 32 questions and 60,000 characters:
grounding and classes per defining document, typing per page. A refused
request is asked in halves.

## Settings

`defaults` in `workflow.ts`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `mappings` | none | Declared mappings: `{ from: { document?, entry_class }, to: { entry_class }, property }`. A link from an instance of `from.entry_class` (in `document`) to one of `to.entry_class` (subclasses too) states `property`, with the link's confidence, and no model is asked |

`trigger()` names the triggered workflow `documents-map` and owns the class
`FactProposal` and its seven proposer fields. `ontology()` adds
`FactProposal` and its fields, `identifier`, and the relation `DENOTES`,
open on both sides (from an entry or a page's head mention to any
instance), as LBB's `documents.map` declares it. Do not run it beside an
LBB-run
`documents.map` on the same graph: they own the same class.

## What the LBB-run version adds

- **Links below the gate.** It reads the stored outputs of the graph's
  `documents.link` workflows, so it maps the links held for review too, with
  their confidence. The template reads the links in the graph.
- **The RDF schema.** It reads the RDFS and OWL schema of the published
  generation beside the records ontology, and shows each term's
  `rdfs:label` and `rdfs:comment` in the options. The template reads the
  records ontology (`GET /v1/ontology`).
- **More candidates.** The name index of `POST /v1/query/ask` and search by
  meaning over the graph's embeddings; class options by meaning. The
  template finds candidates by identifier and orders classes by shared
  words.
- **Descriptions.** An entry's description comes from the definitions
  model. The graph holds the entry's context, which can run on to the next
  rows; the template uses it.
- **Both graph kinds by name.** It proposes the records relation
  `DENOTES` (`https://littlebigbrain.com/r/denotes`) on a records graph, and
  `lbb:denotes` (`https://littlebigbrain.com/ns#denotes`) and the schema's
  own property IRIs on an RDF-native graph. The template proposes the
  records relations (`https://littlebigbrain.com/r/<name>`), `DENOTES`
  included, on both graph kinds.
- **Scopes per document.** On an RDF-native graph it owns its proposals per
  document (a proposal from several documents in the scope of the smallest
  SHA-256), in one owned write per step. The template writes the proposals
  with `replace_owned` on both graph kinds.
- **Any number of links.** It runs in time-limited steps over any number of
  documents and keeps its typed links per document. The template maps at
  most 1,000 linked mentions in one turn and fails the turn (no retry) when
  a graph needs more steps.
- **Requests by tokens.** Requests are packed by an estimate of their
  tokens (28,000), per page, four at once.
- **A new ontology version maps again**, and a new decision model asks
  again (its version holds the model). The template maps on a message: call
  `client.workflows.triggered.refresh` after an ontology change, and change
  `m1` in the effect id to ask a new model.
- **Stale suggestions.** It supersedes the open suggestions a later run no
  longer finds.
- **Status and budget.** Counters per outcome, the `map` model job on the
  Models page, a monthly budget and a preview. The template's calls count
  as `decide` activities.

## Samples and test

`samples/` holds the three invented PDFs of `documents-link`, the parsed
pages of the room sheets, `trace.json` (what a correct `documents-link` run
writes on them: 15 entries, 21 mentions, 15 links) and the answer key
`expected.json` ([`../_samples/README.md`](../_samples/README.md)).
`node sdk/templates/_samples/make-trace.mjs` writes `trace.json` and the
copies from the samples of `documents-link`.

`npm run try` uploads the three PDFs and waits until LBB's
`documents.parse` has read them, so the typing questions show the rows of
each page. Then it adds the ontology of the samples (`Room`, `Equipment`,
`SpecSection`, `HAS_EQUIPMENT`, `SPECIFIED_IN`) and commits the trace
itself. This is the simplest way to run the map on known links: a link run
first would need its own models and give links that vary from run to run.
On your graph, run `documents.link` (or the `documents-link` template)
first.

`workflow.test.ts` runs the workflow on the trace with mock models: the
grounding question picks a candidate whose label holds the identifier, else
a new instance; the class question picks `Room` for the room sheets,
`SpecSection` for a section and `Equipment` for the rest; the typing
question picks the relation whose range is the object's class. The run makes
the 15 facts of the answer key and the 60 statements of the 15 new
instances, and nothing for `M 7`, `S 1.3` or `3.3`. The test also checks the
confidences, a second message answered from the effect cache, a turn
stopped part way, an existing instance, the ontology suggestions, a
withdrawn link, a refused request split in halves, a declared mapping, and
the subject rules.
