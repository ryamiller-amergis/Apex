/**
 * Recovery / reaper sweeps for stale checkpoints and worker_lost confirmation.
 * Missed checkpoints alone move to checking_worker; worker_lost requires a
 * negative Container Apps execution probe.
 */
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  withDistributedLease,
  type HeldDistributedLease,
} from '../aiRunV2/distributedLeaseRepository';
import type { RunAttemptRepository } from '../aiRunV2/runAttemptRepository';
import type { SqlExecutor } from '../aiRunV2/outboxRepository';
import type { Clock, ExecutionProbe, OrchestratorMetrics } from './ports';
import { noopMetrics, systemClock } from './ports';

export type StaleAttemptRow = Readonly<{
  attemptId: string;
  runId: string;
  dispatchMessageId: string;
  status: string;
  lastCheckpointAt: string | null;
  containerAppsExecutionId: string | null;
}>;

export type ReconcilerDeps = Readonly<{
  executor: SqlExecutor;
  attempts: RunAttemptRepository;
  executionProbe: ExecutionProbe;
  clock?: Clock;
  metrics?: OrchestratorMetrics;
  /** Stale if no checkpoint newer than this many ms (default 90s). */
  checkpointStaleMs?: number;
  holderId?: string;
  listStaleRunning?: () => Promise<StaleAttemptRow[]>;
  listCheckingWorkers?: () => Promise<StaleAttemptRow[]>;
  acquireRecoveryLease?: <T>(
    work: (lease: HeldDistributedLease) => Promise<T>,
  ) => Promise<T>;
  acquireReaperLease?: <T>(
    work: (lease: HeldDistributedLease) => Promise<T>,
  ) => Promise<T>;
}>;

export type Reconciler = {
  countUncertainWorkers(): Promise<number>;
  sweepStaleCheckpoints(): Promise<number>;
  sweepCheckingWorkers(): Promise<number>;
  runOnce(): Promise<void>;
};

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

export function createReconciler(deps: ReconcilerDeps): Reconciler {
  const metrics = deps.metrics ?? noopMetrics;
  const clock = deps.clock ?? systemClock;
  const staleMs = deps.checkpointStaleMs ?? 90_000;
  const holderId = deps.holderId ?? `reconciler-${randomUUID()}`;

  const acquireRecovery =
    deps.acquireRecoveryLease ??
    (<T>(work: (lease: HeldDistributedLease) => Promise<T>) =>
      withDistributedLease('recovery', work, {
        holderId: `${holderId}-recovery`,
        leaseMs: 55_000,
        heartbeatMs: 15_000,
      }));

  const acquireReaper =
    deps.acquireReaperLease ??
    (<T>(work: (lease: HeldDistributedLease) => Promise<T>) =>
      withDistributedLease('reaper', work, {
        holderId: `${holderId}-reaper`,
        leaseMs: 55_000,
        heartbeatMs: 15_000,
      }));

  async function defaultListStaleRunning(): Promise<StaleAttemptRow[]> {
    const cutoff = new Date(clock.now().getTime() - staleMs).toISOString();
    const result = await deps.executor.execute(sql`
      SELECT
        a.id AS attempt_id,
        a.run_id,
        a.dispatch_message_id,
        a.status,
        a.last_checkpoint_at,
        a.spec_ref->>'containerAppsExecutionId' AS container_apps_execution_id
      FROM ai_run_attempts a
      JOIN agent_runs r ON r.id = a.run_id
      WHERE r.transport_version = 'servicebus-blob-v2'
        AND a.status IN ('dispatched', 'running')
        AND (
          a.last_checkpoint_at IS NULL
          OR a.last_checkpoint_at < ${cutoff}::timestamptz
        )
      ORDER BY a.updated_at ASC
      LIMIT 50
    `);
    return resultRows<Record<string, unknown>>(result).map((row) => ({
      attemptId: String(row.attempt_id),
      runId: String(row.run_id),
      dispatchMessageId: String(row.dispatch_message_id),
      status: String(row.status),
      lastCheckpointAt:
        row.last_checkpoint_at == null
          ? null
          : row.last_checkpoint_at instanceof Date
            ? row.last_checkpoint_at.toISOString()
            : String(row.last_checkpoint_at),
      containerAppsExecutionId:
        row.container_apps_execution_id == null
          ? null
          : String(row.container_apps_execution_id),
    }));
  }

  async function defaultListCheckingWorkers(): Promise<StaleAttemptRow[]> {
    const result = await deps.executor.execute(sql`
      SELECT
        a.id AS attempt_id,
        a.run_id,
        a.dispatch_message_id,
        a.status,
        a.last_checkpoint_at,
        a.spec_ref->>'containerAppsExecutionId' AS container_apps_execution_id
      FROM ai_run_attempts a
      JOIN agent_runs r ON r.id = a.run_id
      WHERE r.transport_version = 'servicebus-blob-v2'
        AND a.status = 'checking_worker'
      ORDER BY a.updated_at ASC
      LIMIT 50
    `);
    return resultRows<Record<string, unknown>>(result).map((row) => ({
      attemptId: String(row.attempt_id),
      runId: String(row.run_id),
      dispatchMessageId: String(row.dispatch_message_id),
      status: String(row.status),
      lastCheckpointAt:
        row.last_checkpoint_at == null
          ? null
          : row.last_checkpoint_at instanceof Date
            ? row.last_checkpoint_at.toISOString()
            : String(row.last_checkpoint_at),
      containerAppsExecutionId:
        row.container_apps_execution_id == null
          ? null
          : String(row.container_apps_execution_id),
    }));
  }

  const listStale = deps.listStaleRunning ?? defaultListStaleRunning;
  const listChecking = deps.listCheckingWorkers ?? defaultListCheckingWorkers;

  async function countUncertainWorkers(): Promise<number> {
    const rows = await listChecking();
    return rows.length;
  }

  async function sweepStaleCheckpoints(): Promise<number> {
    return acquireRecovery(async () => {
      const stale = await listStale();
      let moved = 0;
      for (const row of stale) {
        const transition = await deps.attempts.transitionAttempt({
          attemptId: row.attemptId,
          expectedDispatchMessageId: row.dispatchMessageId,
          to: 'checking_worker',
        });
        if (transition.status === 'ok') {
          moved += 1;
          metrics.increment('orchestrator.reconciler.checking_worker');
        }
      }
      metrics.gauge('orchestrator.reconciler.stale_batch', stale.length);
      return moved;
    });
  }

  async function sweepCheckingWorkers(): Promise<number> {
    return acquireReaper(async () => {
      const checking = await listChecking();
      let failed = 0;
      for (const row of checking) {
        if (!row.containerAppsExecutionId) {
          // Without an execution id we cannot confirm loss — leave in checking_worker.
          metrics.increment('orchestrator.reconciler.missing_execution_id');
          continue;
        }
        const probe = await deps.executionProbe.probe(row.containerAppsExecutionId);
        if (probe.status === 'running' || probe.status === 'succeeded') {
          // Worker healthy or finished — return to running so checkpoints can resume.
          await deps.attempts.transitionAttempt({
            attemptId: row.attemptId,
            expectedDispatchMessageId: row.dispatchMessageId,
            to: 'running',
          });
          metrics.increment('orchestrator.reconciler.restored_running');
          continue;
        }
        if (probe.status === 'unknown') {
          metrics.increment('orchestrator.reconciler.probe_unknown');
          continue;
        }
        // not_found or failed → worker_lost
        const transition = await deps.attempts.transitionAttempt({
          attemptId: row.attemptId,
          expectedDispatchMessageId: row.dispatchMessageId,
          to: 'failed',
          failureCategory: 'worker_lost',
          failureDetail: `execution probe: ${probe.status}`,
        });
        if (transition.status === 'ok') {
          failed += 1;
          metrics.increment('orchestrator.reconciler.worker_lost');
        }
      }
      metrics.gauge('orchestrator.reconciler.checking_batch', checking.length);
      return failed;
    });
  }

  return {
    countUncertainWorkers,
    sweepStaleCheckpoints,
    sweepCheckingWorkers,
    async runOnce(): Promise<void> {
      await sweepStaleCheckpoints();
      await sweepCheckingWorkers();
      const uncertain = await countUncertainWorkers();
      metrics.gauge('orchestrator.uncertain_workers', uncertain);
    },
  };
}
