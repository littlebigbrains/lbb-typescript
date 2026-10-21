// @ts-check
// Before `npm pack` and `npm publish`: copy the templates from the repository
// (`sdk/templates`) into the package, with the version of
// @littlebigbrain/client they are written for, and the Python ports of the
// templates (`sdk/python/examples`) into the package's `python/`, with the
// version of the `littlebigbrain` Python SDK they are written for. `--clean`
// removes both copies. Python's caches (`__pycache__`) are left out.
//
// `--to <dir>` copies the templates into <dir> instead of the package's
// `templates/`, and `--python-to <dir>` copies the Python ports into <dir>
// instead of the package's `python/`: the public SDK export stages them this
// way, and the checkout stays unchanged. The public lbb-typescript repository
// has no `sdk/templates` and no `sdk/python`; the export staged the copies
// there already. So when a source does not exist and its target holds
// `versions.json`, the script keeps that copy and `--clean` does nothing.
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PYTHON_TEMPLATES,
  TEMPLATES,
  pythonModule,
  pythonSdkVersion,
  withoutCaches,
} from "../lib/create.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const clean = args.includes("--clean");

/** The directory of an option, or undefined without it. @param {string} name */
function option(name) {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const dir = args[at + 1];
  if (dir === undefined || dir.startsWith("--")) throw new Error(`${name} needs a directory`);
  return resolve(dir);
}

/**
 * Copy `source` into `target` with `copy`, or remove `target` with `--clean`.
 * A staged copy stays when `source` does not exist.
 * @param {string} what
 * @param {string} source
 * @param {string} target
 * @param {() => Promise<string>} copy copies and returns what it did
 */
async function sync(what, source, target, copy) {
  if (!existsSync(source) && existsSync(join(target, "versions.json"))) {
    console.log(`Kept the staged ${what} in ${target} (no ${source})`);
  } else if (clean) {
    await rm(target, { recursive: true, force: true });
  } else {
    if (!existsSync(source))
      throw new Error(`no ${what}: ${source} does not exist and ${target} has no versions.json`);
    await rm(target, { recursive: true, force: true });
    console.log(await copy());
  }
}

const templates = option("--to") ?? join(root, "templates");
const templatesSource = join(root, "..", "templates");
await sync("templates", templatesSource, templates, async () => {
  await mkdir(join(templates, "_shared"), { recursive: true });
  await cp(
    join(templatesSource, "_shared", "testing.ts"),
    join(templates, "_shared", "testing.ts"),
  );
  for (const template of TEMPLATES)
    await cp(join(templatesSource, template), join(templates, template), {
      recursive: true,
      filter: withoutCaches,
    });
  const client = JSON.parse(await readFile(join(root, "..", "typescript", "package.json"), "utf8"));
  await writeFile(
    join(templates, "versions.json"),
    `${JSON.stringify({ client: client.version }, null, 2)}\n`,
  );
  return `Copied ${TEMPLATES.join(", ")} for @littlebigbrain/client ${client.version}`;
});

const python = option("--python-to") ?? join(root, "python");
const pythonSource = join(root, "..", "python", "examples");
await sync("Python ports", pythonSource, python, async () => {
  await mkdir(python, { recursive: true });
  for (const template of PYTHON_TEMPLATES) {
    const module = pythonModule(template);
    await cp(join(pythonSource, module), join(python, module), {
      recursive: true,
      filter: withoutCaches,
    });
  }
  const version = pythonSdkVersion(pythonSource);
  await writeFile(
    join(python, "versions.json"),
    `${JSON.stringify({ littlebigbrain: version }, null, 2)}\n`,
  );
  return `Copied the Python ports of ${PYTHON_TEMPLATES.join(", ")} for littlebigbrain ${version}`;
});
