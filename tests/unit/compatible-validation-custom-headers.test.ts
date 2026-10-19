/**
 * Compatible-node connection tests (OpenAI and Anthropic format) must send the connection's customHeaders, as the
 * chat path and the Anthropic-compatible probe (#8369) already do. A gateway behind an
 * access proxy (e.g. Cloudflare Access) otherwise answers 403 and the credential health
 * check flags a working key as "Invalid API key".
 */
import test from "node:test";
import assert from "node:assert/strict";

const { validateOpenAICompatibleProvider } =
  await import("../../src/lib/providers/validation/openaiFormat.ts");
const { validateAnthropicCompatibleProvider } =
  await import("../../src/lib/providers/validation/anthropicFormat.ts");

const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

const GATE = { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "secret" };

function gatedUpstream(seen: Array<{ url: string; headers: Headers }>) {
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    seen.push({ url: String(url), headers });
    const allowed =
      headers.get("CF-Access-Client-Id") === GATE["CF-Access-Client-Id"] &&
      headers.get("CF-Access-Client-Secret") === GATE["CF-Access-Client-Secret"];
    if (!allowed) return new Response("Forbidden", { status: 403 });
    if (String(url).endsWith("/models")) {
      return Response.json({ data: [{ id: "m" }] });
    }
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  }) as typeof fetch;
}

test("models probe sends the connection's customHeaders", async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  gatedUpstream(seen);
  const result = await validateOpenAICompatibleProvider({
    apiKey: "sk-test",
    providerSpecificData: { baseUrl: "https://gw.example.com/v1", customHeaders: GATE },
  });
  assert.equal(result.valid, true, String(result.error));
  assert.equal(seen[0].headers.get("Authorization"), "Bearer sk-test");
});

test("chat fallback probe sends the connection's customHeaders", async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    seen.push({ url: String(url), headers });
    if (String(url).endsWith("/models")) throw new Error("connection reset");
    const allowed = headers.get("CF-Access-Client-Id") === GATE["CF-Access-Client-Id"];
    return allowed
      ? Response.json({ choices: [{ message: { content: "ok" } }] })
      : new Response("Forbidden", { status: 403 });
  }) as typeof fetch;
  const result = await validateOpenAICompatibleProvider({
    apiKey: "sk-test",
    providerSpecificData: {
      baseUrl: "https://gw.example.com/v1",
      customHeaders: GATE,
      validationModelId: "m",
    },
  });
  assert.equal(result.valid, true, String(result.error));
  assert.ok(seen.some((c) => c.url.endsWith("/chat/completions")));
});

test("anthropic-compatible messages probe sends the connection's customHeaders", async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    seen.push({ url: String(url), headers });
    if (headers.get("CF-Access-Client-Id") !== GATE["CF-Access-Client-Id"]) {
      return new Response("Forbidden", { status: 403 });
    }
    if (String(url).endsWith("/models")) return new Response("not found", { status: 404 });
    return Response.json({ type: "message", content: [{ type: "text", text: "ok" }] });
  }) as typeof fetch;
  const result = await validateAnthropicCompatibleProvider({
    apiKey: "sk-test",
    providerSpecificData: { baseUrl: "https://gw.example.com/v1", customHeaders: GATE },
  });
  assert.equal(result.valid, true, String(result.error));
  const post = seen.find((c) => c.url.endsWith("/messages"));
  assert.ok(post, "messages probe ran");
  assert.equal(post.headers.get("x-api-key"), "sk-test");
});

test("customHeaders never replace the probe's Authorization header", async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  gatedUpstream(seen);
  await validateOpenAICompatibleProvider({
    apiKey: "sk-test",
    providerSpecificData: {
      baseUrl: "https://gw.example.com/v1",
      customHeaders: { ...GATE, Authorization: "Bearer other" },
    },
  });
  assert.equal(seen[0].headers.get("Authorization"), "Bearer sk-test");
});
