/**
 * Outbox drain loop: NOTIFY wake + 30s leased safety sweep.
 */
import { randomUUID } from 'node:crypto';
import { AI_RUN_V2_LANE_QUEUES } from '../../../shared/types/aiRunV2';
import {
  withDistributedLease,
  type HeldDistributedLease,
} from '../aiRunV2/distributedLeaseRepository';
import type {
  InteractiveDispatchState,
  RunAttemptRepository,
} from '../aiRunV2/runAttemptRepository';
import {
  createOutboxRepository,
  type OutboxRepository,
  type OutboxRow,
  type SqlExecutor,
} from '../aiRunV2/outboxRepository';
import {
  planAdmissionBatch,
  planInteractiveAdmissionBatch,
  toInteractiveAdmissionCandidate,
  type InteractiveAdmissionCandidate,
} from './admissionController';
import type { InteractiveActorDispatchClient } from './interactiveActorDispatchClient';
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
  interactiveDispatchClient: InteractiveActorDispatchClient;
  attempts: Pick<
    RunAttemptRepository,
    | 'readInteractiveDispatchState'
    | 'markInteractiveDispatched'
    | 'failExpiredInteractiveDispatch'
  >;
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
  const config = deps.config ?? DEFAULT_PROVIDER_CAPACITY;

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

  async function markRowPublished(row: OutboxRow): Promise<number> {
    const marked = await outbox.markPublished([row.id], holderId);
    return marked > 0 ? 1 : 0;
  }

  async function processBackgroundRows(
    rows: OutboxRow[],
    utilization: ProviderUtilization,
    uncertainWorkerCount: number,
  ): Promise<number> {
    const planned = planAdmissionBatch({
      rows,
      utilization,
      uncertainWorkerCount,
      config,
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
      const lane = item.decision.lane;
      try {
        await publishRow(item.outbox, AI_RUN_V2_LANE_QUEUES[lane]);
        published += await markRowPublished(item.outbox);
        metrics.increment('orchestrator.outbox.published', { lane });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await outbox.markFailed(item.outbox.id, holderId, detail, 10_000);
        metrics.increment('orchestrator.outbox.publish_failed');
      }
    }
    return published;
  }

  type ActiveInteractiveCandidate = Readonly<{
    candidate: InteractiveAdmissionCandidate;
    state: Extract<
      InteractiveDispatchState,
      'queued' | 'dispatched' | 'running'
    >;
  }>;

  function compareActiveInteractiveCandidates(
    left: ActiveInteractiveCandidate,
    right: ActiveInteractiveCandidate,
  ): number {
    const createdAtDifference =
      Date.parse(left.candidate.outbox.createdAt) -
      Date.parse(right.candidate.outbox.createdAt);
    if (createdAtDifference !== 0) return createdAtDifference;
    return left.candidate.outbox.id.localeCompare(right.candidate.outbox.id);
  }

  async function dispatchInteractiveCandidate(
    active: ActiveInteractiveCandidate,
  ): Promise<number> {
    const { outbox: row, payload } = active.candidate;
    try {
      const marked = await deps.attempts.markInteractiveDispatched({
        attemptId: payload.attemptId,
        expectedDispatchMessageId: payload.dispatchMessageId,
      });
      switch (marked) {
        case 'dispatched':
          break;
        case 'already-dispatched': {
          const replayState =
            await deps.attempts.readInteractiveDispatchState({
              attemptId: payload.attemptId,
              expectedDispatchMessageId: payload.dispatchMessageId,
            });
          switch (replayState) {
            case 'dispatched':
            case 'running':
              break;
            case 'terminal':
            case 'fence-mismatch':
            case 'not-found':
              metrics.increment(
                'orchestrator.interactive.invalid_dispatch',
                { reason: replayState },
              );
              return markRowPublished(row);
            case 'queued':
              throw new Error(
                `Interactive attempt remained queued after dispatch: ${payload.attemptId}`,
              );
            default: {
              const unhandled: never = replayState;
              throw new Error(
                `Unsupported interactive replay state: ${String(unhandled)}`,
              );
            }
          }
          break;
        }
        case 'fence-mismatch':
        case 'not-found':
          metrics.increment('orchestrator.interactive.invalid_dispatch', {
            reason: marked,
          });
          return markRowPublished(row);
        default: {
          const unhandled: never = marked;
          throw new Error(
            `Unsupported interactive dispatch result: ${String(unhandled)}`,
          );
        }
      }
      await deps.interactiveDispatchClient.dispatch(payload);
      metrics.increment('orchestrator.outbox.published', {
        lane: payload.interactiveClass,
      });
      return markRowPublished(row);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await outbox.markFailed(row.id, holderId, detail, 10_000);
      metrics.increment('orchestrator.interactive.invoke_failed');
      return 0;
    }
  }

  async function processInteractiveRows(
    rows: OutboxRow[],
    utilization: ProviderUtilization,
  ): Promise<number> {
    const now = clock.now();
    const queued: ActiveInteractiveCandidate[] = [];
    const recovery: ActiveInteractiveCandidate[] = [];
    let published = 0;

    for (const row of rows) {
      const candidate = toInteractiveAdmissionCandidate(row);
      if (!candidate) {
        metrics.increment('orchestrator.interactive.invalid_dispatch', {
          reason: 'payload',
        });
        published += await markRowPublished(row);
        continue;
      }

      let state: InteractiveDispatchState;
      try {
        state = await deps.attempts.readInteractiveDispatchState({
          attemptId: candidate.payload.attemptId,
          expectedDispatchMessageId: candidate.payload.dispatchMessageId,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await outbox.markFailed(row.id, holderId, detail, 10_000);
        metrics.increment('orchestrator.interactive.state_read_failed');
        continue;
      }

      switch (state) {
        case 'terminal':
        case 'fence-mismatch':
        case 'not-found':
          published += await markRowPublished(row);
          break;
        case 'queued':
        case 'dispatched':
        case 'running': {
          if (Date.parse(candidate.payload.deadlineAt) <= now.getTime()) {
            try {
              await deps.attempts.failExpiredInteractiveDispatch({
                attemptId: candidate.payload.attemptId,
                expectedDispatchMessageId:
                  candidate.payload.dispatchMessageId,
                detail: 'Interactive turn exceeded its absolute deadline',
              });
              published += await markRowPublished(row);
              metrics.increment('orchestrator.interactive.deadline_expired');
            } catch (err) {
              const detail =
                err instanceof Error ? err.message : String(err);
              await outbox.markFailed(row.id, holderId, detail, 10_000);
              metrics.increment(
                'orchestrator.interactive.terminalize_failed',
              );
            }
            break;
          }
          const active = { candidate, state };
          if (state === 'queued') queued.push(active);
          else recovery.push(active);
          break;
        }
        default: {
          const unhandled: never = state;
          throw new Error(
            `Unsupported interactive dispatch state: ${String(unhandled)}`,
          );
        }
      }
    }

    const selected = planInteractiveAdmissionBatch({
      candidates: queued.map(({ candidate }) => candidate),
      utilization,
      config,
      now,
    });
    const selectedIds = new Set(
      selected.map((candidate) => candidate.outbox.id),
    );
    const deferredUntil = new Date(now.getTime() + 5_000).toISOString();
    for (const active of queued) {
      if (selectedIds.has(active.candidate.outbox.id)) continue;
      await outbox.releaseClaim(
        active.candidate.outbox.id,
        holderId,
        deferredUntil,
        'interactive_cap',
      );
    }

    const selectedById = new Map(
      queued.map((active) => [active.candidate.outbox.id, active]),
    );
    const dispatchable = [
      ...recovery,
      ...selected.map((candidate) => {
        const active = selectedById.get(candidate.outbox.id);
        if (!active) {
          throw new Error(
            `Missing selected interactive candidate: ${candidate.outbox.id}`,
          );
        }
        return active;
      }),
    ].sort(compareActiveInteractiveCandidates);
    for (const active of dispatchable) {
      published += await dispatchInteractiveCandidate(active);
    }
    return published;
  }

  async function drainOnce(): Promise<number> {
    return acquireLease(async () => {
      const [utilization, uncertain] = await Promise.all([
        deps.getUtilization(),
        deps.getUncertainWorkerCount(),
      ]);
      const backgroundClaimed = await outbox.claimBatch(
        batchSize,
        holderId,
        claimMs,
      );
      const interactiveClaimed = await outbox.claimInteractiveCandidates(
        config.interactiveCap,
        Math.max(
          config.laneFloors.fast,
          config.laneFloors.agentic,
        ),
        holderId,
        claimMs,
      );
      const claimed = [
        ...new Map(
          [...backgroundClaimed, ...interactiveClaimed].map((row) => [
            row.id,
            row,
          ]),
        ).values(),
      ];
      if (claimed.length === 0) return 0;

      const backgroundRows: OutboxRow[] = [];
      const interactiveRows: OutboxRow[] = [];
      let published = 0;
      for (const row of claimed) {
        const kind = row.kind;
        switch (kind) {
          case 'dispatch_command':
            backgroundRows.push(row);
            break;
          case 'interactive_dispatch':
            interactiveRows.push(row);
            break;
          case 'checkpoint_notify':
          case 'terminal_result':
            published += await markRowPublished(row);
            break;
          default: {
            const unhandled: never = kind;
            throw new Error(`Unsupported outbox kind: ${String(unhandled)}`);
          }
        }
      }
      published += await processBackgroundRows(
        backgroundRows,
        utilization,
        uncertain,
      );
      published += await processInteractiveRows(interactiveRows, utilization);
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
