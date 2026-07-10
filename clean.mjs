import { rm } from "node:fs/promises";

const directory = process.argv[2] ?? "dist";
if (directory !== "dist" && directory !== "test-dist") {
  throw new Error("clean target must be dist or test-dist");
}
await rm(new URL(`./${directory}`, import.meta.url), { recursive: true, force: true });
