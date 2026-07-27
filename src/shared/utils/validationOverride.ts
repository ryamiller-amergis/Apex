/**
 * Shared audit trail for validation / readiness overrides.
 * History is newest-last; callers may reverse for display.
 */

export interface ValidationOverrideAuditEntry {
  reason: string;
  userId: string;
  userDisplayName?: string;
  at: string;
  /** Short snapshot of what was overridden (e.g. score, readiness state). */
  summary: string;
}

export interface ValidationOverrideBase {
  reason: string;
  userId: string;
  userDisplayName?: string;
  at: string;
  /** Full audit trail including the current override (newest last). */
  history?: ValidationOverrideAuditEntry[];
}

/** Resolve a displayable history list, seeding from legacy single-entry overrides. */
export function resolveOverrideHistory(
  override: ValidationOverrideBase | null | undefined,
  legacySummary: string,
): ValidationOverrideAuditEntry[] {
  if (!override) return [];
  if (override.history && override.history.length > 0) {
    return [...override.history].sort((a, b) => a.at.localeCompare(b.at));
  }
  return [
    {
      reason: override.reason,
      userId: override.userId,
      userDisplayName: override.userDisplayName,
      at: override.at,
      summary: legacySummary,
    },
  ];
}

/** Append a new audit entry, seeding from a legacy override when history is absent. */
export function buildOverrideHistory(
  prior: ValidationOverrideBase | null | undefined,
  nextEntry: ValidationOverrideAuditEntry,
  legacySummaryForPrior: string,
): ValidationOverrideAuditEntry[] {
  const priorHistory = resolveOverrideHistory(prior, legacySummaryForPrior);
  return [...priorHistory, nextEntry];
}

export function formatOverrideTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
