/**
 * Outbox drain loop: NOTIFY wake + 30s leased safety sweep.
 */
import { randomUUID } from 'node:crypto';
import {
  withDistributedLease,
  type HeldDistributedLease,
} from '../aiRunV2/distributedLeaseRepository';
import {
  createOutboxRepository,
  type OutboxRepository,
  type OutboxRow,
  type SqlExecutor,
} from '../aiRunV2/outboxRepository';
import { planAdmissionBatch } from './admissionController';
import {
  initAiRunOutboxNotify,
  shutdownAiRunOutboxNotify,
  subscribeAiRunOutbox,
} from './outboxNotify';
import type { Clock, CommandPublisher, OrchestratorMetrics } from './ports';
import { noopMetrics, systemClock } from './ports';
import type { ProviderCapacityConfig, ProviderUtilization } from './types';
import {
  DEFAULT_OUTBOX_BATCH_SIZE,
  DEFAULT_OUTBOX_CLAIM_MS,
  DEFAULT_PROVIDER_CAPACITY,
  OUTBOX_SAFETY_SWEEP_MS,
  UNCERTAIN_WORKER_PAUSE_THRESHOLD,
} from './types';

export type OutboxDrainerDeps = Readonly<{
  executor: SqlExecutor;
  publisher: CommandPublisher;
  getUtilization: () => Promise<ProviderUtilization>;
  getUncertainWorkerCount: () => Promise<number>;
  clock?: Clock;
  metrics?: OrchestratorMetrics;
  config?: ProviderCapacityConfig;
  batchSize?: number;
  claimMs?: number;
  safetySweepMs?: number;
  holderId?: string;
  /** Inject outbox repo for tests. */
  outbox?: OutboxRepository;
  /** Skip real LISTEN in unit tests. */
  enableNotify?: boolean;
  acquireOutboxLease?: <T>(
    work: (lease: HeldDistributedLease) => Promise<T>,
  ) => Promise<T>;
}>;

export type OutboxDrainer = {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Run one drain cycle (tests / wake handler). */
  drainOnce(): Promise<number>;
};

export function createOutboxDrainer(deps: OutboxDrainerDeps): OutboxDrainer {
  const clock = deps.clock ?? systemClock;
  const metrics = deps.metrics ?? noopMetrics;
  const outbox = deps.outbox ?? createOutboxRepository(deps.executor);
  const batchSize = deps.batchSize ?? DEFAULT_OUTBOX_BATCH_SIZE;
  const claimMs = deps.claimMs ?? DEFAULT_OUTBOX_CLAIM_MS;
  const safetySweepMs = deps.safetySweepMs ?? OUTBOX_SAFETY_SWEEP_MS;
  const holderId = deps.holderId ?? `outbox-drainer-${randomUUID()}`;
  const enableNotify = deps.enableNotify ?? true;

  let stopRequested = false;
  let wakeQueued = false;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let drainChain: Promise<void> = Promise.resolve();

  const acquireLease =
    deps.acquireOutboxLease ??
    (<T>(work: (lease: HeldDistributedLease) => Promise<T>) =>
      withDistributedLease('outbox', work, {
        holderId,
        leaseMs: 55_000,
        heartbeatMs: 15_000,
      }));

  async function publishRow(row: OutboxRow, queueName: string): Promise<void> {
    const messageId =
      (typeof row.payload.dispatchMessageId === 'string'
        ? row.payload.dispatchMessageId
        : null) ?? row.idempotencyKey;
    await deps.publisher.publish({
      queueName,
      messageId,
      body: row.payload,
    });
  }

  async function drainOnce(): Promise<number> {
    return acquireLease(async () => {
      const [utilization, uncertain] = await Promise.all([
        deps.getUtilization(),
        deps.getUncertainWorkerCount(),
      ]);
      const claimed = await outbox.claimBatch(batchSize, holderId, claimMs);
      if (claimed.length === 0) return 0;

      const planned = planAdmissionBatch({
        rows: claimed,
        utilization,
        uncertainWorkerCount: uncertain,
        config: deps.config ?? DEFAULT_PROVIDER_CAPACITY,
        uncertainPauseThreshold: UNCERTAIN_WORKER_PAUSE_THRESHOLD,
      });

      let published = 0;
      for (const item of planned) {
        if (item.decision.status !== 'allow') {
          await outbox.markFailed(
            item.outbox.id,
            holderId,
            item.decision.reason,
            5_000,
          );
          metrics.increment('orchestrator.admission.denied', {
            reason: item.decision.reason,
          });
          continue;
        }
        try {
          await publishRow(item.outbox, item.queueName);
          await outbox.markPublished([item.outbox.id], holderId);
          published += 1;
          metrics.increment('orchestrator.outbox.published', {
            lane: item.lane,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          await outbox.markFailed(item.outbox.id, holderId, detail, 10_000);
          metrics.increment('orchestrator.outbox.publish_failed');
        }
      }
      metrics.gauge('orchestrator.outbox.batch', claimed.length);
      return published;
    });
  }

  function scheduleDrain(): void {
    if (stopRequested) return;
    wakeQueued = true;
    drainChain = drainChain
      .then(async () => {
        while (wakeQueued && !stopRequested) {
          wakeQueued = false;
          try {
            await drainOnce();
          } catch (err) {
            metrics.increment('orchestrator.outbox.drain_error');
            console.error(
              '[aiOrchestrator/outboxDrainer]',
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      })
      .catch(() => undefined);
  }

  return {
    drainOnce,
    async start(): Promise<void> {
      stopRequested = false;
      if (enableNotify) {
        await initAiRunOutboxNotify();
        unsubscribe = subscribeAiRunOutbox(() => scheduleDrain());
      }
      sweepTimer = setInterval(() => scheduleDrain(), safetySweepMs);
      sweepTimer.unref?.();
      scheduleDrain();
    },
    async stop(): Promise<void> {
      stopRequested = true;
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (enableNotify) {
        await shutdownAiRunOutboxNotify();
      }
      await drainChain;
      void clock;
    },
  };
}
