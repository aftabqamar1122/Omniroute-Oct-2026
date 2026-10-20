#!/usr/bin/env node
// scripts/release/bump-version-claims.mjs
//
// Rewrites the prose that asserts which OmniRoute version is CURRENT — the README footer
// ("OmniRoute v3.8.52 ·"), the compatibility floor (`v3.8.52+`), the highlights range
// ("**v3.8.20 → v3.8.52**"), "**Current version:** 3.8.52" in llm.txt — from one version to
// the next, in the root files AND their docs/i18n mirrors, using exactly the claim detector of
// scripts/check/check-docs-counts-sync.mjs (Docs sync strict gate). It exists because the cycle
// bump of /version-bump (Phase 0a.0b of /generate-release) rewrote package*.json, openapi,
// llm.txt and the CHANGELOGs but never the README, so release/v3.8.53 was born red on
// "README.md — stale version … package.json is 3.8.53" (2026-10-19).
//
// Usage:
//   node scripts/release/bump-version-claims.mjs --from 3.8.52 --to 3.8.53 [--files README.md,llm.txt] [--no-state]
//   node scripts/release/bump-version-claims.mjs --check --to 3.8.53 [--files …]      # report only, exit 1 on stale claims
//
// .i18n-state.json: a source whose recorded source_hash still matched the file BEFORE the rewrite
// (i.e. its mirrors were in sync) gets its hashes refreshed — top-level source_hash plus each
// rewritten mirror's source_hash/target_hash — so the mechanical bump does not surface as
// translation drift. A source that was ALREADY drifted is left alone: refreshing it would
// certify stale mirrors as current, which the i18n wave must never inherit. section_hashes are
// never touched (they are the wave's own per-section cache).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SEMVER = String.raw`\d+\.\d+\.\d+`;
const BOLD = "\\*\\*";
const ARROW = "(?:\\u2192|->|\\u2014|\\u2013)";

/** Fresh regexes every call — `g` regexes carry lastIndex state. Order mirrors the gate. */
export function buildClaimPatterns() {
  return [
    // 1. product-named: "OmniRoute v3.8.52"
    new RegExp(`OmniRoute\\s+v?(${SEMVER})`, "g"),
    // 2. explicit label: "**Current version:** 3.8.52"
    new RegExp(`[Cc]urrent\\s+version:?\\s*\\**\\s*v?(${SEMVER})`, "g"),
    // 3. bold range — the TARGET (last endpoint) is the claim
    new RegExp(`${BOLD}\\s*v?${SEMVER}\\s*${ARROW}\\s*v?(${SEMVER})\\s*${BOLD}`, "g"),
    // 4. single bold version
    new RegExp(`${BOLD}\\s*v?(${SEMVER})\\s*${BOLD}`, "g"),
    // 5. heading with a parenthesised/backticked version: "## Key Features (v3.8.52)"
    new RegExp(`^#{1,6}[^\\n]*?[\\(\\\`]\\s*v?(${SEMVER})`, "gm"),
    // 6. inline range target: "v3.8.20 → v3.8.52"
    new RegExp(`v${SEMVER}\\s*${ARROW}\\s*v?(${SEMVER})`, "g"),
    // 7. backticked floor: `v3.8.52+`
    new RegExp("\\`\\s*v?(" + SEMVER + ")\\s*\\+\\s*\\`", "g"),
  ];
}

/** A bold version inside a markdown table row is a column marker, not a current-version claim. */
export function isTableRowAt(content, index) {
  const lineStart = content.lastIndexOf("\n", index - 1) + 1;
  const lineEndRaw = content.indexOf("\n", index);
  const line = content.slice(lineStart, lineEndRaw === -1 ? undefined : lineEndRaw);
  return /^\s*\|/.test(line);
}

/**
 * Pure. Every current-version claim in `content`, with the exact span of the captured
 * version so it can be rewritten in place. Same skip rules as the gate: a match inside a
 * range span is the range's left endpoint unless it is the range pattern itself; a single
 * bold version inside a table row is ignored.
 */
export function findVersionClaims(content) {
  const patterns = buildClaimPatterns();
  const rangeRe = new RegExp(`v?${SEMVER}\\s*${ARROW}\\s*v?${SEMVER}`, "g");
  const rangeSpans = [];
  for (const m of content.matchAll(rangeRe)) {
    rangeSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  const insideRange = (i) => rangeSpans.some(([s, e]) => i >= s && i < e);

  const claims = [];
  patterns.forEach((pattern, p) => {
    const isRangeTarget = p === 2 || p === 5;
    for (const m of content.matchAll(pattern)) {
      const index = m.index ?? 0;
      if (insideRange(index) && !isRangeTarget) continue;
      if (p === 3 && isTableRowAt(content, index)) continue;
      const value = m[1];
      // The captured version is the LAST occurrence inside the match for ranges, the first otherwise.
      const offset = isRangeTarget ? m[0].lastIndexOf(value) : m[0].indexOf(value);
      claims.push({
        value,
        start: index + offset,
        end: index + offset + value.length,
        text: m[0].trim(),
        pattern: p + 1,
      });
    }
  });
  // One claim per span (the same version can be matched by two patterns, e.g. 1 and 4).
  const seen = new Set();
  return claims
    .filter((c) => (seen.has(c.start) ? false : (seen.add(c.start), true)))
    .sort((a, b) => a.start - b.start);
}

/**
 * Pure. Rewrites every claim equal to `from` into `to`. Returns the new content, how many
 * spans changed, and the claims that still do not assert `to` afterwards (other versions).
 */
export function rewriteVersionClaims(content, from, to) {
  const claims = findVersionClaims(content);
  const targets = claims.filter((c) => c.value === from).sort((a, b) => b.start - a.start);
  let out = content;
  for (const c of targets) out = out.slice(0, c.start) + to + out.slice(c.end);
  const remaining = findVersionClaims(out).filter((c) => c.value !== to);
  return { content: out, replaced: targets.length, remaining };
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function parseArgs(argv) {
  const opts = { files: ["README.md", "llm.txt"], check: false, state: true, from: null, to: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") opts.check = true;
    else if (a === "--no-state") opts.state = false;
    else if (a === "--from") opts.from = argv[++i];
    else if (a === "--to") opts.to = argv[++i];
    else if (a === "--files")
      opts.files = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a.startsWith("--from=")) opts.from = a.slice(7);
    else if (a.startsWith("--to=")) opts.to = a.slice(5);
    else if (a.startsWith("--files="))
      opts.files = a
        .slice(8)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  }
  return opts;
}

function mirrorsOf(root, rel) {
  const base = path.join(root, "docs", "i18n");
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ locale: d.name, rel: path.posix.join("docs/i18n", d.name, rel) }))
    .filter((m) => fs.existsSync(path.join(root, m.rel)));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const to = opts.to ?? pkgVersion;
  const semver = new RegExp(`^${SEMVER}$`);
  if (!semver.test(to) || (opts.from !== null && !semver.test(opts.from))) {
    console.error(
      "usage: node scripts/release/bump-version-claims.mjs --from X.Y.Z --to X.Y.Z [--files a,b] [--check] [--no-state]"
    );
    process.exit(2);
  }
  if (!opts.check && !opts.from) {
    console.error(
      "[bump-version-claims] --from <previous version> is required to rewrite (or use --check)"
    );
    process.exit(2);
  }

  let stale = 0;
  let touched = 0;
  const statePath = path.join(ROOT, ".i18n-state.json");
  const state =
    opts.state && fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
  let stateChanged = false;

  for (const rel of opts.files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.log(`[bump-version-claims] ${rel}: not found — skipped`);
      continue;
    }
    const original = fs.readFileSync(abs, "utf8");
    const entry = state?.sources?.[rel];
    const wasInSync = Boolean(entry && entry.source_hash === sha256(Buffer.from(original)));

    if (opts.check) {
      const bad = findVersionClaims(original).filter((c) => c.value !== to);
      stale += bad.length;
      console.log(
        bad.length
          ? `[bump-version-claims] ✗ ${rel}: ${bad.map((c) => `"${c.text}"`).join(", ")} — expected ${to}`
          : `[bump-version-claims] ✓ ${rel}: every version claim says ${to}`
      );
      continue;
    }

    const files = [
      { rel, abs, locale: null },
      ...mirrorsOf(ROOT, rel).map((m) => ({ ...m, abs: path.join(ROOT, m.rel) })),
    ];
    const rewrittenMirrors = [];
    let newSourceHash = null;
    for (const f of files) {
      const before = f.locale === null ? original : fs.readFileSync(f.abs, "utf8");
      const { content, replaced, remaining } = rewriteVersionClaims(before, opts.from, to);
      if (replaced > 0) {
        fs.writeFileSync(f.abs, content);
        touched++;
        if (f.locale === null) newSourceHash = sha256(Buffer.from(content));
        else rewrittenMirrors.push({ locale: f.locale, hash: sha256(Buffer.from(content)) });
      }
      if (f.locale === null) {
        console.log(
          `[bump-version-claims] ${rel}: ${replaced} claim(s) ${opts.from} → ${to}` +
            (remaining.length
              ? ` — still not ${to}: ${remaining.map((c) => `"${c.text}"`).join(", ")}`
              : "")
        );
        stale += remaining.length;
      }
    }
    if (rewrittenMirrors.length) {
      console.log(
        `[bump-version-claims] ${rel}: ${rewrittenMirrors.length} docs/i18n mirror(s) rewritten`
      );
    }

    if (state && entry && newSourceHash) {
      if (wasInSync) {
        entry.source_hash = newSourceHash;
        const now = new Date().toISOString();
        for (const m of rewrittenMirrors) {
          const info = entry.locales?.[m.locale];
          if (!info) continue;
          entry.locales[m.locale] = {
            ...info,
            source_hash: newSourceHash,
            target_hash: m.hash,
            updated_at: now,
          };
        }
        stateChanged = true;
        console.log(
          `[bump-version-claims] ${rel}: .i18n-state.json hashes refreshed (source was in sync; section_hashes untouched)`
        );
      } else {
        console.log(
          `[bump-version-claims] ${rel}: already drifted in .i18n-state.json — state left to the i18n wave`
        );
      }
    }
  }

  if (stateChanged) fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

  if (opts.check) {
    console.log(
      stale ? `[bump-version-claims] ${stale} stale claim(s)` : "[bump-version-claims] OK"
    );
    process.exit(stale ? 1 : 0);
  }
  console.log(
    `[bump-version-claims] done — ${touched} file(s) rewritten${stale ? `, ${stale} claim(s) still stale` : ""}`
  );
  process.exit(stale ? 1 : 0);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  main();
