import test from "node:test";
import assert from "node:assert/strict";

import { logUsage } from "../../open-sse/utils/usageTracking.ts";

// The clock prefix is parsed structurally by src/lib/consoleInterceptor.ts
// (CLOCK_TOKEN_RE = /^\d{2}:\d{2}:\d{2}$/) to strip it from captured log lines.
// getTimeString() builds it with padStart instead of toLocaleTimeString(), so
// pin the exact shape the interceptor and log readers depend on.
test("logUsage prefixes the usage line with a strict HH:MM:SS clock", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    logUsage("openai", { prompt_tokens: 10, completion_tokens: 5 }, "gpt-4", "conn-1234567890");
  } finally {
    console.log = original;
  }

  assert.equal(lines.length, 1, "logUsage must emit exactly one line");
  const match = /^\[(\d{2}:\d{2}:\d{2})\]/.exec(lines[0]);
  assert.ok(match, `usage line must start with a strict clock, got: ${lines[0]}`);
  assert.match(match[1], /^\d{2}:\d{2}:\d{2}$/);

  // Hours are zero-padded, never rendered as "24" or as a locale variant.
  const [hh, mm, ss] = match[1].split(":").map(Number);
  assert.ok(hh >= 0 && hh <= 23, `hour out of range: ${hh}`);
  assert.ok(mm >= 0 && mm <= 59, `minute out of range: ${mm}`);
  assert.ok(ss >= 0 && ss <= 59, `second out of range: ${ss}`);
});
