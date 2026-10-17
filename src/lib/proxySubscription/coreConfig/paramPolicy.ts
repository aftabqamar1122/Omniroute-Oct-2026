/**
 * Auditable parameter policy for URI and Clash sources.
 *
 * Three buckets, checked in this order: wire-affecting keys reject the node
 * whole (they would change the bytes on the wire without a projection here),
 * proven decorative keys render with their names reported in `dropped`, and
 * unknown keys reject by default with `unknown-param:<key>` in `detail`.
 * `sni`/`fp` are consumed — not rejected — because they have a projection
 * (`server_name`/`fingerprint` in the TLS block); the wire sets below hold
 * only knobs with no projection. Never throws: query strings and Clash
 * objects are operator-supplied feed data.
 */

/** Query keys the table consumes when present. */
export const CONSUMED_URI_KEYS: ReadonlySet<string> = new Set([
  "type",
  "security",
  "flow",
  "sni",
  "servername",
  "fp",
  "pbk",
  "sid",
  "insecure",
  "allowinsecure",
  "path",
  "host",
  "servicename",
  "service",
]);

/** Wire-affecting URI keys with no projection: reject the node whole. */
export const WIRE_URI_KEYS: ReadonlySet<string> = new Set([
  "obfs",
  "obfs-password",
  "alpn",
  "encryption",
  "headertype",
  "header",
  "packetencoding",
  "xudp",
  "mux",
  "smux",
  "fragment",
  "ech",
  "utls",
  "client-fingerprint",
  "skip-cert-verify",
  "plugin",
  "pluginopts",
  "salamander",
  "seed",
  "congestion-control",
  "cc",
  "up",
  "down",
  "upmbps",
  "downmbps",
  "disablemtudiscovery",
  "heartbeatinterval",
  "keepalive",
  "maxstreams",
  "quic",
  "mlkem",
  "sni-automated",
  "delegate",
]);

/** Proven decorative URI keys: render, report in `dropped`. */
export const DECORATIVE_URI_KEYS: ReadonlySet<string> = new Set([
  "remark",
  "remarks",
  "name",
  "tag",
  "testurl",
  "urltestinterval",
  "encryption",
  "headertype",
  "header",
]);

/** Keys the projection reads from a decoded `vmess://base64(json)` blob. */
export const VMESS_CONSUMED_KEYS: ReadonlySet<string> = new Set([
  "add",
  "port",
  "id",
  "uuid",
  "net",
  "type",
  "tls",
  "sni",
  "host",
  "path",
  "security",
  "scy",
  "aid",
  "alterid",
  "v",
  "ps",
  "remark",
  "remarks",
]);

/** Wire-affecting extras with no projection in a decoded vmess blob. */
export const VMESS_WIRE_KEYS: ReadonlySet<string> = new Set([
  "obfs",
  "obfs-password",
  "obfs_password",
  "alpn",
  "headertype",
  "header",
  "packetencoding",
  "xudp",
  "mux",
  "fragment",
  "ech",
  "utls",
  "seed",
  "cc",
  "quic",
]);

/** Proven decorative keys in a decoded vmess blob (reported in `dropped`). */
export const VMESS_DECORATIVE_KEYS: ReadonlySet<string> = new Set([
  "ps",
  "remark",
  "remarks",
  "scy",
  "aid",
  "alterid",
  "v",
  "encryption",
]);

/** Clash object fields the table consumes when present. */
export const CONSUMED_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "type",
  "server",
  "port",
  "server-port",
  "serverport",
  "password",
  "uuid",
  "token",
  "method",
  "cipher",
  "transport",
  "network",
  "type-",
  "typeminus",
  "security",
  "tls",
  "sni",
  "servername",
  "fingerprint",
  "fp",
  "publickey",
  "pbk",
  "shortid",
  "sid",
  "allowinsecure",
  "insecure",
  "path",
  "ws-path",
  "wspath",
  "host",
  "servicename",
  "service-name",
  "service",
  "flow",
]);

/** Wire-affecting Clash fields with no projection: reject the node whole. */
export const WIRE_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "obfs",
  "obfs-password",
  "obfspassword",
  "alpn",
  "encryption",
  "headertype",
  "header",
  "packetencoding",
  "xudp",
  "mux",
  "smux",
  "fragment",
  "ech",
  "utls",
  "client-fingerprint",
  "clientfingerprint",
  "skip-cert-verify",
  "skipcertverify",
  "plugin",
  "pluginopts",
  "plugin-opts",
  "salamander",
  "seed",
  "congestion-control",
  "congestioncontrol",
  "cc",
  "up",
  "down",
  "upmbps",
  "downmbps",
  "disablemtudiscovery",
  "heartbeatinterval",
  "keepalive",
  "maxstreams",
  "quic",
  "mlkem",
]);

/** Proven decorative Clash fields: render, report in `dropped`. */
export const DECORATIVE_OBJECT_KEYS: ReadonlySet<string> = new Set(["name"]);

export function normalizeQueryKey(raw: string): string {
  const lowered = raw.toLowerCase().trim().replace(/_/g, "-");
  if (lowered === "obfspassword" || lowered === "obfs-password") return "obfs-password";
  return lowered;
}

export function normalizeObjectKey(raw: string): string {
  return raw.toLowerCase().trim().replace(/_/g, "-");
}

export function cipherDetail(value: unknown, key: string): string | null {
  const text = String(value ?? "")
    .toLowerCase()
    .trim();
  return text === "auto" || text === "" ? null : `wire-param:${key}`;
}

export function peerCountDetail(value: unknown, key: string): string | null {
  const text = String(value ?? "").trim();
  return text === "0" || text === "" ? null : `wire-param:${key}`;
}

export function streamShapeDetail(value: unknown, net: unknown, key: string): string | null {
  if (
    String(net ?? "")
      .toLowerCase()
      .trim() === "tcp"
  )
    return null;
  const text = String(value ?? "")
    .toLowerCase()
    .trim();
  return text === "" || text === "none" ? null : `wire-param:${key}`;
}

export function vmessValueDetail(parsed: Record<string, unknown>, key: string): string | null {
  const lowered = key.toLowerCase().trim();
  if (lowered === "scy" || lowered === "security") return cipherDetail(parsed[key], key);
  if (lowered === "aid" || lowered === "alterid") return peerCountDetail(parsed[key], key);
  if (lowered === "encryption") {
    const text = String(parsed[key] ?? "").trim();
    return text === "none" ? null : `wire-param:${key}`;
  }
  if (lowered === "type") return streamShapeDetail(parsed[key], parsed["net"], key);
  return null;
}

export function auditUriParams(params: URLSearchParams): { dropped: string[]; detail?: string } {
  const seen = [...new Set([...params.keys()].map((key) => key))];
  const normalized = new Map<string, string>();
  for (const key of seen) normalized.set(normalizeQueryKey(key), key);
  const wireHits = [...normalized.keys()].filter((key) => {
    if (WIRE_URI_KEYS.has(key)) {
      if (key === "encryption") return (params.get(normalized.get(key)!) ?? "").trim() !== "none";
      if (key === "headertype" || key === "header") {
        const value = (params.get(normalized.get(key)!) ?? "").toLowerCase().trim();
        return value !== "" && value !== "none";
      }
      return true;
    }
    return false;
  });
  if (wireHits.length > 0) {
    const first = [...normalized.entries()].find(([norm]) => norm === wireHits.sort()[0])!;
    return { dropped: [], detail: `wire-param:${first[1]}` };
  }
  // `encryption=none` / `headertype=none` reach this line only with the
  // decorative value: any other value was rejected as wire-affecting above.
  const unknownHits = [...normalized.keys()].filter(
    (key) => !CONSUMED_URI_KEYS.has(key) && !WIRE_URI_KEYS.has(key) && !DECORATIVE_URI_KEYS.has(key)
  );
  if (unknownHits.length > 0) {
    const first = [...normalized.entries()].find(([norm]) => norm === unknownHits.sort()[0])!;
    return { dropped: [], detail: `unknown-param:${first[1]}` };
  }
  const dropped = [...normalized.keys()]
    .filter((key) => DECORATIVE_URI_KEYS.has(key))
    .map((key) => normalized.get(key)!)
    .sort();
  return { dropped, detail: undefined };
}

export function auditDecodedVmess(parsed: Record<string, unknown>): {
  dropped: string[];
  detail?: string;
} {
  const keys = Object.keys(parsed);
  const wireHit = keys.find(
    (key) => VMESS_WIRE_KEYS.has(key.toLowerCase().trim()) || vmessValueDetail(parsed, key)
  );
  if (wireHit)
    return { dropped: [], detail: vmessValueDetail(parsed, wireHit) ?? `wire-param:${wireHit}` };
  const unknownHit = keys.find((key) => !VMESS_CONSUMED_KEYS.has(key.toLowerCase().trim()));
  if (unknownHit) {
    if (unknownHit.toLowerCase().trim() === "encryption") {
      const detail = vmessValueDetail(parsed, unknownHit);
      if (detail) return { dropped: [], detail };
      return { dropped: [unknownHit], detail: undefined };
    }
    return { dropped: [], detail: `unknown-param:${unknownHit}` };
  }
  const dropped = keys
    .filter(
      (key) => VMESS_DECORATIVE_KEYS.has(key.toLowerCase().trim()) && !vmessValueDetail(parsed, key)
    )
    .map((key) => key)
    .sort();
  return { dropped, detail: undefined };
}

export function auditObjectParams(value: Record<string, unknown>): {
  dropped: string[];
  detail?: string;
} {
  const seen = [...new Set(Object.keys(value).map((key) => key))];
  const normalized = new Map<string, string>();
  for (const key of seen) normalized.set(normalizeObjectKey(key), key);
  const wireHits = [...normalized.keys()].filter((key) => {
    if (WIRE_OBJECT_KEYS.has(key)) {
      if (key === "encryption" || key === "headertype" || key === "header") {
        const raw = normalized.get(key)!;
        const field = String(value[raw] ?? "")
          .toLowerCase()
          .trim();
        return field !== "" && field !== "none";
      }
      return true;
    }
    return false;
  });
  if (wireHits.length > 0) {
    const first = [...normalized.entries()].find(([norm]) => norm === wireHits.sort()[0])!;
    return { dropped: [], detail: `wire-param:${first[1]}` };
  }
  const unknownHits = [...normalized.keys()].filter(
    (key) =>
      !CONSUMED_OBJECT_KEYS.has(key) &&
      !WIRE_OBJECT_KEYS.has(key) &&
      !DECORATIVE_OBJECT_KEYS.has(key)
  );
  if (unknownHits.length > 0) {
    const first = [...normalized.entries()].find(([norm]) => norm === unknownHits.sort()[0])!;
    return { dropped: [], detail: `unknown-param:${first[1]}` };
  }
  const dropped = [...normalized.keys()]
    .filter((key) => DECORATIVE_OBJECT_KEYS.has(key))
    .map((key) => normalized.get(key)!)
    .sort();
  return { dropped, detail: undefined };
}
