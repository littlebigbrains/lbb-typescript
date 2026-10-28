# rows

Reads each CSV, TSV or XLSX file of a graph into one instance per row. A
customer list gives one `Customer` per row, with the values of its
columns. Each instance has an edge `READ_FROM` to the file's `Document`.
The edge's evidence is the row's text, and its source is the file's IRI
with the row: `https://littlebigbrain.com/e/41ab…#row=5`
([evidence.md](../../../docs/reference/evidence.md#evidence-from-a-file)).

The template has no LBB-run version. It is a named workflow with a
**content trigger**: LBB sends it each upload of `text/csv`,
`text/tab-separated-values` or an XLSX workbook within seconds, without a
wait for a publication ([workflows.md](../../../docs/reference/workflows.md#content-triggers)).

## How it runs

Each message holds one file. The first turn of a file:

1. **Check.** Reads the file's name with a strong read, and the
   derivation of the content for `rows@v1` and the settings
   ([Derivations](../../../docs/reference/workflows.md#derivations)). A
   content with a derivation is skipped, so the same bytes under a second
   name are read once. So is a file whose name the settings' `match` does
   not match. Other settings are another derivation, and read the file
   again.
2. **Plan.** Reads the header row: the first window of the file, by byte
   range (`client.files.content(sha256, { range })`). Each column maps to
   a property: the settings' `columns`, else each
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
writes of 400 rows. A turn reads from the byte offset where the last one
stopped, a window of 4 MiB per read, and parses only complete rows. A row
that a window does not end, such as a quoted field with a line break across
the window's edge, is read on in the next window. The first turn reads on
from the bytes of its header read, so a file is read about once in all. A
row is one instance of the settings' class:

- its key: the key column's value, else `<sha256>:<row>`. A row whose key
  column is empty is left out;
- its values, each in its property's type. A value that does not take the
  type is left out and counted. An empty cell removes the property, as the
  owned write replaces the mapped properties of the instance;
- the edge `READ_FROM` to the `Document`, with the evidence
  `{text: <the row's text>, source_id: "<Document IRI>#row=<n>"}`.

Rows count as RFC 7111 counts them: from 1, and the header is row 1. A
blank row counts and writes nothing. When the file has more rows, the turn
continues (`ctx.continue`): the message's cursor keeps the byte offset of
the next row (`byte`) and its row number (`row`), so the row numbers stay
exact. A turn that runs again after a crash reads its rows again from the
same offset. A cursor without `byte`, from an earlier version of the
template, reads the file again from its start. The last turn
records the derivation with what it wrote: the rows, the instances, the
columns it mapped and left out, the instance the file represents, and the
commits of its writes. The record names the upload the check
answered (`content_uploaded_at`). The cursor carries it from turn to turn.
When the file was deleted while the run read it, the record writes nothing
(`409 derivation_upload_changed`). The run ends and counts the file as
skipped. The run of a new upload reads the file again. Say the file was
deleted and not uploaded again. The next read of its bytes answers
`404 file_not_found`. The run ends there too, and counts the file as
skipped.

The parser follows RFC 4180: fields in double quotes can hold the
delimiter, line breaks and quotes (`""`). A row whose quoted field holds a
line break spans two lines and keeps one row number. TSV takes the same
quotes, with a tab as the delimiter. A byte order mark is dropped. The
parser reads bytes: the delimiter, the quote and the line breaks are ASCII,
so a window's edge inside a character of UTF-8 or between CR and LF changes
no row.

## XLSX files

For an XLSX workbook the template reads one sheet: the setting `sheet`, else
the first visible sheet. The server parses the workbook on its first read
(`client.files.sheets`, [Spreadsheets](../../../docs/reference/files.md#spreadsheets))
and serves the stored values of the sheet by A1 row, so the template reads no
byte of the file. A cell is the value its file stores, as text. A formula
cell is its stored value, and empty when the file stored none: nothing is
calculated.

The first row that holds a cell is the header (a sheet that starts at row 3
has its header in row 3). A record is a row that holds a cell, and its row
number is the A1 row, so a blank row between two rows is not a record and
does not shift the numbers. The rest is as for CSV: the mapped columns, the
key column, `represents`, the derivation and the turns (`rowsPerTurn`, with
the next A1 row in the cursor instead of a byte offset).

An instance has the edge `READ_FROM` to the `Document`, with the row's text
as evidence and the row as a range of its sheet as source:
`<Document IRI>#Sales!A5:F5` (cells A to the last cell of row 5; a sheet name
with a space is quoted and percent encoded). The console opens the file at
that range. A client without `files.sheets` skips XLSX files, and so does a
workbook that has no sheet named in `sheet`. A workbook the server refuses
(a limit, a macro, an encrypted file) fails the file's turn with the
server's reason.

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
| `sheet` | first visible sheet | For an XLSX file, the sheet to read. A workbook without it is skipped |

`trigger(settings)` names the workflow `rows`, with the content trigger
`rows` for the two media types. It owns the class, `READ_FROM`,
`REPRESENTS` when `represents` is set, and the properties of `columns`.
`ontology(settings)` adds the class and `READ_FROM`. The properties come
from the graph: add them with `lbb.evolve` before the first file.

The settings digest is the SHA-256 of the settings' canonical JSON: a
change of any setting reads every file again.

Two content workflows own one relation when no upload can reach both:
`rows` and `sections`, both with `represents`, go on one graph, because no
media type of one meets a media type of the other. A second workflow that
writes `REPRESENTS` for a type that meets one of these, such as `text/*`, is
refused with `409 workflow_owns_conflict`
([starter-workflows.md](../../../docs/reference/starter-workflows.md#cycles-and-conflicts)).

## Commands

`setup.ts`, `worker.ts` and `try.ts` are the template's own:
`npm run setup` creates the named workflow with
`client.workflows.named.put(trigger())`, and `npm start` serves
`createWorkflow(lbbActivities(client), client)`: the client reads the
files' bytes and the derivations. A fourth argument sets how the workflow
reads: `{ window, maxRecord }`, the bytes of one read (default 4 MiB, at
least 64) and of the longest row (default 16 MiB). They change no output,
so they are not settings and enter no settings digest. `npm run try` creates the graph
`try-rows`, adds the sample properties and reports, uploads the two sample
files and creates the workflow. A content trigger reads the uploads from
before its creation too.

## Limits

- A turn holds at most one window and the longest row in memory. A row
  longer than 16 MiB, such as a quote that never closes, stops the file:
  the turn fails with an error that names the row and its byte offset.
- A turn that stops at `rowsPerTurn` in the middle of a window reads the
  rest of that window again in the next turn.
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
on RFC 4180's cases. The reads by range: a file of many windows read once
with exact row numbers, every window size from 64 to 200 bytes over
quoted fields, letters beyond ASCII and the three line breaks, a CRLF file
whose window ends between CR and LF, a turn that continues from its byte
offset (also after a crash), and a row longer than the longest row.
