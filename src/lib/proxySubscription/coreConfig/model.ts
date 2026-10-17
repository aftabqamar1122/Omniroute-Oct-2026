/**
 * Core-agnostic generation model: what OmniRoute owns (local listeners,
 * selector groups, node tags) — never how a protocol is translated.
 *
 * It doesn't model core payloads: each node carries its original definition
 * untouched (`source`), and a renderer passes it through verbatim or projects
 * the canonical translation below. The canonical form carries identity,
 * server, port, transport, security and credentials only: any field that
 * would change connection behavior outside the supported set rejects the
 * whole node instead of guessing, proven decorative fields render with their
 * names journaled, and unknown fields reject by default with their name.
 */
import { createHash } from "node:crypto";
import type { NeedsCoreNode, NodeSource, SubscriptionNode } from "../parse";
import { isLocalCoreEndpointAllowed } from "../coreEndpoint";
import { parseSelectorTag, stripSelectorSuffix } from "../selectorEndpoint";
import { auditDecodedVmess, auditObjectParams, auditUriParams } from "./paramPolicy";

/** Prefix marking every tag this generator owns (listeners, groups, nodes). */
export const OWNED_TAG_PREFIX = "omniroute-";

export interface CoreListener {
  tag: string;
  scheme: "socks5" | "http" | "https";
  host: string;
  port: number;
  group: string;
}

export interface CoreGroup {
  tag: string;
  members: string[];
}

export interface CoreNode {
  tag: string;
  source: NodeSource;
}

/** Core-agnostic translation of one node source. Memory-only, never persisted. */
export interface CanonicalNode {
  type: string;
  server: string;
  serverPort: number;
  identity: string;
  transport: { kind: "tcp" | "ws" | "grpc"; path?: string; host?: string; service?: string };
  security: {
    kind: "none" | "tls" | "reality";
    serverName?: string;
    insecure?: boolean;
    publicKey?: string;
    shortId?: string;
    fingerprint?: string;
  };
  credentials: { kind: "uuid" | "password" | "method-password"; secret: string; method?: string };
  flow?: string;
}

/** Result of translating one node source into the canonical form. */
export type NormalizeOk = { ok: true; node: CanonicalNode; dropped: string[] };
export type NormalizeFail = {
  ok: false;
  reason: "converter_unsupported" | "source_not_singbox_shape";
  detail?: string;
};
export type NormalizeResult = NormalizeOk | NormalizeFail;

/** Known schemes that reach the table but carry no supported translation. */
const UNSUPPORTED_KNOWN_SCHEMES: ReadonlySet<string> = new Set([
  "ssr",
  "tuic",
  "snell",
  "hysteria",
  "wireguard",
]);

/** Scheme spellings accepted by the table, including client aliases. */
const SUPPORTED_SCHEMES: ReadonlySet<string> = new Set([
  "vless",
  "trojan",
  "ss",
  "shadowsocks",
  "vmess",
  "hysteria2",
  "hy2",
]);

const CANONICAL_TYPE_BY_SCHEME: Record<string, string> = {
  vless: "vless",
  trojan: "trojan",
  ss: "shadowsocks",
  shadowsocks: "shadowsocks",
  vmess: "vmess",
  hysteria2: "hysteria2",
  hy2: "hysteria2",
};

const SUPPORTED_TRANSPORTS: ReadonlySet<string> = new Set(["tcp", "raw", "ws", "grpc"]);
const SUPPORTED_FLOWS: ReadonlySet<string> = new Set(["xtls-rprx-vision"]);

function unsupported(
  reason: "converter_unsupported" | "source_not_singbox_shape"
): NormalizeResult {
  return { ok: false, reason };
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function portField(value: unknown): number {
  const port = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function normalizeScheme(raw: unknown): string {
  return typeof raw === "string" ? raw.toLowerCase().trim() : "";
}

function decodedOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksEncoded(value: string): boolean {
  return value.includes("%") && decodedOnce(value) !== value;
}

/**
 * Bounded credential decoding: one application pass after the URL decoding.
 * `new URL` already percent-decodes username/password/searchParams once, so
 * this guard sees the second layer: a value that still looks encoded after
 * this pass is rejected instead of decoded again, so a double-encoded secret
 * can never silently become another credential.
 */
function decodedCredential(value: string): string | null {
  const once = decodedOnce(value);
  if (looksEncoded(once)) return null;
  return once;
}

function userinfoCredential(url: URL): string | null {
  const raw = url.username
    ? `${url.username}${url.password ? `:${url.password}` : ""}`
    : url.password;
  if (!raw) return null;
  return decodedCredential(raw);
}

function portFromUrl(url: URL): number {
  if (!url.port) return 0;
  return portField(Number(url.port));
}

function wsTransport(params: URLSearchParams): CanonicalNode["transport"] | null {
  const decodedPath = decodedCredential(params.get("path") ?? "/");
  if (decodedPath === null) return null;
  const host = decodedCredential(params.get("host") ?? "");
  if (host === null) return null;
  return { kind: "ws", path: decodedPath || "/", ...(host ? { host } : {}) };
}

function grpcTransport(params: URLSearchParams): CanonicalNode["transport"] | null {
  const service = decodedCredential(params.get("serviceName") ?? params.get("service") ?? "");
  if (service === null) return null;
  return { kind: "grpc", ...(service ? { service } : {}) };
}

function transportFromParams(params: URLSearchParams): CanonicalNode["transport"] | null {
  const kind = (params.get("type") ?? "tcp").toLowerCase().trim() || "tcp";
  if (!SUPPORTED_TRANSPORTS.has(kind)) return null;
  if (kind === "ws") return wsTransport(params);
  if (kind === "grpc") return grpcTransport(params);
  return { kind: "tcp" };
}

function tlsExtras(
  params: URLSearchParams,
  security: CanonicalNode["security"]
): CanonicalNode["security"] | null {
  if ((params.get("allowInsecure") ?? "") === "1" || (params.get("insecure") ?? "") === "1") {
    security.insecure = true;
  }
  const fingerprint = decodedCredential(params.get("fp") ?? "");
  if (fingerprint === null) return null;
  if (fingerprint) security.fingerprint = fingerprint;
  return security;
}

function realityExtras(
  params: URLSearchParams,
  security: CanonicalNode["security"]
): CanonicalNode["security"] | null {
  const publicKey = decodedCredential(params.get("pbk") ?? "");
  const shortId = decodedCredential(params.get("sid") ?? "");
  if (publicKey === null || shortId === null) return null;
  if (publicKey) security.publicKey = publicKey;
  if (shortId) security.shortId = shortId;
  return security;
}

function securityFromParams(
  params: URLSearchParams,
  server: string
): CanonicalNode["security"] | null {
  const raw = (params.get("security") ?? "none").toLowerCase().trim() || "none";
  if (raw !== "none" && raw !== "tls" && raw !== "reality") return null;
  if (raw === "none") return { kind: "none" };
  const decodedSni = decodedCredential(params.get("sni") ?? params.get("serverName") ?? "");
  if (decodedSni === null) return null;
  const security: CanonicalNode["security"] = { kind: raw, serverName: decodedSni || server };
  if (!tlsExtras(params, security)) return null;
  if (raw === "reality" && !realityExtras(params, security)) return null;
  return security;
}

function flowFromParams(params: URLSearchParams): { flow?: string; detail?: string } {
  const flow = params.get("flow");
  if (flow === null || flow === "") return {};
  if (!SUPPORTED_FLOWS.has(flow)) return { detail: "wire-param:flow" };
  return { flow };
}

function sip002Credentials(userinfo: string): { method: string; secret: string } | null {
  if (userinfo.includes(":")) {
    const [methodRaw, passwordRaw] = [
      userinfo.slice(0, userinfo.indexOf(":")),
      userinfo.slice(userinfo.indexOf(":") + 1),
    ];
    const method = decodedCredential(methodRaw);
    const secret = decodedCredential(passwordRaw);
    if (!method || secret === null || !secret) return null;
    return { method, secret };
  }
  let padded = userinfo.replace(/-/g, "+").replace(/_/g, "/");
  padded += "=".repeat((4 - (padded.length % 4)) % 4);
  let decoded: string;
  try {
    decoded = Buffer.from(padded, "base64").toString("utf-8");
  } catch {
    return null;
  }
  if (!decoded.includes(":")) return null;
  const method = decoded.slice(0, decoded.indexOf(":"));
  const secret = decoded.slice(decoded.indexOf(":") + 1);
  if (!method || !secret) return null;
  if (looksEncoded(method) || looksEncoded(secret)) return null;
  return { method, secret };
}

function vmessPayload(raw: string): Record<string, unknown> | null {
  const payload = raw.startsWith("vmess://") ? raw.slice("vmess://".length).split("#")[0] : "";
  const bare = payload.replace(/^\/*/, "");
  if (!bare) return null;
  const padded = bare + "=".repeat((4 - (bare.length % 4)) % 4);
  try {
    const parsed = JSON.parse(
      Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
    ) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function vmessEndpoint(
  parsed: Record<string, unknown>
): { server: string; port: number; secret: string } | null {
  const secret = textField(parsed.id);
  const server = textField(parsed.add).trim();
  const port = portField(parsed.port);
  if (!secret || !server || !port) return null;
  return { server, port, secret };
}

function vmessTransport(parsed: Record<string, unknown>): CanonicalNode["transport"] | null {
  const net = textField(parsed.net).toLowerCase().trim() || "tcp";
  if (!SUPPORTED_TRANSPORTS.has(net)) return null;
  if (net === "ws") {
    return {
      kind: "ws",
      path: textField(parsed.path) || "/",
      ...(textField(parsed.host) ? { host: textField(parsed.host) } : {}),
    };
  }
  if (net === "grpc") {
    return { kind: "grpc", ...(textField(parsed.path) ? { service: textField(parsed.path) } : {}) };
  }
  return { kind: "tcp" };
}

function vmessSecurity(parsed: Record<string, unknown>, server: string): CanonicalNode["security"] {
  const tlsRaw = parsed.tls;
  const useTls = tlsRaw === true || tlsRaw === "tls" || tlsRaw === 1 || tlsRaw === "1";
  return useTls
    ? { kind: "tls", serverName: textField(parsed.sni) || textField(parsed.host) || server }
    : { kind: "none" };
}

function vmessCredentials(raw: string): {
  server: string;
  port: number;
  secret: string;
  transport: CanonicalNode["transport"];
  security: CanonicalNode["security"];
} | null {
  const parsed = vmessPayload(raw);
  if (!parsed) return null;
  const endpoint = vmessEndpoint(parsed);
  if (!endpoint) return null;
  const transport = vmessTransport(parsed);
  if (!transport) return null;
  return { ...endpoint, transport, security: vmessSecurity(parsed, endpoint.server) };
}

function uriScheme(url: URL): string | null {
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (UNSUPPORTED_KNOWN_SCHEMES.has(scheme)) return null;
  return SUPPORTED_SCHEMES.has(scheme) ? scheme : null;
}

function uriVmess(type: string, raw: string): NormalizeResult {
  const parsed = vmessCredentials(raw);
  if (!parsed) return unsupported("converter_unsupported");
  let dropped: string[] = [];
  let detail: string | undefined;
  ({ dropped, detail } = auditDecodedVmess(parsed));
  if (detail) return { ok: false, reason: "converter_unsupported", detail };
  return {
    ok: true,
    node: {
      type,
      server: parsed.server,
      serverPort: parsed.port,
      identity: parsed.secret,
      transport: parsed.transport,
      security: parsed.security,
      credentials: { kind: "uuid", secret: parsed.secret },
    },
    dropped,
  };
}

function uriShadowsocks(type: string, url: URL): NormalizeResult {
  const userinfo =
    url.username || url.password ? `${url.username}${url.password ? `:${url.password}` : ""}` : "";
  const credentials = sip002Credentials(userinfo);
  const server = url.hostname.trim();
  const port = portFromUrl(url);
  if (!credentials || !server || !port) return unsupported("converter_unsupported");
  const audit = auditUriParams(url.searchParams);
  if (audit.detail) return { ok: false, reason: "converter_unsupported", detail: audit.detail };
  return {
    ok: true,
    node: {
      type,
      server,
      serverPort: port,
      identity: credentials.secret,
      transport: { kind: "tcp" },
      security: { kind: "none" },
      credentials: {
        kind: "method-password",
        secret: credentials.secret,
        method: credentials.method,
      },
    },
    dropped: audit.dropped,
  };
}

function uriCredentialed(type: string, scheme: string, url: URL): NormalizeResult {
  const credential = userinfoCredential(url);
  const server = url.hostname.trim();
  const port = portFromUrl(url);
  if (!credential || !server || !port) return unsupported("converter_unsupported");
  const params = url.searchParams;
  const audit = auditUriParams(params);
  if (audit.detail) return { ok: false, reason: "converter_unsupported", detail: audit.detail };
  const transport = transportFromParams(params);
  if (!transport) return { ok: false, reason: "converter_unsupported", detail: "wire-param:type" };
  if (!params.has("security") && scheme === "trojan") params.set("security", "tls");
  const securityRaw = securityFromParams(params, server);
  if (!securityRaw)
    return { ok: false, reason: "converter_unsupported", detail: "wire-param:security" };
  const flowed = flowFromParams(params);
  if (flowed.detail) return { ok: false, reason: "converter_unsupported", detail: flowed.detail };
  return {
    ok: true,
    node: {
      type,
      server,
      serverPort: port,
      identity: credential,
      transport,
      security: securityRaw,
      credentials:
        type === "vless" || type === "vmess"
          ? { kind: "uuid", secret: credential }
          : { kind: "password", secret: credential },
      ...(flowed.flow ? { flow: flowed.flow } : {}),
    },
    dropped: audit.dropped,
  };
}

function normalizeUriSource(raw: string): NormalizeResult {
  if (!raw || typeof raw !== "string") return unsupported("source_not_singbox_shape");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return unsupported("source_not_singbox_shape");
  }
  const scheme = uriScheme(url);
  if (!scheme) return unsupported("source_not_singbox_shape");
  const type = CANONICAL_TYPE_BY_SCHEME[scheme] ?? scheme;
  if (scheme === "vmess") return uriVmess(type, raw);
  if (scheme === "ss" || scheme === "shadowsocks") return uriShadowsocks(type, url);
  return uriCredentialed(type, scheme, url);
}

function objectEndpoint(value: Record<string, unknown>): { server: string; port: number } | null {
  const server = textField(value.server).trim();
  const port = portField(value.port) || portField(value.server_port);
  if (!server || !port) return null;
  return { server, port };
}

function objectSettings(
  value: Record<string, unknown>,
  server: string
): {
  transport: CanonicalNode["transport"];
  security: CanonicalNode["security"];
  flow?: string;
} | null {
  const transport = transportFromObject(value);
  const security = securityFromObject(value, server);
  if (!transport || !security) return null;
  const flowRaw = textField(value.flow).trim();
  if (flowRaw && !SUPPORTED_FLOWS.has(flowRaw)) return null;
  return { transport, security, ...(flowRaw ? { flow: flowRaw } : {}) };
}

function objectCredentials(
  canonical: string,
  value: Record<string, unknown>
): CanonicalNode["credentials"] | null {
  if (canonical === "shadowsocks") {
    const method = textField(value.method) || textField(value.cipher);
    const secret = textField(value.password);
    if (!method || !secret) return null;
    return { kind: "method-password", secret, method };
  }
  const secret = textField(value.uuid) || textField(value.password) || textField(value.token);
  if (!secret) return null;
  return canonical === "vless" || canonical === "vmess"
    ? { kind: "uuid", secret }
    : { kind: "password", secret };
}

function normalizeObjectSource(value: Record<string, unknown>): NormalizeResult {
  const scheme = normalizeScheme(value.type);
  const canonical = scheme ? CANONICAL_TYPE_BY_SCHEME[scheme] : "";
  if (!scheme || !canonical) {
    if (scheme && UNSUPPORTED_KNOWN_SCHEMES.has(scheme))
      return unsupported("source_not_singbox_shape");
    return unsupported("source_not_singbox_shape");
  }
  const audit = auditObjectParams(value);
  if (audit.detail) return { ok: false, reason: "converter_unsupported", detail: audit.detail };
  const endpoint = objectEndpoint(value);
  if (!endpoint) return unsupported("converter_unsupported");
  const settings = objectSettings(value, endpoint.server);
  if (!settings) return unsupported("converter_unsupported");
  const credentials = objectCredentials(canonical, value);
  if (!credentials) return unsupported("converter_unsupported");
  return {
    ok: true,
    node: {
      type: canonical,
      server: endpoint.server,
      serverPort: endpoint.port,
      identity: credentials.secret,
      transport: settings.transport,
      security: settings.security,
      credentials,
      ...(settings.flow ? { flow: settings.flow } : {}),
    },
    dropped: audit.dropped,
  };
}

export function isSingBoxLike(value: Record<string, unknown>): boolean {
  // Single shape predicate shared with the renderer: an object carrying the
  // triplet passes through verbatim without touching the normalizer.
  return (
    typeof value.type === "string" &&
    typeof value.server === "string" &&
    typeof value.server_port === "number"
  );
}

function transportFromObject(value: Record<string, unknown>): CanonicalNode["transport"] | null {
  const raw =
    (textField(value.transport) || textField(value.network) || textField(value.type_) || "tcp")
      .toLowerCase()
      .trim() || "tcp";
  const kind = raw === "raw" ? "tcp" : raw;
  if (!SUPPORTED_TRANSPORTS.has(kind)) return null;
  if (kind === "ws") {
    const path = textField(value.path) || textField(value.ws_path) || "/";
    return { kind: "ws", path, ...(textField(value.host) ? { host: textField(value.host) } : {}) };
  }
  if (kind === "grpc") {
    const service =
      textField(value.serviceName) || textField(value.service_name) || textField(value.path);
    return { kind: "grpc", ...(service ? { service } : {}) };
  }
  return { kind: "tcp" };
}

function securityKind(value: Record<string, unknown>): "tls" | "reality" | "none" | null {
  const explicit = (textField(value.security) || textField(value.tls)).toLowerCase().trim();
  if (explicit === "tls" || explicit === "reality") return explicit;
  if (explicit === "" || explicit === "none" || explicit === "false" || explicit === "0")
    return "none";
  return null;
}

function objectTlsSecurity(
  value: Record<string, unknown>,
  server: string,
  kind: "tls" | "reality"
): CanonicalNode["security"] {
  return {
    kind,
    serverName: textField(value.sni) || textField(value.serverName) || server,
    ...((textField(value.allowInsecure) === "1" || value.insecure === true
      ? { insecure: true }
      : {}) as { insecure?: boolean }),
    ...((textField(value.fingerprint) || textField(value.fp)
      ? { fingerprint: textField(value.fingerprint) || textField(value.fp) }
      : {}) as { fingerprint?: string }),
    ...((kind === "reality" && textField(value.publicKey)
      ? { publicKey: textField(value.publicKey) }
      : {}) as { publicKey?: string }),
    ...((kind === "reality" && textField(value.shortId)
      ? { shortId: textField(value.shortId) }
      : {}) as { shortId?: string }),
  };
}

function securityFromObject(
  value: Record<string, unknown>,
  server: string
): CanonicalNode["security"] | null {
  const kind = securityKind(value);
  if (kind === null) return null;
  if (kind === "none") {
    if (normalizeScheme(value.type) === "trojan") {
      return { kind: "tls", serverName: textField(value.sni) || server };
    }
    return { kind: "none" };
  }
  return objectTlsSecurity(value, server, kind);
}

/**
 * Translate one node source into the core-agnostic canonical form.
 *
 * Known schemes outside the supported table keep the historical
 * `source_not_singbox_shape` reason; supported schemes that cannot be
 * translated whole report `converter_unsupported`. Never throws.
 */
export function normalizeSource(source: NodeSource): NormalizeResult {
  try {
    if (!source) return unsupported("source_not_singbox_shape");
    if (source.kind === "uri") {
      if (typeof source.value !== "string") return unsupported("source_not_singbox_shape");
      return normalizeUriSource(source.value);
    }
    if (source.kind === "object") {
      if (!source.value || typeof source.value !== "object")
        return unsupported("source_not_singbox_shape");
      return normalizeObjectSource(source.value as Record<string, unknown>);
    }
    return unsupported("source_not_singbox_shape");
  } catch {
    return unsupported("source_not_singbox_shape");
  }
}

export interface CoreModel {
  listeners: CoreListener[];
  groups: CoreGroup[];
  nodes: CoreNode[];
  skipped: Array<{ line?: string; node?: string; reason: string }>;
}

function hashSlotFallback(name: string, slots: number): number {
  const digest = createHash("sha256").update(name, "utf8").digest();
  return digest.readUInt32BE(0) % slots;
}

function displayLabel(name: unknown): string {
  return (typeof name === "string" ? name.normalize("NFC") : "") || "node";
}

const IDENTITY_SUFFIX_LENGTH = 6;

function firstPresent(value: unknown): string {
  return typeof value === "string" && value ? value : "";
}

function canonicalFields(
  type: string,
  server: string,
  port: number,
  identity: string,
  transport: string,
  security: string
): string {
  return [type, server, String(port), identity, transport, security].join("\x1f");
}

function numericField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function objectPort(value: Record<string, unknown>): number {
  return numericField(value.port) || numericField(value.server_port);
}

function objectCredential(value: Record<string, unknown>): string {
  return (
    firstPresent(value.uuid) ||
    firstPresent(value.password) ||
    firstPresent(value.token) ||
    firstPresent(value.username)
  );
}

function identityFromObject(value: Record<string, unknown>): string | null {
  const type = typeof value.type === "string" ? value.type.toLowerCase().trim() : "";
  const serverRaw = typeof value.server === "string" ? value.server : "";
  const server = serverRaw.trim().toLowerCase().normalize("NFC");
  const port = objectPort(value);
  const identity = objectCredential(value);
  const transport = (firstPresent(value.transport) || firstPresent(value.network)).toLowerCase();
  const security = (firstPresent(value.security) || firstPresent(value.tls)).toLowerCase();
  if (!type && !server && port === 0 && !identity) return null;
  return createHash("sha256")
    .update(canonicalFields(type, server, port, identity, transport, security), "utf8")
    .digest("hex");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function uriCredential(url: URL): string {
  if (url.username) return safeDecode(url.username);
  if (url.password) return safeDecode(url.password);
  if (url.hash) return safeDecode(url.hash.replace(/^#/, ""));
  return "";
}

function identityFromUri(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const type = url.protocol.replace(/:$/, "").toLowerCase();
  const server = url.hostname.trim().toLowerCase().normalize("NFC");
  const port = url.port ? Number(url.port) || 0 : 0;
  const identity = uriCredential(url);
  const transport = (url.searchParams.get("type") ?? "").toLowerCase();
  const security = (url.searchParams.get("security") ?? "").toLowerCase();
  if (!type && !server && port === 0 && !identity) return null;
  return createHash("sha256")
    .update(canonicalFields(type, server, port, identity, transport, security), "utf8")
    .digest("hex");
}

function nodeIdentity(source: NodeSource): string | null {
  if (!source) return null;
  if (source.kind === "object") {
    if (!source.value || typeof source.value !== "object") return null;
    return identityFromObject(source.value as Record<string, unknown>);
  }
  if (source.kind === "uri") {
    if (typeof source.value !== "string") return null;
    return identityFromUri(source.value);
  }
  return null;
}

function rendezvousGroup(identity: string, groups: string[]): string {
  let best = groups[0];
  let bestScore = "";
  for (const group of groups) {
    const score = createHash("sha256").update(`${identity}\x1f${group}`, "utf8").digest("hex");
    if (score > bestScore) {
      bestScore = score;
      best = group;
    }
  }
  return best;
}

function uniqueTag(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let i = 2;
  while (taken.has(`${base}-${i}`)) i += 1;
  const tag = `${base}-${i}`;
  taken.add(tag);
  return tag;
}

function listenerPort(url: URL, scheme: "socks5" | "http" | "https"): number {
  const port = Number(url.port);
  if (port > 0) return port;
  return scheme === "https" ? 443 : scheme === "http" ? 80 : 1080;
}

function listenerFromLine(
  line: string,
  index: number,
  skipped: CoreModel["skipped"]
): CoreListener | null {
  const tag = parseSelectorTag(line);
  if (!tag) {
    skipped.push({ line, reason: "no_selector_tag" });
    return null;
  }
  const bare = stripSelectorSuffix(line);
  if (!isLocalCoreEndpointAllowed(bare)) {
    skipped.push({ line, reason: "invalid_endpoint" });
    return null;
  }
  let url: URL;
  try {
    url = new URL(bare);
  } catch {
    skipped.push({ line, reason: "invalid_endpoint" });
    return null;
  }
  const scheme = url.protocol === "https:" ? "https" : url.protocol === "http:" ? "http" : "socks5";
  const group = `${OWNED_TAG_PREFIX}${tag}`;
  return {
    tag: `${OWNED_TAG_PREFIX}in-${tag}-${index}`,
    scheme,
    host: url.hostname,
    port: listenerPort(url, scheme),
    group,
  };
}

function assignNodes(
  nodes: Array<SubscriptionNode | NeedsCoreNode>,
  groups: string[],
  groupMembers: Map<string, CoreNode[]>,
  skipped: CoreModel["skipped"]
): CoreNode[] {
  const taken = new Set<string>();
  const coreNodes: CoreNode[] = [];
  for (const node of nodes) {
    const source = node.source;
    if (!source) {
      skipped.push({ node: node.name, reason: "no_source" });
      continue;
    }
    const identity = nodeIdentity(source);
    const display = displayLabel(node.name);
    let tag: string;
    if (identity) {
      const suffixed = `${display}-${identity.slice(0, IDENTITY_SUFFIX_LENGTH)}`;
      if (!taken.has(suffixed)) {
        taken.add(suffixed);
        tag = suffixed;
      } else {
        tag = uniqueTag(suffixed, taken);
      }
    } else {
      tag = uniqueTag(display, taken);
    }
    coreNodes.push({ tag, source });
    const group = identity
      ? rendezvousGroup(identity, groups)
      : groups[hashSlotFallback(display, groups.length)];
    groupMembers.get(group)!.push({ tag, source });
  }
  return coreNodes;
}

/**
 * Build the generation model from local-core lines and parsed nodes.
 *
 * `entries` are the already-split `localCoreEndpoint` lines (one per line).
 * Lines without a `selector=` suffix or with a disallowed endpoint land in
 * `skipped`; every other line becomes one listener. Lines sharing a selector
 * tag form one group. Each node with a `source` joins exactly one group by
 * rendezvous hashing on its definition identity, so removing a group only
 * moves that group's members and adding a node never moves the others.
 * Without any group the model stays empty: nodes are neither rendered nor
 * listed, and the renderer emits nothing owned.
 */
export function buildCoreModel(
  entries: string[],
  nodes: Array<SubscriptionNode | NeedsCoreNode>
): CoreModel {
  const skipped: CoreModel["skipped"] = [];
  const listeners: CoreListener[] = [];
  const groupTags = new Map<string, string>();
  const groupMembers = new Map<string, CoreNode[]>();

  entries.forEach((raw, index) => {
    const line = typeof raw === "string" ? raw.trim() : "";
    if (!line) return;
    const listener = listenerFromLine(line, index, skipped);
    if (!listener) return;
    // Key on the bare selector tag: listener.group carries the owned prefix,
    // so testing the prefixed form here would never hit and reset the member
    // list on every line sharing a selector.
    if (!groupTags.has(parseSelectorTag(line)!)) {
      groupTags.set(parseSelectorTag(line)!, listener.group);
      groupMembers.set(listener.group, []);
    }
    listeners.push(listener);
  });

  const groups = [...groupTags.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, tag]) => tag);
  if (groups.length === 0) return { listeners: [], groups: [], nodes: [], skipped };

  const coreNodes = assignNodes(nodes, groups, groupMembers, skipped);
  for (const tag of groups) {
    if ((groupMembers.get(tag) ?? []).length === 0) {
      skipped.push({ node: tag, reason: "empty_group" });
    }
  }

  return {
    listeners,
    groups: groups.map((tag) => ({
      tag,
      members: (groupMembers.get(tag) ?? []).map((n) => n.tag),
    })),
    nodes: coreNodes,
    skipped,
  };
}
