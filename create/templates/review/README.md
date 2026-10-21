# review

Decides which fact proposals become facts. A proposer (the
[`documents-map`](../documents-map/README.md) template, LBB's
`documents.map`, or a workflow of yours) does not write the facts of the
graph's own ontology itself: it writes one `FactProposal` per statement,
with its confidence and its evidence. This workflow writes a proposal at or
above the gate as a fact, with the proposal as its evidence, and gives the
others to a person: one review item per instance.

The LBB-run version is the starter workflow `review@v1`
(`docs/reference/starter-workflows.md`, "Review"; design
`docs/architecture/document-output-mapping.md`). This template takes its
rules, notes, counters and review items: the workflow in `workflow.ts`, the
rules and the facts in `decision.ts`. It calls no model. Its eval runs both
on the samples and on a fixture of every rule, and finds the same
decisions, notes, facts and items
([`../_evals/README.md`](../_evals/README.md)).

## How it runs

The triggered workflow watches the class `FactProposal` and the fields of
its statement (`fact_subject`, `fact_predicate`, `fact_object`), so a new
proposal, or one whose statement changed, sends a message. A turn decides at
most 20 proposals, two steps each, and files at most one review item per
instance; the rest of a message goes to a new turn (`ctx.continue`). Each
proposal is decided once: one that has a `fact_status` already is skipped.

1. **Read** the proposal (`fact_subject`, `fact_predicate`, `fact_object`,
   `fact_datatype`, `fact_confidence`, `fact_evidence`, `proposed_by`), the
   entities its statement names, and the ontology (`GET /v1/ontology`). An
   entity the graph does not have is a new instance: its class comes from an
   `rdf:type` proposal of it, its name from an `rdfs:label` proposal.
2. **What the statement is** (`classify`): an `rdf:type` of a class, an
   `rdfs:label`, a relation between two instances (the entry's `DENOTES`
   included), or a property value in its type. The ends of a relation must fit
   its domain and range, superclasses included.
3. **The decision** (`decide`), in this order, with LBB's notes:
   - **refused** when the graph cannot hold the statement: a predicate that
     is no relation or property of the records ontology (nor `rdf:type` or
     `rdfs:label`), a value that does not take its property's type (LBB's
     words: `` `vierzehn` is not a number``), an object that is no
     instance, an instance without a class, an end its relation does not
     take, a second class, or a statement about a proposal;
   - **to a person** when a rule of `alwaysReview` names it (`new_instance`:
     a statement whose subject or object the graph does not have yet; or a
     predicate IRI), when it would replace another writer's value or name, or
     when its gate value is below the gate. The gate value is the
     proposal's confidence, or the typing answer's probability `p` of a
     source whose link is in the graph already (`gateValue`). The proposal
     goes into the **review item of its instance** (`groupOf`): its subject;
     the object of a link whose subject the graph has and whose object is
     new; and always the object of the trace (`DENOTES`). One item holds every
     proposal of its instance that the turn sends to a person, in order: the
     type, the label, values, links, the trace (`fileItem`). The item is
     LBB's: its key (`starter:<workflow>:instance:<hash of the
     instance>:<hash of its proposals>`, `itemKey`), its title (`New
     Equipment M 7 Medienwagen`, or `Room Raum 0.12 Klassenraum: 1 fact to
     check`), its rationale, its summary (`is a Equipment · label · M 7
     Medienwagen · 1 link`), one status row per fact (the proposal's
     `fact_status: accepted`) and one evidence sample per fact (what it
     states, its gate value, its line, the other new instance a link waits
     for). The type of a new instance is a required row: a person keeps it or
     dismisses the item. After the status rows the item holds each
     statement, so its accept commits the facts (design G8); each sample names
     the rows and triplets of its fact (`rows`, `triplets`), so a person can
     leave facts out of the accept;
   - **written** otherwise: a relation as an edge whose evidence names the
     proposal (`source_id` is the proposal's IRI, the text its evidence); a
     property as its value; a new instance's `rdf:type` as the instance of
     that class with `proposed_in` (a records graph holds an instance through
     its facts); a label as the entity's name. A new instance takes the name
     of its label proposal (the first in order) from its first write, so its
     name does not depend on which statement is written first. A label is a
     text: an IRI or an empty label is refused. A statement the graph holds
     already is not written again. Nothing is taken back, a name included: a
     records instance keeps one. When the graph refuses the commit, the
     proposal is `refused` with `The graph refused the statement: …`.
4. **Write** (`writeOwned`): the proposal's `fact_status` (`written`,
   `in_review` or `refused`) and `review_note`, owned by this workflow, and in
   the same commit the facts of a written statement.

The state counts what LBB's version counts: `proposals`, `written` (a
statement the graph held already included), `held_already`, `in_review`,
`refused`, `new_instance` (proposals for a person that name a new instance)
and `items`.

## Settings

`defaults` in `workflow.ts`, those of LBB's `review`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `className` | `FactProposal` | The class of the proposals |
| `gate` | 0.8 | A proposal below this confidence goes to a person |
| `alwaysReview` | `[]` | What goes to a person whatever its confidence: `new_instance`, and predicate IRIs (`https://littlebigbrain.com/r/has_equipment`). Empty: the gate decides everything, a new instance too |

With `["new_instance"]` every statement about a new instance goes to a
person, whatever its confidence. That was the default of LBB's `review`
until 2026-10-12.

`trigger(settings)` names the triggered workflow `review` and owns
`fact_status` and `review_note`. `ontology(settings)` adds the class and the
properties of a proposal and of the review (`proposed_in` too). Do not run it
beside an LBB-run `review` on the same graph: they own the same properties.

## What the LBB-run version adds

- **It writes the accepted facts itself.** Its item carries the statuses
  only; its sweep writes each kept fact, the type first, and dismisses the
  facts a person left out. A link to another new instance waits until that
  instance's item is accepted, and is dismissed with it. The template's item
  commits its facts on accept (design G8), so such a link makes the other
  instance too.
- **One item per instance over time.** Its items follow the open proposals
  of an instance across messages: when they change, it supersedes the open
  item with a new one, and an accept of the old item fails (409). The
  template files one item per instance and turn: the key carries the
  proposals, so a later turn with other proposals of the instance files
  another item.
- **Withdrawn proposals.** When a proposer withdraws a proposal, it takes
  the proposal out of its item and retracts the fact it wrote, unless a
  person accepted it or the fact held before; a record per proposal says
  which fact. The template keeps both: dismiss the item, or retract the fact
  yourself.
- **Dismissed items.** It checks the open review items and sets
  `dismissed` on the proposals of a dismissed one. The template leaves
  `in_review`.
- **Predicates another workflow owns.** It refuses a statement whose
  predicate another workflow owns by predicate, since that workflow's owned
  write would delete it.
- **RDF-native graphs by IRI.** On an RDF-native graph it writes each
  statement as one owned triple: `lbb:denotes`, the asserted schema's
  properties (the OWL object, symmetric, transitive, functional,
  inverse-functional and asymmetric properties take an IRI) and classes
  (the ends of `rdfs:subClassOf` count), the records ontology's terms and
  `rdfs:label`. There a subject or object is new when it is the subject of
  no statement. The template writes through `POST /v1/graph/commit`, on both
  graph kinds: the records ontology's relations (the records `DENOTES`
  included), properties and classes, and `rdfs:label`. An instance is new
  when it has no class of the records ontology. It refuses any other
  predicate with LBB's note (`owl:sameAs`, `lbb:denotes`).
- **Ownership by statement.** Its facts count as owned by statement, so it
  conflicts with no other workflow on the predicates it writes. The template
  owns `fact_status` and `review_note` only and writes the facts without
  owning them.
- **Status and preview.** The open items it follows in its status, and a
  preview of what it would decide.

The template differs from it in two places, and its eval names both:

- **Domain and range.** LBB's review leaves them to the commit, and a
  records graph commits such an edge, so it writes p11 of the samples (a
  room as the equipment of a room). The template checks a relation's ends
  against its domain and range, superclasses included, and refuses it, as
  the answer key says.
- **What it reads.** The template reads the graph with the commits of its
  own turn; LBB's review reads the published generation. A statement written
  earlier in the same turn (the label of a new instance written with its
  type) counts as `held_already` in the template, and LBB's review writes it
  again. The facts are the same.

## Samples and test

`samples/proposals.json` holds a small invented graph (two rooms of the
school building and five pieces of equipment, one `HAS_EQUIPMENT` edge) and
14 proposals about it, one for each case; `samples/expected.json` gives the
status each one gets with `alwaysReview` `["new_instance"]`, the facts the
graph holds after the run, and the three review items with the proposals
each one holds
([`../_samples/README.md`](../_samples/README.md)).

`npm run try` adds the sample ontology (`Room`, `Equipment`,
`HAS_EQUIPMENT`, `identifier`, `area_m2`), commits the instances, reads
their IRIs back, and commits the proposals as a proposer would
(`proposed_by` is `samples/review`). This is the simplest input: the review
calls no model and needs no proposer to run first. To review the proposals
of `documents-map`, run it (or LBB's `documents.map`) on the same graph.

`workflow.test.ts` runs the workflow on a graph in memory with the samples:
the statuses and facts of the answer key, the evidence of a written fact,
the notes, one item per instance (the order of its facts and its required
type), the facts of an accepted item, the default settings (the gate
decides a new instance), a predicate rule, a second message that changes
nothing, and a message larger than a turn.
