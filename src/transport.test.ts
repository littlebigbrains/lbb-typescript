import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseResponseJson,
  parseRetryAfterMs,
  retryAllowed,
  retryDelayForAttempt,
} from "./transport.js";

test("retry policy allows reads and explicitly idempotent writes only", () => {
  assert.equal(retryAllowed("GET"), true);
  assert.equal(retryAllowed("post"), false);
  assert.equal(retryAllowed("POST", "ik_1"), true);
});

test("Retry-After supports delta seconds, dates, malformed values, and a safety cap", () => {
  assert.equal(parseRetryAfterMs("2"), 2_000);
  assert.equal(parseRetryAfterMs("999"), 60_000);
  assert.equal(
    parseRetryAfterMs("Thu, 01 Jan 2026 00:00:03 GMT", Date.UTC(2026, 0, 1)),
    3_000,
  );
  assert.equal(parseRetryAfterMs("not-a-date"), undefined);
  assert.equal(retryDelayForAttempt(100, 2), 300);
  assert.equal(retryDelayForAttempt(100, 2, "1"), 1_000);
});

test("invalid success JSON reports HTTP status and request id", () => {
  let caught: unknown;
  try {
    parseResponseJson("not-json", 200, "req_json");
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof SyntaxError, true);
  assert.match(String(caught), /HTTP 200 \(request req_json\)/);
});
