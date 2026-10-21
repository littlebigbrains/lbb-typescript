# ontology-fit

Reads the text of each new or changed instance of a class and proposes the
ontology changes the text supports: a class `Mangel` for the defects a set
of site reports follows, its properties `frist` and `status`, a relation
`zustaendig` to `Firma`. Each change becomes a review item with its
evolve operations and the quotes that support it; a person accepts it, and
the ontology changes.

The LBB-run version is the starter workflow `ontology.fit@v1`, the fit
sources of `/v1/ontology/fit-sources` (`docs/reference/fit-sources.md`). The
template follows its rules (`lbb-graph-query/src/fit_sources.rs`); its eval
runs both on the same recorded model answers and finds the same calls,
review items and counters ([`../_evals/README.md`](../_evals/README.md)).

## How it runs

The triggered workflow watches the class and its text field. A turn first
reads the workflow's review items (`lbb.listReviews`): the titles of the open
ones and the names of the dismissed ones. Then, for each instance of the
message, two steps:

1. **Propose.** The text is the field's values as LBB composes it
   (`text: <values>`), read in chunks of 40,000 characters with 1,000 shared.
   The reasoning model reads each chunk with LBB's prompt: the ontology (its
   classes, relations with domain and range, properties, and the name style
   it uses), and the changes already proposed and waiting for review, newest
   support first, with the rejected names. It returns up to 12 proposals per
   chunk: `add_class`, `add_property`, `add_relation` or `widen_relation`,
   each with a sentence of the text as its quote. A chunk the model gives no
   usable answer for counts as failed, and the instance goes on. Then the
   checks without a model, in LBB's order: the shape (`shape`; a relation or
   property name in the ontology's style, `ZUSTAENDIG` as `zustaendig`, and
   a new relation with the name of an existing one widens it), one proposal
   per change, the quote in the text with at least three words, and a dry run
   (`lbb.evolve(change, { dryRun: true })`): a change the ontology has is
   `already_covered`. The decision model scores how well each quote supports
   its change; one below 0.5 is `weak_support`.
2. **File.** Each kept change goes into the review item of its key:
   `fit:<workflow name>/add_class/mangel`,
   `fit:<workflow name>/add_relation/mangel/zustaendig/firma`,
   `fit:<workflow name>/widen_relation/betrifft-raum/mangel/x`. The item
   keeps the best supported samples of every text that supports it (at most
   20), and its rationale says how many instances support it. An item a
   person decided is left alone. The next instance's prompt lists the
   change.

The state counts what LBB's fit sources count: `instances`, `chunks`,
`failed_chunks`, `proposals`, `kept`, `filed`, `updated`, `quote_not_found`,
`invalid`, `already_covered` and `weak_support`. A turn reads at most 24
texts; the rest goes to a new turn.

## Settings

`defaults` in `workflow.ts`, which fit the samples:

| Setting | Default | Meaning |
| --- | --- | --- |
| `className` | `Baustellenbericht` | The class whose instances hold the text |
| `textField` | `text` | The property that holds the text |
| `context` | the samples' | One sentence about what the text is |

`trigger(settings)` names the triggered workflow `berichte`; the name starts
every key. The workflow writes no graph facts, so it owns nothing.

## What the LBB-run version adds

- **Support across all runs.** It keeps the instances that support each key
  beside the source, so its count stays exact past 20 samples. The template
  counts from the item: its count, and one more for an instance the samples
  do not hold yet.
- **Reopening.** A dismissed change opens again when twice its support and
  three more instances support it. The template leaves a dismissed change
  dismissed.
- Its own monthly budget, a preview with the proposals of a sample, and
  counters per outcome in the source's status.

## Samples and test

`samples/texts.json` holds five invented site reports and meeting minutes;
`samples/expected.md` describes the graph before the run, the proposals a
good run makes with their keys, those it may make, and those it does not
make. `samples.ts` sets up that graph for `npm run try`.

`workflow.test.ts` runs the workflow with a mock reasoning model whose rules
are fixed (a sentence about a `Mangel` proposes the class, `Frist`, `Status`
and `Zuständig` its facts, a room widens `betrifft_raum`). The run files
the five keys of `expected.md` and no other: the relation `anwesend`, which
the ontology has, is dropped by the dry run, and a proposal whose quote is
not in its text is dropped by the quote check.
