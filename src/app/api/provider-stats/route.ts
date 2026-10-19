import { NextResponse } from "next/server";
import {
  buildProviderStatsSince,
  getProviderCallStats,
  getModelCallStats,
} from "@/lib/db/providerStats";
import { serveAnalyticsCached } from "@/lib/usage/analyticsResponseCache";
import { AI_PROVIDERS } from "@/shared/constants/providers";

export async function GET() {
  // The dashboard polls this route every 30 s from every mounted tab; the
  // windowed aggregates plus the in-memory sections are cached briefly so a
  // large call_logs history does not hold the event loop on each poll.
  return serveAnalyticsCached("provider-stats", async () => {
    try {
      // Hard Rule #5: SQL lives in src/lib/db/providerStats.ts, not inline here.
      const since = buildProviderStatsSince();
      const providerStats = getProviderCallStats(since);
      const modelStats = getModelCallStats(since);

      let comboMetrics: Record<string, unknown> = {};
      try {
        const { getAllComboMetrics } = await import(
          "@omniroute/open-sse/services/comboMetrics.ts"
        );
        comboMetrics = getAllComboMetrics() as Record<string, unknown>;
      } catch {}

      let telemetry: Record<string, unknown> = {};
      try {
        const { getTelemetrySummary } = await import("@/shared/utils/requestTelemetry");
        telemetry = getTelemetrySummary(300000) as Record<string, unknown>;
      } catch {}

      let toolLatency: Record<string, unknown> = {};
      try {
        const { getToolLatencyByProvider } = await import(
          "@omniroute/open-sse/services/toolLatencyTracker"
        );
        toolLatency = getToolLatencyByProvider() as Record<string, unknown>;
      } catch {}

      const resolveName = (provider: string, nodeName: string | null) => {
        if (nodeName?.trim()) return nodeName.trim();
        const info = AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS];
        return info?.name || provider;
      };

      const providers = providerStats.map((p: any) => ({
        ...p,
        provider: resolveName(p.provider, p.nodeName),
      }));

      const models = modelStats.map((m: any) => ({
        ...m,
        provider: resolveName(m.provider, m.nodeName),
      }));

      return NextResponse.json({
        providers,
        models,
        comboMetrics,
        telemetry,
        toolLatency,
        windowSince: since,
      });
    } catch (error) {
      console.error("Error fetching provider stats:", error);
      return NextResponse.json({ error: "Failed to fetch provider stats" }, { status: 500 });
    }
  });
}
