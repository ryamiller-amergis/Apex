/**
 * Outbox drain loop: NOTIFY wake + 30s leased safety sweep.
 */
import { randomUUID } from 'node:crypto';
import { AI_RUN_V2_LANE_QUEUES } from '../../../shared/types/aiRunV2';
import { isCanonicalUuid } from '../../../shared/types/durableInteractiveTurn';
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
import {
  createProviderCapacityReservation,
} from './providerGovernor';
import type {
  ProviderCapacityConfig,
  ProviderCapacityReservation,
  ProviderUtilization,
} from './types';
import {
  DEFAULT_OUTBOX_BATCH_SIZE,
  DEFAULT_OUTBOX_CLAIM_MS,
  DEFAULT_PROVIDER_CAPACITY,
  MAX_OUTBOX_DRAIN_PAGES,
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
    | 'failInvalidInteractiveDispatch'
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

  type PageOutcome = Readonly<{
    published: number;
    discarded: number;
  }>;

  const noOutcome = (): PageOutcome => ({ published: 0, discarded: 0 });

  async function discardRow(
    row: OutboxRow,
    reason: string,
  ): Promise<number> {
    const discarded = await outbox.markDiscarded(row.id, holderId, reason);
    if (discarded) {
      metrics.increment('orchestrator.interactive.discarded', { reason });
      return 1;
    }
    return 0;
  }

  function safeDispatchIdentity(row: OutboxRow): Readonly<{
    attemptId: string;
    expectedDispatchMessageId: string;
  }> | null {
    const attemptId = row.payload.attemptId;
    const dispatchMessageId = row.payload.dispatchMessageId;
    if (
      !isCanonicalUuid(attemptId) ||
      !isCanonicalUuid(dispatchMessageId) ||
      row.attemptId !== attemptId
    ) {
      return null;
    }
    return {
      attemptId,
      expectedDispatchMessageId: dispatchMessageId,
    };
  }

  async function discardInvalidRow(
    row: OutboxRow,
    reason: string,
    detail: string,
  ): Promise<number> {
    const identity = safeDispatchIdentity(row);
    if (identity) {
      try {
        await deps.attempts.failInvalidInteractiveDispatch({
          ...identity,
          detail,
        });
      } catch (err) {
        const failureDetail =
          err instanceof Error ? err.message : String(err);
        await outbox.markFailed(
          row.id,
          holderId,
          failureDetail,
          10_000,
        );
        metrics.increment('orchestrator.interactive.terminalize_failed');
        return 0;
      }
    }
    return discardRow(row, reason);
  }

  async function processBackgroundRows(
    rows: OutboxRow[],
    utilization: ProviderUtilization,
    reservation: ProviderCapacityReservation,
    uncertainWorkerCount: number,
  ): Promise<PageOutcome> {
    const planned = planAdmissionBatch({
      rows,
      utilization,
      reservation,
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
    return { published, discarded: 0 };
  }

  type ActiveInteractiveCandidate = Readonly<{
    candidate: InteractiveAdmissionCandidate;
    state: Extract<
      InteractiveDispatchState,
      'queued' | 'dispatched' | 'running'
    >;
    capacityCharged: boolean;
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

  function releaseInteractiveReservation(
    active: ActiveInteractiveCandidate,
    reservation: ProviderCapacityReservation,
  ): void {
    if (!active.capacityCharged) return;
    const interactiveClass = active.candidate.payload.interactiveClass;
    reservation.interactiveClassInFlight[interactiveClass] = Math.max(
      0,
      reservation.interactiveClassInFlight[interactiveClass] - 1,
    );
    reservation.cursorInFlight = Math.max(
      0,
      reservation.cursorInFlight - 1,
    );
    reservation.providerClassInFlight.cursor.interactive = Math.max(
      0,
      reservation.providerClassInFlight.cursor.interactive - 1,
    );
  }

  async function expireInteractiveCandidate(
    active: ActiveInteractiveCandidate,
    reservation: ProviderCapacityReservation,
  ): Promise<PageOutcome> {
    const { outbox: row, payload } = active.candidate;
    try {
      const result = await deps.attempts.failExpiredInteractiveDispatch({
        attemptId: payload.attemptId,
        expectedDispatchMessageId: payload.dispatchMessageId,
        detail: 'Interactive turn exceeded its absolute deadline',
      });
      switch (result) {
        case 'terminalized': {
          releaseInteractiveReservation(active, reservation);
          const discarded = await discardRow(row, 'deadline_expired');
          metrics.increment('orchestrator.interactive.deadline_expired');
          return { published: 0, discarded };
        }
        case 'already-terminal': {
          releaseInteractiveReservation(active, reservation);
          const published = await markRowPublished(row);
          return { published, discarded: 0 };
        }
        case 'fence-mismatch': {
          const discarded = await discardRow(row, 'fence_mismatch');
          return { published: 0, discarded };
        }
        case 'not-found': {
          releaseInteractiveReservation(active, reservation);
          const discarded =
            await discardRow(row, 'attempt_not_found');
          return { published: 0, discarded };
        }
        default: {
          const unhandled: never = result;
          throw new Error(
            `Unsupported interactive terminal result: ${String(unhandled)}`,
          );
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await outbox.markFailed(row.id, holderId, detail, 10_000);
      metrics.increment('orchestrator.interactive.terminalize_failed');
      return noOutcome();
    }
  }

  async function dispatchInteractiveCandidate(
    active: ActiveInteractiveCandidate,
    reservation: ProviderCapacityReservation,
  ): Promise<PageOutcome> {
    const { outbox: row, payload } = active.candidate;
    const deadlineMs = Date.parse(payload.deadlineAt);
    if (deadlineMs <= clock.now().getTime()) {
      return expireInteractiveCandidate(active, reservation);
    }

    let marked: Awaited<
      ReturnType<typeof deps.attempts.markInteractiveDispatched>
    >;
    try {
      marked = await deps.attempts.markInteractiveDispatched({
        attemptId: payload.attemptId,
        expectedDispatchMessageId: payload.dispatchMessageId,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await outbox.markFailed(row.id, holderId, detail, 10_000);
      metrics.increment('orchestrator.interactive.invoke_failed');
      return noOutcome();
    }

    try {
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
            case 'terminal': {
              releaseInteractiveReservation(active, reservation);
              const published = await markRowPublished(row);
              return { published, discarded: 0 };
            }
            case 'fence-mismatch': {
              const discarded = await discardRow(row, 'fence_mismatch');
              return { published: 0, discarded };
            }
            case 'not-found': {
              releaseInteractiveReservation(active, reservation);
              const discarded =
                await discardRow(row, 'attempt_not_found');
              return { published: 0, discarded };
            }
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
        case 'fence-mismatch': {
          const discarded = await discardRow(row, 'fence_mismatch');
          return { published: 0, discarded };
        }
        case 'not-found': {
          releaseInteractiveReservation(active, reservation);
          const discarded = await discardRow(row, 'attempt_not_found');
          return { published: 0, discarded };
        }
        default: {
          const unhandled: never = marked;
          throw new Error(
            `Unsupported interactive dispatch result: ${String(unhandled)}`,
          );
        }
      }

      const invocationNowMs = clock.now().getTime();
      if (deadlineMs <= invocationNowMs) {
        return expireInteractiveCandidate(active, reservation);
      }
      const controller = new AbortController();
      let deadlineReached = false;
      let timeout: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          deadlineReached = true;
          controller.abort();
          reject(new Error('Interactive dispatch deadline reached'));
        }, deadlineMs - invocationNowMs);
      });
      try {
        await Promise.race([
          deps.interactiveDispatchClient.dispatch(payload, {
            signal: controller.signal,
            deadlineAt: payload.deadlineAt,
          }),
          deadline,
        ]);
      } catch (err) {
        if (deadlineReached) {
          return expireInteractiveCandidate(active, reservation);
        }
        const detail = err instanceof Error ? err.message : String(err);
        await outbox.markFailed(row.id, holderId, detail, 10_000);
        metrics.increment('orchestrator.interactive.invoke_failed');
        return noOutcome();
      } finally {
        clearTimeout(timeout!);
      }
      metrics.increment('orchestrator.outbox.published', {
        lane: payload.interactiveClass,
      });
      const published = await markRowPublished(row);
      return { published, discarded: 0 };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await outbox.markFailed(row.id, holderId, detail, 10_000);
      metrics.increment('orchestrator.interactive.invoke_failed');
      return noOutcome();
    }
  }

  async function processInteractiveRows(
    rows: OutboxRow[],
    utilization: ProviderUtilization,
    reservation: ProviderCapacityReservation,
  ): Promise<PageOutcome> {
    const now = clock.now();
    const queued: ActiveInteractiveCandidate[] = [];
    const recovery: ActiveInteractiveCandidate[] = [];
    let published = 0;
    let discarded = 0;

    for (const row of rows) {
      const candidate = toInteractiveAdmissionCandidate(row);
      if (!candidate) {
        discarded += await discardInvalidRow(
          row,
          'invalid_payload',
          'Interactive dispatch payload failed validation',
        );
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
          published += await markRowPublished(row);
          break;
        case 'fence-mismatch':
          discarded += await discardRow(row, 'fence_mismatch');
          break;
        case 'not-found':
          discarded += await discardRow(row, 'attempt_not_found');
          break;
        case 'queued':
        case 'dispatched':
        case 'running': {
          const active: ActiveInteractiveCandidate = {
            candidate,
            state,
            capacityCharged: state !== 'queued',
          };
          if (Date.parse(candidate.payload.deadlineAt) <= now.getTime()) {
            const outcome =
              await expireInteractiveCandidate(active, reservation);
            discarded += outcome.discarded;
            published += outcome.published;
            break;
          }
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
      reservation,
      config,
      now,
    });
    const selectedIds = new Set(
      selected.map((candidate) => candidate.outbox.id),
    );
    const interactiveInFlight =
      reservation.interactiveClassInFlight.fast +
      reservation.interactiveClassInFlight.agentic;
    const deferralReason =
      interactiveInFlight >= config.interactiveCap
        ? 'interactive_cap'
        : reservation.cursorInFlight >= config.cursorCap
          ? 'provider_cap'
          : 'interactive_cap';
    const deferredUntil = new Date(
      clock.now().getTime() + 5_000,
    ).toISOString();
    for (const active of queued) {
      if (selectedIds.has(active.candidate.outbox.id)) continue;
      await outbox.releaseClaim(
        active.candidate.outbox.id,
        holderId,
        deferredUntil,
        deferralReason,
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
        return { ...active, capacityCharged: true };
      }),
    ].sort(compareActiveInteractiveCandidates);
    for (const active of dispatchable) {
      const outcome =
        await dispatchInteractiveCandidate(active, reservation);
      published += outcome.published;
      discarded += outcome.discarded;
    }
    return { published, discarded };
  }

  async function drainOnce(): Promise<number> {
    return acquireLease(async () => {
      const [utilization, uncertain] = await Promise.all([
        deps.getUtilization(),
        deps.getUncertainWorkerCount(),
      ]);
      const reservation =
        createProviderCapacityReservation(utilization);
      const seenOutboxIds = new Set<string>();
      const pendingBackgroundRows: OutboxRow[] = [];
      let totalClaimed = 0;
      let totalPublished = 0;

      for (let page = 0; page < MAX_OUTBOX_DRAIN_PAGES; page += 1) {
        const backgroundClaimed = await outbox.claimBatch(
          batchSize,
          holderId,
          claimMs,
        );
        const interactiveClaimed =
          await outbox.claimInteractiveCandidates(
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
        ].filter((row) => {
          if (seenOutboxIds.has(row.id)) return false;
          seenOutboxIds.add(row.id);
          return true;
        });
        if (claimed.length === 0) break;

        totalClaimed += claimed.length;
        const interactiveRows: OutboxRow[] = [];
        let pagePublished = 0;
        let pageDiscarded = 0;
        for (const row of claimed) {
          const kind = row.kind;
          switch (kind) {
            case 'dispatch_command':
              pendingBackgroundRows.push(row);
              break;
            case 'interactive_dispatch':
              interactiveRows.push(row);
              break;
            case 'checkpoint_notify':
            case 'terminal_result':
              pagePublished += await markRowPublished(row);
              break;
            default: {
              const unhandled: never = kind;
              throw new Error(
                `Unsupported outbox kind: ${String(unhandled)}`,
              );
            }
          }
        }

        const interactiveOutcome = await processInteractiveRows(
          interactiveRows,
          utilization,
          reservation,
        );
        pagePublished += interactiveOutcome.published;
        pageDiscarded += interactiveOutcome.discarded;

        totalPublished += pagePublished;

        if (pagePublished + pageDiscarded === 0) break;
      }

      const backgroundOutcome = await processBackgroundRows(
        pendingBackgroundRows,
        utilization,
        reservation,
        uncertain,
      );
      totalPublished += backgroundOutcome.published;

      metrics.gauge('orchestrator.outbox.batch', totalClaimed);
      return totalPublished;
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
