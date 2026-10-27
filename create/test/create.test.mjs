// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PYTHON_TEMPLATES,
  TEMPLATES,
  clientVersion,
  create,
  main,
  parseArgs,
  pythonModule,
  pythonRoot,
  pythonSdkVersion,
  templatesRoot,
} from "../lib/create.mjs";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PACKAGE, "..", "..");

/** A new empty directory under the system's temporary folder. */
const scratch = () => mkdtemp(join(tmpdir(), "create-littlebigbrain-"));

/** Every file under `dir`, relative and sorted. @param {string} dir @returns {Promise<string[]>} */
async function filesOf(dir, prefix = "") {
  /** @type {string[]} */
  const out = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await filesOf(dir, path)));
    else out.push(path);
  }
  return out.sort();
}

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

test("the command line takes a language, ts or python", () => {
  assert.deepEqual(parseArgs(["--template=values-extract", "--lang=python", "my-values"]), {
    help: false,
    template: "values-extract",
    lang: "python",
    dir: "my-values",
  });
  assert.equal(parseArgs(["-t", "review", "--lang", "ts"]).lang, "ts");
  assert.equal(parseArgs(["-t", "review"]).lang, undefined);
  assert.throws(() => parseArgs(["--lang", "go"]), /--lang is ts or python, not go/);
  assert.throws(() => parseArgs(["--lang"]), /needs a value/);
});

test("in the repository the Python ports come from sdk/python/examples, for the SDK's version", async () => {
  const root = pythonRoot();
  assert.equal(root, join(REPO, "sdk", "python", "examples"));
  // The ports are the folders of sdk/python/examples, by template name.
  const folders = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("__"))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(folders, PYTHON_TEMPLATES.map(pythonModule).sort());
  for (const template of PYTHON_TEMPLATES) {
    assert.ok(TEMPLATES.includes(template), `${template} is a template`);
    assert.ok(existsSync(join(PACKAGE, "project", "python", pythonModule(template))), template);
  }
  const version = await readFile(join(REPO, "sdk", "python", "lbb", "_version.py"), "utf8");
  assert.ok(version.includes(`__version__ = "${pythonSdkVersion(root)}"`), version);
});

test("a Python values-extract project has the port, its samples, a test and its pyproject", async () => {
  const dir = join(await scratch(), "My Values");
  /** @type {string[]} */
  const lines = [];
  await main(["--template", "values-extract", "--lang", "python", dir], {
    log: (line) => lines.push(line),
  });
  assert.deepEqual(await filesOf(dir), [
    ".gitignore",
    "README.md",
    "pyproject.toml",
    "tests/fake_lbb.py",
    "tests/test_workflow.py",
    "values_extract/__init__.py",
    "values_extract/__main__.py",
    "values_extract/samples.py",
    "values_extract/samples/expected.json",
    "values_extract/samples/records.json",
    "values_extract/workflow.py",
  ]);
  const pyproject = await readFile(join(dir, "pyproject.toml"), "utf8");
  const version = pythonSdkVersion(pythonRoot());
  assert.match(pyproject, /^name = "my-values"$/m);
  assert.match(pyproject, /^requires-python = ">=3\.10"$/m);
  assert.ok(pyproject.includes(`dependencies = ["littlebigbrain>=${version}"]`), pyproject);
  assert.match(pyproject, /^test = \["pytest>=8"\]$/m);
  assert.match(pyproject, /^include = \["values_extract\*"\]$/m);
  for (const file of ["workflow.py", "samples/expected.json"])
    assert.equal(
      await readFile(join(dir, "values_extract", file), "utf8"),
      await readFile(join(REPO, "sdk", "python", "examples", "values_extract", file), "utf8"),
      file,
    );
  const test = await readFile(join(dir, "tests", "test_workflow.py"), "utf8");
  assert.match(test, /expected\.json/);
  assert.match(test, /^from fake_lbb import /m);
  const gitignore = await readFile(join(dir, ".gitignore"), "utf8");
  for (const entry of [".venv/", "__pycache__/", "*.egg-info/"])
    assert.ok(gitignore.split("\n").includes(entry), entry);
  const readme = await readFile(join(dir, "README.md"), "utf8");
  for (const text of [
    "# my-values",
    "python3 -m venv .venv",
    'pip install -e ".[test]"',
    "\npytest\n",
    "python -m values_extract try",
    "python -m values_extract setup",
    "python -m values_extract start",
    "LBB_URL",
    "LBB_API_KEY",
    "LBB_GRAPH",
    "## The template",
    "It fills properties of\na class",
  ])
    assert.ok(readme.includes(text), text);
  assert.doesNotMatch(readme, /sdk\/python\/examples/, "no path of the repository");
  assert.doesNotMatch(readme, /—|–/, "no dashes in the prose");
  assert.match(lines[0] ?? "", /in Python \(11 files\)/);
  assert.ok(lines.includes("  pytest"), lines.join("\n"));
  assert.ok(lines.includes("  LBB_URL=... LBB_API_KEY=... python -m values_extract try"));
});

test("--lang python needs a template with a Python port, and no --client", async () => {
  const dir = await scratch();
  await assert.rejects(
    create({ template: "review", dir: join(dir, "review"), lang: "python" }),
    /the template review has no Python port; the templates with one are values-extract/,
  );
  await assert.rejects(
    main(["--template", "documents-link", "--lang", "python", join(dir, "links")], {
      log: () => {},
    }),
    /has no Python port; the templates with one are values-extract/,
  );
  assert.equal(existsSync(join(dir, "links")), false, "nothing is written");
  await assert.rejects(
    create({ template: "embeddings", dir: join(dir, "x"), lang: "python" }),
    /unknown template/,
  );
  await assert.rejects(
    create({ template: "values-extract", dir: join(dir, "v"), lang: "python", client: "^1" }),
    /--client names the dependency of a TypeScript project/,
  );
  await assert.rejects(
    create({ template: "values-extract", dir: join(dir, "v"), lang: "go" }),
    /ts or python, not go/,
  );
});

test("a packed package reads its own copy of the ports and leaves Python's caches out", async () => {
  const dir = await scratch();
  const root = join(dir, "create");
  await cp(join(PACKAGE, "project"), join(root, "project"), { recursive: true });
  const port = join(root, "python", "values_extract");
  await cp(join(REPO, "sdk", "python", "examples", "values_extract"), port, { recursive: true });
  await mkdir(join(port, "__pycache__"), { recursive: true });
  await writeFile(join(port, "__pycache__", "workflow.cpython-312.pyc"), "");
  await writeFile(join(root, "python", "versions.json"), '{ "littlebigbrain": "9.8.7" }\n');
  assert.equal(pythonRoot(root), join(root, "python"));

  const project = join(dir, "values");
  const files = await create({ template: "values-extract", dir: project, lang: "python", root });
  assert.ok(files.includes("values_extract/workflow.py"));
  assert.ok(!files.some((file) => file.includes("__pycache__")), files.join("\n"));
  assert.ok(!files.includes("values_extract/README.md"), "the project's README holds it");
  const pyproject = await readFile(join(project, "pyproject.toml"), "utf8");
  assert.ok(pyproject.includes('dependencies = ["littlebigbrain>=9.8.7"]'), pyproject);
  await rm(dir, { recursive: true, force: true });
});

test("--lang ts is the TypeScript project, as without --lang", async () => {
  const dir = await scratch();
  const plain = await create({ template: "values-extract", dir: join(dir, "plain") });
  const ts = await create({ template: "values-extract", dir: join(dir, "ts"), lang: "ts" });
  assert.deepEqual(ts, plain);
  assert.ok(ts.includes("package.json") && ts.includes("src/workflow.ts"));
  assert.ok(!ts.includes("pyproject.toml"));
  /** @type {string[]} */
  const lines = [];
  await main(["--template", "review", "--lang", "ts", join(dir, "review")], {
    log: (line) => lines.push(line),
  });
  assert.match(lines[0] ?? "", /from the review template \(\d+ files\)/);
  assert.ok(lines.includes("  npm install") && lines.includes("  npm test"), lines.join("\n"));
  await rm(dir, { recursive: true, force: true });
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

test("a link project keeps the template's folders, its own commands and its grading command", async () => {
  const dir = join(await scratch(), "links");
  const files = await create({ template: "link", dir });
  for (const file of [
    "src/sources/records.ts",
    "src/grade-run.ts",
    "samples/gold.json",
    "samples/records.json",
  ])
    assert.ok(files.includes(file), file);
  const setup = await readFile(join(dir, "src", "setup.ts"), "utf8");
  assert.match(setup, /await setup\(client/, "the template's own setup, not the project's");
  const fixture = await readFile(join(dir, "src", "fixture.ts"), "utf8");
  assert.match(fixture, /from "\.\/testing\.js"/);
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.grade, "tsx src/grade-run.ts");
  const other = JSON.parse(
    await readFile(
      join(
        await create({ template: "review", dir: join(dir, "..", "review") }).then(() =>
          join(dir, "..", "review"),
        ),
        "package.json",
      ),
      "utf8",
    ),
  );
  assert.equal(other.scripts.grade, undefined);
  assert.equal(other.scripts["test:examples"], undefined);
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
  // values-extract tests on examples of your graph before it writes.
  assert.equal(pkg.scripts["test:examples"], "tsx src/test-examples.ts");
  assert.ok(existsSync(join(dir, "src", "test-examples.ts")));
});

test("a documents-check project holds shapes.ttl beside its code, and its README names no repository path", async () => {
  const dir = join(await scratch(), "checks");
  const files = await create({ template: "documents-check", dir });
  for (const file of [
    "src/shapes.ttl",
    "src/checks.ts",
    "src/live.test.ts",
    "samples/expected.json",
  ])
    assert.ok(files.includes(file), file);
  const readme = await readFile(join(dir, "README.md"), "utf8");
  // The project is not the repository: no `npm run dev:stack`, no `.lbb-dev`, no link to a file of the repository.
  assert.doesNotMatch(readme, /dev:stack|\.lbb-dev|_samples/);
  assert.doesNotMatch(
    readme,
    /\]\((?!https:)[^)]*\)/,
    "a markdown link in the README points at a file",
  );
  await rm(dirname(dir), { recursive: true, force: true });
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
