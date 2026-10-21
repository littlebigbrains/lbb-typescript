# values-extract

Fills properties of a class from the text of its instances. Each value
comes with the words of the text that state it: `width_cm` 60 and
`depth_cm` 40 from `ca. 60x40 cm`. The value is written on the instance,
with an edge `HAS_VALUE_SOURCE` to a `ValueSource` entity whose evidence is
the quote.

The LBB-run version is the starter workflow `values.extract@v1`
(`docs/reference/starter-workflows.md`, "Values from text").

## How it runs

The template follows the rules of LBB's version
(`lbb-graph-query/src/infer_llm.rs`). Its eval runs both on the same
recorded model answers and finds the same calls and outputs
([`../_evals/README.md`](../_evals/README.md)).

The triggered workflow watches the class and its text field. For each
instance of a trigger message, two steps:

1. **Values.** The text is the field's values as LBB composes it
   (`text: <values>`, each value's whitespace as single spaces). The
   reasoning model reads it and returns `{values: [{property, value, unit,
   quote}]}`; the schema allows only the settings' property names, in name
   order, and a number property names its unit. A number comes as the text
   states it, with its unit, and the model never converts it. The prompt is
   the LBB version's: the values of the instance's own item in its base
   version, not those of a part, an accessory, an alternative or a variant
   under a condition; an approximate value is stated. Then the checks
   without a model, in LBB's order (`check`): the property is one the
   workflow fills (else `unknown_property`), the value is the first of its
   property (else `duplicate`), it takes its property's type (else
   `invalid_value`), and its quote is in the text with at least three words
   or the value in it (else `quote_not_found`). A number of a property with
   a unit must come in that unit, with the unit in its quote
   (`unitProblem`); otherwise it goes to review at most, with LBB's reason.
2. **Support.** The decision model scores how well each quote supports its
   value: `supported`, `weak` or `not_supported`. The support is the
   probability of `supported`.

Then the gate: a value at or above `gate` is `written`, one from 0.5 to the
gate goes to `review`, one below 0.5 or without an answer is
`weak_support` and is dropped. A value in review becomes a `value` review
item (`lbb.review({ kind: "value" })`) with the property's unit and the
quote, one per property of an instance, under LBB's key
`starter:<workflow>:value:<hash of instance and property>` (`valueItemKey`,
with `stableHashHex`). One owned write per turn replaces the values of the
turn's instances: a property the workflow does not write again loses its
value and its source. Each value's evidence is its quote, with the
instance's page box as its region when the instance has one (`page`, `x0`,
`y0`, `x1`, `y1`, as a `DocEntry` has).

Before it writes, the workflow reads the items (`lbb.reviewItems(keys)`): a
person's answer wins over the model, for the evidence it was given on
(`evidence_hash`: a hash of the value's quote and of the unit the text
states, `evidenceOf`). With the same evidence, the value in force, or the
value the person decided on, a value a person accepted, or corrected with
a number in the property's unit, is written as answered. New evidence that
reads another value asks the person again, and the answered value and its
source link stay (the instance is written on its own, without that
property) until a new answer is written. A value a person rejected is
not written again, nor is one the graph refused (`effects.commit_error`; the
item is open again for the person). An earlier version filed a value in
review as a suggestion, one per value (`legacyValueKey`): an accepted one is
written again, an open one stays the question, and a dismissed one is a
reject of its value. An instance that leaves the class keeps its values:
they go with its fields when it is retracted.

The write's request id is its step's effect id, which no other turn
repeats, so a value that changes back (A, then B, then A) is written again.
When a model call is refused, the instance goes back to the watch
(`lbb.requeue`, after 1, 4 and 16 minutes, at most 3 times) and keeps its
values; the turn completes and the shard goes on. A spent budget fails the
turn with the time to retry, and the worker waits without an attempt.

The state counts what LBB's version counts: `instances`,
`values_proposed`, one counter per outcome, `failed`, `commits` and
`removed`. A turn reads at most 24 instances; the rest of a message goes to
a new turn (`ctx.continue`).

## Settings

`defaults` in `workflow.ts`, which fit the samples:

| Setting | Default | Meaning |
| --- | --- | --- |
| `className` | `EquipmentItem` | The class whose instances are read |
| `textField` | `text` | The property that holds the text |
| `properties` | `width_cm`, `depth_cm` (`f64`), `material` (`text`), `water_supply` (`keyword`) | The properties to fill, with their types (`text`, `keyword`, `i64`, `f64`, `bool`, `date_time`) |
| `context` | the samples' | One sentence about what the text is |
| `gate` | 0.8 | The support a value needs to be written |
| `units` | `width_cm`, `depth_cm`: `cm` | The unit of each number property; `ontology()` declares it on the property |

`trigger(settings)` names the triggered workflow `values-extract` and
owns the class `ValueSource`, the relation `HAS_VALUE_SOURCE` and the
properties. `ontology(settings)` adds the class, the properties and the
relation.

## What the LBB-run version adds

- `params.where`: a SPARQL pattern that limits the instances it reads.
- Texts built from several watched fields, and the fields chosen for you
  when the watch names none.
- A check at creation that each property is in the property registry with
  a type it can write.
- Its own monthly budget, a preview with the values of up to 3 instances,
  and its counters in the workflow's status.

It differs in three places. It commits once per instance, the template once
per turn, so its `commits` counter is larger. When the reasoning model gives
no usable answer, it counts the instance `failed` and clears its values; the
template sends the instance back to the watch and keeps them. And it
converts a number the text states in another unit of the same kind (`600 mm`
for a property in `cm`) to the unit the property declares, and refuses a
unit it does not know or of another kind; the template sends such a number
to review. So the question of such a number differs: LBB's item asks the
converted value, the template's the value as stated.

## Samples and test

`samples/records.json` holds six invented entries of a sanitary equipment
list; `samples/expected.json` gives the values a correct run writes, and the
ones it leaves out ([`../_samples/README.md`](../_samples/README.md)).

`workflow.test.ts` runs the workflow with mock models: the reasoning model
reads the first size, material and water supply of each text, and the
decision model says a quote from a sentence about an accessory (`Zubehör`)
or a conditional variant (`Bei Einsatz`) does not support its value. The run
writes the values of the answer key and none it leaves out. The test also
checks the review path, the checks of type and quote, an instance that
leaves the class, and a message larger than a turn.

## Test on examples

`npm run test:examples` runs the workflow on instances of your graph with
the real models, and writes nothing (`test-examples.ts`). The activities go
through `captureActivities`: the server checks each owned write with the
commit's dry run, and keeps it. Each review item is kept too. The script
prints, for each input, the values the workflow would write and the values
it would give a person to review.

```sh
LBB_URL=... LBB_API_KEY=... LBB_GRAPH=tender npm run test:examples           # the first 6 instances
LBB_URL=... LBB_API_KEY=... LBB_GRAPH=tender npm run test:examples -- <iri>  # chosen instances
```

The model calls count in your environment's budget. For the LBB-run
version, test the workflow in the console (the workflow's Test tab) or with
`client.workflows.tests`.
