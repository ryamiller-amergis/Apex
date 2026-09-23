/**
 * Recovery / reaper sweeps for stale checkpoints and worker_lost confirmation.
 * Missed checkpoints alone move to checking_worker; worker_lost requires a
 * negative Container Apps execution probe.
 */
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  isAiRunBlobRef,
  isAiRunV2WorkloadLane,
  type AiRunBlobRef,
  type AiRunV2WorkloadLane,
} from '../../../shared/types/aiRunV2';
import {
  isVisualSubjectKind,
  type VisualSubjectKind,
} from '../../../shared/types/aiRunV2VisualSpec';
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

export type QueuedAttemptRow = Readonly<{
  attemptId: string;
  runId: string;
  dispatchMessageId: string;
  status: 'queued';
  createdAt: string;
}>;

/**
 * What a replacement attempt needs. The lane and specification reference live
 * on the original dispatch command, not on the attempt row.
 */
export type RetryContext = Readonly<{
  workloadLane: AiRunV2WorkloadLane;
  visualSubjectKind?: VisualSubjectKind;
  specRef: AiRunBlobRef;
  attemptCount: number;
}>;

export type ReconcilerDeps = Readonly<{
  executor: SqlExecutor;
  attempts: RunAttemptRepository;
  executionProbe: ExecutionProbe;
  /** Attempts per run before a confirmed loss stops being retried. */
  maxAttempts?: number;
  loadRetryContext?: (row: StaleAttemptRow) => Promise<RetryContext | null>;
  clock?: Clock;
  metrics?: OrchestratorMetrics;
  /** Stale if no checkpoint newer than this many ms (default 90s). */
  checkpointStaleMs?: number;
  /** Initial dispatch must commit within this many ms (default 90s). */
  initialDispatchStaleMs?: number;
  holderId?: string;
  listStaleQueued?: () => Promise<QueuedAttemptRow[]>;
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
  sweepQueuedInitialAttempts(): Promise<number>;
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
  const initialDispatchStaleMs = deps.initialDispatchStaleMs ?? 90_000;
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

  async function defaultListStaleQueued(): Promise<QueuedAttemptRow[]> {
    const cutoff = new Date(
      clock.now().getTime() - initialDispatchStaleMs,
    ).toISOString();
    const result = await deps.executor.execute(sql`
      SELECT
        a.id AS attempt_id,
        a.run_id,
        a.dispatch_message_id,
        a.status,
        a.created_at
      FROM ai_run_attempts a
      JOIN agent_runs r ON r.id = a.run_id
      WHERE r.transport_version = 'servicebus-blob-v2'
        AND r.status = 'queued'
        AND a.status = 'queued'
        AND a.attempt_number = 1
        AND a.created_at < ${cutoff}::timestamptz
      ORDER BY a.created_at ASC
      LIMIT 50
    `);
    return resultRows<Record<string, unknown>>(result).map((row) => ({
      attemptId: String(row.attempt_id),
      runId: String(row.run_id),
      dispatchMessageId: String(row.dispatch_message_id),
      status: 'queued',
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    }));
  }

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

  async function defaultLoadRetryContext(
    row: StaleAttemptRow,
  ): Promise<RetryContext | null> {
    const result = await deps.executor.execute(sql`
      SELECT
        o.payload->>'workloadLane' AS workload_lane,
        o.payload->>'visualSubjectKind' AS visual_subject_kind,
        o.payload->'specRef' AS spec_ref,
        (
          SELECT COUNT(*)::int
          FROM ai_run_attempts
          WHERE run_id = ${row.runId}
        ) AS attempt_count
      FROM ai_run_outbox o
      WHERE o.attempt_id = ${row.attemptId}
        AND o.kind = 'dispatch_command'
      LIMIT 1
    `);
    const found = resultRows<Record<string, unknown>>(result)[0];
    if (!found) return null;
    const specRef =
      typeof found.spec_ref === 'string'
        ? (JSON.parse(found.spec_ref) as unknown)
        : found.spec_ref;
    if (
      !isAiRunV2WorkloadLane(found.workload_lane) ||
      !isAiRunBlobRef(specRef) ||
      (
        found.workload_lane === 'visual'
        && !isVisualSubjectKind(found.visual_subject_kind)
      )
    ) {
      return null;
    }
    return {
      workloadLane: found.workload_lane,
      ...(isVisualSubjectKind(found.visual_subject_kind)
        ? { visualSubjectKind: found.visual_subject_kind }
        : {}),
      specRef,
      attemptCount: Number(found.attempt_count ?? 0),
    };
  }

  const listStaleQueued = deps.listStaleQueued ?? defaultListStaleQueued;
  const listStale = deps.listStaleRunning ?? defaultListStaleRunning;
  const listChecking = deps.listCheckingWorkers ?? defaultListCheckingWorkers;
  const loadRetryContext = deps.loadRetryContext ?? defaultLoadRetryContext;
  const maxAttempts = deps.maxAttempts ?? 3;

  /**
   * A confirmed loss leaves the run with no live attempt, so replace it with a
   * fresh attempt and dispatch id rather than reusing the fence the dead
   * worker still holds.
   */
  async function retryAfterConfirmedLoss(row: StaleAttemptRow): Promise<void> {
    const context = await loadRetryContext(row);
    if (!context) {
      metrics.increment('orchestrator.reconciler.retry_context_missing');
      return;
    }
    if (context.attemptCount >= maxAttempts) {
      metrics.increment('orchestrator.reconciler.retry_exhausted');
      return;
    }
    try {
      await deps.attempts.dispatchNextAttempt({
        runId: row.runId,
        workloadLane: context.workloadLane,
        visualSubjectKind: context.visualSubjectKind,
        specRef: context.specRef,
      });
      metrics.increment('orchestrator.reconciler.retry_dispatched');
    } catch {
      metrics.increment('orchestrator.reconciler.retry_failed');
    }
  }

  async function countUncertainWorkers(): Promise<number> {
    const rows = await listChecking();
    return rows.length;
  }

  async function sweepQueuedInitialAttempts(): Promise<number> {
    return acquireRecovery(async (lease) => {
      const queued = await listStaleQueued();
      let cancelled = 0;
      for (const row of queued) {
        await lease.assertOwned();
        const transition = await deps.attempts.transitionAttempt({
          attemptId: row.attemptId,
          expectedDispatchMessageId: row.dispatchMessageId,
          to: 'cancelled',
          failureDetail:
            'Initial dispatch did not complete before the recovery deadline.',
        });
        if (transition.status === 'ok') {
          cancelled += 1;
          metrics.increment(
            'orchestrator.reconciler.initial_dispatch_cancelled',
          );
        }
      }
      metrics.gauge(
        'orchestrator.reconciler.queued_initial_batch',
        queued.length,
      );
      return cancelled;
    });
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
          await retryAfterConfirmedLoss(row);
        }
      }
      metrics.gauge('orchestrator.reconciler.checking_batch', checking.length);
      return failed;
    });
  }

  return {
    countUncertainWorkers,
    sweepQueuedInitialAttempts,
    sweepStaleCheckpoints,
    sweepCheckingWorkers,
    async runOnce(): Promise<void> {
      await sweepQueuedInitialAttempts();
      await sweepStaleCheckpoints();
      await sweepCheckingWorkers();
      const uncertain = await countUncertainWorkers();
      metrics.gauge('orchestrator.uncertain_workers', uncertain);
    },
  };
}
