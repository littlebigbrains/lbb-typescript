# documents-check

Checks PDFs against each other. Upload an order, a delivery note and an
invoice. SHACL rules compare their values. Each difference becomes a review
item for a person, with the quotes of both documents.

The output is a list of candidates for a person to check. The pipeline makes
no payment, approval or compliance decision. It writes no fact about the
purchase.

It joins parts LBB already has: Files, `documents.parse`, `values.extract`,
SHACL and Review. Two small workflows of your worker are the glue:

- `documents-texts` writes the text of each parsed PDF as an instance of a
  class. The first line of the PDF picks the class.
- `documents-check` turns each result of the conformance report into a
  `choice` review item.

The full walk-through is the guide
[Check documents against each other](https://docs.littlebigbrain.com/guides/check-documents-against-each-other/).

```text
upload PDF ─▶ documents.parse ─▶ documents-texts ─▶ values.extract ─▶ SHACL shapes ─▶ documents-check ─▶ Review
  Files        LBB-run             your worker        LBB-run          LBB-run         your worker
```

## In this project

| File | Holds |
| --- | --- |
| `shapes.ttl` | The rules, as SHACL-SPARQL shapes. They run in `warn` mode and refuse no write |
| `checks.ts` | The words of each rule: the sentences of its item and the quotes it shows |
| `texts.ts` | `documents-texts` and the kinds of document (`KINDS`) |
| `check.ts` | `documents-check` |
| `workflow.ts` | The ontology, the LBB-run workflows, `setup()` and the settings |
| `samples/` | Three invented PDFs, their parsed pages and the answer key |

## Commands

```sh
npm install
npm test                                      # both workflows on the samples, with mock models
LBB_GRAPH=try-documents-check npm run try     # the pipeline and the sample PDFs on your stack
LBB_GRAPH=try-documents-check npm start       # serve the two workflows
LBB_GRAPH=docs npm run setup && LBB_GRAPH=docs npm start   # your graph
```

The commands read `LBB_URL` and `LBB_API_KEY`. The server needs the workflow
engine, `pdftotext` for `documents.parse`, and models. A local server with
mock model roles works. The mocks read `label: value` lines, so the samples
are written that way.

`src/live.test.ts` runs the whole pipeline on a stack. It creates and deletes
a graph, so it needs an explicit opt-in:

```sh
LBB_LIVE_TEST=1 LBB_URL=... LBB_API_KEY=... npx tsx --test src/live.test.ts
```

## What `setup` changes

- It publishes `shapes.ttl` as the graph's shape set. Publishing replaces the
  whole set, so `setup` stops when the graph has shapes of its own. Merge
  `shapes.ttl` into yours and publish the union.
- A graph that holds these shapes keeps its enforcement mode. A graph with no
  shapes gets `warn`.
- The workflow owns the classes `PurchaseOrder`, `DeliveryNote` and
  `Invoice`. It owns the properties `document_text` and `read_sha256`, and the
  relation `TEXT_OF`. It drops only the instances it wrote.
- The `rows` and `sections` templates own other names. All three can run on
  one graph.
- After you merge `shapes.ttl` into your own shapes, set `publishShapes: false`
  in `defaults`. `setup` then leaves the shape set alone.

## Limits

The guide lists the limits. The main ones:

- Each class has one value per property. A document with several line items
  needs one instance per line.
- A rule skips a document whose reference names no document of the graph.
- A turn files at most `candidatesPerTurn` new items (25). A continuation
  files the rest.
- `values.extract` leaves the `ValueSource` entities of a deleted file. It
  also leaves the open `value` items.
