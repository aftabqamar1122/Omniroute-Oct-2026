import { resolveProviderAvailability, type ProviderAvailability } from "@/lib/providerAvailability";
import { parseRuntimeTimestamp, runtimeCooldownEvidence } from "./runtimeCooldown";
import type { CodexPaidCredits } from "@/lib/providers/codexPaidCredits";
import { quotaPercentage, type QuotaBypass } from "./quotaEligibility";
import type { ConnectionQuotaAvailability } from "@/lib/usage/availabilityTypes";
export { runtimeCooldownUntil } from "./runtimeCooldown";

// Retain persisted filter identifiers; every layout uses the same account projection.
export type HealthStatus = "critical" | "alert" | "ok" | "paused" | "empty";
export type QuotaLayout = "overview" | "full" | "compact";
export const AVAILABILITY_LABELS = {
  critical: "usage.healthUnavailable",
  alert: "usage.healthRestricted",
  ok: "usage.healthAvailable",
  empty: "usage.tierUnknown",
  paused: "common.paused",
} as const;
export interface HealthQuota {
  name: string;
  displayName?: string;
  used?: number;
  total?: number;
  remainingPercentage?: number;
  resetAt?: string | null;
  unlimited?: boolean;
  isCredits?: boolean;
  isResetCredits?: boolean;
  modelKey?: string;
  modelScoped?: boolean;
  window?: string;
  windowSeconds?: number | null;
  quotaGroupId?: string;
  staleAfterReset?: boolean;
  fractionReported?: boolean;
}
export interface HealthData {
  quotas?: HealthQuota[];
  stale?: unknown;
  raw?: {
    fetchedAt?: string;
    _stale?: boolean;
    paidCredits?: CodexPaidCredits;
    quotas?: Record<string, Partial<HealthQuota>>;
    quotaGroups?: Array<{
      id: string;
      displayName?: string;
      models?: string[];
      windows?: Record<string, Partial<HealthQuota>>;
    }>;
  };
}
export interface HealthConnection {
  provider: string;
  quotaWindowThresholds?: Record<string, number> | null;
  providerSpecificData?: {
    quotaPreflightEnabled?: boolean;
    blockExtraUsage?: boolean;
    allowPaidCredits?: boolean;
    limitPolicy?: { enabled?: boolean };
  };
  id: string;
  name?: string;
  displayName?: string;
  email?: string;
  isActive?: boolean;
  testStatus?: string | null;
  rateLimitedUntil?: string | number | null;
  lastErrorAt?: string | number | null;
  lastErrorType?: string | null;
  updatedAt?: string;
  runtimeObservedAt?: string;
}
export interface HealthCooldown {
  id: string;
  status: string;
  isActive?: boolean;
  testStatus?: string | null;
  rateLimitedUntil?: string | number | null;
  lastErrorAt?: string | number | null;
  cooldownRemainingMs?: number;
  lastErrorType?: string | null;
  lockouts: Array<{ model: string; remainingMs: number; reason: string }>;
}
export interface AvailabilityEvidence {
  activeConfirmation?: { isActive: boolean; confirmedAt: string };
  availability?: ConnectionQuotaAvailability;
  availabilityObservedAt?: string | number;
  cooldown?: HealthCooldown;
  /** First local observation of this connection + cooldown-until pair. */
  cooldownObservedAt?: number;
  cooldownDeadline?: number;
  cooldownStartedAt?: number;
  summaryFailed?: boolean;
  observedAt?: string | number;
  error?: string | null;
}
export type HealthScope = "account" | "group" | "scoped";
export interface HealthReason {
  type:
    | "paused"
    | "terminal"
    | "cooldown"
    | "scopeCooldown"
    | "peakHour"
    | "quota"
    | "quotaBypass"
    | "cutoffNotEvaluated"
    | "lockout"
    | "previousFailure"
    | "awaitingSync"
    | "verdictUnavailable"
    | "previousSnapshot"
    | "noQuota"
    | "quotaError"
    | "noRuntime";
  bypass?: QuotaBypass;
  scope?: HealthScope;
  scopeId?: string;
  window?: string;
  percent?: number;
  cutoff?: number;
  resetAt?: string | null;
  /** Fixed total runtime cooldown duration; never recomputed from the ticking clock. */
  durationMs?: number;
  terminal?: string;
  error?: string;
}
export interface HealthCell {
  name: string;
  displayName?: string;
  percent: number;
  resetAt: string | null;
  scope: HealthScope;
  scopeId?: string;
  window: "fiveHour" | "overall" | null;
  awaitingSync: boolean;
  quotaIgnored?: boolean;
}
export interface HealthAccount {
  quotaAvailability?: ConnectionQuotaAvailability;
  quotaAvailabilityValidUntil?: number;
  runtimeAvailability?: ProviderAvailability;
  quotaPools?: Array<{ id: string; models?: string[] }>;
  connection: HealthConnection;
  cells: HealthCell[];
  reasons: HealthReason[];
  status: HealthStatus;
  partial: boolean;
  recoverAt?: string;
  quotaObservedAt?: string;
  runtimeObservedAt?: string;
}
const RANK = { critical: 0, alert: 1, ok: 2, paused: 3, empty: 4 };
export function resolveQuotaLayout(saved: string | null): QuotaLayout {
  return saved === "full" || saved === "compact" ? saved : "overview";
}
function textWindow(value: string): "fiveHour" | "overall" | null {
  if (/week|month|overall|total|7\s*d\b|seven[_\s-]?day/i.test(value)) return "overall";
  if (/session|five[_\s-]?hour|5\s*(?:h\b|hours?)/i.test(value)) return "fiveHour";
  return null;
}
/** Display labels/durations outrank legacy keys: Codex's `session` can actually be Weekly.
 * Time-to-reset only disproves a short window; a weekly window near reset is NOT a 5h window.
 * Use the fixed capture time, never the ticking UI clock, to keep topology stable on refresh.
 */
export function normalizeHealthWindow(
  quota: HealthQuota,
  fetchedAt?: string
): "fiveHour" | "overall" | null {
  if (quota.windowSeconds != null && quota.windowSeconds > 0)
    return quota.windowSeconds <= 5 * 3600 ? "fiveHour" : "overall";
  const display = textWindow(quota.displayName || "");
  if (display) return display;
  const explicit = textWindow(quota.window || "");
  if (explicit) return explicit;
  const named = textWindow(quota.name);
  const duration = Date.parse(quota.resetAt || "") - Date.parse(fetchedAt || "");
  return named === "fiveHour" && duration > 5 * 3_600_000 + 60_000 ? "overall" : named;
}
// Explicit frontend scope contracts only; all unproven names are account-wide.
// src/domain/quotaCache.ts:isCodexQuotaExhausted uses the model filter in
// open-sse/config/codexQuotaScopes.ts; usage keys come from services/codexUsageQuotas.ts.
// Display-only reserve windows are excluded below, as in quotaCache.ts:setQuotaCache.
const CODEX_SCOPED_WINDOWS: Record<string, string> = {
  gpt_5_3_codex_spark_session: "spark",
  gpt_5_3_codex_spark_weekly: "spark",
  "codex-spark": "spark",
  "codex-spark-weekly": "spark",
  code_review: "code_review",
  code_review_weekly: "code_review",
};
/** All blocked is red, mixed usable/blocked is yellow, incomplete evidence is never green.
 * Paused accounts have their own count and never contribute to the available count.
 */
export function aggregateAvailability(statuses: HealthStatus[]): HealthStatus {
  if (statuses.length && statuses.every((s) => s === "paused")) return "paused";
  const active = statuses.filter((s) => s !== "paused");
  if (!active.length || active.every((s) => s === "empty")) return "empty";
  if (active.every((s) => s === "critical")) return "critical";
  if (active.every((s) => s === "ok")) return "ok";
  if (active.some((s) => s === "critical" || s === "alert")) return "alert";
  return "empty";
}
/** Availability ignores ALL display hiding. Raw values also prevent reset-adjusted display 100% from fabricating a recovery. */
export function buildHealthAccount(
  connection: HealthConnection,
  data: HealthData | undefined,
  _visibility: Record<string, { hidden?: string[] }> = {},
  now = Date.now(),
  evidence: AvailabilityEvidence = {}
): HealthAccount {
  const quotas = new Map<string, HealthQuota>();
  for (const q of data?.quotas || []) quotas.set(q.name, q);
  for (const [name, q] of Object.entries(data?.raw?.quotas || {}))
    quotas.set(name, { ...quotas.get(name), ...q, name });
  for (const g of data?.raw?.quotaGroups || []) {
    for (const [window, q] of Object.entries(g.windows || {})) {
      const name = `${g.id}_${window}`;
      quotas.set(name, { ...quotas.get(name), ...q, name, window, quotaGroupId: g.id });
    }
  }
  const cells: HealthCell[] = [];
  const reasons: HealthReason[] = [];
  const blocked: HealthReason[] = [];
  // Explicit groups describe independent pools; a scoped model never becomes an extra account.
  const groups = new Set((data?.raw?.quotaGroups || []).map((g) => g.id));
  // Every quota below is display-only; constraints come exclusively from the server.
  const availabilityUntil = parseRuntimeTimestamp(evidence.availabilityObservedAt) + 90_000;
  const availability = availabilityUntil >= now ? evidence.availability : undefined;
  const decisions = availability
    ? [
        { scope: "account" as const, scopeId: undefined, decision: availability.account },
        ...availability.scopes.map((s) => ({ scope: s.kind, scopeId: s.id, decision: s.decision })),
      ]
    : [];
  for (const { scope, scopeId, decision } of decisions) {
    if (decision.cutoffEvaluated === false && !reasons.some((r) => r.type === "cutoffNotEvaluated"))
      reasons.push({ type: "cutoffNotEvaluated" });
    if (decision.usable === false)
      for (const blocker of decision.blockers)
        blocked.push({
          type: blocker.reason === "modelLockout" ? "lockout" : blocker.reason || "quota",
          scope,
          scopeId,
          window: blocker.name,
          resetAt: blocker.resetAt,
          percent: blocker.remainingPercent,
          cutoff: blocker.cutoffPercent,
        });
    for (const bypass of decision.allowanceReasons) {
      if (!reasons.some((r) => r.type === "quotaBypass" && r.bypass === bypass))
        reasons.push({ type: "quotaBypass", bypass });
    }
  }
  for (const q of quotas.values()) {
    if (
      q.isCredits ||
      q.isResetCredits ||
      // quotaCache.ts:setQuotaCache omits these display-only Codex reserve windows.
      (connection.provider === "codex" && ["reserve_session", "reserve_weekly"].includes(q.name)) ||
      q.fractionReported === false ||
      /^(extra_usage|banked_reset_credits)$/.test(q.name) ||
      (q.name === "credits" &&
        !(connection.provider === "openrouter" && (q.total ?? 0) > 0 && !q.unlimited))
    )
      continue;
    const percent = quotaPercentage(q);
    if (percent === null) continue;
    const window = normalizeHealthWindow(q, data?.raw?.fetchedAt);
    // usage/antigravity.ts and antigravityWeeklyQuota.ts identify independent pools.
    // Claude provenance is marked by parseClaude from usage/claudeQuota.ts:modelQuotas.
    // AGY exact-model windows: services/antigravityQuotaFamily.ts:selectAntigravityQuotaWindowNames
    // is used by src/domain/quotaCache.ts:isAntigravityQuotaExhausted. modelKey comes from parseAntigravity.
    // OpenRouter: services/openrouterQuotaFetcher.ts:checkFreeWindowExhausted and
    // executors/base.ts recordFreeWindowAttempt only apply these counters to :free models.
    const scopeId =
      q.quotaGroupId ||
      (connection.provider === "claude" && q.modelScoped === true
        ? q.name
        : ["antigravity", "agy"].includes(connection.provider) && q.modelKey
          ? q.modelKey
          : connection.provider === "openrouter" && ["free_daily", "free_rpm"].includes(q.name)
            ? ":free"
            : connection.provider === "codex" && Object.hasOwn(CODEX_SCOPED_WINDOWS, q.name)
              ? CODEX_SCOPED_WINDOWS[q.name]
              : undefined);
    const scope: HealthScope = q.quotaGroupId ? "group" : scopeId ? "scoped" : "account";
    if (scope === "group" && scopeId) groups.add(scopeId);
    const awaitingSync = !!q.staleAfterReset || Date.parse(q.resetAt || "") <= now;
    if (awaitingSync) reasons.push({ type: "awaitingSync", window: q.name });
    cells.push({
      name: q.name,
      displayName: q.displayName,
      percent,
      resetAt: q.resetAt || null,
      scope,
      scopeId: scopeId || undefined,
      window,
      awaitingSync,
      // Meter selection only: allowance reasons never override the server's usable field.
      quotaIgnored: decisions.some(({ decision }) =>
        decision.allowanceReasons.some(
          (reason) =>
            reason === "extraUsage" ||
            reason === "filteringDisabled" ||
            (reason === "paidCredits" && scopeId !== "spark")
        )
      ),
    });
  }
  if (!availability || availability.account.usable === null)
    reasons.push({ type: "verdictUnavailable" });
  if (cells.length && (data?.stale || data?.raw?._stale || evidence.error))
    reasons.push({ type: "previousSnapshot" });
  if (!cells.length)
    reasons.push(
      evidence.error ? { type: "quotaError", error: evidence.error } : { type: "noQuota" }
    );
  const {
    row,
    runtime: selectedRuntime,
    summaryTime,
    lockouts,
    until: reportedUntil,
    isActive,
  } = runtimeCooldownEvidence(connection, evidence, now);
  const runtime = {
    ...selectedRuntime,
    isActive,
  };
  const testStatus = runtime.testStatus?.trim().toLowerCase();
  const runtimeAvailable =
    !!row ||
    [connection.isActive, connection.testStatus, connection.rateLimitedUntil].some(
      (v) => v !== undefined
    );
  if (!runtimeAvailable) reasons.push({ type: "noRuntime" });
  // Pause is a separate display state. Let the upstream classifier own terminal
  // membership and freshness; STALE_TERMINAL still needs attention, never a timer.
  const until = evidence.cooldownDeadline ?? reportedUntil;
  const errorAt = parseRuntimeTimestamp(runtime.lastErrorAt);
  const runtimeAvailability = resolveProviderAvailability(
    {
      isActive: true,
      testStatus,
      lastErrorType: runtime.lastErrorType,
      rateLimitedUntil: Number.isFinite(until) ? String(until) : null,
      lastErrorAt: Number.isFinite(errorAt) ? String(errorAt) : null,
    },
    now
  );
  const terminal = ["AUTH_EXPIRED", "QUOTA_EXHAUSTED", "DISABLED", "STALE_TERMINAL"].includes(
    runtimeAvailability.state
  )
    ? { type: "terminal" as const, terminal: testStatus }
    : null;
  const startedAt =
    evidence.cooldownStartedAt ??
    (evidence.cooldownObservedAt !== undefined
      ? Math.min(
          evidence.cooldownObservedAt,
          Number.isFinite(errorAt) && errorAt < until ? errorAt : Infinity
        )
      : Number.isFinite(errorAt) && errorAt < until
        ? errorAt
        : now);
  const cooldown: HealthReason | null =
    until > now
      ? {
          type: "cooldown",
          resetAt: new Date(until).toISOString(),
          durationMs: Math.max(1, until - startedAt),
        }
      : null;
  if (testStatus === "unavailable" && !cooldown) reasons.push({ type: "previousFailure" });
  const locks: HealthReason[] = lockouts.flatMap((l) => {
    const end = summaryTime + l.remainingMs;
    return summaryTime && end > now
      ? [
          {
            type: "lockout" as const,
            scope: "scoped" as const,
            window: l.model,
            resetAt: new Date(end).toISOString(),
          },
        ]
      : [];
  });
  const allGroupsBlocked =
    groups.size > 0 &&
    [...groups].every((g) => blocked.some((r) => r.scope === "group" && r.scopeId === g));
  let status: HealthStatus;
  if (runtime.isActive === false) status = "paused";
  else if (terminal || cooldown || availability?.account.usable === false || allGroupsBlocked)
    status = "critical";
  else if (!availability || availability.account.usable === null) status = "empty";
  else if (blocked.length || locks.length) status = "alert";
  else if (!runtimeAvailable) status = "empty";
  else status = "ok";
  if (status === "paused") reasons.unshift({ type: "paused" });
  if (cooldown) reasons.unshift(cooldown);
  if (terminal) reasons.unshift(terminal);
  reasons.push(...blocked, ...locks);
  const constraints = [
    ...blocked,
    ...locks,
    ...(cooldown ? [cooldown] : []),
    ...(terminal ? [terminal] : []),
  ];
  const times = constraints.map((r) => Date.parse("resetAt" in r ? r.resetAt || "" : ""));
  const recoverAt =
    ["critical", "alert"].includes(status) && times.length && times.every((t) => t > now)
      ? new Date(Math.max(...times)).toISOString()
      : undefined;
  return {
    runtimeAvailability: runtime.isActive === false ? { state: "DISABLED" } : runtimeAvailability,
    quotaPools: data?.raw?.quotaGroups?.map(({ id, models }) => ({ id, models })),
    connection,
    cells,
    reasons,
    status,
    recoverAt,
    quotaAvailability: availability,
    quotaAvailabilityValidUntil: availabilityUntil,
    partial: !row || !availability,
    quotaObservedAt: availability?.account.fetchedAt || undefined,
    runtimeObservedAt: row
      ? new Date(summaryTime).toISOString()
      : connection.runtimeObservedAt || connection.updatedAt,
  };
}
/** Provider-only groups, exactly one row per account; no family or window buckets. */
export function buildHealthGroups(
  accounts: HealthAccount[],
  providerOrder: string[] | Record<string, number> = {}
) {
  const providers = new Map<string, HealthAccount[]>();
  for (const a of accounts)
    providers.set(a.connection.provider, [...(providers.get(a.connection.provider) || []), a]);
  const rank = (id: string) => {
    const n = Array.isArray(providerOrder) ? providerOrder.indexOf(id) : providerOrder[id];
    return n === undefined || n < 0 ? Infinity : n;
  };
  return [...providers]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([provider, list]) => {
      const counts: Record<HealthStatus, number> = {
        critical: 0,
        alert: 0,
        ok: 0,
        paused: 0,
        empty: 0,
      };
      const sorted = [...list].sort(
        (a, b) =>
          RANK[a.status] - RANK[b.status] ||
          (
            a.connection.name ||
            a.connection.displayName ||
            a.connection.email ||
            a.connection.id
          ).localeCompare(
            b.connection.name || b.connection.displayName || b.connection.email || b.connection.id
          ) ||
          a.connection.id.localeCompare(b.connection.id)
      );
      for (const a of sorted) counts[a.status]++;
      return {
        provider,
        total: list.length,
        counts,
        status: aggregateAvailability(list.map((a) => a.status)),
        accounts: sorted,
      };
    });
}
