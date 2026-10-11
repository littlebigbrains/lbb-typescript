// @ts-check
// Before `npm pack` and `npm publish`: copy the templates from the repository
// (`sdk/templates`) into the package, with the version of
// @littlebigbrain/client they are written for. `--clean` removes the copy.
//
// `--to <dir>` copies into <dir> instead of the package's `templates/`: the
// public SDK export stages the templates this way, and the checkout stays
// unchanged. The public lbb-typescript repository has no `sdk/templates`; the
// export staged the copy there already. So when `../templates` does not exist
// and the target holds `versions.json`, the script keeps the copy and
// `--clean` does nothing.
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEMPLATES } from "../lib/create.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const clean = args.includes("--clean");
const to = args.indexOf("--to");
const dir = to === -1 ? undefined : args[to + 1];
if (to !== -1 && (dir === undefined || dir.startsWith("--")))
  throw new Error("--to needs a directory");
const target = dir === undefined ? join(root, "templates") : resolve(dir);
const source = join(root, "..", "templates");

if (!existsSync(source) && existsSync(join(target, "versions.json"))) {
  console.log(`Kept the staged templates in ${target} (no ${source})`);
} else if (clean) {
  await rm(target, { recursive: true, force: true });
} else {
  if (!existsSync(source))
    throw new Error(`no templates: ${source} does not exist and ${target} has no versions.json`);
  await rm(target, { recursive: true, force: true });
  await mkdir(join(target, "_shared"), { recursive: true });
  await cp(join(source, "_shared", "testing.ts"), join(target, "_shared", "testing.ts"));
  for (const template of TEMPLATES)
    await cp(join(source, template), join(target, template), { recursive: true });
  const client = JSON.parse(await readFile(join(root, "..", "typescript", "package.json"), "utf8"));
  await writeFile(
    join(target, "versions.json"),
    `${JSON.stringify({ client: client.version }, null, 2)}\n`,
  );
  console.log(`Copied ${TEMPLATES.join(", ")} for @littlebigbrain/client ${client.version}`);
}
