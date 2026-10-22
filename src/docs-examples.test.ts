// Every TypeScript example of the docs pages in PAGES type-checks against
// this package's source, so a renamed method or field fails here and names
// the page and the block.
//
// The rule for a page: its ```ts blocks are one module, in page order. A
// later block uses what an earlier one declares, so the page's first block
// imports the client and makes `client`, and no two blocks of a page declare
// the same name. A block that imports "@littlebigbrain/client" gets this
// package's `src/index.ts`. The check type-checks only (no emit, no run):
// the curl, Python and Rust tests run the examples.
//
// The public SDK export has no docs site; there the test skips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const PAGES = [
  "start/first-workflow.mdx",
  "guides/test-a-workflow.mdx",
  "guides/datasets.mdx",
];

const SDK_IMPORT = '"@littlebigbrain/client"';

/** `docs-site/src/content/docs` in an ancestor of the working directory. */
function findDocs(): string | undefined {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, "docs-site/src/content/docs");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The ```ts (or ```typescript) blocks of a page, in order. */
export function tsBlocks(source: string): string[] {
  const blocks: string[] = [];
  const fence = /^```(?:ts|typescript)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
  for (const match of source.matchAll(fence)) blocks.push(match[1]!);
  return blocks;
}

interface Module {
  page: string;
  fileName: string;
  text: string;
  /** The first line (0-based) of each block in `text`. */
  starts: number[];
}

/** A page's blocks as one module, with the SDK import pointed at the source. */
function moduleOf(page: string, blocks: string[], dir: string): Module {
  const lines: string[] = [];
  const starts: number[] = [];
  blocks.forEach((block, index) => {
    lines.push(`// ${page}, block ${index + 1}`);
    starts.push(lines.length);
    lines.push(
      ...block.replaceAll(SDK_IMPORT, '"../src/index.js"').split("\n"),
    );
  });
  return {
    page,
    fileName: join(dir, `${page.replace(/[/.]/g, "-")}.mts`),
    text: lines.join("\n"),
    starts,
  };
}

/** Where a 0-based line of a module is: its block (1-based) and its line in it. */
function placeOf(module: Module, line: number): string {
  let block = 0;
  while (
    block + 1 < module.starts.length &&
    module.starts[block + 1]! - 1 <= line
  )
    block++;
  return `${module.page}, block ${block + 1}, line ${line - module.starts[block]! + 1}`;
}

test("the TypeScript examples of the docs type-check against the SDK", () => {
  const docs = findDocs();
  const index = resolve(process.cwd(), "src/index.ts");
  if (docs === undefined || !existsSync(index)) {
    console.log("# skipped: the docs site is not in this tree");
    return;
  }
  // The modules sit next to src/, so `../src/index.js` and node_modules resolve.
  const dir = resolve(process.cwd(), "docs-examples");
  const modules = PAGES.map((page) => {
    const path = join(docs, page);
    assert.ok(existsSync(path), `${page} is missing`);
    const blocks = tsBlocks(readFileSync(path, "utf8"));
    assert.ok(blocks.length > 0, `${page} has no TypeScript example`);
    return moduleOf(page, blocks, dir);
  });
  const virtual = new Map(
    modules.map((module) => [module.fileName, module.text]),
  );

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2022.d.ts"],
    types: ["node"],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const base = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...base,
    fileExists: (name) => virtual.has(name) || base.fileExists(name),
    readFile: (name) => virtual.get(name) ?? base.readFile(name),
    getSourceFile: (name, languageVersion, onError, shouldCreate) => {
      const text = virtual.get(name);
      if (text !== undefined)
        return ts.createSourceFile(name, text, languageVersion, true);
      return base.getSourceFile(name, languageVersion, onError, shouldCreate);
    },
  };
  const program = ts.createProgram([...virtual.keys()], options, host);

  const errors: string[] = [];
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n",
    );
    const file = diagnostic.file;
    if (file === undefined) {
      errors.push(message);
      continue;
    }
    const module = modules.find((each) => each.fileName === file.fileName);
    if (module === undefined) continue;
    const { line } = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    errors.push(`${placeOf(module, line)}: ${message}`);
  }
  assert.deepEqual(
    errors,
    [],
    `the docs examples do not type-check:\n${errors.join("\n")}`,
  );
});

test("a page's blocks are its ```ts fences, in order", () => {
  const page = [
    "Intro.",
    "```ts",
    'import { LbbClient } from "@littlebigbrain/client";',
    "```",
    "",
    "```sh",
    "curl -sS x",
    "```",
    "",
    "```typescript",
    "const a = 1;",
    "```",
  ].join("\n");
  assert.deepEqual(tsBlocks(page), [
    'import { LbbClient } from "@littlebigbrain/client";\n',
    "const a = 1;\n",
  ]);
});
