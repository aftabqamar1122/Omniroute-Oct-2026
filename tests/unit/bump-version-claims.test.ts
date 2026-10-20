import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findVersionClaims,
  isTableRowAt,
  rewriteVersionClaims,
} from "../../scripts/release/bump-version-claims.mjs";

// The cycle bump (Phase 0a.0b) left release/v3.8.53's README asserting 3.8.52 in three places
// (2026-10-19); these are the exact shapes the Docs sync strict gate flagged.
const README = [
  "| Channel | v3.8.50 | **v3.8.51** | `v3.8.52+` |",
  "",
  "> Recent highlights from **v3.8.20 → v3.8.52**. Full history in [`CHANGELOG.md`](CHANGELOG.md).",
  "",
  "## Key Features (v3.8.52)",
  "",
  "Pinned dependency lru-cache 11.1.0 and better-sqlite3 12.4.1 stay as they are.",
  "Branch names such as release/v3.8.52 are not claims either.",
  "",
  "<sub>OmniRoute v3.8.52 · Node ≥22.22.2 · MIT License</sub>",
  "",
  "**Current version:** 3.8.52",
  "",
  "Upgrade path v3.8.51 -> v3.8.52 is documented below.",
].join("\n");

test("findVersionClaims mirrors the gate: one claim per current-version assertion", () => {
  const claims = findVersionClaims(README);
  assert.deepEqual(
    claims.map((c) => c.text),
    [
      "`v3.8.52+`",
      "**v3.8.20 → v3.8.52**",
      "## Key Features (v3.8.52",
      "OmniRoute v3.8.52",
      "Current version:** 3.8.52", // the gate's pattern starts at the label, after the opening `**`
      "v3.8.51 -> v3.8.52",
    ]
  );
  // every claim is the TARGET version, never a range's left endpoint or a dependency pin
  assert.ok(claims.every((c) => c.value === "3.8.52"));
});

test("a bold version inside a table row is a column marker, not a claim", () => {
  const row = "| x | **v3.8.51** | `v3.8.52+` |";
  assert.equal(isTableRowAt(row, row.indexOf("**v3.8.51**")), true);
  assert.deepEqual(
    findVersionClaims(row).map((c) => c.text),
    ["`v3.8.52+`"]
  );
  assert.deepEqual(
    findVersionClaims("Shipped in **v3.8.51** last week.").map((c) => c.value),
    ["3.8.51"]
  );
});

test("rewriteVersionClaims moves every claim to the new version and nothing else", () => {
  const { content, replaced, remaining } = rewriteVersionClaims(README, "3.8.52", "3.8.53");
  assert.equal(replaced, 6);
  assert.deepEqual(remaining, []);
  assert.match(content, /`v3\.8\.53\+`/);
  assert.match(content, /\*\*v3\.8\.20 → v3\.8\.53\*\*/);
  assert.match(content, /## Key Features \(v3\.8\.53\)/);
  assert.match(content, /OmniRoute v3\.8\.53 · Node/);
  assert.match(content, /\*\*Current version:\*\* 3\.8\.53/);
  assert.match(content, /v3\.8\.51 -> v3\.8\.53/);
  // untouched: the table's bold marker, the range's left endpoint, dependency pins, branch names
  assert.match(content, /\*\*v3\.8\.51\*\*/);
  assert.match(content, /lru-cache 11\.1\.0 and better-sqlite3 12\.4\.1/);
  assert.match(content, /release\/v3\.8\.52/);
  assert.equal((content.match(/3\.8\.52/g) ?? []).length, 1); // only the branch name survives
});

test("rewriteVersionClaims reports claims that assert a third version instead of silently passing", () => {
  const { replaced, remaining } = rewriteVersionClaims(
    "OmniRoute v3.8.52 · **Current version:** 3.8.40",
    "3.8.52",
    "3.8.53"
  );
  assert.equal(replaced, 1);
  assert.deepEqual(
    remaining.map((c) => c.value),
    ["3.8.40"]
  );
});

test("rewriteVersionClaims is idempotent", () => {
  const once = rewriteVersionClaims(README, "3.8.52", "3.8.53").content;
  const twice = rewriteVersionClaims(once, "3.8.52", "3.8.53");
  assert.equal(twice.replaced, 0);
  assert.equal(twice.content, once);
});
