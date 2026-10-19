"use client";

import { useFormatter, useNow, useTranslations } from "next-intl";
import type { HealthAccount, HealthCell, HealthReason } from "./healthOverview";
import { formatQuotaLabel } from "./utils";
import { parseRuntimeTimestamp } from "./runtimeCooldown";

/** Presentation only: the projection carries facts, never human-readable reason strings. */
export function useHealthText() {
  const t = useTranslations("usage");
  const all = useTranslations();
  const format = useFormatter();
  const now = useNow({ updateInterval: 1000 });
  const relative = (value?: string | null) =>
    value && Number.isFinite(parseRuntimeTimestamp(value))
      ? format.relativeTime(new Date(parseRuntimeTimestamp(value)), now)
      : t("tierUnknown");
  const reason = (r: HealthReason, account?: HealthAccount): string => {
    const cell = account?.cells.find((c) => c.name === r.window);
    const window = cell ? windowLabel(cell) : r.window;
    switch (r.type) {
      case "paused":
        return all("common.paused");
      case "terminal":
        return t("healthLegendAction");
      case "cooldown":
        return t("healthCooldown");
      case "scopeCooldown":
        return `${t("healthCooldown")} · ${r.scopeId || window} · ${relative(r.resetAt)}`;
      case "peakHour":
        return `${t("healthPeakHourProtection")} · ${relative(r.resetAt)}`;
      case "quota":
        return `${t(r.percent === 0 ? "healthQuotaExhausted" : "quotaCutoffsColumnHelp")} · ${window} · ${format.number(r.percent! / 100, { style: "percent", maximumFractionDigits: 1 })} ≤ ${format.number(r.cutoff! / 100, { style: "percent", maximumFractionDigits: 1 })}`;
      case "quotaBypass":
        return t(
          r.bypass === "extraUsage"
            ? "healthExtraUsageBypass"
            : r.bypass === "paidCredits"
              ? "healthPaidCreditsBypass"
              : r.bypass === "recentSuccess"
                ? "healthRecentSuccessBypass"
                : r.bypass === "purchasedBalance"
                  ? "healthPurchasedBalanceBypass"
                  : "healthFilteringBypass"
        );
      case "cutoffNotEvaluated":
        return t("healthCutoffAtRequest");
      case "lockout":
        return `${t("modelLockouts")} · ${window} · ${relative(r.resetAt)}`;
      case "quotaError":
        return `${t("healthQuotaError")} · ${r.error}`;
      case "noQuota":
        return t("noQuotaData");
      case "noRuntime":
        return t("healthNoRuntime");
      case "previousFailure":
        return t("healthPreviousFailure");
      case "previousSnapshot":
        return t("healthPreviousSnapshot");
      case "awaitingSync":
        return `${window} · ${t("healthAwaitingSync")}`;
      case "verdictUnavailable":
        return t("healthVerdictUnavailable");
    }
  };
  const primary = (account: HealthAccount) => {
    const r = account.reasons.find((r) =>
      ({
        paused: ["paused"],
        critical: ["terminal", "cooldown", "scopeCooldown", "peakHour", "quota"],
        alert: ["quota", "lockout", "scopeCooldown", "peakHour"],
        empty: ["quotaError", "noQuota", "noRuntime"],
        ok: ["previousFailure", "awaitingSync"],
      })[account.status].includes(r.type)
    );
    // Keep the accessible name short; raw constraint values belong in the shared card.
    if (!r) return t("healthAvailable");
    if (r.type === "quota")
      return t(r.percent === 0 ? "healthQuotaExhausted" : "quotaThresholdLabel");
    if (r.type === "lockout") return t("modelLockouts");
    if (r.type === "quotaError") return t("healthQuotaError");
    return reason(r, account);
  };
  const windowLabel = (cell: HealthCell) => {
    if (!cell.window) return cell.displayName || cell.name;
    const label =
      cell.window === "fiveHour"
        ? t("healthFiveHour")
        : /month/i.test(cell.displayName || cell.name)
          ? t("budgetResetMonthly")
          : /week|7d|seven/i.test(cell.displayName || cell.name) || /weekly/i.test(cell.name)
            ? t("weekly")
            : t("healthOverall");
    return cell.scope === "scoped" ? `${cell.scopeId} · ${label}` : label;
  };
  const recovery = (value: string) => {
    const minutes = Math.max(0, Math.ceil((parseRuntimeTimestamp(value) - now.getTime()) / 60_000));
    if (minutes === 0) return relative(value);
    const days = Math.floor(minutes / (24 * 60));
    const hours = Math.floor(minutes / 60) % 24;
    return format.list(
      [
        ...(days ? [format.number(days, { style: "unit", unit: "day", unitDisplay: "long" })] : []),
        ...(hours
          ? [format.number(hours, { style: "unit", unit: "hour", unitDisplay: "long" })]
          : []),
        ...(minutes % 60
          ? [format.number(minutes % 60, { style: "unit", unit: "minute", unitDisplay: "long" })]
          : []),
      ],
      { type: "unit" }
    );
  };
  const poolLabel = (id: string) =>
    t("healthPool", {
      name:
        id === "gemini" ? "Gemini" : id === "claude_gpt" ? "Claude / GPT" : formatQuotaLabel(id),
    });
  return { t, all, format, relative, recovery, reason, primary, windowLabel, poolLabel };
}
