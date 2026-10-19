"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useNow } from "next-intl";
import { pickDisplayValue } from "@/shared/utils/maskEmail";
import {
  buildHealthAccount,
  type HealthAccount,
  type HealthConnection,
  type HealthData,
} from "./healthOverview";
import {
  displayAccount,
  displayPool,
  poolIds,
  compareDisplayAccounts,
  DISPLAY_COLORS,
  DISPLAY_LABELS,
  type DisplayAccount,
} from "./availabilityDisplay";
import HealthAccountTooltip from "./HealthAccountTooltip";
import { useHealthText } from "./useHealthText";
import { useProviderOrder } from "./useProviderOrder";
import { useLegendVisibility } from "./useLegendVisibility";
import { SortableProviderRow, ProviderSortContext } from "./ProviderRowSort";
import { CAPSULE_CLASS, capsuleStyle, CapsuleWater } from "./HealthCapsule";
import { HealthBanner, HealthLegend, HealthCounts } from "./HealthOverviewChrome";
interface Props {
  connections: HealthConnection[];
  quotaData: Record<string, HealthData>;
  accounts?: Record<string, HealthAccount>;
  quotaVisibility?: Record<string, { hidden?: string[] }>;
  providerLabels: Record<string, string>;
  emailsVisible: boolean;
  summaryFailed?: boolean;
  renderCard: (connection: HealthConnection) => ReactNode;
}
/** One capsule per account in each independent pool. The existing detail card retains all operations. */
export default function QuotaHealthOverview({
  connections,
  quotaData,
  accounts,
  providerLabels,
  emailsVisible,
  summaryFailed = false,
  renderCard,
}: Props) {
  const { t, all, relative, primary, poolLabel } = useHealthText();
  const id = useId();
  const { legendHidden, toggleLegend } = useLegendVisibility();
  const now = useNow({ updateInterval: 1000 }).getTime();
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; pool?: string; anchor: HTMLElement } | null>(
    null
  );
  const rows = useMemo(
    () =>
      connections.map((c) => accounts?.[c.id] || buildHealthAccount(c, quotaData[c.id], {}, now)),
    [connections, accounts, quotaData, now]
  );
  const {
    order: completeOrder,
    custom,
    reset,
    reorder,
  } = useProviderOrder(
    Object.values(accounts || {})
      .map((a) => a.connection.provider)
      .concat(connections.map((c) => c.provider))
  );
  const order = completeOrder.filter((provider) =>
    connections.some((c) => c.provider === provider)
  );
  const groups = order.map((provider) => ({
    provider,
    accounts: rows.filter((a) => a.connection.provider === provider),
  }));
  const display = rows.map((a) => displayAccount(a, now));
  const selectedAccount = rows.find((a) => a.connection.id === selected);
  const previewAccount = preview && rows.find((a) => a.connection.id === preview.id);
  const currentPreview =
    previewAccount &&
    (preview.pool
      ? displayPool(previewAccount, preview.pool, now)
      : displayAccount(previewAccount, now));
  // Invalidate state, not merely its rendering: restoring a filtered account must not reopen details.
  if (selected && !selectedAccount) setSelected(null);
  if (preview && !currentPreview) setPreview(null);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreview(null);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, []);
  const label = (c: HealthConnection) =>
    pickDisplayValue([c.name, c.displayName, c.email], emailsVisible, c.provider) || c.id;
  const oldest = (key: "runtimeObservedAt" | "quotaObservedAt") =>
    rows
      .map((a) => a[key])
      .filter((v) => v && Number.isFinite(Date.parse(v)))
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const capsules = (list: DisplayAccount[]) => (
    <div className="flex min-w-0 flex-wrap gap-x-[4px] gap-y-[6px]">
      {[...list].sort(compareDisplayAccounts).map((a) => {
        const expanded = selected === a.connection.id;
        const visualKind = a.kind;
        return (
          <button
            key={a.connection.id}
            type="button"
            data-availability={a.status}
            data-kind={a.kind}
            data-account={a.connection.id}
            aria-label={`${label(a.connection)}${a.poolId ? ` · ${poolLabel(a.poolId)}` : ""} · ${all(DISPLAY_LABELS[a.kind])} · ${primary(a)}`}
            aria-describedby={
              preview?.id === a.connection.id && preview?.pool === a.poolId
                ? `${id}-preview`
                : undefined
            }
            aria-expanded={expanded}
            aria-controls={expanded ? `${id}-details` : undefined}
            onMouseEnter={(e) =>
              setPreview({ id: a.connection.id, pool: a.poolId, anchor: e.currentTarget })
            }
            onMouseLeave={() => setPreview(null)}
            onFocus={(e) =>
              setPreview({ id: a.connection.id, pool: a.poolId, anchor: e.currentTarget })
            }
            onBlur={() => setPreview(null)}
            onClick={() => setSelected(expanded ? null : a.connection.id)}
            className={`${CAPSULE_CLASS} cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary hover:brightness-110 ${visualKind === "empty" ? "border border-dashed border-text-muted" : ""}`}
            style={capsuleStyle(visualKind)}
          >
            <CapsuleWater kind={visualKind} fill={a.fill} partial={a.partial} />
          </button>
        );
      })}
    </div>
  );
  return (
    <div className="min-w-0 space-y-[14px]">
      <HealthBanner accounts={display} />
      <div className="min-w-0 rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center gap-[10px] border-b border-border px-[18px] py-[14px]">
          <h2 className="text-[15px] font-semibold">{t("healthTitle")}</h2>
          <span className="min-w-0 text-xs text-text-muted">
            {t("healthAccountHint")} ·{" "}
            {t("healthRuntimeObserved", { time: relative(oldest("runtimeObservedAt")) })} ·{" "}
            {t("healthOldestQuota", { time: relative(oldest("quotaObservedAt")) })}
          </span>
          <button
            type="button"
            className="ml-auto text-xs text-primary"
            aria-expanded={!legendHidden}
            aria-controls={`${id}-legend`}
            onClick={toggleLegend}
          >
            {t(legendHidden ? "healthLegendShow" : "healthLegendHide")}
          </button>
          {custom && (
            <button type="button" data-reset-order className="text-xs text-primary" onClick={reset}>
              ↺ {t("healthResetOrder")}
            </button>
          )}
        </div>
        <HealthLegend id={`${id}-legend`} hidden={legendHidden} />
        {summaryFailed && (
          <p
            data-summary-warning
            role="note"
            className="m-3 rounded border border-yellow-500/40 bg-yellow-500/10 p-2 text-xs text-text-main"
          >
            {t("healthSummaryFailed")}
          </p>
        )}
        <ProviderSortContext ids={order} labels={providerLabels} onReorder={reorder}>
          {groups.map((group) => {
            const list = group.accounts.map((a) => displayAccount(a, now));
            const ids = [...new Set(group.accounts.flatMap(poolIds))].sort();
            const worst =
              list.find((a) => a.kind === "cdw" || a.kind === "act") ||
              list.find((a) => a.kind === "cd5") ||
              list.find((a) => a.partial) ||
              list[0];
            return (
              <SortableProviderRow
                key={group.provider}
                id={group.provider}
                label={providerLabels[group.provider] || group.provider}
                header={
                  <>
                    <span
                      aria-hidden
                      className="h-[9px] w-[9px] shrink-0 rounded-full"
                      style={{
                        background:
                          worst?.partial && worst.kind === "ok"
                            ? "#eab308"
                            : DISPLAY_COLORS[worst?.kind || "empty"],
                      }}
                    />
                    <h3 className="break-words text-sm font-semibold">
                      {providerLabels[group.provider] || group.provider}
                    </h3>
                    <span className="text-xs text-text-muted">
                      {t("accountsCount", { count: group.accounts.length })}
                    </span>
                    <HealthCounts accounts={list} />
                  </>
                }
              >
                {ids.length
                  ? ids.map((pool) => {
                      const poolAccounts = group.accounts.map((a) => displayPool(a, pool, now));
                      return (
                        <div
                          key={pool}
                          data-subpool={pool}
                          className="mb-[10px] ml-5 min-w-0 border-l-2 border-border pl-3 last:mb-0"
                        >
                          <div className="mb-[7px] flex flex-wrap items-center gap-2 text-xs">
                            <b>{poolLabel(pool)}</b>
                            <HealthCounts accounts={poolAccounts} />
                          </div>
                          {capsules(poolAccounts)}
                        </div>
                      );
                    })
                  : capsules(list)}
              </SortableProviderRow>
            );
          })}
        </ProviderSortContext>
      </div>
      {currentPreview && (
        <HealthAccountTooltip
          id={`${id}-preview`}
          account={currentPreview}
          label={`${label(currentPreview.connection)}${preview.pool ? ` · ${poolLabel(preview.pool)}` : ""}`}
          anchor={preview.anchor}
          otherPools={
            preview.pool
              ? poolIds(previewAccount)
                  .filter((p) => p !== preview.pool)
                  .map((p) => displayPool(previewAccount, p, now))
              : undefined
          }
        />
      )}
      {selectedAccount && (
        <div id={`${id}-details`} className="max-w-2xl space-y-2">
          <h4 className="text-sm font-medium text-text-main">
            {label(selectedAccount.connection)} · {t("columnDetails")}
          </h4>
          {renderCard(selectedAccount.connection)}
        </div>
      )}
    </div>
  );
}
