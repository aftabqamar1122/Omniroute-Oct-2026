/**
 * tests/unit/17109-thinking-budget-capped-haiku.test.ts
 *
 * Issue #17109 — "Claude thinking budget can shrink capped Haiku responses to 2,048 tokens"
 *
 * When the caller's max_tokens is at or above the effective model output cap and
 * extended thinking is enabled, `fitThinkingToMaxTokens` computed the correct
 * capped target (e.g. 64000) and then DISCARDED it: the insufficient-thinking-room
 * fallback recomputed `target` from a response room shrunk to MIN_RESPONSE_ROOM,
 * so a Haiku request with max_tokens 128000 + thinking budget 1024 went out as
 * max_tokens 2048 — responses truncated at 2,048 tokens.
 *
 * Contract (from the issue): preserve the already capped total and fit the
 * thinking split inside it — 64000 stays 64000, 1024 reserved for thinking,
 * 62976 left for the response.
 *
 * TDD: the first two assertions FAIL before the fix (they expect 64000; the
 * buggy code returns 2048). The last two pin behaviors the fix must NOT change:
 * sub-floor budgets still disable thinking, and the documented Opus worked
 * example is preserved. See Hard Rule #18.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { fitThinkingToMaxTokens } from "../../open-sse/translator/request/openai-to-claude/thinkingBudget.ts";

// claude-haiku-4.5 (dotted alias) resolves an effective output cap of 64000
// under provider "claude" (src/shared/constants/modelSpecs.ts, #13364).
const HAIKU_MODEL = "claude-haiku-4.5";
const HAIKU_CAP = 64000;

test("#17109: caller max_tokens above the cap keeps the capped total with thinking enabled", () => {
  const result = fitThinkingToMaxTokens(
    HAIKU_MODEL,
    128000,
    { type: "enabled", budget_tokens: 1024 },
    "claude"
  );
  assert.equal(
    result.maxTokens,
    HAIKU_CAP,
    `maxTokens must stay at the model cap (${HAIKU_CAP}), not shrink to budget+MIN_RESPONSE_ROOM`
  );
  assert.equal((result.thinking as { budget_tokens?: number } | undefined)?.budget_tokens, 1024);
  assert.equal(
    result.maxTokens - 1024,
    62976,
    "64,000 total with 1,024 thinking leaves 62,976 for the response"
  );
});

test("#17109: caller max_tokens equal to the cap also keeps the capped total", () => {
  const result = fitThinkingToMaxTokens(
    HAIKU_MODEL,
    HAIKU_CAP,
    { type: "enabled", budget_tokens: 1024 },
    "claude"
  );
  assert.equal(result.maxTokens, HAIKU_CAP);
  assert.equal((result.thinking as { budget_tokens?: number } | undefined)?.budget_tokens, 1024);
});

test("sub-floor thinking budget (< 1024) still disables thinking (behavior preserved)", () => {
  const result = fitThinkingToMaxTokens(
    HAIKU_MODEL,
    128000,
    { type: "enabled", budget_tokens: 512 },
    "claude"
  );
  assert.equal(result.thinking, undefined, "Anthropic requires budget_tokens >= 1024");
  assert.equal(result.maxTokens, HAIKU_CAP);
});

test("documented Opus worked example is preserved (#7926 strategy)", () => {
  // caller 32000 + reasoning_effort=high budget 131072, cap 128000:
  // → max_tokens 128000, budget 96000.
  const result = fitThinkingToMaxTokens(
    "claude-opus-4-7",
    32000,
    { type: "enabled", budget_tokens: 131072 },
    "claude"
  );
  assert.equal(result.maxTokens, 128000);
  assert.equal((result.thinking as { budget_tokens?: number } | undefined)?.budget_tokens, 96000);
});
