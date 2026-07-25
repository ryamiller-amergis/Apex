/**
 * Load-test run status transition table (FEAT-007 / A-003).
 * Illegal transitions are rejected by the service with 409.
 */
import type { RunStatus } from '../../../shared/types/loadTest';
import { LoadTestValidationError } from '../../../shared/types/loadTest';

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  'passed',
  'failed',
  'errored',
  'cancelled',
]);

export const ACTIVE_EXECUTION_STATUSES: ReadonlySet<RunStatus> = new Set([
  'dispatched',
  'running',
]);

/** Statuses that occupy the one-run-per-target execution lock. */
export const LOCK_STATUSES: RunStatus[] = ['dispatched', 'running'];

const ALLOWED: Record<RunStatus, ReadonlySet<RunStatus>> = {
  queued: new Set(['dispatched', 'cancelled', 'errored']),
  // Final may arrive before an explicit progress heartbeat (cold start → complete).
  dispatched: new Set(['running', 'passed', 'failed', 'cancelled', 'errored']),
  running: new Set(['passed', 'failed', 'errored', 'cancelled']),
  passed: new Set(),
  failed: new Set(),
  errored: new Set(),
  cancelled: new Set(),
};

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (from === to) return;
  if (!ALLOWED[from]?.has(to)) {
    throw new LoadTestValidationError(
      `Illegal load-test run status transition: ${from} → ${to}`,
      'LOAD_TEST_ILLEGAL_TRANSITION',
    );
  }
}

/** Derive terminal pass/fail from client-side threshold results only (BR-007). */
export function evaluateThresholdOutcome(
  results: Array<{ passed: boolean; evaluated?: boolean }> | null | undefined,
): 'passed' | 'failed' | 'errored' {
  if (!results || results.length === 0) return 'errored';
  // Missing k6 evaluation (empty summary / no ok flag) is incomplete — not Fail.
  if (results.some((r) => r.evaluated === false)) return 'errored';
  return results.every((r) => r.passed) ? 'passed' : 'failed';
}
