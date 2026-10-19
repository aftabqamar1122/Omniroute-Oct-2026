/**
 * xAI /v1/responses rejects the whole request on unknown tool types:
 *   422 tools[7].type: unknown variant `namespace`, expected one of `function`, ...
 * Codex CLI sends its MCP servers as `namespace` groups, so the executor must flatten
 * them, and the 422 must not cool down the (often single) xAI account.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { XaiExecutor, normalizeXaiResponsesTools } = await import("../../open-sse/executors/xai.ts");
const { isRequestShapeRejection } = await import("../../src/sse/handlers/chatPredicates.ts");

const codexLikeTools = [
  { type: "function", name: "shell", description: "run", parameters: { type: "object" } },
  { type: "web_search" },
  {
    type: "namespace",
    name: "mcp__atlassian__",
    description: "Atlassian",
    tools: [
      { type: "function", name: "getIssue", description: "get", parameters: { type: "object" } },
      { name: "search", parameters: { type: "object" } },
    ],
  },
  { type: "custom", name: "apply_patch", description: "patch", format: { type: "grammar" } },
  { type: "local_shell" },
  { type: "function", function: { name: "nested", parameters: { type: "object" } } },
];

test("normalizeXaiResponsesTools flattens namespace groups and drops unknown types", () => {
  const out = normalizeXaiResponsesTools(codexLikeTools) as Array<Record<string, unknown>>;
  const types = out.map((t) => t.type);
  assert.ok(
    types.every((t) => t === "function" || t === "web_search"),
    String(types)
  );
  const names = out.filter((t) => t.type === "function").map((t) => t.name);
  assert.deepEqual(names, [
    "shell",
    "mcp__atlassian__getIssue",
    "mcp__atlassian__search",
    "apply_patch",
    "nested",
  ]);
  const patch = out.find((t) => t.name === "apply_patch") as Record<string, unknown>;
  assert.deepEqual((patch.parameters as Record<string, unknown>).required, ["input"]);
  const nested = out.find((t) => t.name === "nested") as Record<string, unknown>;
  assert.equal(nested.function, undefined);
});

test("XaiExecutor native passthrough never ships a namespace tool to xAI", () => {
  const executor = new XaiExecutor("xai-oauth");
  const out = executor.transformRequest(
    "grok-4.6",
    {
      model: "grok-4.6",
      input: "hi",
      tools: codexLikeTools,
      _nativeXaiResponsesPassthrough: true,
    },
    true,
    {} as never
  ) as Record<string, unknown>;
  const tools = out.tools as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(tools));
  assert.ok(!tools.some((t) => t.type === "namespace" || t.type === "custom"));
  assert.ok(tools.some((t) => t.name === "mcp__atlassian__getIssue"));
});

test("isRequestShapeRejection recognises xAI body-deserialization 422s only", () => {
  assert.equal(
    isRequestShapeRejection({
      status: 422,
      error:
        "[422]: Failed to deserialize the JSON body into the target type: tools[7].type: unknown variant `namespace`",
    }),
    true
  );
  assert.equal(isRequestShapeRejection({ status: 429, error: "Failed to deserialize" }), false);
  assert.equal(isRequestShapeRejection({ status: 422, error: "quota exhausted" }), false);
});

test("web_search loses OpenAI-only args xAI rejects (external_web_access)", async () => {
  const out = normalizeXaiResponsesTools([
    { type: "web_search", external_web_access: true, filters: { allowed_domains: ["a.com"] } },
  ]) as Array<Record<string, unknown>>;
  assert.deepEqual(out, [{ type: "web_search", allowed_domains: ["a.com"] }]);
});

test("normalizeXaiResponsesInput maps Chat `text` parts to Responses part types", async () => {
  const { normalizeXaiResponsesInput } = await import("../../open-sse/executors/xai.ts");
  const out = normalizeXaiResponsesInput([
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { type: "message", role: "assistant", content: [{ type: "text", text: "yo" }] },
    { type: "function_call_output", call_id: "c", output: "x" },
  ]) as Array<Record<string, unknown>>;
  assert.equal((out[0].content as any)[0].type, "input_text");
  assert.equal((out[1].content as any)[0].type, "output_text");
  assert.deepEqual(out[2], { type: "function_call_output", call_id: "c", output: "x" });
});

test("isRequestShapeError: 400 unsupported argument / 422 schema → no cooldown", async () => {
  const { isRequestShapeError } = await import("../../src/sse/services/auth.ts");
  assert.equal(
    isRequestShapeError(400, "[400]: Argument not supported: external_web_access"),
    true
  );
  assert.equal(isRequestShapeError(422, 'content[0]: unknown content type "text"'), true);
  assert.equal(isRequestShapeError(401, "Argument not supported"), false);
  assert.equal(isRequestShapeError(400, "invalid api key"), false);
  assert.equal(isRequestShapeRejection({ status: 400, error: "Argument not supported: x" }), true);
});

test("XaiExecutor drops tool_choice when the Responses body ends up with no tools", () => {
  const executor = new XaiExecutor("xai-oauth");
  const out = executor.transformRequest(
    "grok-4.6",
    {
      model: "grok-4.6",
      input: "title please",
      tool_choice: "auto",
      parallel_tool_calls: true,
      _nativeXaiResponsesPassthrough: true,
    },
    true,
    {} as never
  ) as Record<string, unknown>;
  assert.equal(out.tool_choice, undefined);
  assert.equal(out.parallel_tool_calls, undefined);
  const kept = executor.transformRequest(
    "grok-4.6",
    {
      model: "grok-4.6",
      input: "x",
      tools: [{ type: "function", name: "f" }],
      tool_choice: "auto",
      _nativeXaiResponsesPassthrough: true,
    },
    true,
    {} as never
  ) as Record<string, unknown>;
  assert.equal(kept.tool_choice, "auto");
});

test("xAI 400/422 never cool down the account; other providers need a shape message", async () => {
  const { isRequestShapeError } = await import("../../src/sse/services/auth.ts");
  assert.equal(
    isRequestShapeError(400, "Invalid request content: A tool_choice was set", "xai-oauth"),
    true
  );
  assert.equal(isRequestShapeError(400, "anything", "xai"), true);
  assert.equal(isRequestShapeError(429, "anything", "xai-oauth"), false);
  assert.equal(isRequestShapeError(400, "API key not valid", "gemini"), false);
  assert.equal(isRequestShapeRejection({ status: 400, error: "whatever" }, "xai-oauth"), true);
  assert.equal(isRequestShapeRejection({ status: 400, error: "whatever" }, "gemini"), false);
});
