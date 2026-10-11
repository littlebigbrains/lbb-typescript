// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEMPLATES,
  clientVersion,
  create,
  main,
  parseArgs,
  templatesRoot,
} from "../lib/create.mjs";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PACKAGE, "..", "..");

/** A new empty directory under the system's temporary folder. */
const scratch = () => mkdtemp(join(tmpdir(), "create-littlebigbrain-"));

test("the command line takes a template, a directory and a client", () => {
  assert.deepEqual(parseArgs(["--template", "documents-link", "my-links"]), {
    help: false,
    template: "documents-link",
    dir: "my-links",
  });
  assert.deepEqual(parseArgs(["--template=ontology-fit", "--client", "file:../client"]), {
    help: false,
    template: "ontology-fit",
    client: "file:../client",
  });
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["--template"]), /needs a value/);
  assert.throws(() => parseArgs(["--force"]), /unknown option/);
  assert.throws(() => parseArgs(["a", "b"]), /one directory/);
});

test("in the repository the templates come from sdk/templates, for the client's version", async () => {
  const root = templatesRoot();
  assert.equal(root, join(REPO, "sdk", "templates"));
  const client = JSON.parse(
    await readFile(join(REPO, "sdk", "typescript", "package.json"), "utf8"),
  );
  assert.equal(clientVersion(root), client.version);
  for (const template of TEMPLATES)
    assert.ok(existsSync(join(root, template, "workflow.ts")), template);
});

test("a documents-link project has the template, its samples and the three commands", async () => {
  const dir = join(await scratch(), "My Links");
  const files = await create({ template: "documents-link", dir });

  assert.deepEqual(files, [
    ".gitignore",
    "README.md",
    "package.json",
    "samples/ausstattungsliste.pdf",
    "samples/baubeschreibung.pdf",
    "samples/expected.json",
    "samples/pages/ausstattungsliste.json",
    "samples/pages/baubeschreibung.json",
    "samples/pages/raumblaetter.json",
    "samples/raumblaetter.pdf",
    "src/link.ts",
    "src/samples.ts",
    "src/setup.ts",
    "src/testing.ts",
    "src/try.ts",
    "src/worker.ts",
    "src/workflow.test.ts",
    "src/workflow.ts",
    "tsconfig.json",
  ]);
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.name, "my-links");
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.dependencies["@littlebigbrain/client"], `^${clientVersion(templatesRoot())}`);
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ["@types/node", "tsx", "typescript"]);
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ["setup", "start", "test", "try", "typecheck"]);
  const tsconfig = JSON.parse(await readFile(join(dir, "tsconfig.json"), "utf8"));
  assert.equal(tsconfig.compilerOptions.module, "NodeNext");
  const test = await readFile(join(dir, "src", "workflow.test.ts"), "utf8");
  assert.match(test, /from "\.\/testing\.js"/);
  assert.doesNotMatch(test, /_shared/);
  const tryScript = await readFile(join(dir, "src", "try.ts"), "utf8");
  assert.match(tryScript, /try-documents-link/);
  const readme = await readFile(join(dir, "README.md"), "utf8");
  for (const command of ["npm test", "npm run try", "npm run setup && npm start"])
    assert.ok(readme.includes(command), command);
  assert.doesNotMatch(readme, /\]\(\.\.\//, "no link into the repository");
});

test("a project needs a known template and an empty directory", async () => {
  const dir = await scratch();
  await assert.rejects(create({ template: "embeddings", dir: join(dir, "x") }), /unknown template/);
  await writeFile(join(dir, "file"), "x");
  await assert.rejects(create({ template: "ontology-fit", dir }), /not empty/);
  /** @type {string[]} */
  const lines = [];
  await assert.rejects(main([], { log: (line) => lines.push(line) }), /--template is required/);
  assert.match(lines[0] ?? "", /Usage/);
});

test("the client dependency can name another source", async () => {
  const dir = join(await scratch(), "values");
  await create({ template: "values-extract", dir, client: "file:../lbb/sdk/typescript" });
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@littlebigbrain/client"], "file:../lbb/sdk/typescript");
});

const built = existsSync(join(REPO, "sdk", "typescript", "dist", "index.js"));
const tsc = join(REPO, "node_modules", "typescript", "bin", "tsc");

for (const template of TEMPLATES)
  test(
    `a ${template} project compiles and its test passes on the workspace client`,
    { skip: !built && "build @littlebigbrain/client first" },
    async () => {
      const dir = join(await scratch(), template);
      await create({ template, dir });
      // The project's dependencies, from the workspace: the client and the Node types.
      await mkdir(join(dir, "node_modules", "@littlebigbrain"), { recursive: true });
      await mkdir(join(dir, "node_modules", "@types"), { recursive: true });
      await symlink(
        join(REPO, "sdk", "typescript"),
        join(dir, "node_modules", "@littlebigbrain", "client"),
        "dir",
      );
      await symlink(
        join(REPO, "node_modules", "@types", "node"),
        join(dir, "node_modules", "@types", "node"),
        "dir",
      );
      // The project runs its TypeScript with tsx; here tsc compiles it and node runs the test.
      execFileSync(
        process.execPath,
        [tsc, "-p", join(dir, "tsconfig.json"), "--noEmit", "false", "--outDir", join(dir, "dist")],
        { stdio: "pipe" },
      );
      // A test run inside a test run reports to its parent unless NODE_TEST_CONTEXT is cleared.
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const output = execFileSync(
        process.execPath,
        ["--test", "--test-reporter=tap", join(dir, "dist", "workflow.test.js")],
        {
          encoding: "utf8",
          env,
        },
      );
      assert.match(output, /# fail 0/);
      assert.doesNotMatch(output, /# pass 0\b/);
      await rm(dirname(dir), { recursive: true, force: true });
    },
  );
