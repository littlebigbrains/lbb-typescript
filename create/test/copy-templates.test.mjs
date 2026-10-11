// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEMPLATES } from "../lib/create.mjs";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PACKAGE, "..", "..");
const SCRIPT = join("scripts", "copy-templates.mjs");

/** A new empty directory under the system's temporary folder. */
const scratch = () => mkdtemp(join(tmpdir(), "copy-templates-"));

/** Run the copy script of the package in `root`. @param {string} root @param {string[]} args */
const run = (root, args) =>
  spawnSync(process.execPath, [join(root, SCRIPT), ...args], { cwd: root, encoding: "utf8" });

test("--to copies the templates and the client version into another folder", async () => {
  const dir = await scratch();
  const target = join(dir, "staged", "templates");
  const packageCopy = existsSync(join(PACKAGE, "templates"));
  execFileSync(process.execPath, [join(PACKAGE, SCRIPT), "--to", target], { stdio: "pipe" });

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
  assert.equal(existsSync(join(PACKAGE, "templates")), packageCopy, "the checkout is unchanged");

  execFileSync(process.execPath, [join(PACKAGE, SCRIPT), "--clean", "--to", target], {
    stdio: "pipe",
  });
  assert.equal(existsSync(target), false, "--clean --to removes that folder");
  assert.equal(existsSync(join(PACKAGE, "templates")), packageCopy, "the checkout is unchanged");
  await rm(dir, { recursive: true, force: true });
});

test("without ../templates the staged copy stays, and --clean does nothing", async () => {
  // The layout of the public repository: the package with its staged
  // templates, and no sdk/templates next to it.
  const dir = await scratch();
  const root = join(dir, "lbb-typescript", "create");
  for (const folder of ["scripts", "lib"])
    await cp(join(PACKAGE, folder), join(root, folder), { recursive: true });
  const staged = join(root, "templates");
  await mkdir(join(staged, "documents-link"), { recursive: true });
  await writeFile(join(staged, "versions.json"), '{ "client": "0.23.0" }\n');
  await writeFile(join(staged, "documents-link", "workflow.ts"), "// staged\n");

  for (const args of [[], ["--clean"]]) {
    const result = run(root, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Kept the staged templates/);
    assert.equal(await readFile(join(staged, "versions.json"), "utf8"), '{ "client": "0.23.0" }\n');
    assert.equal(
      await readFile(join(staged, "documents-link", "workflow.ts"), "utf8"),
      "// staged\n",
    );
  }

  // With no staged copy there is nothing to pack: the script fails.
  const empty = join(dir, "empty");
  const result = run(root, ["--to", empty]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no templates: .* has no versions\.json/);
  assert.equal(existsSync(join(empty, "versions.json")), false);
  await rm(dir, { recursive: true, force: true });
});
