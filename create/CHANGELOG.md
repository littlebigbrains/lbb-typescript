# Changelog

All notable changes to the `@littlebigbrain/create` package are documented here.

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
