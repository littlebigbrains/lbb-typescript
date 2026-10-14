# @littlebigbrain/create

Creates a project from a little big brain starter workflow template: a
workflow that your `WorkflowWorker` runs on a graph, with its test, its
samples and the scripts that run it.

```sh
npm create @littlebigbrain -- --template documents-link my-links
cd my-links
npm install
npm test
```

## Templates

| Template | Does |
| --- | --- |
| `documents-link` | Connects mentions of the same thing across the documents: each reference links to where that thing is defined or described |
| `values-extract` | Fills properties of a class from the text of its instances, each value with a verbatim quote |
| `ontology-fit` | Proposes the ontology changes the texts of a class support, as review items |
| `documents-map` | Maps the links of `documents-link` into the graph's own ontology, as fact proposals |
| `review` | Writes the fact proposals at or above a gate as facts and gives the others to a person |
| `link` | Connects the mentions of one thing across the records of a graph into one thing, and proposes records of one thing as an identity |

A template id is the id of its starter workflow, with dashes for dots:
`documents-link` is the code of `documents.link`.

## The project

| File | Holds |
| --- | --- |
| `src/workflow.ts` | The workflow, its settings, the triggered workflow that sends it the instances (`trigger()`) and the ontology it writes (`ontology()`) |
| `src/*.ts` | The template's helpers and `samples.ts`, which puts the samples on a graph |
| `src/workflow.test.ts`, `src/testing.ts` | The workflow on its samples, with mock models and no server |
| `src/worker.ts`, `src/setup.ts`, `src/try.ts` | `npm start`, `npm run setup` and `npm run try`; a template that has its own (`link`) keeps them |
| `src/grade-run.ts` | `npm run grade`, in a template that grades a run against a gold file (`link`) |
| `samples/` | The samples and their answer key |

`npm run try` creates a graph (`LBB_GRAPH`, default `try-<template>`), puts
the samples on it and creates the workflow there. `npm run setup` creates the
workflow on your own graph, and `npm start` serves it. All three read
`LBB_URL` and `LBB_API_KEY`.

## Options

| Option | Meaning |
| --- | --- |
| `--template <name>` | The template (required) |
| `--client <spec>` | The `@littlebigbrain/client` dependency of the project. Default: the version the templates are written for |
| `[dir]` | The new project's directory. Default: the template's name. It must be empty or missing |

## Development

The package is developed in the little big brain monorepo, and the templates
live in its `sdk/templates`. There the command reads them from that folder.
`npm pack` copies them into the package (`prepack`) with the client version,
and removes the copy afterwards.

```sh
node sdk/create/bin/create-littlebigbrain.mjs --template documents-link /tmp/my-links
npm test -w @littlebigbrain/create
```

The test creates each project, compiles it against the workspace's client
and runs its test.

The public repository
[littlebigbrains/lbb-typescript](https://github.com/littlebigbrains/lbb-typescript)
holds the package in `create/`, with the templates and
`templates/versions.json` already copied in. There `prepack` keeps that copy.
A new version in `create/package.json` is published to npm by the
repository's `release-create.yml` workflow.

## License

Apache-2.0
