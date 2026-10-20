import { getDbInstance } from "./core";

/**
 * Provider/model call statistics aggregated from `call_logs`.
 *
 * Hard Rule #5: routes must not embed raw SQL — these queries live here so the
 * /api/provider-stats route can delegate. Read-only aggregation; no writes.
 *
 * Both aggregates are bounded to the last 7 days (`PROVIDER_STATS_WINDOW_MS`):
 * on a busy instance the unbounded `GROUP BY` over the full call history held
 * the event loop for seconds on every dashboard poll. The provider guard keeps
 * only providers that still have a live connection row, so a deleted
 * connection does not resurface from its retained call_logs rows.
 */

export const PROVIDER_STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** ISO start of the 7-day window ending at `now` (defaults to the current time). */
export function buildProviderStatsSince(now: Date = new Date()): string {
  return new Date(now.getTime() - PROVIDER_STATS_WINDOW_MS).toISOString();
}

export interface ProviderCallStat {
  provider: string;
  nodeName: string | null;
  totalRequests: number;
  successfulRequests: number;
  avgLatencyMs: number | null;
  totalTokensIn: number | null;
  totalTokensOut: number | null;
}

export interface ModelCallStat {
  provider: string;
  nodeName: string | null;
  model: string;
  requests: number;
  avgLatencyMs: number | null;
  successfulRequests: number;
}

export function getProviderCallStats(since: string): ProviderCallStat[] {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT
         c.provider,
         pn.name AS nodeName,
         COUNT(*) AS totalRequests,
         SUM(CASE WHEN c.status >= 200 AND c.status < 400 THEN 1 ELSE 0 END) AS successfulRequests,
         ROUND(AVG(c.duration)) AS avgLatencyMs,
         SUM(c.tokens_in) AS totalTokensIn,
         SUM(c.tokens_out) AS totalTokensOut
       FROM call_logs c
       LEFT JOIN provider_nodes pn ON pn.id = c.provider
       WHERE c.provider IS NOT NULL AND c.provider != '-'
         AND c.timestamp >= @since
         AND EXISTS (SELECT 1 FROM provider_connections pc WHERE pc.provider = c.provider)
       GROUP BY c.provider
       ORDER BY totalRequests DESC`
    )
    .all({ since }) as ProviderCallStat[];
}

export function getModelCallStats(since: string): ModelCallStat[] {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT
         c.provider,
         pn.name AS nodeName,
         c.model,
         COUNT(*) AS requests,
         ROUND(AVG(c.duration)) AS avgLatencyMs,
         SUM(CASE WHEN c.status >= 200 AND c.status < 400 THEN 1 ELSE 0 END) AS successfulRequests
       FROM call_logs c
       LEFT JOIN provider_nodes pn ON pn.id = c.provider
       WHERE c.provider IS NOT NULL AND c.model IS NOT NULL
         AND c.timestamp >= @since
         AND EXISTS (SELECT 1 FROM provider_connections pc WHERE pc.provider = c.provider)
       GROUP BY c.provider, c.model
       ORDER BY c.provider, requests DESC`
    )
    .all({ since }) as ModelCallStat[];
}
