# rows

Reads each CSV or TSV file of a graph into one instance per row. A
customer list gives one `Customer` per row, with the values of its
columns. Each instance has an edge `READ_FROM` to the file's `Document`.
The edge's evidence is the row's text, and its source is the file's IRI
with the row: `https://littlebigbrain.com/e/41ab…#row=5`
([evidence.md](../../../docs/reference/evidence.md#evidence-from-a-file)).

The template has no LBB-run version. It is a named workflow with a
**content trigger**: LBB sends it each upload of `text/csv` or
`text/tab-separated-values` within seconds, without a wait for a
publication ([workflows.md](../../../docs/reference/workflows.md#content-triggers)).

## How it runs

Each message holds one file. The first turn of a file:

1. **Check.** Reads the file's name with a strong read, and the
   derivation of the content for `rows@v1` and the settings
   ([Derivations](../../../docs/reference/workflows.md#derivations)). A
   content with a derivation is skipped, so the same bytes under a second
   name are read once. So is a file whose name the settings' `match` does
   not match. Other settings are another derivation, and read the file
   again.
2. **Plan.** Reads the bytes (`client.files.content`) and the header row.
   Each column maps to a property: the settings' `columns`, else each
   column whose header is a property of the graph by its normalized name
   (`Customer ID` and `customer_id` match). A property must be in the
   graph's property registry with a scalar type. The key column keys each
   instance; a column named `name`, `title` or `label` names it.
3. **Represents.** With `represents`, when the file's name without its
   extension is the label of exactly one instance of that class, writes
   `Document REPRESENTS <instance>`. `q3-customers.csv` represents the
   report `Q3 customers`: the labels compare in lower case, with `-`, `_`
   and spaces as one space. No match, or more than one, writes nothing and
   proposes nothing.

Then each turn reads at most `rowsPerTurn` rows and writes them in owned
writes of 400 rows. A row is one instance of the settings' class:

- its key: the key column's value, else `<sha256>:<row>`. A row whose key
  column is empty is left out;
- its values, each in its property's type. A value that does not take the
  type is left out and counted. An empty cell removes the property, as the
  owned write replaces the mapped properties of the instance;
- the edge `READ_FROM` to the `Document`, with the evidence
  `{text: <the row's text>, source_id: "<Document IRI>#row=<n>"}`.

Rows count as RFC 7111 counts them: from 1, and the header is row 1. A
blank row counts and writes nothing. When the file has more rows, the turn
continues (`ctx.continue`) at the offset of the next row. The last turn
records the derivation with what it wrote: the rows, the instances, the
columns it mapped and left out, the instance the file represents, and the
commits of its writes.

The parser follows RFC 4180: fields in double quotes can hold the
delimiter, line breaks and quotes (`""`). A row whose quoted field holds a
line break spans two lines and keeps one row number. TSV takes the same
quotes, with a tab as the delimiter. A byte order mark is dropped.

## Settings

`defaults` in `workflow.ts`, which fit the samples:

| Setting | Default | Meaning |
| --- | --- | --- |
| `className` | `Customer` | The class of the instances, one per data row |
| `key` | `Customer ID` | The column whose value keys each instance. Without it, the key is `<sha256>:<row>` |
| `columns` | none | Column to property. Without it, each column whose header is a property of the graph |
| `represents` | `{class: "Report"}` | Write `REPRESENTS` to the one instance of this class that the file's name names |
| `match` | `customers` | A regular expression on the file's name. Without it, every CSV and TSV file |
| `rowsPerTurn` | 5,000 | Rows one turn reads, 1 to 20,000 |

`trigger(settings)` names the workflow `rows`, with the content trigger
`rows` for the two media types. It owns the class, `READ_FROM`,
`REPRESENTS` when `represents` is set, and the properties of `columns`.
`ontology(settings)` adds the class and `READ_FROM`. The properties come
from the graph: add them with `lbb.evolve` before the first file.

The settings digest is the SHA-256 of the settings' canonical JSON: a
change of any setting reads every file again.

Run one workflow that writes `REPRESENTS` per graph. Two content workflows
that own one relation are refused with `409 workflow_owns_conflict`, so
`rows` and `sections` both with `represents` do not go on one graph.

## Commands

`setup.ts`, `worker.ts` and `try.ts` are the template's own:
`npm run setup` creates the named workflow with
`client.workflows.named.put(trigger())`, and `npm start` serves
`createWorkflow(lbbActivities(client), client)`: the client reads the
files' bytes and the derivations. `npm run try` creates the graph
`try-rows`, adds the sample properties and reports, uploads the two sample
files and creates the workflow. A content trigger reads the uploads from
before its creation too.

## Limits

- `GET /v1/files/content` returns the whole file, so each turn reads the
  whole file and parses from the offset of its first row: a large file is
  read once per turn.
- A file deleted later keeps the instances it gave; its `READ_FROM` edges
  go with its `Document`.
- A message that comes again while a large file is still in progress (a
  run now) reads the file again. The writes are the same.

## Samples and test

`samples/q3-customers.csv` is an invented customer list of 8 data rows. It
holds a quoted name with a comma, a name with quotes, an address with a
line break, a value that is not a date, a blank row, an empty cell and a
row without a key. `samples/q3-orders.tsv` is an invented order table.
`samples/properties.json` lists the graph properties the columns fill, and
`samples/reports.json` three reports the file names can name.
`samples/expected.json` gives the instances a correct run writes.

`workflow.test.ts` runs the workflow without a server (`MockContent` holds
the files and the derivations). It checks the answer key for both files,
the evidence of each row, the skip by derivation and by name, a file of
more rows than a turn reads, parts of 400 rows, a header-only file and an
empty file, `represents` with zero, one and two matching instances, keys
without a key column, the `columns` setting, the phases, and the parser
on RFC 4180's cases.
