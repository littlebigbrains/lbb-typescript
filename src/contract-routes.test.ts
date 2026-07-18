import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Contract-drift guard for the hand-written TS client surface (S8). The
// generated types (schema.ts) are gated by the `contracts` CI job, but the
// hand-written `this.request("METHOD", "/path")` calls embed route strings
// nothing checks. This asserts every literal route the client issues is either
// a real operation in contracts/openapi.json or an explicitly allow-listed
// control-plane route.
//
// `npm test` runs from the package dir. Locate contracts/openapi.json by
// walking up from cwd so the test works both in the monorepo (two levels up)
// and in the public lbb-typescript repo, where the package sits at the
// repository root next to contracts/.
function findContract(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, "contracts/openapi.json");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) {
      throw new Error("contracts/openapi.json not found in any ancestor");
    }
    dir = parent;
  }
}
const OPENAPI = findContract();
const CLIENT = resolve(process.cwd(), "src/client.ts");

// Routes the TS client legitimately calls that are intentionally NOT in the
// public data-plane OpenAPI contract. This allow-list is the visible debt
// register: adding a route here is a conscious decision to leave it
// uncontracted. (The /api/admin/* control-plane surface lives in
// apps/saas-api/src/controlPlaneClient.ts, not in this SDK.)
const UNCONTRACTED = new Set<string>();

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function specOperations(): Set<string> {
  const spec = JSON.parse(readFileSync(OPENAPI, "utf8")) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const ops = new Set<string>();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of Object.keys(methods)) {
      if (HTTP_METHODS.has(method.toLowerCase())) {
        ops.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return ops;
}

function clientRoutes(): Set<string> {
  // Matches `this.request("POST", "/v1/graph/commit"`; only static string-literal
  // paths are captured (template-literal path-param routes are covered by the
  // methods that build them and are invisible here).
  const source = readFileSync(CLIENT, "utf8");
  const re = /request\(\s*"([A-Z]+)",\s*"([^"]+)"/g;
  const routes = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    routes.add(`${match[1]} ${match[2]}`);
  }
  return routes;
}

test("every TS client route is contracted or explicitly allow-listed", () => {
  const spec = specOperations();
  const routes = clientRoutes();
  assert.ok(routes.size > 0, "no request routes parsed from client.ts");
  const missing = [...routes]
    .filter((route) => !spec.has(route) && !UNCONTRACTED.has(route))
    .sort();
  assert.deepEqual(
    missing,
    [],
    `client calls route(s) absent from contracts/openapi.json and not allow-listed ` +
      `(typo or removed route?): ${missing.join(", ")}`,
  );
});

test("the uncontracted allow-list has no stale entries", () => {
  // Prune an allow-listed route the client no longer calls, or that has since
  // been added to the contract — keep the debt register honest.
  const spec = specOperations();
  const routes = clientRoutes();
  const stale = [...UNCONTRACTED]
    .filter((route) => !routes.has(route) || spec.has(route))
    .sort();
  assert.deepEqual(
    stale,
    [],
    `stale allow-list entries (client no longer calls, or now contracted): ${stale.join(", ")}`,
  );
});
