# link

Connects the mentions of one thing across the records of a graph. A
contact, a lead, a deal and a note can each name one person in a different
way: `Mira Tannenholt-Ruiz`, `Mira Ruiz`, `M. Tannenholt`, `Mimi T.`. The
workflow groups those mentions into one `LinkedThing`. The links are
references across the graph, and later checks compare what each source says
about the thing.

This is phase L1 of the design
[general linking](../../../docs/architecture/general-linking.md): identities
on records. Documents (pages) come in phase L2.

## What it writes

| Term | Kind | Holds |
| --- | --- | --- |
| `Mention` | class | `span`, `role` (`self` or `refers`), `kind`, `field`, `offset`, `length`, `block_key` (several), `window` (the sentence of a span of text); the links and constraints `linked_to`, `must_link` and `cannot_link` |
| `LinkedThing` | class | its name (the anchor's name), `kind`, `anchor_key`, `alias` (several: the other names its members use) |
| `MENTIONED_IN` | relation, mention to record | the record that holds the mention |
| `SAME_THING_AS` | relation, mention to mention | a decided or accepted pair, with its confidence and its evidence (the sentence and the record's name) |
| `REFERS_TO` | relation, mention to `LinkedThing` | the thing the mention is in |
| `HAS_RECORD` | relation, `LinkedThing` to record | the records whose names and keys are in the thing |
| `MERGED_INTO` | relation, `LinkedThing` to `LinkedThing` | where an old thing is now: a thing whose anchor changed, or that merged |
| `SAME_AS` | relation, record to record | two records of one thing: a person writes it when they accept an identity |

A record's own names and keys are `self` mentions. Each record anchors a
thing. A span in a text field that names something is a `refers` mention.

## How it links

1. **Mentions.** A `name` or `key:*` field gives one `self` mention per
   value. A `text` field gives `refers` mentions: first the gazetteer pass,
   which keeps each span whose name or key a mention of the graph has; then
   the spans written like a name or a key (`M. Tannenholt`, an email).
2. **Block keys.** Each mention gets normal forms of its name or key as
   graph facts (`block_key`): the sorted name, the initials forms, the name
   parts and their sound, an email, a web address, a code. A key that more
   than 200 mentions hold is a stop key and finds nothing.
3. **Candidates.** The mentions that share a key, and the things of the
   records within two hops (the deal that a note is about). At most 30, the
   ones with a strong key first.
4. **Decision.** See the next section.
5. **Things.** The things identity groups the decided pairs. A person's
   decisions are constraints. Two records are never one thing until a person
   accepts their identity.

The thing's IRI is a hash of the graph and its anchor's key. The anchor is a
record's name first, then any other mention. So the same inputs give the
same IRIs. A thing whose anchor changes keeps one statement, `MERGED_INTO`
the thing that holds its members now.

## Model reads of record values

`modelsReadRecords` is off by default (general linking 12, decision 1).

- **Off.** No model reads a record value. A strong key (an email, a web
  address, a phone number, a handle, a code) links at confidence 1. Every
  other candidate goes to a person, grouped by thing.
- **On.** The decision model reads the names, keys and context fields of
  the records. It answers a kind question and a names question per mention,
  and a same-record question per pair of records. A link at or above `gate`
  (0.8) is written; a link below it goes to a person. The reasoning model
  reads only the text fields that opt in: `{ "role": "text", "extract": true }`
  (decision 8).

Every model call has an effect id made from its request. The same question
gets its first answer from the effect cache, at no cost.

## Review items

| Item | One per | Accept writes |
| --- | --- | --- |
| Link (`starter:<name>:link:…`) | Thing | The kept `SAME_THING_AS` rows. A row left out keeps its mention apart from the thing. |
| No link (`starter:<name>:nolink:…`) | Thing of the best candidate | The kept rows: the model chose no thing, and a person disagrees. |
| Identity (`starter:<name>:identity:…`) | Group of 2 to 10 records | `SAME_AS` between the records, and `SAME_THING_AS` between their names. |

A person always accepts an identity (decision 2). The `identityGate` (0.99)
only orders and groups the identity items (`mapping.identity.above_gate`).
Each item has the origin `starter:<name>` with the label `link`, so the
inbox labels and patterns of the producer `link` read it.

A person's decisions feed back. A kept row is a must-link. A row left out,
or a dismissed item, is a cannot-link. No model answer joins what a
cannot-link keeps apart.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `name` | `link` | The named workflows are `<name>-<class>` and `<name>-reviews`; the things identity is `<name>-things` |
| `fields` | the samples' CRM | The role of each field of each class (below) |
| `gate` | 0.8 | A link at or above it is written, with model reads on |
| `identityGate` | 0.99 | Orders and groups the identity items |
| `modelsReadRecords` | `false` | Whether models may read record values |
| `shards` | 4 | Source shards of each named workflow |
| `sourcesPerTurn` | 16 | Records per message |
| `textPerTurn` | 8,000 | Characters of text per turn; the rest continues in a new turn |

| Field role | Gives |
| --- | --- |
| `name` | One `self` mention per value |
| `name:given`, `name:family` | One `self` mention of the two joined (`first_name+last_name`) |
| `key:email`, `key:phone`, `key:web`, `key:handle`, `key:code` | One `self` mention per value, with a strong key |
| `text`, `{ "role": "text", "extract": true }` | `refers` mentions found in the text |
| `context` | No mention; read for the decisions |

A field named `name` (or `label`) is the record's display name, which the
published graph holds as `rdfs:label`; the workflow watches it as `label`.
Any other field is a property of the record.

## Run it

```sh
npm create @littlebigbrain -- --template link my-links
cd my-links && npm install
npm test                                           # the workflow on the samples, with mock models
LBB_GRAPH=try-link npm run try                     # the samples on a graph of your stack
LBB_GRAPH=try-link npm start                       # serve it
LBB_GRAPH=try-link npm run grade -- --gold samples/gold.json
LBB_GRAPH=crm npm run setup && npm start           # your graph
```

`npm run setup` creates the classes and properties, one named workflow per
class of the settings, the named workflow that watches accepted items, and
the things identity. It is safe to repeat. The workflow is for a records
graph. Do not run it on a graph where `documents.link` runs: both write
`MENTIONED_IN` and `REFERS_TO`.

## Grade a run

`npm run grade` (`src/grade-run.ts`) prints the metrics of general linking
9.2: link precision at the gate and its 95% Wilson interval, pairwise
precision and recall over things, cluster purity and completeness
(B-cubed), the review share, and identity precision and recall.

```sh
LBB_URL=... LBB_API_KEY=... LBB_GRAPH=crm npm run grade -- --gold .lbb-datasets/link-eval/gold.json --save run.json
npm run grade -- --gold .lbb-datasets/link-eval/gold.json --run run.json
```

The gold file (`lbb.link.gold.v1`) lists the groups. Each group is one real
thing, with the mentions that name it:

```json
{
  "format": "lbb.link.gold.v1",
  "complete": false,
  "records": { "contact-1": "https://littlebigbrain.com/e/…" },
  "groups": [
    { "id": "mira", "kind": "person", "mentions": [
      { "record": "contact-1", "field": "name", "span": "Mira Tannenholt-Ruiz" },
      { "record": "https://littlebigbrain.com/e/…", "field": "body", "span": "Mimi T.", "occurrence": 0 }
    ] }
  ]
}
```

A mention names its record (an IRI, or a name of `records`), its field
(`first_name+last_name` for a joined name), its span as the field writes it,
and which equal span of the field it is (`occurrence`, default 0). With
`complete: true`, a mention that the gold does not list is a thing of its
own. Without it, a link to such a mention counts apart as unjudged. Keep a
gold file of real records out of git, under `.lbb-datasets/`.

## The samples

`samples/records.json` is an invented CRM: 7 organizations, 12 contacts, 5
leads, 7 deals and 11 notes. Every name, company and address is invented.
The names vary: a nickname (`Bob` for `Robert`), initials (`M. Tannenholt`,
`F. Okafor`), accents and transliterations (`Jürgen`, `Juergen`, `Jurgen`;
`Søren`, `Soren`; `Zoë`, `Zoe`), name order (`Wren, Tobias`), a typo
(`Ramaswamey`), a person known only by an email, a surname that two people
share (`Okafor`), two people of one name at two organizations (`Alex
Brandt`), and company domains. `samples/gold.json` holds the gold groups.

## How the template differs from the design

- A named workflow takes one watch trigger in this release, so each class is
  a named workflow of its own. All of them run the workflow type `link`.
- The candidates by the name index and by meaning wait for work tokens that
  reach those routes (N3). The keys and the neighbours find the candidates.
- A source turn sends its decided pairs in messages of at most 24,000
  bytes; a larger message goes in parts (`.1`, `.2`, …) until blobs (G11).
- The things identity is an engine identity that `npm run setup` creates.
  It reads the review items it filed to learn a person's decisions.

## Files

| File | Holds |
| --- | --- |
| `workflow.ts` | The workflow, the named workflows (`workflows()`), the ontology, the ports (`linkPorts()`) and `setup()` |
| `settings.ts` | The settings and the names of the parts, and the decided message |
| `names.ts` | Normal forms and block keys |
| `candidates.ts` | The candidate reads, the scoring and the bounds |
| `decide.ts` | The questions, the packing, the link rule and the rules without models |
| `things.ts` | The grouping with constraints, anchors, IRIs, merges and splits |
| `sources/records.ts` | Field roles, and the mentions of record fields |
| `source-turn.ts`, `things-turn.ts` | The turns of a source shard and of the things identity |
| `items.ts`, `reads.ts` | The review items, and the reads of the graph |
| `grade.ts`, `grade-run.ts` | The grading, and its command |
| `fixture.ts` | The test support: the graph in memory, mock models and ports, a reviewer that follows a gold file |
| `setup.ts`, `worker.ts`, `try.ts`, `samples.ts` | The commands |
