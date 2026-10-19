import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-embeddings-gemini-dim-"));

const { handleEmbedding } = await import("../../open-sse/handlers/embeddings.ts");

// Gemini embedding models can return 3072 dimensions by default. OpenAI-compatible
// clients may request a smaller embedding (e.g. 1536 for pgvector schemas) via the
// `dimensions` field. Google's OpenAI-compatible endpoint honors `dimensions` directly
// and rejects the camelCase `outputDimensionality` with HTTP 400 ("Unknown name"),
// while the Gemini native transport maps `dimensions` to snake_case `output_dimensionality`
// on its own. OmniRoute must therefore forward `dimensions` untouched and must NOT
// inject `outputDimensionality` into the OpenAI-compatible upstream body (#17158).

function captureFetch(captured: { body?: Record<string, unknown> }) {
  return async (_url: unknown, options: { headers?: unknown; body?: unknown } = {}) => {
    captured.body = JSON.parse(String(options.body || "{}"));
    return new Response(
      JSON.stringify({
        data: [{ object: "embedding", embedding: new Array(1536).fill(0.1), index: 0 }],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
}

test("handleEmbedding forwards Gemini dimensions untouched without outputDimensionality (single input)", async () => {
  const originalFetch = globalThis.fetch;
  const captured: { body?: Record<string, unknown> } = {};
  globalThis.fetch = captureFetch(captured) as typeof fetch;

  try {
    const result = await handleEmbedding({
      body: {
        model: "gemini/text-embedding-004",
        input: "test",
        dimensions: 1536,
      },
      credentials: { apiKey: "gemini-key" },
      log: null,
    });

    assert.equal(result.success, true);
    // OpenAI-style `dimensions` must still be forwarded.
    assert.equal(captured.body?.dimensions, 1536);
    // Google's OpenAI-compatible endpoint rejects `outputDimensionality` (400 Unknown name).
    // It must not be injected.
    assert.equal(
      "outputDimensionality" in (captured.body || {}),
      false,
      "outputDimensionality must not be injected for Gemini OpenAI-compatible embeddings"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleEmbedding forwards Gemini dimensions untouched without outputDimensionality (batch input)", async () => {
  const originalFetch = globalThis.fetch;
  const captured: { body?: Record<string, unknown> } = {};
  globalThis.fetch = captureFetch(captured) as typeof fetch;

  try {
    const result = await handleEmbedding({
      body: {
        model: "gemini/text-embedding-004",
        input: ["hello", "world"],
        dimensions: 1536,
      },
      credentials: { apiKey: "gemini-key" },
      log: null,
    });

    assert.equal(result.success, true);
    assert.equal(captured.body?.dimensions, 1536);
    assert.equal(
      "outputDimensionality" in (captured.body || {}),
      false,
      "outputDimensionality must not be injected for Gemini batch embeddings"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleEmbedding does not inject outputDimensionality when dimensions is omitted (Gemini)", async () => {
  const originalFetch = globalThis.fetch;
  const captured: { body?: Record<string, unknown> } = {};
  globalThis.fetch = captureFetch(captured) as typeof fetch;

  try {
    const result = await handleEmbedding({
      body: {
        model: "gemini/text-embedding-004",
        input: "test",
      },
      credentials: { apiKey: "gemini-key" },
      log: null,
    });

    assert.equal(result.success, true);
    assert.equal(
      "outputDimensionality" in (captured.body || {}),
      false,
      "outputDimensionality must not be injected when the client did not request a specific size"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleEmbedding does not inject outputDimensionality for non-Gemini providers", async () => {
  const originalFetch = globalThis.fetch;
  const captured: { body?: Record<string, unknown> } = {};
  globalThis.fetch = captureFetch(captured) as typeof fetch;

  try {
    const result = await handleEmbedding({
      body: {
        model: "openai/text-embedding-3-small",
        input: "test",
        dimensions: 1536,
      },
      credentials: { apiKey: "openai-key" },
      log: null,
    });

    assert.equal(result.success, true);
    // OpenAI gets the standard `dimensions` field — not `outputDimensionality`.
    assert.equal(captured.body?.dimensions, 1536);
    assert.equal(
      "outputDimensionality" in (captured.body || {}),
      false,
      "outputDimensionality is Gemini-specific and must not leak into other providers"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleEmbedding ignores non-finite/non-positive dimensions for Gemini", async () => {
  const originalFetch = globalThis.fetch;
  const captured: { body?: Record<string, unknown> } = {};
  globalThis.fetch = captureFetch(captured) as typeof fetch;

  try {
    const result = await handleEmbedding({
      body: {
        model: "gemini/text-embedding-004",
        input: "test",
        dimensions: 0,
      },
      credentials: { apiKey: "gemini-key" },
      log: null,
    });

    assert.equal(result.success, true);
    assert.equal(
      "outputDimensionality" in (captured.body || {}),
      false,
      "0/NaN/negative dimensions must not map to outputDimensionality"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
