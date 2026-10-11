# values-extract

Fills properties of a class from the text of its instances. Each value
comes with the words of the text that state it: `width_cm` 60 and
`depth_cm` 40 from `ca. 60x40 cm`. The value is written on the instance,
with an edge `HAS_VALUE_SOURCE` to a `ValueSource` entity whose evidence is
the quote.

The LBB-run version is the starter workflow `values.extract@v1`
(`docs/reference/starter-workflows.md`, "Values from text").

## How it runs

The triggered workflow watches the class and its text field. For each
instance of a trigger message, two steps:

1. **Values.** The reasoning model reads the text and returns
   `{values: [{property, value, quote}]}`; the schema allows only the
   settings' property names. The prompt is the LBB version's: the values of
   the instance's own item in its base version, not those of a part, an
   accessory, an alternative or a variant under a condition; an approximate
   value is stated. Then the checks without a model: a value takes its
   property's type (`typed`), its quote is in the text with at least three
   words or the value in it (`quoteHolds`), and one value per property.
2. **Support.** The decision model scores how well each quote supports its
   value: `supported`, `weak` or `not_supported`. The support is the
   probability of `supported`.

Then the gate: a value at or above `gate` is written, one from 0.5 to the
gate becomes a review item with the value as its facts, one below 0.5 is
dropped. One owned write per turn replaces the values of the turn's
instances: a property the workflow does not write again loses its value and
its source. An accepted review item's value is written with the others the
next time its instance is read. An instance that leaves the class loses the
values this workflow wrote.

A turn reads at most 24 instances; the rest of a message goes to a new turn
(`ctx.continue`).

## Settings

`defaults` in `workflow.ts`, which fit the samples:

| Setting | Default | Meaning |
| --- | --- | --- |
| `className` | `EquipmentItem` | The class whose instances are read |
| `textField` | `text` | The property that holds the text |
| `properties` | `width_cm`, `depth_cm` (`f64`), `material` (`text`), `water_supply` (`keyword`) | The properties to fill, with their types (`text`, `keyword`, `i64`, `f64`, `bool`, `date_time`) |
| `context` | the samples' | One sentence about what the text is |
| `gate` | 0.8 | The support a value needs to be written |

`trigger(settings)` names the triggered workflow `values-extract` and
owns the class `ValueSource`, the relation `HAS_VALUE_SOURCE` and the
properties. `ontology(settings)` adds the class, the properties and the
relation.

## What the LBB-run version adds

- `params.where`: a SPARQL pattern that limits the instances it reads.
- Texts built from several watched fields, as fit sources build them, and
  the fields chosen for you when the watch names none.
- The instance's page box as the region of each value's evidence, for an
  instance that has one (a `DocEntry`).
- A check at creation that each property is in the property registry with
  a type it can write.
- Its own monthly budget, a preview with the values of up to 3 instances,
  and counters per outcome in the workflow's status.

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
