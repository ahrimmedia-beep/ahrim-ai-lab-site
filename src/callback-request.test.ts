// Run with `npm test` (node:test, no extra framework: Node strips the types itself).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CALLBACK_COOLDOWN_MS,
  DEFAULT_SOURCE,
  WEBHOOK_TIMEOUT_MS,
  callbackRequestSchema,
  createCooldownLimiter,
  isHoneypotFilled,
  triggerCallback,
} from "./callback-request.ts";

// Placeholder values only: a fictional 555 number, an example.test host and
// documentation IPs from 203.0.113.0/24 (RFC 5737).
const PHONE = "+1 555 010 0199";
const WEBHOOK_URL = "https://hooks.example.test/callback";

// --- Validation --------------------------------------------------------------------

test("a phone number alone is a valid request", () => {
  const parsed = callbackRequestSchema.safeParse({ phone: PHONE });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data, { phone: PHONE });
});

test("source and the honeypot field are optional strings", () => {
  const parsed = callbackRequestSchema.safeParse({ phone: PHONE, source: "outbound", website: "" });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data, { phone: PHONE, source: "outbound", website: "" });
});

test("the phone must be 7 to 20 characters", () => {
  assert.equal(callbackRequestSchema.safeParse({ phone: "123456" }).success, false);
  assert.equal(callbackRequestSchema.safeParse({ phone: "1234567" }).success, true);
  assert.equal(callbackRequestSchema.safeParse({ phone: "1".repeat(20) }).success, true);
  assert.equal(callbackRequestSchema.safeParse({ phone: "1".repeat(21) }).success, false);
});

test("a missing or non-string phone is rejected", () => {
  for (const phone of [undefined, null, 15550100199, ["+15550100199"], {}]) {
    assert.equal(callbackRequestSchema.safeParse({ phone }).success, false, JSON.stringify(phone));
  }
});

test("oversized source or honeypot values are rejected", () => {
  assert.equal(callbackRequestSchema.safeParse({ phone: PHONE, source: "x".repeat(51) }).success, false);
  assert.equal(callbackRequestSchema.safeParse({ phone: PHONE, website: "x".repeat(201) }).success, false);
});

test("a non-object body is rejected", () => {
  for (const body of [PHONE, 42, null, [], undefined]) {
    assert.equal(callbackRequestSchema.safeParse(body).success, false);
  }
});

test("unknown keys are stripped, so nothing extra reaches n8n", () => {
  const parsed = callbackRequestSchema.safeParse({ phone: PHONE, callerId: "spoofed", script: "x" });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data, { phone: PHONE });
});

test("the outbound agent calls back by default", () => {
  assert.equal(DEFAULT_SOURCE, "outbound");
});

// --- Honeypot ----------------------------------------------------------------------

test("an empty or absent honeypot means a person", () => {
  assert.equal(isHoneypotFilled({ phone: PHONE }), false);
  assert.equal(isHoneypotFilled({ phone: PHONE, website: "" }), false);
});

test("a filled honeypot means a bot", () => {
  assert.equal(isHoneypotFilled({ phone: PHONE, website: "https://spam.example" }), true);
  assert.equal(isHoneypotFilled({ phone: PHONE, website: " " }), true);
});

// --- Cooldown ----------------------------------------------------------------------

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

test("one request per IP per minute", () => {
  const clock = fakeClock();
  const limiter = createCooldownLimiter({ now: clock.now });
  assert.equal(limiter.tryAcquire("203.0.113.5"), true);
  assert.equal(limiter.tryAcquire("203.0.113.5"), false);
  clock.advance(CALLBACK_COOLDOWN_MS - 1);
  assert.equal(limiter.tryAcquire("203.0.113.5"), false);
  clock.advance(1);
  assert.equal(limiter.tryAcquire("203.0.113.5"), true);
});

test("different IPs do not share a cooldown", () => {
  const limiter = createCooldownLimiter({ now: fakeClock().now });
  assert.equal(limiter.tryAcquire("203.0.113.5"), true);
  assert.equal(limiter.tryAcquire("203.0.113.6"), true);
  assert.equal(limiter.tryAcquire("203.0.113.5"), false);
});

test("a refused retry does not push the window further", () => {
  const clock = fakeClock();
  const limiter = createCooldownLimiter({ now: clock.now });
  limiter.tryAcquire("ip");
  clock.advance(30_000);
  assert.equal(limiter.tryAcquire("ip"), false);
  clock.advance(30_000);
  assert.equal(limiter.tryAcquire("ip"), true);
});

test("a time of 0 is still a recorded call", () => {
  const limiter = createCooldownLimiter({ now: () => 0 });
  assert.equal(limiter.tryAcquire("ip"), true);
  assert.equal(limiter.tryAcquire("ip"), false);
});

test("expired entries are swept once the map grows past its cap", () => {
  const clock = fakeClock();
  const limiter = createCooldownLimiter({ now: clock.now, maxKeys: 3 });
  for (const ip of ["a", "b", "c"]) limiter.tryAcquire(ip);
  clock.advance(CALLBACK_COOLDOWN_MS + 1);
  limiter.tryAcquire("fresh-1");
  limiter.tryAcquire("fresh-2");
  limiter.tryAcquire("fresh-3");
  // The sweep ran when the 4th key arrived: a, b and c were expired and dropped.
  assert.equal(limiter.size, 3);
  assert.equal(limiter.tryAcquire("fresh-1"), false, "fresh entries survive the sweep");
});

test("no sweep while the map is under its cap", () => {
  const clock = fakeClock();
  const limiter = createCooldownLimiter({ now: clock.now, maxKeys: 10 });
  for (const ip of ["a", "b", "c"]) limiter.tryAcquire(ip);
  clock.advance(CALLBACK_COOLDOWN_MS * 10);
  limiter.tryAcquire("d");
  assert.equal(limiter.size, 4);
});

// --- n8n webhook -------------------------------------------------------------------

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("without a webhook URL the callback is off and nothing is sent", async () => {
  const { calls, fetchImpl } = fakeFetch(() => new Response(null, { status: 200 }));
  assert.equal(await triggerCallback(PHONE, "outbound", { url: undefined, fetchImpl }), false);
  assert.equal(await triggerCallback(PHONE, "outbound", { url: "", fetchImpl }), false);
  assert.equal(calls.length, 0);
});

test("the webhook gets the phone, the source and a timestamp as JSON", async () => {
  const { calls, fetchImpl } = fakeFetch(() => new Response(null, { status: 200 }));
  const ok = await triggerCallback(PHONE, "outbound", { url: WEBHOOK_URL, fetchImpl, now: () => 1234 });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, WEBHOOK_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { phone: PHONE, source: "outbound", ts: 1234 });
  assert.deepEqual(calls[0].init.headers, { "Content-Type": "application/json" });
});

test("the bearer token is added only when it is configured", async () => {
  const { calls, fetchImpl } = fakeFetch(() => new Response(null, { status: 200 }));
  await triggerCallback(PHONE, "outbound", { url: WEBHOOK_URL, token: "test-token", fetchImpl });
  await triggerCallback(PHONE, "outbound", { url: WEBHOOK_URL, token: "", fetchImpl });
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer test-token");
  assert.equal("Authorization" in (calls[1].init.headers as Record<string, string>), false);
});

test("the request carries a timeout signal", async () => {
  const { calls, fetchImpl } = fakeFetch(() => new Response(null, { status: 200 }));
  await triggerCallback(PHONE, "outbound", { url: WEBHOOK_URL, fetchImpl });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.signal.aborted, false);
  assert.ok(WEBHOOK_TIMEOUT_MS <= 10_000, "the form should not hang on a slow n8n");
});

test("an error status from n8n reports false", async () => {
  for (const status of [401, 404, 500, 503]) {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status }));
    assert.equal(await triggerCallback(PHONE, "outbound", { url: WEBHOOK_URL, fetchImpl }), false, String(status));
  }
});

test("a network error or timeout reports false instead of throwing", async () => {
  for (const error of [new TypeError("fetch failed"), new DOMException("timed out", "TimeoutError")]) {
    const { fetchImpl } = fakeFetch(() => {
      throw error;
    });
    assert.equal(await triggerCallback(PHONE, "outbound", { url: WEBHOOK_URL, fetchImpl }), false);
  }
});
