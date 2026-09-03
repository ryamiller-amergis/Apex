/**
 * Pure derivations over a Cloud Agent run's reported check results (FEAT-003 TBI-005).
 * Called from the session projection so the wire response already carries the
 * row-ready values and the client never re-derives this logic.
 */

import type { RunCheckKind, RunCheckResult } from '../types/agentRunLifecycle';

/**
 * The kinds that failed, in the order the run reported them.
 * A run with no reported results has nothing to show as failing.
 */
export function deriveFailingChecks(results: RunCheckResult[] | null | undefined): RunCheckKind[] {
  if (!results) return [];
  return results.filter((result) => result.outcome === 'failed').map((result) => result.kind);
}

/**
 * Whether the row may state that all checks passed.
 *
 * A run that finished without a PR never claims passed checks (TBI-005 DoD-2),
 * and neither does a run that reported no results at all.
 */
export function shouldClaimAllChecksPassed(
  results: RunCheckResult[] | null | undefined,
  finishedWithoutPr: boolean,
): boolean {
  if (finishedWithoutPr) return false;
  if (!results || results.length === 0) return false;
  return results.every((result) => result.outcome === 'passed');
}
