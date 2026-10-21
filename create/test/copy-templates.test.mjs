// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PYTHON_TEMPLATES, TEMPLATES, pythonModule } from "../lib/create.mjs";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PACKAGE, "..", "..");
const SCRIPT = join("scripts", "copy-templates.mjs");

/** A new empty directory under the system's temporary folder. */
const scratch = () => mkdtemp(join(tmpdir(), "copy-templates-"));

/** Run the copy script of the package in `root`. @param {string} root @param {string[]} args */
const run = (root, args) =>
  spawnSync(process.execPath, [join(root, SCRIPT), ...args], { cwd: root, encoding: "utf8" });

/** Every path under `dir`, relative. @param {string} dir @returns {Promise<string[]>} */
async function pathsOf(dir, prefix = "") {
  /** @type {string[]} */
  const out = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    out.push(path);
    if (entry.isDirectory()) out.push(...(await pathsOf(dir, path)));
  }
  return out;
}

test("--to and --python-to copy the templates and the Python ports, with their versions", async () => {
  const dir = await scratch();
  const target = join(dir, "staged", "templates");
  const python = join(dir, "staged", "python");
  const packageCopy = existsSync(join(PACKAGE, "templates"));
  const pythonCopy = existsSync(join(PACKAGE, "python"));
  execFileSync(process.execPath, [join(PACKAGE, SCRIPT), "--to", target, "--python-to", python], {
    stdio: "pipe",
  });

  assert.deepEqual(
    (await readdir(target)).sort(),
    ["_shared", ...TEMPLATES, "versions.json"].sort(),
  );
  assert.ok(existsSync(join(target, "_shared", "testing.ts")));
  for (const template of TEMPLATES) {
    assert.ok(existsSync(join(target, template, "workflow.ts")), template);
    assert.ok(existsSync(join(target, template, "samples")), `${template} samples`);
  }
  const client = JSON.parse(
    await readFile(join(REPO, "sdk", "typescript", "package.json"), "utf8"),
  );
  assert.deepEqual(JSON.parse(await readFile(join(target, "versions.json"), "utf8")), {
    client: client.version,
  });

  assert.deepEqual(
    (await readdir(python)).sort(),
    [...PYTHON_TEMPLATES.map(pythonModule), "versions.json"].sort(),
  );
  for (const template of PYTHON_TEMPLATES) {
    const port = join(python, pythonModule(template));
    for (const file of ["__main__.py", "workflow.py", "samples.py", "samples/expected.json"])
      assert.ok(existsSync(join(port, file)), `${template} ${file}`);
    const cached = (await pathsOf(port)).filter((path) => /__pycache__|\.pyc$/.test(path));
    assert.deepEqual(cached, [], "no Python caches");
  }
  const sdk = await readFile(join(REPO, "sdk", "python", "lbb", "_version.py"), "utf8");
  const { littlebigbrain } = JSON.parse(await readFile(join(python, "versions.json"), "utf8"));
  assert.ok(sdk.includes(`__version__ = "${littlebigbrain}"`), `${littlebigbrain} in ${sdk}`);
  assert.equal(existsSync(join(PACKAGE, "templates")), packageCopy, "the checkout is unchanged");
  assert.equal(existsSync(join(PACKAGE, "python")), pythonCopy, "the checkout is unchanged");

  execFileSync(
    process.execPath,
    [join(PACKAGE, SCRIPT), "--clean", "--to", target, "--python-to", python],
    { stdio: "pipe" },
  );
  assert.equal(existsSync(target), false, "--clean --to removes that folder");
  assert.equal(existsSync(python), false, "--clean --python-to removes that folder");
  assert.equal(existsSync(join(PACKAGE, "templates")), packageCopy, "the checkout is unchanged");
  assert.equal(existsSync(join(PACKAGE, "python")), pythonCopy, "the checkout is unchanged");
  await rm(dir, { recursive: true, force: true });
});

test("without ../templates and ../python the staged copies stay, and --clean does nothing", async () => {
  // The layout of the public repository: the package with its staged
  // templates and Python ports, and no sdk/templates or sdk/python next to it.
  const dir = await scratch();
  const root = join(dir, "lbb-typescript", "create");
  for (const folder of ["scripts", "lib"])
    await cp(join(PACKAGE, folder), join(root, folder), { recursive: true });
  const staged = join(root, "templates");
  await mkdir(join(staged, "documents-link"), { recursive: true });
  await writeFile(join(staged, "versions.json"), '{ "client": "0.23.0" }\n');
  await writeFile(join(staged, "documents-link", "workflow.ts"), "// staged\n");
  const python = join(root, "python");
  await mkdir(join(python, "values_extract"), { recursive: true });
  await writeFile(join(python, "versions.json"), '{ "littlebigbrain": "0.23.0" }\n');
  await writeFile(join(python, "values_extract", "workflow.py"), "# staged\n");

  for (const args of [[], ["--clean"]]) {
    const result = run(root, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Kept the staged templates/);
    assert.match(result.stdout, /Kept the staged Python ports/);
    assert.equal(await readFile(join(staged, "versions.json"), "utf8"), '{ "client": "0.23.0" }\n');
    assert.equal(
      await readFile(join(staged, "documents-link", "workflow.ts"), "utf8"),
      "// staged\n",
    );
    assert.equal(
      await readFile(join(python, "values_extract", "workflow.py"), "utf8"),
      "# staged\n",
    );
  }

  // With no staged copy there is nothing to pack: the script fails.
  const empty = join(dir, "empty");
  const result = run(root, ["--to", empty]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no templates: .* has no versions\.json/);
  assert.equal(existsSync(join(empty, "versions.json")), false);
  const noPorts = run(root, ["--python-to", join(dir, "no-ports")]);
  assert.notEqual(noPorts.status, 0);
  assert.match(noPorts.stderr, /no Python ports: .* has no versions\.json/);
  await rm(dir, { recursive: true, force: true });
});
