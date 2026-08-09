/**
 * FEAT-002 fair, environment-wide admission governor.
 *
 * The database transaction persists dispatch fences before this service
 * publishes payload-free Service Bus messages. Publish failures intentionally
 * leave dispatched rows durable for the S5 recovery sweep.
 */
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import type {
  AdmissionResult,
  DispatchMessage,
} from '../../shared/types/agentRunAdmission';
import {
  getServiceBusPublisher,
  type ServiceBusPublisher,
} from './serviceBusPublisher';
import { trackEvent } from './telemetry';
import type { AgentRunEventEnvelope } from '../../shared/types/chat';
import {
  nextRunEventSequence,
  notifyRunEvent as notifyDurableRunEvent,
  RUN_EVENT_SOURCE_INSTANCE,
} from './pgNotifyService';
import {
  workerTierTelemetry,
  type WorkerTierTelemetry,
} from './workerTierTelemetry';

const DEFAULT_BACKGROUND_IN_FLIGHT_LIMIT = 10;
const MAX_BACKGROUND_IN_FLIGHT_LIMIT = 100;
const DEFAULT_BACKGROUND_PUBLISH_GRACE_MS = 60_000;
const MIN_BACKGROUND_PUBLISH_GRACE_MS = 1_000;
const MAX_BACKGROUND_PUBLISH_GRACE_MS = 10 * 60_000;
const DEFAULT_STALE_DISPATCH_BATCH_SIZE = 100;
const MAX_STALE_DISPATCH_BATCH_SIZE = 100;
const BACKGROUND_LANE = 'background';
const DISPATCHED_PROGRESS_LABEL = 'Starting…';

export type AdmissionReason = 'enqueue' | 'slot-release' | 'sweep';

export type AdmissionQueueSnapshot = Readonly<{
  inFlight: number;
  queuedDepth: number;
  oldestQueuedAt: string | null;
}>;

export type AdmittedDispatch = Readonly<{
  runId: string;
  threadId: string;
  dispatchMessageId: string;
  projectId: string;
  lane: 'background';
  queuedAt: string;
  /** Live project count immediately before this run was admitted. */
  projectInFlight: number;
}>;

export interface AdmissionTransaction {
  acquireGlobalLock(): Promise<void>;
  readQueueSnapshot(): Promise<AdmissionQueueSnapshot>;
  admitNext(
    dispatchMessageId: string,
    dispatchedAt: string,
  ): Promise<AdmittedDispatch | null>;
}

export interface AdmissionStore {
  runInTransaction<T>(
    work: (tx: AdmissionTransaction) => Promise<T>,
  ): Promise<T>;
}

export type StaleDispatch = Readonly<{
  runId: string;
  dispatchMessageId: string;
}>;

export interface StaleDispatchRecoveryStore {
  findStaleDispatches(
    dispatchedBefore: string,
    limit: number,
  ): Promise<StaleDispatch[]>;
}

export type StaleDispatchRecoveryResult = Readonly<{
  selected: number;
  published: number;
  failed: number;
}>;

type AdmissionTelemetry = (
  name: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>,
) => void;

type AdmissionGovernorDependencies = {
  store?: AdmissionStore;
  publisher?: ServiceBusPublisher;
  resolveLimit?: () => number;
  randomUuid?: () => string;
  now?: () => Date;
  telemetry?: AdmissionTelemetry;
  workerTelemetry?: WorkerTierTelemetry;
  notifyRunEvent?: typeof notifyDurableRunEvent;
  logError?: (message: string, fields: Record<string, string>) => void;
};

type TransactionOutcome = {
  snapshot: AdmissionQueueSnapshot;
  finalSnapshot: AdmissionQueueSnapshot;
  dispatches: AdmittedDispatch[];
};

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

const postgresAdmissionStore: AdmissionStore = {
  runInTransaction<T>(
    work: (tx: AdmissionTransaction) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (databaseTransaction) => work({
      async acquireGlobalLock(): Promise<void> {
        // SKIP LOCKED prevents duplicate row claims; this transaction-scoped
        // lock additionally serializes the global count+claim decision so
        // separate web instances cannot overshoot the environment cap.
        await databaseTransaction.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('apex_ai_run_background_admission'))`,
        );
      },

      async readQueueSnapshot(): Promise<AdmissionQueueSnapshot> {
        const result = await databaseTransaction.execute(sql`
          SELECT
            COUNT(*) FILTER (
              WHERE lane = ${BACKGROUND_LANE}
                AND status IN ('dispatched', 'running')
            )::int AS in_flight,
            COUNT(*) FILTER (
              WHERE lane = ${BACKGROUND_LANE}
                AND status = 'queued'
            )::int AS queued_depth,
            MIN(queued_at) FILTER (
              WHERE lane = ${BACKGROUND_LANE}
                AND status = 'queued'
            ) AS oldest_queued_at
          FROM agent_runs
        `);
        const row = resultRows<{
          in_flight: number | string;
          queued_depth: number | string;
          oldest_queued_at: string | Date | null;
        }>(result)[0];
        const oldest = row?.oldest_queued_at;
        return {
          inFlight: numberValue(row?.in_flight),
          queuedDepth: numberValue(row?.queued_depth),
          oldestQueuedAt:
            oldest instanceof Date ? oldest.toISOString() : oldest ?? null,
        };
      },

      async admitNext(
        dispatchMessageId: string,
        dispatchedAt: string,
      ): Promise<AdmittedDispatch | null> {
        // This query is deliberately executed once per free slot. The newly
        // dispatched row therefore contributes to the next project's live
        // count, rebalancing fairness after every admission.
        const result = await databaseTransaction.execute(sql`
          WITH project_in_flight AS (
            SELECT project_id, COUNT(*)::int AS in_flight
            FROM agent_runs
            WHERE lane = ${BACKGROUND_LANE}
              AND status IN ('dispatched', 'running')
            GROUP BY project_id
          ),
          candidate AS (
            SELECT
              queued.id,
              queued.project_id,
              queued.queued_at,
              COALESCE(project_in_flight.in_flight, 0)::int AS project_in_flight
            FROM agent_runs queued
            LEFT JOIN project_in_flight
              ON project_in_flight.project_id = queued.project_id
            WHERE queued.lane = ${BACKGROUND_LANE}
              AND queued.status = 'queued'
              AND queued.project_id IS NOT NULL
              AND queued.queued_at IS NOT NULL
            ORDER BY
              COALESCE(project_in_flight.in_flight, 0) ASC,
              queued.queued_at ASC,
              queued.id ASC
            FOR UPDATE OF queued SKIP LOCKED
            LIMIT 1
          ),
          updated AS (
            UPDATE agent_runs
            SET status = 'dispatched',
                dispatch_message_id = ${dispatchMessageId},
                dispatched_at = ${dispatchedAt},
                progress_phase = 'dispatched',
                progress_label = ${DISPATCHED_PROGRESS_LABEL},
                updated_at = ${dispatchedAt}
            FROM candidate
            WHERE agent_runs.id = candidate.id
              AND agent_runs.status = 'queued'
            RETURNING
              agent_runs.id,
              agent_runs.thread_id,
              agent_runs.project_id,
              agent_runs.queued_at
          )
          SELECT
            updated.id AS run_id,
            updated.thread_id,
            updated.project_id,
            updated.queued_at,
            candidate.project_in_flight
          FROM updated
          JOIN candidate ON candidate.id = updated.id
        `);
        const row = resultRows<{
          run_id: string;
          thread_id: string;
          project_id: string;
          queued_at: string | Date;
          project_in_flight: number | string;
        }>(result)[0];
        if (!row) return null;

        return {
          runId: row.run_id,
          threadId: row.thread_id,
          dispatchMessageId,
          projectId: row.project_id,
          lane: BACKGROUND_LANE,
          queuedAt:
            row.queued_at instanceof Date
              ? row.queued_at.toISOString()
              : row.queued_at,
          projectInFlight: numberValue(row.project_in_flight),
        };
      },
    }));
  },
};

const postgresStaleDispatchRecoveryStore: StaleDispatchRecoveryStore = {
  async findStaleDispatches(
    dispatchedBefore: string,
    limit: number,
  ): Promise<StaleDispatch[]> {
    const result = await db.execute(sql`
      SELECT
        id AS run_id,
        dispatch_message_id
      FROM agent_runs
      WHERE lane = ${BACKGROUND_LANE}
        AND status = 'dispatched'
        AND dispatch_message_id IS NOT NULL
        AND dispatched_at IS NOT NULL
        AND dispatched_at < ${dispatchedBefore}
      ORDER BY dispatched_at ASC, id ASC
      LIMIT ${limit}
    `);
    return resultRows<{
      run_id: string;
      dispatch_message_id: string;
    }>(result).map((row) => ({
      runId: row.run_id,
      dispatchMessageId: row.dispatch_message_id,
    }));
  },
};

/**
 * Resolve the environment-wide cap. Invalid, fractional, non-positive, and
 * unreasonably large values fail safely to the documented default.
 */
export function resolveBackgroundInFlightLimit(
  rawValue = process.env.AI_RUNS_BACKGROUND_INFLIGHT_LIMIT,
): number {
  const normalized = rawValue?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) {
    return DEFAULT_BACKGROUND_IN_FLIGHT_LIMIT;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed)
    && parsed >= 1
    && parsed <= MAX_BACKGROUND_IN_FLIGHT_LIMIT
    ? parsed
    : DEFAULT_BACKGROUND_IN_FLIGHT_LIMIT;
}

/**
 * Resolve the short admit-to-publish recovery grace. Bounding the value avoids
 * both immediate republish churn and accidentally disabling crash recovery.
 */
export function resolveBackgroundPublishGraceMs(
  rawValue = process.env.AI_RUNS_BACKGROUND_PUBLISH_GRACE_MS,
): number {
  const normalized = rawValue?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) {
    return DEFAULT_BACKGROUND_PUBLISH_GRACE_MS;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed)
    && parsed >= MIN_BACKGROUND_PUBLISH_GRACE_MS
    && parsed <= MAX_BACKGROUND_PUBLISH_GRACE_MS
    ? parsed
    : DEFAULT_BACKGROUND_PUBLISH_GRACE_MS;
}

type StaleDispatchRecoveryDependencies = {
  store?: StaleDispatchRecoveryStore;
  publisher?: ServiceBusPublisher;
  resolveGraceMs?: () => number;
  now?: () => Date;
  batchSize?: number;
  logError?: (message: string, fields: Record<string, string>) => void;
};

/**
 * Republish durable dispatch fences without mutating lifecycle state or
 * allocating capacity. Service Bus duplicate detection makes same-ID retries
 * idempotent; the worker fence rejects any stale delivery that races progress.
 */
export function createStaleDispatchRecoveryService(
  dependencies: StaleDispatchRecoveryDependencies = {},
): {
  recoverStaleDispatchedRuns(): Promise<StaleDispatchRecoveryResult>;
} {
  const store =
    dependencies.store ?? postgresStaleDispatchRecoveryStore;
  const resolveGraceMs =
    dependencies.resolveGraceMs ?? resolveBackgroundPublishGraceMs;
  const now = dependencies.now ?? (() => new Date());
  const requestedBatchSize =
    dependencies.batchSize ?? DEFAULT_STALE_DISPATCH_BATCH_SIZE;
  const batchSize = Number.isFinite(requestedBatchSize)
    ? Math.min(
      MAX_STALE_DISPATCH_BATCH_SIZE,
      Math.max(1, Math.floor(requestedBatchSize)),
    )
    : DEFAULT_STALE_DISPATCH_BATCH_SIZE;
  const logError = dependencies.logError
    ?? ((message: string, fields: Record<string, string>) => {
      console.error(message, JSON.stringify(fields));
    });

  return {
    async recoverStaleDispatchedRuns(): Promise<StaleDispatchRecoveryResult> {
      const cutoff = new Date(
        now().getTime() - resolveGraceMs(),
      ).toISOString();
      const staleDispatches = await store.findStaleDispatches(
        cutoff,
        batchSize,
      );
      const publisher = dependencies.publisher ?? getServiceBusPublisher();
      let published = 0;
      let failed = 0;

      for (const staleDispatch of staleDispatches) {
        const message: DispatchMessage = {
          runId: staleDispatch.runId,
          dispatchMessageId: staleDispatch.dispatchMessageId,
        };
        try {
          await publisher.publish(message);
          published += 1;
        } catch {
          failed += 1;
          try {
            logError('[agent-run-admission] stale dispatch republish failed', {
              runId: staleDispatch.runId,
              dispatchMessageId: staleDispatch.dispatchMessageId,
              lane: BACKGROUND_LANE,
              reason: 'sweep',
              status: 'republish_failed',
            });
          } catch {
            // Logging must not prevent the remaining bounded batch from retrying.
          }
        }
      }

      return {
        selected: staleDispatches.length,
        published,
        failed,
      };
    },
  };
}

function ageInMilliseconds(now: Date, timestamp: string | null): number | null {
  if (!timestamp) return null;
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return null;
  return Math.max(0, now.getTime() - timestampMs);
}

function buildDispatchedEvent(
  dispatch: AdmittedDispatch,
  timestamp: string,
): AgentRunEventEnvelope {
  return {
    eventId: randomUUID(),
    threadId: dispatch.threadId,
    runId: dispatch.runId,
    sourceInstance: RUN_EVENT_SOURCE_INSTANCE,
    sequence: nextRunEventSequence(dispatch.runId),
    timestamp,
    type: 'phase',
    phase: 'dispatched',
    status: 'pending',
    detail: DISPATCHED_PROGRESS_LABEL,
    event: {
      type: 'phase',
      phase: 'dispatched',
      status: 'pending',
      detail: DISPATCHED_PROGRESS_LABEL,
      runId: dispatch.runId,
      eventTimestamp: timestamp,
    },
  };
}

export function createAdmissionGovernorService(
  dependencies: AdmissionGovernorDependencies = {},
): {
  runAdmissionCycle(reason: AdmissionReason): Promise<AdmissionResult>;
} {
  const store = dependencies.store ?? postgresAdmissionStore;
  const resolveLimit =
    dependencies.resolveLimit ?? resolveBackgroundInFlightLimit;
  const createUuid = dependencies.randomUuid ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());
  const telemetry = dependencies.telemetry ?? trackEvent;
  const typedTelemetry = dependencies.workerTelemetry ?? workerTierTelemetry;
  const publishRunEvent =
    dependencies.notifyRunEvent ?? notifyDurableRunEvent;
  const logError = dependencies.logError
    ?? ((message: string, fields: Record<string, string>) => {
      console.error(message, JSON.stringify(fields));
    });

  const emitTelemetry: AdmissionTelemetry = (name, properties, measurements) => {
    try {
      telemetry(name, properties, measurements);
    } catch {
      // Observability must never affect durable admission.
    }
  };
  const emitWorkerTelemetry = (emit: () => void): void => {
    try {
      emit();
    } catch {
      // Observability must never affect durable admission.
    }
  };

  return {
    async runAdmissionCycle(reason: AdmissionReason): Promise<AdmissionResult> {
      const limit = resolveLimit();
      const cycleNow = now();
      const dispatchedAt = cycleNow.toISOString();

      const outcome = await store.runInTransaction<TransactionOutcome>(
        async (transaction) => {
          await transaction.acquireGlobalLock();
          const snapshot = await transaction.readQueueSnapshot();
          const free = Math.max(0, limit - snapshot.inFlight);
          const dispatches: AdmittedDispatch[] = [];

          for (let slot = 0; slot < free; slot += 1) {
            const admitted = await transaction.admitNext(
              createUuid(),
              dispatchedAt,
            );
            if (!admitted) break;
            dispatches.push(admitted);
          }

          const finalSnapshot = await transaction.readQueueSnapshot();
          return { snapshot, finalSnapshot, dispatches };
        },
      );

      // The transaction promise has resolved, so every fence below is durable
      // before its corresponding payload-free message is published.
      for (const dispatch of outcome.dispatches) {
        try {
          await publishRunEvent(
            buildDispatchedEvent(dispatch, dispatchedAt),
            { persist: true },
          );
        } catch {
          logError('[agent-run-admission] dispatched event publish failed', {
            runId: dispatch.runId,
            dispatchMessageId: dispatch.dispatchMessageId,
            project: dispatch.projectId,
            lane: dispatch.lane,
          });
        }
      }

      const publisher = dependencies.publisher ?? getServiceBusPublisher();
      for (const dispatch of outcome.dispatches) {
        const message: DispatchMessage = {
          runId: dispatch.runId,
          dispatchMessageId: dispatch.dispatchMessageId,
        };
        try {
          await publisher.publish(message);
        } catch {
          // Do not include broker error text: it can contain response content,
          // credentials, URLs, or other operational secrets.
          logError('[agent-run-admission] publish failed', {
            runId: dispatch.runId,
            dispatchMessageId: dispatch.dispatchMessageId,
            projectId: dispatch.projectId,
            lane: dispatch.lane,
            reason,
            status: 'publish_failed',
          });
        }
      }

      const cycleMeasurements: Record<string, number> = {
        limit,
        inFlight: outcome.snapshot.inFlight,
        admitted: outcome.dispatches.length,
        queuedDepth: outcome.snapshot.queuedDepth,
      };
      const oldestQueuedAgeMs = ageInMilliseconds(
        cycleNow,
        outcome.snapshot.oldestQueuedAt,
      );
      if (oldestQueuedAgeMs !== null) {
        cycleMeasurements.oldestQueuedAgeMs = oldestQueuedAgeMs;
      }
      emitTelemetry(
        'agent_run.admission_cycle',
        { lane: BACKGROUND_LANE, reason },
        cycleMeasurements,
      );
      const workerContext = { lane: BACKGROUND_LANE };
      emitWorkerTelemetry(() => {
        typedTelemetry.inflight(
          workerContext,
          outcome.finalSnapshot.inFlight,
          limit,
        );
      });
      emitWorkerTelemetry(() => {
        typedTelemetry.queueDepth(
          workerContext,
          outcome.finalSnapshot.queuedDepth,
        );
      });
      const finalOldestQueuedAgeMs = ageInMilliseconds(
        cycleNow,
        outcome.finalSnapshot.oldestQueuedAt,
      ) ?? 0;
      emitWorkerTelemetry(() => {
        typedTelemetry.queueOldestAge(
          workerContext,
          finalOldestQueuedAgeMs,
        );
      });

      for (const dispatch of outcome.dispatches) {
        const admissionWaitMs =
          ageInMilliseconds(cycleNow, dispatch.queuedAt) ?? 0;
        emitTelemetry(
          'agent_run.admitted',
          {
            runId: dispatch.runId,
            dispatchMessageId: dispatch.dispatchMessageId,
            projectId: dispatch.projectId,
            lane: dispatch.lane,
            reason,
          },
          {
            projectInFlight: dispatch.projectInFlight,
            admissionWaitMs,
          },
        );
        const context = {
          runId: dispatch.runId,
          dispatchMessageId: dispatch.dispatchMessageId,
          project: dispatch.projectId,
          lane: dispatch.lane,
        };
        emitWorkerTelemetry(() => {
          typedTelemetry.projectInflight(
            context,
            dispatch.projectInFlight + 1,
          );
        });
        emitWorkerTelemetry(() => {
          typedTelemetry.admissionWait(context, admissionWaitMs);
        });
      }

      return {
        admitted: outcome.dispatches.length,
        inFlight: outcome.snapshot.inFlight,
        limit,
      };
    },
  };
}

const defaultAdmissionGovernor = createAdmissionGovernorService();
const defaultStaleDispatchRecovery =
  createStaleDispatchRecoveryService();

export async function runAdmissionCycle(
  reason: AdmissionReason,
): Promise<AdmissionResult> {
  return defaultAdmissionGovernor.runAdmissionCycle(reason);
}

export async function recoverStaleDispatchedRuns(
): Promise<StaleDispatchRecoveryResult> {
  return defaultStaleDispatchRecovery.recoverStaleDispatchedRuns();
}
