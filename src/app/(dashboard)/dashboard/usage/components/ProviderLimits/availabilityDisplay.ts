import type { HealthAccount, HealthReason, HealthStatus } from "./healthOverview";
import { parseRuntimeTimestamp } from "./runtimeCooldown";

export type DisplayKind = "ok" | "cd5" | "cdw" | "act" | "paused" | "empty";
export type DisplayFilter = DisplayKind | "all" | "critical" | "alert";
export interface DisplayAccount extends HealthAccount {
  kind: DisplayKind;
  fill: number | null;
  remainingPct: number | null;
  waitMs: number | null;
  poolId?: string;
}
export const DISPLAY_KINDS: DisplayKind[] = ["ok", "cd5", "cdw", "act", "paused", "empty"];
export const DISPLAY_COLORS: Record<DisplayKind, string> = {
  ok: "#22c55e",
  cd5: "#eab308",
  cdw: "#ef4444",
  act: "#ef4444",
  paused: "var(--color-text-muted)",
  empty: "var(--color-text-muted)",
};
export const DISPLAY_LABELS = {
  ok: "usage.healthAvailable",
  cd5: "usage.healthCd5",
  cdw: "usage.healthCdw",
  act: "usage.healthAction",
  paused: "common.paused",
  empty: "usage.tierUnknown",
} as const;
const FIVE_HOURS = 5 * 3_600_000;
const WEEK = 7 * 24 * 3_600_000;
export function poolIds(account: HealthAccount): string[] {
  return [
    ...new Set([
      ...(account.quotaPools || []).map((g) => g.id),
      ...account.cells.filter((c) => c.scope === "group").map((c) => c.scopeId),
    ]),
  ]
    .filter((id): id is string => !!id)
    .sort();
}
/** Same applicableModel fallback as the original family projection. Unknown mappings stay visible. */
function applicableModel(model: string, id: string, account: HealthAccount) {
  if (account.quotaPools?.find((g) => g.id === id)?.models?.includes(model)) return true;
  if (["agy", "antigravity"].includes(account.connection.provider)) {
    if (/^gemini/i.test(model)) return id === "gemini";
    if (/^(claude|gpt)/i.test(model)) return id === "claude_gpt";
  }
  return true;
}
function project(account: HealthAccount, now: number, poolId?: string): DisplayAccount {
  const cells = poolId
    ? account.cells.filter((c) =>
        c.scope === "group"
          ? c.scopeId === poolId
          : c.scope === "scoped" && applicableModel(c.name, poolId, account)
      )
    : account.cells;
  const reasons = account.reasons.filter(
    (r) =>
      (r.type !== "cooldown" || parseRuntimeTimestamp(r.resetAt || "") > now) &&
      (!poolId ||
        (r.type === "lockout" || r.scope === "scoped"
          ? applicableModel(r.window || "", poolId, account)
          : r.scope !== "group" || r.scopeId === poolId))
  );
  const server =
    (account.quotaAvailabilityValidUntil ?? -Infinity) >= now
      ? account.quotaAvailability
      : undefined;
  const decision = poolId
    ? server?.scopes.find((s) => s.kind === "group" && s.id === poolId)?.decision
    : server?.account;
  const accountBlocked = decision?.usable === false;
  const quotaBlocked = false;
  const terminal = reasons.some((r) => r.type === "terminal");
  const cooldown = reasons.filter((r) => r.type === "cooldown");
  let kind: DisplayKind = account.status === "paused" ? "paused" : terminal ? "act" : "ok";
  const recoveryBlockers = decision?.recoveryWindow
    ? [decision.recoveryWindow]
    : decision?.blockers || [];
  const constraints: HealthReason[] = [
    ...recoveryBlockers.map((b) => ({
      type: "quota" as const,
      window: b.name,
      resetAt: b.resetAt,
    })),
    ...cooldown,
  ];
  let recoverAt: string | undefined;
  let waitMs: number | null = null;
  let waitDuration = WEEK;
  if (kind === "ok" && (accountBlocked || quotaBlocked || cooldown.length)) {
    const classify = (r: HealthReason): "cd5" | "cdw" => {
      if (r.type === "quota") {
        return recoveryBlockers.find((b) => b.name === r.window)?.kind === "fiveHour"
          ? "cd5"
          : "cdw";
      }
      return (r.durationMs ?? Infinity) <= FIVE_HOURS ? "cd5" : "cdw";
    };
    const unknown = constraints.filter(
      (r) => !Number.isFinite(parseRuntimeTimestamp(r.resetAt || ""))
    );
    // An unknown constraint cannot promise a recovery; unknown long windows outrank short ones.
    const latest = [...constraints].sort(
      (a, b) =>
        (unknown.length
          ? 0
          : parseRuntimeTimestamp(b.resetAt!) - parseRuntimeTimestamp(a.resetAt!)) ||
        Number(classify(b) === "cdw") - Number(classify(a) === "cdw")
    )[0];
    kind = latest ? classify(latest) : "cdw";
    waitDuration =
      latest?.type === "cooldown" && latest.durationMs !== undefined && latest.durationMs > 0
        ? latest.durationMs
        : kind === "cd5"
          ? FIVE_HOURS
          : WEEK;
    if (!unknown.length && latest) {
      recoverAt = latest.resetAt || undefined;
      waitMs = Math.max(0, parseRuntimeTimestamp(recoverAt!) - now);
    }
  }
  const partial =
    kind === "ok" &&
    ((server?.scopes.some((s) => s.decision.usable !== true) ?? false) ||
      reasons.some((r) => r.type === "lockout"));
  if (kind === "ok" && (decision?.usable !== true || reasons.some((r) => r.type === "noRuntime")))
    kind = "empty";
  // Water level is display-only, never an eligibility test.
  const locallyLimited = cells.filter((c) => !c.quotaIgnored);
  const bypassed = cells.some((c) => c.quotaIgnored);
  const waterCells =
    poolId || bypassed ? locallyLimited : locallyLimited.filter((c) => c.scope !== "scoped");
  // Alternative budgets share one meter; the server supplies each display threshold.
  // This selection affects fill only, never kind, partial, reasons or eligibility.
  const alternatives = new Map<string, typeof waterCells>();
  for (const cell of waterCells) {
    const base = cell.name.replace(/_freetrial$/, "");
    const key = JSON.stringify([cell.scope, cell.scopeId, base]);
    alternatives.set(key, [...(alternatives.get(key) || []), cell]);
  }
  const percentages = [...alternatives.values()].map(
    (entries) =>
      [...entries].sort((a, b) => {
        const above = (c: typeof a) =>
          Number(c.percent > (decision?.displayCutoffs?.[c.name] ?? 0) + 1e-9);
        return above(b) - above(a) || b.percent - a.percent;
      })[0].percent
  );
  const remainingPct = percentages.length ? Math.min(...percentages) : bypassed ? 100 : null;
  const fill =
    kind === "ok"
      ? remainingPct
      : kind === "cd5" || kind === "cdw"
        ? waitMs === null
          ? 0
          : Math.max(0, Math.min(100, (1 - waitMs / waitDuration) * 100))
        : null;
  return {
    ...account,
    cells,
    reasons,
    kind,
    partial,
    fill,
    remainingPct,
    waitMs,
    recoverAt,
    poolId,
    status: displayStatus({ kind, partial }),
  };
}
export function displayAccount(account: HealthAccount, now = Date.now()): DisplayAccount {
  return project(account, now);
}
export function displayPool(account: HealthAccount, id: string, now = Date.now()): DisplayAccount {
  return project(account, now, id);
}
export function displayStatus(a: Pick<DisplayAccount, "kind" | "partial">): HealthStatus {
  if (a.kind === "ok") return a.partial ? "alert" : "ok";
  return ["cd5", "cdw", "act"].includes(a.kind) ? "critical" : (a.kind as HealthStatus);
}
export function matchesDisplayFilter(a: DisplayAccount, filter: DisplayFilter): boolean {
  if (filter === "all") return true;
  if (filter === "critical") return ["cd5", "cdw", "act"].includes(a.kind);
  if (filter === "alert") return a.kind === "ok" && a.partial;
  return a.kind === filter;
}
export function compareDisplayAccounts(a: DisplayAccount, b: DisplayAccount) {
  const rank = (x: DisplayAccount) =>
    x.kind === "ok" ? Number(x.partial) : DISPLAY_KINDS.indexOf(x.kind) + 1;
  const label = (x: DisplayAccount) =>
    x.connection.name || x.connection.displayName || x.connection.email || x.connection.id;
  return (
    rank(a) - rank(b) ||
    (b.fill ?? -1) - (a.fill ?? -1) ||
    label(a).localeCompare(label(b)) ||
    a.connection.id.localeCompare(b.connection.id)
  );
}
export function countDisplay(accounts: DisplayAccount[]) {
  const counts = {
    ok: 0,
    cd5: 0,
    cdw: 0,
    act: 0,
    paused: 0,
    empty: 0,
    partial: 0,
    all: accounts.length,
  };
  for (const a of accounts) {
    counts[a.kind]++;
    if (a.kind === "ok" && a.partial) counts.partial++;
  }
  return counts;
}
