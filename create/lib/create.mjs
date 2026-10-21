// @ts-check
// Create a project from a starter workflow template:
//
//   npm create @littlebigbrain -- --template documents-link [dir]
//   npm create @littlebigbrain -- --template values-extract --lang python [dir]
//
// The project holds the template's workflow, helpers, test and samples, and
// the scripts that run it: `npm test` (the workflow on its samples, with mock
// models), `npm run try` (the samples on a graph of your stack), `npm run
// setup` and `npm start` (your graph). The templates come from `templates/`
// in the package (copied there when it is packed) or, in the repository,
// from `sdk/templates`.
//
// `--lang python` creates the Python port of a template: its package, a test
// with mock models (`pytest`) and the commands `python -m <package>
// try|setup|start`. The ports come from `python/` in the package (copied
// there when it is packed) or, in the repository, from `sdk/python/examples`.
// The test and its fake LBB come from `project/python/<package>`.
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The templates a project can start from: the folder names under `sdk/templates`. */
export const TEMPLATES = [
  "documents-link",
  "documents-map",
  "review",
  "values-extract",
  "ontology-fit",
  "link",
  "rows",
  "sections",
];

/**
 * The templates with a Python port: the folder names under
 * `sdk/python/examples`, with dashes for underscores.
 */
export const PYTHON_TEMPLATES = ["values-extract"];

/** The languages of a project: `ts` (the default) and `python`. */
export const LANGS = ["ts", "python"];

/**
 * The Python package of a template's port: `values-extract` is `values_extract`.
 * @param {string} template
 */
export const pythonModule = (template) => template.replaceAll("-", "_");

/**
 * A copy filter that leaves out Python's caches.
 * @param {string} source
 */
export const withoutCaches = (source) =>
  basename(source) !== "__pycache__" && !source.endsWith(".pyc");

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Create a project from a little big brain starter workflow template.

Usage:
  npm create @littlebigbrain -- --template <name> [--lang ts|python] [dir]

Templates: ${TEMPLATES.join(", ")}
With a Python port (--lang python): ${PYTHON_TEMPLATES.join(", ")}

Options:
  --template <name>   the template (required)
  --lang <ts|python>  the project's language (default: ts)
  --client <spec>     the @littlebigbrain/client dependency of a TypeScript project
                      (default: ^<the current version>)
  --help              this text`;

/** @typedef {{ template?: string, dir?: string, client?: string, lang?: string, help: boolean }} Args */

/**
 * The options of the command line.
 * @param {string[]} argv
 * @returns {Args}
 */
export function parseArgs(argv) {
  /** @type {Args} */
  const out = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith("--") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = () => {
      const next = inline ?? argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--help" || flag === "-h") out.help = true;
    else if (flag === "--template" || flag === "-t") out.template = value();
    else if (flag === "--client") out.client = value();
    else if (flag === "--lang") {
      const lang = value();
      if (!LANGS.includes(lang)) throw new Error(`--lang is ts or python, not ${lang}`);
      out.lang = lang;
    } else if (flag.startsWith("-")) throw new Error(`unknown option ${flag}`);
    else if (out.dir === undefined) out.dir = arg;
    else throw new Error(`one directory, not ${out.dir} and ${arg}`);
  }
  return out;
}

/**
 * The folder that holds the templates: the package's own copy, else the
 * repository's `sdk/templates`.
 * @param {string} [root] the package folder
 */
export function templatesRoot(root = PACKAGE) {
  for (const candidate of [join(root, "templates"), join(root, "..", "templates")])
    if (existsSync(join(candidate, "_shared", "testing.ts"))) return candidate;
  throw new Error(`no templates in ${root}/templates or ${root}/../templates`);
}

/**
 * The version of @littlebigbrain/client the templates are written for.
 * @param {string} templates the templates folder
 */
export function clientVersion(templates) {
  const packed = join(templates, "versions.json");
  if (existsSync(packed)) return JSON.parse(readFileSync(packed, "utf8")).client;
  const repo = join(templates, "..", "typescript", "package.json");
  return JSON.parse(readFileSync(repo, "utf8")).version;
}

/**
 * The folder that holds the Python ports: the package's own copy, else the
 * repository's `sdk/python/examples`.
 * @param {string} [root] the package folder
 */
export function pythonRoot(root = PACKAGE) {
  const packed = join(root, "python");
  if (existsSync(join(packed, "versions.json"))) return packed;
  const repo = join(root, "..", "python", "examples");
  if (existsSync(join(repo, "..", "lbb", "_version.py"))) return repo;
  throw new Error(`no Python ports in ${packed} or ${repo}`);
}

/**
 * The version of the `littlebigbrain` Python SDK the ports are written for.
 * @param {string} ports the folder of the Python ports
 * @returns {string}
 */
export function pythonSdkVersion(ports) {
  const packed = join(ports, "versions.json");
  if (existsSync(packed)) return JSON.parse(readFileSync(packed, "utf8")).littlebigbrain;
  const file = join(ports, "..", "lbb", "_version.py");
  const found = readFileSync(file, "utf8").match(/^__version__ = "([^"]+)"$/m);
  if (!found?.[1]) throw new Error(`no __version__ in ${file}`);
  return found[1];
}

/** A package name from a directory name. @param {string} dir */
const packageName = (dir) =>
  basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9-._~]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "") || "workflow";

/**
 * A Python project name from a directory name: letters, digits, `.`, `_` and
 * `-`, with a letter or a digit at each end.
 * @param {string} dir
 */
const pythonName = (dir) =>
  basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "") || "workflow";

/**
 * A template's README as a section of the project's: no title, its headings
 * one level down, and its links into the repository as plain text.
 * @param {string} text
 */
const projectReadme = (text) =>
  text
    .replace(/\[([^\]]+)\]\((?:\.\.\/)+[^)]*\)/g, "$1")
    .replace(/^# .*\n/, "")
    .replace(/^(#{2,}) /gm, "#$1 ");

/**
 * Create the project of `template` in `dir`, in TypeScript (`lang` `ts`, the
 * default) or in Python. Returns the files written, relative to `dir`, sorted.
 * @param {{ template: string, dir: string, lang?: string, client?: string, root?: string }} options
 * @returns {Promise<string[]>}
 */
export async function create({ template, dir, lang = "ts", client, root = PACKAGE }) {
  if (!TEMPLATES.includes(template))
    throw new Error(`unknown template ${template}; the templates are ${TEMPLATES.join(", ")}`);
  if (!LANGS.includes(lang)) throw new Error(`the language is ts or python, not ${lang}`);
  if (lang === "python" && !PYTHON_TEMPLATES.includes(template))
    throw new Error(
      `the template ${template} has no Python port; ` +
        `the templates with one are ${PYTHON_TEMPLATES.join(", ")}`,
    );
  if (lang === "python" && client !== undefined)
    throw new Error("--client names the dependency of a TypeScript project (--lang ts)");
  if (existsSync(dir) && (await readdir(dir)).length)
    throw new Error(`${dir} is not empty: name a new directory`);
  if (lang === "python") return createPython({ template, dir, root });
  const templates = templatesRoot(root);
  const from = join(templates, template);
  const src = join(dir, "src");
  await mkdir(src, { recursive: true });

  // The template's code, its test and the test support, all under src/, the
  // template's folders (`sources/`) as they are.
  const code = await templateCode(from);
  for (const file of code) {
    const text = await readFile(join(from, file), "utf8");
    const up = "../".repeat(file.split("/").length - 1);
    await mkdir(dirname(join(src, file)), { recursive: true });
    await writeFile(
      join(src, file),
      text.replaceAll(`../${up}_shared/testing.js`, `${up || "./"}testing.js`),
    );
  }
  await cp(join(templates, "_shared", "testing.ts"), join(src, "testing.ts"));
  await cp(join(from, "samples"), join(dir, "samples"), { recursive: true });
  // A template's own commands win: a workflow of several parts sets itself up.
  for (const file of ["worker.ts", "setup.ts", "try.ts"]) {
    if (code.includes(file)) continue;
    const text = await readFile(join(root, "project", file), "utf8");
    await writeFile(join(src, file), text.replaceAll("__TEMPLATE__", template));
  }

  const name = packageName(dir);
  const pkg = {
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      start: "tsx src/worker.ts",
      setup: "tsx src/setup.ts",
      try: "tsx src/try.ts",
      test: "tsx --test src/workflow.test.ts",
      typecheck: "tsc --noEmit",
      ...(code.includes("grade-run.ts") ? { grade: "tsx src/grade-run.ts" } : {}),
      ...(code.includes("test-examples.ts") ? { "test:examples": "tsx src/test-examples.ts" } : {}),
    },
    dependencies: { "@littlebigbrain/client": client ?? `^${clientVersion(templates)}` },
    devDependencies: { "@types/node": "^22", tsx: "^4", typescript: "^5.6" },
  };
  await writeFile(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022"],
      strict: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      types: ["node"],
      noEmit: true,
    },
    include: ["src"],
  };
  await writeFile(join(dir, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
  await writeFile(join(dir, ".gitignore"), "node_modules/\ndist/\n.env\n");

  const readme = await readFile(join(from, "README.md"), "utf8");
  await writeFile(
    join(dir, "README.md"),
    `# ${name}

The \`${template}\` starter workflow template of little big brain, as a
project of its own: a workflow that your \`WorkflowWorker\` runs on a graph.

## Commands

\`\`\`sh
npm install
npm test                    # the workflow on its samples, with mock models: no server
npm run try                 # the samples on a graph of your stack, and the workflow there
${code.includes("test-examples.ts") ? "npm run test:examples       # the workflow on instances of your graph; writes nothing\n" : ""}npm run setup && npm start  # your graph: create the workflow, then serve it
\`\`\`

\`npm run try\`, \`npm run setup\` and \`npm start\` read \`LBB_URL\` (your
stack's endpoint), \`LBB_API_KEY\` (a key of the stack) and \`LBB_GRAPH\` (the
graph; \`npm run try\` creates it, default \`try-${template}\`). After
\`npm run try\`, serve the workflow with \`LBB_GRAPH=try-${template} npm start\`.
The server needs the workflow engine, and the models need a plan with managed
models.

## Files

- \`src/workflow.ts\`: the workflow, its settings (\`defaults\`), the triggered
  workflow that sends it the instances (\`trigger()\`) and the ontology it
  writes (\`ontology()\`). Change it here.
- \`src/workflow.test.ts\` and \`src/testing.ts\`: the test, and the mock of
  the activities and the workflow engine it runs on.
- \`src/samples.ts\` and \`samples/\`: the samples and what \`npm run try\` does
  with them.
- \`src/worker.ts\`, \`src/setup.ts\`, \`src/try.ts\`: the three commands.

## The template

${projectReadme(readme).trim()}
`,
  );
  return listFiles(dir);
}

/**
 * Create the Python project of `template` in `dir`: the port's package, the
 * test and the fake LBB it runs on (`tests/`), `pyproject.toml`, `.gitignore`
 * and `README.md`. Returns the files written, relative to `dir`, sorted.
 * @param {{ template: string, dir: string, root: string }} options
 * @returns {Promise<string[]>}
 */
async function createPython({ template, dir, root }) {
  const ports = pythonRoot(root);
  const module = pythonModule(template);
  const from = join(ports, module);
  const portReadme = join(from, "README.md");
  await mkdir(dir, { recursive: true });
  // The port's package, without its README: the project's README holds it.
  await cp(from, join(dir, module), {
    recursive: true,
    filter: (source) => withoutCaches(source) && source !== portReadme,
  });
  await cp(join(root, "project", "python", module), dir, {
    recursive: true,
    filter: withoutCaches,
  });

  const name = pythonName(dir);
  await writeFile(
    join(dir, "pyproject.toml"),
    `[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "${name}"
version = "0.1.0"
description = "The ${template} starter workflow template of little big brain, in Python"
requires-python = ">=3.10"
dependencies = ["littlebigbrain>=${pythonSdkVersion(ports)}"]

[project.optional-dependencies]
# pytest: the workflow on its samples, with mock models.
test = ["pytest>=8"]

[tool.setuptools.packages.find]
include = ["${module}*"]

[tool.setuptools.package-data]
${module} = ["samples/**/*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = [".", "tests"]
`,
  );
  await writeFile(
    join(dir, ".gitignore"),
    ".venv/\n__pycache__/\n*.egg-info/\n.pytest_cache/\n.env\n",
  );

  // The port's README up to its first section: what the workflow does.
  const about = projectReadme((await readFile(portReadme, "utf8")).split(/^## /m)[0] ?? "");
  await writeFile(
    join(dir, "README.md"),
    `# ${name}

The \`${template}\` starter workflow template of little big brain, in Python,
as a project of its own: a workflow that your \`WorkflowWorker\` runs on a
graph.

## Commands

Create a virtual environment, install the project with its test
dependencies, and run the test. The test runs the workflow on its samples,
with mock models and no server.

\`\`\`sh
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[test]"
pytest
\`\`\`

Then put the samples on a graph of your stack, create the workflow there, and
serve it:

\`\`\`sh
export LBB_URL=... LBB_API_KEY=...
python -m ${module} try
LBB_GRAPH=try-${template} python -m ${module} start
\`\`\`

| Command | Does |
| --- | --- |
| \`python -m ${module} try\` | Creates a graph (\`LBB_GRAPH\`, default \`try-${template}\`), puts the samples on it, and creates the workflow there |
| \`python -m ${module} setup\` | Creates the workflow on your graph (\`LBB_GRAPH\`, default \`main\`) |
| \`python -m ${module} start\` | Serves the workflow on \`LBB_GRAPH\` (default \`main\`) until SIGTERM or Ctrl-C. \`LBB_WORKER_ID\` names the worker, \`LBB_CONCURRENCY\` sets how many turns run at once |

The three commands read \`LBB_URL\` (your stack's endpoint) and
\`LBB_API_KEY\` (a key of the stack). The server needs the workflow engine,
and the models need a plan with managed models.

## Files

- \`${module}/workflow.py\`: the workflow, its settings (\`Settings\`,
  \`DEFAULTS\`), the triggered workflow that sends it the instances
  (\`trigger()\`) and the ontology it writes (\`ontology()\`). Change it here.
- \`${module}/samples.py\` and \`${module}/samples/\`: the samples, their
  answer key, and what \`try\` does with them.
- \`${module}/__main__.py\`: the three commands.
- \`tests/test_workflow.py\` and \`tests/fake_lbb.py\`: the test, and the fake
  LBB it runs the SDK's worker against.

## The template

${about.trim()}
`,
  );
  return listFiles(dir);
}

/**
 * The TypeScript files of a template folder, relative, in its folders too;
 * the samples are copied on their own.
 * @param {string} from
 * @returns {Promise<string[]>}
 */
async function templateCode(from) {
  return (await listFiles(from)).filter(
    (file) => file.endsWith(".ts") && !file.startsWith("samples/"),
  );
}

/** Every file under `dir`, relative and sorted. @param {string} dir @returns {Promise<string[]>} */
async function listFiles(dir, prefix = "") {
  /** @type {string[]} */
  const out = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, path)));
    else out.push(path);
  }
  return out.sort();
}

/**
 * The command: parse the arguments, create the project, print the next steps.
 * @param {string[]} argv
 * @param {{ log?: (line: string) => void }} [io]
 */
export async function main(argv, io = {}) {
  const log = io.log ?? ((line) => console.log(line));
  const options = parseArgs(argv);
  if (options.help || !options.template) {
    log(USAGE);
    if (!options.help) throw new Error("--template is required");
    return;
  }
  const { template, lang = "ts", client } = options;
  const dir = options.dir ?? template;
  const files = await create({ template, dir, lang, client });
  if (lang === "python") {
    log(`Created ${dir} from the ${template} template, in Python (${files.length} files). Next:`);
    log(`  cd ${dir}`);
    log("  python3 -m venv .venv && source .venv/bin/activate");
    log('  pip install -e ".[test]"');
    log("  pytest");
    log(`  LBB_URL=... LBB_API_KEY=... python -m ${pythonModule(template)} try`);
    return;
  }
  log(`Created ${dir} from the ${template} template (${files.length} files). Next:`);
  log(`  cd ${dir}`);
  log("  npm install");
  log("  npm test");
  log(`  LBB_URL=... LBB_API_KEY=... LBB_GRAPH=try-${template} npm run try`);
}
