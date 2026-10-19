// Characterization of recordCompressionCacheStats — the compression cache-stats hook extracted
// from handleChatCore's request-setup compression path (chatCore god-file decomposition, #3501).
// Fire-and-forget; uses a real temp DB and polls compression_cache_stats. Locks: a compressed
// prompt records a cache-stats row with the resolved provider/mode/tokens-saved, and the helper
// returns synchronously without throwing (fail-open).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-comp-cache-test-"));
process.env.DATA_DIR = testDataDir;

const coreDb = await import("../../src/lib/db/core.ts");
const { recordCompressionCacheStats } =
  await import("../../open-sse/handlers/chatCore/compressionCacheStats.ts");

function rowsFor(provider: string): Array<Record<string, unknown>> {
  return coreDb
    .getDbInstance()
    .prepare(
      "SELECT provider, compression_mode AS mode, tokens_saved_compression AS saved, cache_control_present, estimated_cache_hit FROM compression_cache_stats WHERE provider = ?"
    )
    .all(provider) as Array<Record<string, unknown>>;
}

async function waitForRows(provider: string, min: number, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (rowsFor(provider).length >= min) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return rowsFor(provider);
}

before(async () => {
  await coreDb.ensureDbInitialized();
});

after(() => {
  coreDb.resetDbInstance();
  try {
    fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best-effort cleanup
  }
});

test("returns synchronously without throwing (fire-and-forget)", () => {
  assert.doesNotThrow(() =>
    recordCompressionCacheStats({
      compressionInputBody: { messages: [{ role: "user", content: "hi" }] },
      provider: "openai",
      targetFormat: "openai",
      effectiveModel: "gpt-x",
      mode: "balanced",
      stats: { originalTokens: 100, compressedTokens: 60 },
    })
  );
});

test("records a cache-stats row with the resolved provider/mode/tokens-saved", async () => {
  recordCompressionCacheStats({
    compressionInputBody: { messages: [{ role: "user", content: "hello world" }] },
    provider: "ccs-prov",
    targetFormat: "openai",
    effectiveModel: "gpt-ccs",
    mode: "aggressive",
    stats: { originalTokens: 200, compressedTokens: 75 },
  });
  const rows = await waitForRows("ccs-prov", 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mode, "aggressive");
  assert.equal(rows[0].saved, 125);
});

test("clamps negative tokens-saved to 0", async () => {
  recordCompressionCacheStats({
    compressionInputBody: { messages: [] },
    provider: "ccs-neg",
    targetFormat: "openai",
    effectiveModel: "gpt-x",
    mode: "balanced",
    stats: { originalTokens: 50, compressedTokens: 80 },
  });
  const rows = await waitForRows("ccs-neg", 1);
  assert.equal(rows[0].saved, 0);
});

test("records estimated_cache_hit=1 for automatic caching provider without explicit markers", async () => {
  recordCompressionCacheStats({
    compressionInputBody: { messages: [{ role: "user", content: "hello openai" }] },
    provider: "openai",
    targetFormat: "openai",
    effectiveModel: "gpt-4o",
    mode: "balanced",
    stats: { originalTokens: 200, compressedTokens: 100 },
  });
  const rows = await waitForRows("openai", 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cache_control_present, 0);
  assert.equal(rows[0].estimated_cache_hit, 1);
});

test("records estimated_cache_hit=0 for non-caching provider", async () => {
  recordCompressionCacheStats({
    compressionInputBody: { messages: [{ role: "user", content: "hello groq" }] },
    provider: "groq",
    targetFormat: "openai",
    effectiveModel: "llama-3",
    mode: "balanced",
    stats: { originalTokens: 200, compressedTokens: 100 },
  });
  const rows = await waitForRows("groq", 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cache_control_present, 0);
  assert.equal(rows[0].estimated_cache_hit, 0);
});

test("does not estimate a hit for an explicit-cache provider without a marker", async () => {
  recordCompressionCacheStats({
    compressionInputBody: { messages: [{ role: "user", content: "hello anthropic" }] },
    provider: "anthropic-no-marker",
    targetFormat: "claude",
    effectiveModel: "claude-3-5-sonnet",
    mode: "balanced",
    stats: { originalTokens: 200, compressedTokens: 100 },
  });
  const written = await waitForRows("anthropic-no-marker", 1);
  assert.equal(written.length, 1);
  assert.equal(written[0].cache_control_present, 0);
  assert.equal(written[0].estimated_cache_hit, 0);
});

test("records estimated_cache_hit=1 and cache_control_present=1 for explicit caching provider with markers", async () => {
  recordCompressionCacheStats({
    compressionInputBody: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello anthropic",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    },
    provider: "anthropic",
    targetFormat: "claude",
    effectiveModel: "claude-3-5-sonnet",
    mode: "balanced",
    stats: { originalTokens: 200, compressedTokens: 100 },
  });
  const rows = await waitForRows("anthropic", 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cache_control_present, 1);
  assert.equal(rows[0].estimated_cache_hit, 1);
});
