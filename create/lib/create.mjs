// @ts-check
// Create a project from a starter workflow template:
//
//   npm create @littlebigbrain -- --template documents-link [dir]
//
// The project holds the template's workflow, helpers, test and samples, and
// the scripts that run it: `npm test` (the workflow on its samples, with mock
// models), `npm run try` (the samples on a graph of your stack), `npm run
// setup` and `npm start` (your graph). The templates come from `templates/`
// in the package (copied there when it is packed) or, in the repository,
// from `sdk/templates`.
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
];

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Create a project from a little big brain starter workflow template.

Usage:
  npm create @littlebigbrain -- --template <name> [dir]

Templates: ${TEMPLATES.join(", ")}

Options:
  --template <name>   the template (required)
  --client <spec>     the @littlebigbrain/client dependency (default: ^<the current version>)
  --help              this text`;

/**
 * The options of the command line.
 * @param {string[]} argv
 * @returns {{ template?: string, dir?: string, client?: string, help: boolean }}
 */
export function parseArgs(argv) {
  /** @type {{ template?: string, dir?: string, client?: string, help: boolean }} */
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
    else if (flag.startsWith("-")) throw new Error(`unknown option ${flag}`);
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

/** A package name from a directory name. @param {string} dir */
const packageName = (dir) =>
  basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9-._~]+/g, "-")
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
 * Create the project of `template` in `dir`. Returns the files written,
 * relative to `dir`, sorted.
 * @param {{ template: string, dir: string, client?: string, root?: string }} options
 * @returns {Promise<string[]>}
 */
export async function create({ template, dir, client, root = PACKAGE }) {
  if (!TEMPLATES.includes(template))
    throw new Error(`unknown template ${template}; the templates are ${TEMPLATES.join(", ")}`);
  if (existsSync(dir) && (await readdir(dir)).length)
    throw new Error(`${dir} is not empty: name a new directory`);
  const templates = templatesRoot(root);
  const from = join(templates, template);
  const src = join(dir, "src");
  await mkdir(src, { recursive: true });

  // The template's code, its test and the test support, all under src/.
  for (const file of await readdir(from)) {
    if (!file.endsWith(".ts")) continue;
    const text = await readFile(join(from, file), "utf8");
    await writeFile(join(src, file), text.replaceAll("../_shared/testing.js", "./testing.js"));
  }
  await cp(join(templates, "_shared", "testing.ts"), join(src, "testing.ts"));
  await cp(join(from, "samples"), join(dir, "samples"), { recursive: true });
  for (const file of ["worker.ts", "setup.ts", "try.ts"]) {
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
npm run setup && npm start  # your graph: create the workflow, then serve it
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
  const dir = options.dir ?? options.template;
  const files = await create({ template: options.template, dir, client: options.client });
  log(`Created ${dir} from the ${options.template} template (${files.length} files). Next:`);
  log(`  cd ${dir}`);
  log("  npm install");
  log("  npm test");
  log(`  LBB_URL=... LBB_API_KEY=... LBB_GRAPH=try-${options.template} npm run try`);
}
