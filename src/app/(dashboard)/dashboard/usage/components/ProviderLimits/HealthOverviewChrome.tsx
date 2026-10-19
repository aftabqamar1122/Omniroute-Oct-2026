"use client";
import { useHealthText } from "./useHealthText";
import {
  countDisplay,
  DISPLAY_COLORS,
  DISPLAY_LABELS,
  type DisplayAccount,
  type DisplayKind,
} from "./availabilityDisplay";
import { CAPSULE_CLASS, capsuleStyle, CapsuleWater } from "./HealthCapsule";
export function HealthCounts({ accounts }: { accounts: DisplayAccount[] }) {
  const { t, all, format } = useHealthText();
  const counts = countDisplay(accounts);
  return (
    <div
      data-group-counts
      className="ml-auto flex flex-wrap items-center gap-2 text-xs text-text-muted"
    >
      {(["cd5", "cdw", "act", "partial", "paused", "empty"] as const)
        .filter((k) => counts[k] > 0)
        .map((k) => (
          <span
            key={k}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-subtle px-2 py-px"
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: k === "partial" ? "#eab308" : DISPLAY_COLORS[k] }}
            />
            {k === "partial" ? t("healthRestricted") : all(DISPLAY_LABELS[k])}{" "}
            {format.number(counts[k])}
          </span>
        ))}
      <span className="ml-[6px]">
        {t("healthRatio", { available: counts.ok, active: counts.all - counts.paused })}
      </span>
    </div>
  );
}
export function HealthLegend({ id, hidden }: { id: string; hidden: boolean }) {
  return (
    <div
      id={id}
      inert={hidden}
      aria-hidden={hidden}
      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-in-out motion-reduce:transition-none ${hidden ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"}`}
    >
      <div className="min-h-0 overflow-hidden">
        <LegendItems />
      </div>
    </div>
  );
}
function LegendItems() {
  const { t, all, format } = useHealthText();
  return (
    <div
      data-legend
      className="grid min-w-0 grid-cols-1 gap-x-5 gap-y-2 border-b border-border px-[18px] py-3 text-xs sm:grid-cols-2 xl:grid-cols-3"
    >
      {(["ok", "cd5", "cdw", "act", "partial", "paused", "empty"] as const).map((k) => {
        const kind: DisplayKind = k === "partial" ? "ok" : k;
        return (
          <div key={k} className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className={`${CAPSULE_CLASS} !h-[22px] !w-[8px] ${kind === "empty" ? "border border-dashed border-text-muted" : ""}`}
              style={capsuleStyle(kind)}
            >
              <CapsuleWater
                kind={kind}
                fill={["ok", "cd5", "cdw"].includes(kind) ? 65 : null}
                partial={k === "partial"}
              />
            </span>
            <span>
              <b>{k === "partial" ? t("healthRestricted") : all(DISPLAY_LABELS[k])}</b>{" "}
              <span className="text-text-muted">
                {k === "ok"
                  ? t("healthLegendOk")
                  : k === "cd5" || k === "cdw"
                    ? t("healthLegendCooldown", {
                        window:
                          k === "cd5"
                            ? t("healthFiveHour")
                            : `${t("weekly")} · ${format.number(7, { style: "unit", unit: "day", unitDisplay: "long" })}`,
                      })
                    : k === "act"
                      ? t("healthLegendAction")
                      : k === "partial"
                        ? t("healthLegendPartial")
                        : ""}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
export function HealthBanner({ accounts }: { accounts: DisplayAccount[] }) {
  const { t, all, recovery, format } = useHealthText();
  const c = countDisplay(accounts),
    blocked = c.cd5 + c.cdw + c.act;
  const earliest = accounts
    .filter((a) => a.kind === "cd5" && a.recoverAt)
    .map((a) => a.recoverAt!)
    .sort()[0];
  const green = c.ok === c.all;
  return (
    <div
      data-banner
      className={`flex items-center gap-[10px] rounded-xl border px-[18px] py-[14px] ${green ? "border-green-500/35 bg-green-500/[0.07]" : "border-yellow-500/35 bg-yellow-500/[0.07]"}`}
    >
      <span
        aria-hidden
        className="h-[14px] w-[14px] shrink-0 rounded-full"
        style={{ background: green ? "#22c55e" : "#eab308" }}
      />
      <div className="min-w-0">
        <b className="text-[15px]">
          {t(green ? "healthBannerAvailable" : "healthBannerUnavailable", {
            count: green ? c.all : blocked,
          })}
        </b>
        <div className="text-xs text-text-muted">
          {(["cd5", "cdw", "act", "ok", "paused"] as const).map((k, i) => (
            <span key={k}>
              {i > 0 ? " · " : ""}
              {format.number(c[k])} {all(DISPLAY_LABELS[k])}
              {k === "cd5" && earliest
                ? ` (${t("healthFastest", { duration: recovery(earliest) })})`
                : ""}
              {k === "ok" && c.partial > 0 ? ` (${t("healthIncluded", { count: c.partial })})` : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
