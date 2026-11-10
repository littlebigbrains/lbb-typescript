import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bodyMarksTerminal,
  errorCodeFromBody,
  fullJitterBackoffMs,
  parseLbbError,
  parseResponseJson,
  parseRetryAfterMs,
  retryAfterFromBodyMs,
  retryAfterHeaderSeconds,
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

test("retryDelayMs uses the header, then the body hint, as a floor with jitter", () => {
  const low = () => 0;
  const high = () => 1;
  // 1. Retry-After header is the floor; jitter adds up to the same again.
  assert.equal(retryDelayMs(100, 2, { retryAfterHeader: "1" }, low), 1_000);
  assert.equal(retryDelayMs(100, 2, { retryAfterHeader: "1" }, high), 2_000);
  // 2. No header: the body retry_after_seconds hint is used the same way.
  const body = JSON.stringify({ error: { retry_after_seconds: 4 } });
  assert.equal(retryDelayMs(100, 2, { body }, low), 4_000);
  assert.equal(retryDelayMs(100, 2, { body }, high), 8_000);
  // 3. Neither: full-jitter exponential, bounded by base * 2**attempt.
  assert.equal(retryDelayMs(100, 3, {}, high), 800);
});

test("Retry-After jitter spreads clients but never goes below the floor or above the cap", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 200; i += 1) {
    const delay = retryDelayMs(100, 0, { retryAfterHeader: "1" });
    assert.ok(delay >= 1_000 && delay <= 2_000, `delay ${delay}`);
    seen.add(delay);
  }
  assert.ok(seen.size > 100, "delays are spread, not constant");
  assert.equal(
    retryDelayMs(100, 0, { retryAfterHeader: "999" }, () => 1),
    60_000,
  );
  assert.equal(
    retryDelayMs(100, 0, { retryAfterHeader: "0" }, () => 1),
    0,
  );
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

test("an error's retryAfterSeconds is the body hint, else the Retry-After header", () => {
  assert.equal(
    retryAfterHeaderSeconds(
      "Thu, 01 Jan 2026 00:30:00 GMT",
      Date.UTC(2026, 0, 1),
    ),
    1_800,
  );
  assert.equal(retryAfterHeaderSeconds("1800"), 1_800);
  assert.equal(retryAfterHeaderSeconds("soon"), undefined);
  const hinted = parseLbbError(
    429,
    JSON.stringify({ error: { code: "ingest_busy", retry_after_seconds: 2 } }),
    undefined,
    "5",
  );
  assert.equal(hinted.retryAfterSeconds, 2);
  const headerOnly = parseLbbError(
    429,
    JSON.stringify({ error: { code: "ingest_busy" } }),
    "req_1",
    "5",
  );
  assert.equal(headerOnly.retryAfterSeconds, 5);
  assert.equal(headerOnly.requestId, "req_1");
  const integrations = parseLbbError(
    429,
    JSON.stringify({ ok: false, error: "slow down", code: "rate_limited" }),
    undefined,
    "30",
  );
  assert.equal(integrations.code, "rate_limited");
  assert.equal(integrations.message, "slow down");
  assert.equal(integrations.retryAfterSeconds, 30);
  assert.equal(
    errorCodeFromBody(
      JSON.stringify({ ok: false, error: "slow down", code: "rate_limited" }),
    ),
    "rate_limited",
  );
  assert.equal(
    errorCodeFromBody(JSON.stringify({ error: { code: "ingest_busy" } })),
    "ingest_busy",
  );
});
