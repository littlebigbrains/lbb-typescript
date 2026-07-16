import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bodyMarksTerminal,
  fullJitterBackoffMs,
  parseResponseJson,
  parseRetryAfterMs,
  retryAfterFromBodyMs,
  retryAllowed,
  retryDelayMs,
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
});

test("retryDelayMs prefers the header, then the body hint, then jitter", () => {
  // 1. Retry-After header wins.
  assert.equal(retryDelayMs(100, 2, { retryAfterHeader: "1" }), 1_000);
  // 2. No header: the server's body retry_after_seconds hint is used.
  assert.equal(
    retryDelayMs(100, 2, {
      body: JSON.stringify({ error: { retry_after_seconds: 4 } }),
    }),
    4_000,
  );
  // 3. Neither: full-jitter exponential, bounded by base * 2**attempt.
  const rng = () => 1; // upper bound of the jitter window
  assert.equal(retryDelayMs(100, 3, {}, rng), 800);
});

test("full-jitter backoff stays within [0, base * 2**attempt] and caps at 60s", () => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const ceiling = Math.min(100 * 2 ** attempt, 60_000);
    for (let i = 0; i < 50; i += 1) {
      const delay = fullJitterBackoffMs(100, attempt);
      assert.ok(delay >= 0 && delay <= ceiling, `delay ${delay} > ${ceiling}`);
    }
  }
  assert.equal(
    fullJitterBackoffMs(100_000, 10, () => 1),
    60_000,
  );
});

test("body verdict: retryable:false is terminal; retry_after_seconds is a hint", () => {
  assert.equal(
    bodyMarksTerminal(JSON.stringify({ error: { retryable: false } })),
    true,
  );
  assert.equal(
    bodyMarksTerminal(JSON.stringify({ error: { retryable: true } })),
    false,
  );
  assert.equal(bodyMarksTerminal("<html>502</html>"), false); // naked LB body
  assert.equal(
    retryAfterFromBodyMs(JSON.stringify({ error: { retry_after_seconds: 3 } })),
    3_000,
  );
  assert.equal(retryAfterFromBodyMs("<html>502</html>"), undefined);
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
