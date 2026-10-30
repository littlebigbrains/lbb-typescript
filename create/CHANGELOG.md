# Changelog

All notable changes to the `@littlebigbrain/create` package are documented here.

## 0.8.0 (2026-10-30)

- A new project requires `@littlebigbrain/client` ^0.32.0, and a
  `--lang python` project `littlebigbrain>=0.33.0`. These releases add
  `files.sheets` and the `attempt` option of `reason`, which the templates
  below use.
- The new template `documents-check` checks PDFs against each other: SHACL
  rules over the values `values.extract` reads, and a review item with the
  quotes of both documents for each difference. The project holds its rules in
  `src/shapes.ttl`. The template has no LBB-run version and no Python port.
- The `rows` template reads XLSX files by sheet. The new setting `sheet` names
  the sheet to read; the default is the first visible sheet.
- The `values-extract` template takes `repair: 0 | 1` (`Settings(repair=1)`
  in the Python port): `1` asks again once when the first answer fails a
  check. The default `0` makes the same calls as before.

## 0.7.0 (2026-10-26)

- A new project requires `@littlebigbrain/client` ^0.31.0, and a
  `--lang python` project `littlebigbrain>=0.32.0`. These releases add the
  workflow tree `/v1/workflows/named`, workflow tests under
  `/v1/workflows/named/tests` and one list envelope. They also add a model
  choice for each workflow use, and schedule and stream triggers.

## 0.6.0 (2026-10-21)

- `--lang <ts|python>` (default `ts`). `--lang python` creates the Python
  port of a template, for the `littlebigbrain` Python SDK:
  `npm create @littlebigbrain -- --template values-extract --lang python`.
  The project holds the port's package (`values_extract/`), a test that runs
  the workflow on its samples with mock models and checks the values of the
  answer key (`pytest`), `pyproject.toml` with the dependency
  `littlebigbrain>=<the version the port is written for>` and a `test` extra,
  `.gitignore` and `README.md`. Its commands are
  `python -m values_extract try`, `setup` and `start`. A template without a
  Python port fails with the list of the templates that have one.
- The package ships the Python ports in `python/`, with `python/versions.json`
  (the Python SDK version they are written for).
