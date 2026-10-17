/**
 * Mihomo renderer: merges the generation model into owned sections only.
 *
 * Owned = any `proxies` / `proxy-groups` / `listeners` entry whose name
 * starts with the shared owned-tag prefix. Owned entries are removed then
 * replaced; everything else (dns, log, user proxies, user groups, unknown
 * keys) is kept verbatim, key order included. An adopted file without a
 * `proxies`, `proxy-groups` or `listeners` array is refused
 * (`no_ownable_section`), never rewritten.
 *
 * Every rendered node goes through the canonical form (`normalizeSource`,
 * same as the sing-box renderer): nodes that are neither sing-box-shaped
 * nor translatable are listed with a reason — `converter_unsupported` for a
 * supported scheme that cannot translate whole, `source_not_singbox_shape`
 * for anything else. Never guesses: a field outside the supported set
 * rejects the whole node. No verbatim passthrough of sing-box payloads: a
 * sing-box-shaped source renders only through its canonical projection.
 */
import {
  OWNED_TAG_PREFIX,
  normalizeSource,
  type CanonicalNode,
  type CoreListener,
  type CoreModel,
  type NormalizeFail,
} from "./model";
import { createHash } from "node:crypto";
import * as yaml from "js-yaml";
import type { RenderRefused, RenderResult } from "./renderers";

/** Canonical type to Mihomo proxy type (`shadowsocks` is `ss` on the wire). */
const MIHOMO_TYPE_BY_CANONICAL: Record<string, string> = {
  vless: "vless",
  trojan: "trojan",
  shadowsocks: "ss",
  vmess: "vmess",
  hysteria2: "hysteria2",
};

function isOwnedName(name: unknown): boolean {
  return typeof name === "string" && name.startsWith(OWNED_TAG_PREFIX);
}

function withoutOwned<T>(items: T[], nameOf: (item: T) => unknown): T[] {
  return items.filter((item) => !isOwnedName(nameOf(item)));
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function parseBase(existingText: string | null): Record<string, unknown> | RenderResult {
  if (existingText === null) return { proxies: [], "proxy-groups": [], listeners: [] };
  let parsed: unknown;
  try {
    parsed = yaml.load(existingText);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  // A bare scalar document (`not json`, `123`) is not a config object; an
  // empty document loads as undefined, same as a null root.
  if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
    return { ok: false, reason: "unparseable" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not_an_object" };
  }
  const base = parsed as Record<string, unknown>;
  if (
    !Array.isArray(base.proxies) &&
    !Array.isArray(base["proxy-groups"]) &&
    !Array.isArray(base.listeners)
  ) {
    return { ok: false, reason: "no_ownable_section" };
  }
  return base;
}

function renderedTagSet(model: CoreModel): Set<string> {
  const tags = new Set<string>();
  for (const node of model.nodes) {
    if (normalizeSource(node.source).ok) tags.add(node.tag);
  }
  return tags;
}

function securityFields(node: CanonicalNode): Record<string, unknown> {
  const security = node.security;
  if (security.kind === "none") return {};
  const fields: Record<string, unknown> = {
    tls: true,
    servername: security.serverName ?? node.server,
  };
  if (security.insecure) fields["skip-cert-verify"] = true;
  fields["client-fingerprint"] = security.fingerprint ?? "chrome";
  if (security.kind === "reality") {
    fields["reality-opts"] = {
      "public-key": security.publicKey ?? "",
      "short-id": security.shortId ?? "",
    };
  }
  return fields;
}

function transportFields(node: CanonicalNode): Record<string, unknown> {
  if (node.transport.kind === "ws") {
    return {
      network: "ws",
      "ws-opts": {
        path: node.transport.path ?? "/",
        ...(node.transport.host ? { headers: { Host: node.transport.host } } : {}),
      },
    };
  }
  if (node.transport.kind === "grpc") {
    return { network: "grpc", "grpc-opts": { "grpc-service-name": node.transport.service ?? "" } };
  }
  return {};
}

function credentialFields(node: CanonicalNode): Record<string, unknown> {
  if (node.credentials.kind === "uuid") return { uuid: node.credentials.secret };
  if (node.credentials.kind === "password") return { password: node.credentials.secret };
  return { cipher: node.credentials.method, password: node.credentials.secret };
}

/** Project one canonical node to a Mihomo proxy (name added by the caller). */
export function projectCanonicalMihomo(node: CanonicalNode): Record<string, unknown> {
  const proxy: Record<string, unknown> = {
    type: MIHOMO_TYPE_BY_CANONICAL[node.type] ?? node.type,
    server: node.server,
    port: node.serverPort,
    ...credentialFields(node),
  };
  if (node.flow) proxy.flow = node.flow;
  Object.assign(proxy, securityFields(node), transportFields(node));
  return proxy;
}

function listenerFor(listener: CoreListener): Record<string, unknown> {
  return {
    name: listener.tag,
    type: listener.scheme === "socks5" ? "socks" : "http",
    listen: listener.host,
    port: listener.port,
  };
}

function proxyEntries(
  model: CoreModel,
  renderedTags: Set<string>,
  keptProxies: Array<Record<string, unknown>>
): string[] {
  const emittedGroups = model.groups.filter((g) => g.members.some((m) => renderedTags.has(m)));
  const emittedTags = new Set(emittedGroups.map((g) => g.tag));
  for (const node of model.nodes) {
    if (!renderedTags.has(node.tag)) continue;
    const normalized = normalizeSource(node.source);
    if (!normalized.ok) continue;
    keptProxies.push({
      ...projectCanonicalMihomo(normalized.node),
      name: `${OWNED_TAG_PREFIX}${node.tag}`,
    });
  }
  return [...emittedTags];
}

function isRefused(value: Record<string, unknown> | RenderResult): value is RenderRefused {
  return "ok" in value && value.ok === false;
}

function collectSkips(
  model: CoreModel,
  renderedTags: Set<string>
): Array<{ node: string; reason: string; detail?: string }> {
  const skipped: Array<{ node: string; reason: string; detail?: string }> = [];
  for (const node of model.nodes) {
    if (renderedTags.has(node.tag)) continue;
    const verdict = normalizeSource(node.source);
    if (verdict.ok) continue;
    const failed = verdict as NormalizeFail;
    skipped.push({
      node: node.tag,
      reason: failed.reason,
      ...(failed.detail ? { detail: failed.detail } : {}),
    });
  }
  return skipped;
}

/**
 * Count-once journal for proven decorative params set aside during the
 * render: rendered nodes are not skipped, so without this line the `dropped`
 * audit would live in the normalizer result only. One line per render, never
 * per node.
 */
function logDroppedParams(model: CoreModel, renderedTags: Set<string>): void {
  const counts = new Map<string, number>();
  for (const node of model.nodes) {
    if (!renderedTags.has(node.tag)) continue;
    const verdict = normalizeSource(node.source);
    if (verdict.ok && verdict.dropped.length > 0) {
      for (const key of verdict.dropped) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return;
  const summary = [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, count]) => `${key}=${count}`)
    .join(", ");
  console.warn(`[ProxySubscription] core config dropped decorative params: ${summary}`);
}

function collectEmptyGroups(
  model: CoreModel,
  renderedTags: Set<string>
): Array<{ node: string; reason: string }> {
  const skipped: Array<{ node: string; reason: string }> = [];
  // Groups with members assigned but none renderable emit nothing (see
  // proxyEntries above): report each once so an unemitted listener never
  // goes silent. Groups already reported by the model layer (no members
  // assigned at all) are excluded here — no double count at the sync merge.
  for (const group of model.groups) {
    if (group.members.length === 0) continue;
    if (group.members.some((m) => renderedTags.has(m))) continue;
    skipped.push({ node: group.tag, reason: "empty_group" });
  }
  return skipped;
}

export function renderMihomo(model: CoreModel, existingText: string | null): RenderResult {
  const baseOrRefused = parseBase(existingText);
  if (isRefused(baseOrRefused)) return baseOrRefused;
  const base: Record<string, unknown> = baseOrRefused;

  const renderedTags = renderedTagSet(model);
  logDroppedParams(model, renderedTags);
  const out: Record<string, unknown> = { ...base };
  const proxies = asArray(base.proxies).slice();
  const groups = asArray(base["proxy-groups"]).slice();
  const listeners = asArray(base.listeners).slice();

  const keptProxies = withoutOwned(proxies, (p) => (p as Record<string, unknown>).name);
  const keptGroups = withoutOwned(groups, (g) => (g as Record<string, unknown>).name);
  const keptListeners = withoutOwned(listeners, (l) => (l as Record<string, unknown>).name);

  const skipped: Array<{ node: string; reason: string }> = [...collectSkips(model, renderedTags)];

  const operatorCount = keptProxies.length;
  const emittedTags = proxyEntries(model, renderedTags, keptProxies);
  const emittedGroupTags = new Set(emittedTags);

  skipped.push(...collectEmptyGroups(model, renderedTags));
  // Owned-position table, aligned with the final `proxies` array: operator
  // entries (kept) are unowned; node entries carry the model tag. Positional,
  // never prefix-matched, so group names sharing the owned prefix can never
  // resolve to a node.
  const renderableTags = model.nodes.filter((n) => renderedTags.has(n.tag)).map((n) => n.tag);
  const ownedIndex: Array<string | null> = keptProxies.map((_, i) => {
    const nodePos = i - operatorCount;
    return nodePos >= 0 && nodePos < renderableTags.length
      ? (renderableTags[nodePos] as string)
      : null;
  });

  for (const group of model.groups) {
    if (!emittedGroupTags.has(group.tag)) continue;
    keptGroups.push({
      name: group.tag,
      type: "select",
      proxies: group.members
        .filter((m) => renderedTags.has(m))
        .map((m) => `${OWNED_TAG_PREFIX}${m}`),
    });
  }

  for (const listener of model.listeners) {
    if (!emittedGroupTags.has(listener.group)) continue;
    keptListeners.push(listenerFor(listener));
  }

  out.proxies = keptProxies;
  out["proxy-groups"] = keptGroups;
  out.listeners = keptListeners;

  const dumped = yaml.dump(out);
  const text = dumped.endsWith("\n") ? dumped : `${dumped}\n`;
  const membersDigest = createHash("sha256")
    .update([...renderedTags].sort().join("\n"), "utf8")
    .digest("hex");
  return { ok: true, text, unchanged: text === existingText, skipped, ownedIndex, membersDigest };
}

/**
 * Map a failed check's raw output to the owned node tag it names, via the
 * renderer's owned-position table. First `proxies[i]` (or `proxy[i]`) match
 * wins (a check names one position per run); unowned, out-of-range or absent
 * positions resolve to null and keep the previous behaviour upstream.
 */
export function resolveMihomoTag(
  stderr: string,
  ownedIndex: Array<string | null>
): { tag: string; token: string } | null {
  const match = /prox(?:ies|y)\[(\d{1,6})\]/.exec(stderr);
  if (!match) return null;
  const index = Number(match[1]);
  const tag = Number.isSafeInteger(index) ? ownedIndex[index] : null;
  if (typeof tag !== "string" || !tag) return null;
  return { tag, token: `offending-pattern:proxies[${match[1]}]` };
}
