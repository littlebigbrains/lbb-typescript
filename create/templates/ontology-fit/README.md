# ontology-fit

Reads the text of each new or changed instance of a class and proposes the
ontology changes the text supports: a class `Mangel` for the defects a set
of site reports follows, its properties `frist` and `status`, a relation
`zustaendig` to `Firma`. Each change becomes a review item with its
evolve operations and the quotes that support it; a person accepts it, and
the ontology changes.

The LBB-run version is the starter workflow `ontology.fit@v1`, the fit
sources of `/v1/ontology/fit-sources` (`docs/reference/fit-sources.md`).

## How it runs

The triggered workflow watches the class and its text field. For each
instance of a trigger message, one step:

1. The reasoning model reads the text with the ontology
   (`lbb.ontology()`, as classes, relations with their domain and range,
   and properties) and the changes the earlier texts of the turn proposed,
   and returns up to 12 proposals: `add_class`, `add_property`,
   `add_relation` or `widen_relation`, each with a sentence of the text as
   its quote. The prompt and schema are the LBB version's.
2. Each proposal becomes a change (`shape`): its key, its title and its
   evolve operations. A class the change names that the ontology lacks is
   added first, and a new relation with the name of an existing one widens
   it. The key follows the LBB version:
   `fit:<workflow name>/add_class/mangel`,
   `fit:<workflow name>/add_relation/mangel/zustaendig/firma`,
   `fit:<workflow name>/widen_relation/betrifft-raum/mangel/x`.
3. A change is kept when its quote is in the text with at least three
   words, and a dry run (`lbb.evolve(change, { dryRun: true })`) says the
   ontology does not have it yet.

A last step files one review item per key, with the quotes of every text of
the turn that supports it. The same key again updates the item. A turn reads
at most 48 texts; the rest goes to a new turn.

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

- **Support scores.** The decision model scores how well each quote
  supports its change; a change below 0.5 is dropped.
- **Support across instances.** The instances that support each key are
  counted over every run, and a dismissed change opens again when twice its
  support and three more instances support it.
- **The proposals of the source.** The open suggestions of the source and
  the names of the dismissed ones go into every prompt, so the model reuses
  names and does not propose a rejected change again.
- **Name style.** A new relation or property name is written in the
  ontology's style (`works_in` or `WORKS_IN`).
- **Long texts.** A text past 40,000 characters is read in overlapping
  chunks.
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
