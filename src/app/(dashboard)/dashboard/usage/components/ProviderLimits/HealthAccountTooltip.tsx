"use client";

import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { HealthAccount } from "./healthOverview";
import {
  displayAccount,
  DISPLAY_COLORS,
  DISPLAY_LABELS,
  type DisplayAccount,
} from "./availabilityDisplay";
import { useHealthText } from "./useHealthText";
export default function HealthAccountTooltip({
  id,
  account,
  label,
  anchor,
  otherPools,
}: {
  id: string;
  account: HealthAccount | DisplayAccount;
  label: string;
  anchor: HTMLElement;
  otherPools?: DisplayAccount[];
}) {
  const card = useRef<HTMLDivElement>(null);
  const { t, all, format, relative, recovery, reason, windowLabel, poolLabel } = useHealthText();
  const a = "kind" in account ? account : displayAccount(account);
  useLayoutEffect(() => {
    const position = () => {
      if (!card.current) return;
      const anchorBox = anchor.getBoundingClientRect(),
        box = card.current.getBoundingClientRect();
      card.current.style.left = `${Math.max(8, Math.min(anchorBox.left, window.innerWidth - box.width - 8))}px`;
      card.current.style.top = `${Math.max(8, Math.min(anchorBox.bottom + 8, window.innerHeight - box.height - 8))}px`;
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [anchor, account]);
  const cooling = a.kind === "cd5" || a.kind === "cdw";
  const thresholdBlocked = a.reasons.some(
    (r) => r.type === "quota" && (r.percent ?? 0) > 0 && Number.isFinite(r.cutoff)
  );
  return createPortal(
    <div
      ref={card}
      id={id}
      role="tooltip"
      className="pointer-events-none fixed z-50 max-h-[calc(100vh-16px)] w-[330px] max-w-[calc(100vw-16px)] overflow-y-auto break-words rounded-[10px] border border-border bg-surface/95 px-3 py-[10px] text-xs text-text-main shadow-xl"
    >
      <div className="mb-[6px] flex items-center justify-between gap-2">
        <b>{label}</b>
        <span
          className="shrink-0 rounded-full px-2 py-px text-[11px]"
          style={{
            color: DISPLAY_COLORS[a.kind],
            background: `color-mix(in srgb, ${DISPLAY_COLORS[a.kind]} 13%, transparent)`,
          }}
        >
          {all(DISPLAY_LABELS[a.kind])}
        </span>
      </div>
      <p>
        {cooling && <>{t("healthRecovery")}: </>}
        {a.kind === "act"
          ? t("healthLegendAction")
          : cooling
            ? `${t(thresholdBlocked ? "quotaThresholdLabel" : a.reasons.some((r) => r.type === "quota") ? "healthQuotaExhausted" : "healthCooldown")} · ${a.recoverAt ? t("healthWait", { duration: recovery(a.recoverAt), time: format.dateTime(new Date(a.recoverAt), { hour: "2-digit", minute: "2-digit" }) }) : t("healthRecoveryUnknown")}`
            : a.partial
              ? t("healthLegendPartial")
              : all(DISPLAY_LABELS[a.kind])}
      </p>
      {cooling && (
        <p>
          {t("healthWaited", {
            percent: format.number((a.fill || 0) / 100, {
              style: "percent",
              maximumFractionDigits: 0,
            }),
          })}
        </p>
      )}
      {otherPools?.map((pool) => (
        <p data-other-pool key={pool.poolId} className="mt-1 text-text-muted">
          {t("healthOtherPool", {
            pool: poolLabel(pool.poolId!),
            status: all(DISPLAY_LABELS[pool.kind]),
            remaining:
              pool.remainingPct === null
                ? t("tierUnknown")
                : format.number(pool.remainingPct / 100, {
                    style: "percent",
                    maximumFractionDigits: 1,
                  }),
          })}
        </p>
      ))}
      {a.reasons
        .filter((r) =>
          r.type === "quota"
            ? Number.isFinite(r.percent) && Number.isFinite(r.cutoff)
            : !["cooldown", "terminal"].includes(r.type)
        )
        .map((r, i) => (
          <p key={i} className="mt-0.5 text-text-muted">
            {reason(r, a)}
          </p>
        ))}
      <div className="mt-2 space-y-[6px]">
        {a.cells.map((cell) => (
          <div key={cell.name}>
            <div className="flex flex-wrap justify-between gap-2">
              <span>{windowLabel(cell)}</span>
              <span>
                {format.number(cell.percent / 100, { style: "percent", maximumFractionDigits: 1 })}
                {cell.resetAt
                  ? ` · ${t("resetsIn")} ${recovery(cell.resetAt)}`
                  : ` · ${t("healthRecoveryUnknown")}`}
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={windowLabel(cell)}
              aria-valuenow={cell.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              className="mt-1 h-[6px] overflow-hidden rounded-full bg-border/60"
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${cell.percent}%`,
                  background: cell.percent > 0 ? "#22c55e" : DISPLAY_COLORS[a.kind],
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-text-muted">
        {t("healthQuotaObserved", { time: relative(a.quotaObservedAt) })} ·{" "}
        {t("healthRuntimeObserved", { time: relative(a.runtimeObservedAt) })} ·{" "}
        {t("healthDetailsHint")}
      </p>
    </div>,
    document.body
  );
}
