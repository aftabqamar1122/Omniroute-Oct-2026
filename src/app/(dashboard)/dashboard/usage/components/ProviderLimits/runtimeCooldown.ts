import { resolveProviderAvailability } from "@/lib/providerAvailability";
import type { AvailabilityEvidence, HealthConnection, HealthCooldown } from "./healthOverview";

/** Client-only equivalent of services/accountFallback.ts:cooldownUntilMs (#3954).
 * Do not import the server fallback module (DB/auth side effects) into the dashboard.
 */
export function parseRuntimeTimestamp(value: string | number | Date | null | undefined): number {
  if (value === null || value === undefined || value === "") return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const raw = value.trim();
  return /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : new Date(raw).getTime();
}

export const SUMMARY_FRESHNESS_MS = 90_000;
export function hasTerminalStatus(runtime: { testStatus?: string | null }): boolean {
  // Without a confirmation time the shared classifier preserves every terminal
  // status as STALE_TERMINAL; do not maintain a separate terminal-status list.
  return resolveProviderAvailability({ testStatus: runtime.testStatus }).state === "STALE_TERMINAL";
}
/** Connection fields use the newer observation, including explicit null clears.
 * In-memory model locks have no DB counterpart and use only a fresh summary.
 * Summary schema: src/lib/resilience/cooldownManager.ts:toCooldownConnection.
 */
export function runtimeCooldownEvidence(
  connection: HealthConnection,
  evidence: AvailabilityEvidence,
  now = Date.now()
) {
  const summaryTime = parseRuntimeTimestamp(evidence.observedAt);
  const connectionTime = parseRuntimeTimestamp(
    connection.runtimeObservedAt || connection.updatedAt
  );
  const summary =
    Number.isFinite(summaryTime) && evidence.cooldown?.id === connection.id
      ? evidence.cooldown
      : undefined;
  const fresh = !evidence.summaryFailed && now - summaryTime <= SUMMARY_FRESHNESS_MS;
  const terminal = !!summary && hasTerminalStatus(summary);
  const newerConnection =
    connectionTime > summaryTime && (!terminal || connection.testStatus !== undefined);
  // Losing freshness is not recovery evidence. Only a newer connection state or
  // a later successful summary may supersede a confirmed terminal status.
  const row = summary && (fresh || terminal) && !newerConnection ? summary : undefined;
  const runtime = row || connection;
  const explicit = parseRuntimeTimestamp(row && !fresh ? undefined : runtime.rateLimitedUntil);
  const derived = !Number.isFinite(explicit) && !!row && fresh && row.cooldownRemainingMs > 0;
  const until = Number.isFinite(explicit)
    ? explicit
    : derived
      ? summaryTime + row.cooldownRemainingMs
      : 0;
  const lockouts: HealthCooldown["lockouts"] = fresh ? summary?.lockouts || [] : [];
  return {
    row,
    runtime,
    summaryTime,
    derived,
    until,
    lockouts,
    isActive:
      evidence.activeConfirmation &&
      parseRuntimeTimestamp(evidence.activeConfirmation.confirmedAt) >
        Math.max(
          Number.isFinite(connectionTime) ? connectionTime : 0,
          summary?.isActive !== undefined ? summaryTime : 0
        )
        ? evidence.activeConfirmation.isActive
        : (runtime.isActive ?? connection.isActive),
  };
}
/** The same absolute runtime deadline is used by capture and projection. */
export function runtimeCooldownUntil(
  connection: HealthConnection,
  evidence: AvailabilityEvidence,
  now = Date.now()
) {
  return runtimeCooldownEvidence(connection, evidence, now).until;
}
export interface CooldownObservation {
  until: number;
  derived: boolean;
  observedAt: number;
  startedAt: number;
}
export function sameCooldown(
  old: CooldownObservation | undefined,
  next: { until: number; derived: boolean }
) {
  return (
    !!old &&
    (old.until === next.until ||
      (old.derived && next.derived && Math.abs(old.until - next.until) <= 5000))
  );
}
