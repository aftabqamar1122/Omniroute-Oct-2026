"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { resolveQuotaLayout, type QuotaLayout } from "./healthOverview";

const STORAGE_KEY = "omniroute:limits:layoutMode";
const MODES = ["overview", "full", "compact"] as const;
const LABELS = {
  overview: "healthOverview",
  full: "layoutFull",
  compact: "layoutCompact",
} as const;

export function useQuotaLayout() {
  const [layoutMode, setLayoutMode] = useState<QuotaLayout>(() => {
    if (typeof window === "undefined") return "overview";
    try {
      return resolveQuotaLayout(localStorage.getItem(STORAGE_KEY));
    } catch {
      // Storage can be blocked; keep the default overview usable.
      return "overview";
    }
  });
  const selectLayout = (mode: QuotaLayout) => {
    setLayoutMode(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // A preference write must not prevent switching layouts.
    }
  };
  return { layoutMode, selectLayout };
}

export default function QuotaLayoutPicker({
  value,
  onChange,
}: {
  value: QuotaLayout;
  onChange: (mode: QuotaLayout) => void;
}) {
  const t = useTranslations("usage");
  return (
    <div
      className="inline-flex rounded-lg border border-border bg-bg-subtle p-0.5"
      role="group"
      aria-label={t("providerLimits")}
    >
      {MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
          className={`rounded-md px-2 py-1 text-xs cursor-pointer focus-visible:outline-2 focus-visible:outline-primary ${value === mode ? "bg-surface text-text-main shadow-sm" : "text-text-muted hover:text-text-main"}`}
        >
          {t(LABELS[mode])}
        </button>
      ))}
    </div>
  );
}
