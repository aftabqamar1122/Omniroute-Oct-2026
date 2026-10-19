/**
 * #3175 — /api/provider-stats serves its payload through the shared analytics
 * response cache and reports the start of the 7-day stats window.
 *
 * Gates:
 *   - "cached": the second call is served from the cache with no SQL prepared
 *   - "bounded": the payload carries `windowSince` (ISO start of the window)
 *   - "orphaned provider": excluded from the response (EXISTS guard)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-provider-stats-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_ANALYTICS_CACHE_TTL_MS = "60000";
process.env.OMNIROUTE_ANALYTICS_CACHE_MIN_COMPUTE_MS = "0";

const core = await import("../../src/lib/db/core.ts");
const cache = await import("../../src/lib/usage/analyticsResponseCache.ts");
const stats = await import("../../src/lib/db/providerStats.ts");
const { GET } = await import("../../src/app/api/provider-stats/route.ts");

let prepareCalls = 0;

interface ProviderStatsBody {
  providers: Array<Record<string, unknown>>;
  windowSince: string;
}

function seed() {
  const db = core.getDbInstance();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO provider_connections (id, provider, created_at, updated_at) VALUES (?, ?, ?, ?)`
  ).run("route-conn", "openai", now, now);
  db.prepare(
    `INSERT INTO call_logs (id, timestamp, provider, model, status, duration, tokens_in, tokens_out)
     VALUES (?, ?, 'openai', 'openai/gpt-4.1', 200, 100, 10, 20),
             (?, ?, 'openai', 'openai/gpt-4.1', 500, 300, 5, 0),
             (?, ?, 'ghost-provider', 'ghost/model', 200, 50, 1, 2)`
  ).run("rlog-1", now, "rlog-2", now, "rlog-3", now);
}

test.before(() => {
  core.resetDbInstance();
  const db = core.getDbInstance();
  const realPrepare = db.prepare.bind(db);
  db.prepare = (...args: unknown[]) => {
    prepareCalls += 1;
    return realPrepare(...(args as []));
  };
  seed();
});

test.beforeEach(() => {
  cache.clearAnalyticsResponseCache();
  prepareCalls = 0;
});

test.after(() => {
  core.resetDbInstance();
  delete process.env.OMNIROUTE_ANALYTICS_CACHE_TTL_MS;
  delete process.env.OMNIROUTE_ANALYTICS_CACHE_MIN_COMPUTE_MS;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function getBody() {
  const res = await GET();
  return { res, body: (await res.json()) as ProviderStatsBody };
}

test("first call computes and bounds the window, orphaned provider excluded", async () => {
  const { res, body } = await getBody();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-analytics-cache"), "miss");

  const providers = body.providers;
  assert.deepEqual(
    providers.map((p) => p.provider),
    ["OpenAI"]
  );
  assert.equal(providers[0].totalRequests, 2);
  assert.equal(providers[0].successfulRequests, 1);
  assert.ok(
    !JSON.stringify(body).includes("ghost-provider"),
    "orphaned provider must not appear in the payload"
  );

  assert.ok(typeof body.windowSince === "string", "windowSince is in the payload");
  assert.match(body.windowSince, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const start = new Date(body.windowSince).getTime();
  const expected = Date.now() - 7 * 24 * 60 * 60 * 1000;
  assert.ok(
    Math.abs(start - expected) < 5 * 60 * 1000,
    `windowSince ${body.windowSince} is ~7 days before now`
  );
});

test("second call is served from the cache with no SQL prepared", async () => {
  await GET();
  assert.equal(prepareCalls > 0, true, "first call prepared statements");
  const firstCalls = prepareCalls;

  const { res, body } = await getBody();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-analytics-cache"), "hit");
  assert.equal(prepareCalls, firstCalls, "no SQL prepared on the cached call");
  assert.ok(typeof body.windowSince === "string", "cached payload keeps windowSince");
  assert.equal(body.providers.length, 1);
});

test("the helper derives the window start from an explicit now", () => {
  const now = new Date("2026-10-19T00:00:00.000Z");
  const since = stats.buildProviderStatsSince(now);
  assert.equal(since, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString());
});
