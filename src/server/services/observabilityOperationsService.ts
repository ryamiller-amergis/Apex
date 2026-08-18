/**
 * Retention scheduler and payload-free Capture Health composition (TBI-006 / FEAT-004).
 * Purge is a safety invariant: it runs even when observability-capture is disabled.
 */
import os from 'os';
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/drizzle';
import {
  CAPTURE_BUFFER_CAPACITY,
  type CaptureHealthResponse,
  type CaptureHealthSnapshot,
} from '../../shared/types/observability';
import { getObservabilityCaptureService } from './observabilityCaptureService';
import { isObservabilityCaptureEnabled } from './observabilityCaptureFlagSnapshot';
import { trackEvent } from './telemetry';

export const OBSERVABILITY_RETENTION_LOCK_KEY = 'apex:observability-retention';
export const OBSERVABILITY_RETENTION_DAYS = 30;
export const OBSERVABILITY_RETENTION_CHUNK_SIZE = 5_000;
export const OBSERVABILITY_RETENTION_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const OBSERVABILITY_RETENTION_HOUR_UTC = 2;

export class CaptureHealthUnavailableError extends Error {
  readonly code = 'CAPTURE_HEALTH_UNAVAILABLE' as const;

  constructor() {
    super('Capture health unavailable');
    this.name = 'CaptureHealthUnavailableError';
  }
}

export interface RetentionCycleResult {
  skipped: boolean;
  deletedCount: number;
}

export interface ObservabilityOperationsDb {
  execute: (query: unknown) => Promise<unknown>;
  transaction: (
    fn: (tx: { execute: (query: unknown) => Promise<unknown> }) => Promise<unknown>,
  ) => Promise<unknown>;
}

export interface ObservabilityOperationsDeps {
  db?: ObservabilityOperationsDb;
  getCaptureHealth?: () => CaptureHealthSnapshot;
  isCaptureEnabled?: () => boolean;
  now?: () => Date;
  instanceId?: string;
  track?: typeof trackEvent;
}

export interface ObservabilityOperationsService {
  getCaptureHealth(): Promise<CaptureHealthResponse>;
  runRetentionCycle(): Promise<RetentionCycleResult>;
  start(options?: { e2eMode?: boolean }): void;
  stop(): void;
  tick(): Promise<void>;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

function isLockAcquired(value: unknown): boolean {
  return value === true || value === 't' || value === 'true';
}

function finiteNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function utcDateString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function isRetentionDue(now: Date, lastSuccessfulUtcDate: string | null): boolean {
  if (now.getUTCHours() < OBSERVABILITY_RETENTION_HOUR_UTC) return false;
  return lastSuccessfulUtcDate !== utcDateString(now);
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  const asString = String(value);
  return asString.length > 0 ? asString : null;
}

function parseBytes(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function errorCategory(err: unknown): string {
  const message = err instanceof Error ? err.message : 'unknown';
  if (/lock/i.test(message)) return 'lock_failed';
  return 'purge_failed';
}

function projectHealth(
  pipeline: CaptureHealthSnapshot,
  store: { approximateStoreBytes: number; oldestRetainedEventAt: string | null },
  captureEnabled: boolean,
  instanceId: string,
  capturedAt: string,
): CaptureHealthResponse {
  const latest = pipeline.lastFlushError
    ? {
        occurredAt: pipeline.lastFlushError.occurredAt,
        message: pipeline.lastFlushError.message.slice(0, 512),
      }
    : null;
  return {
    capturedAt,
    instanceId,
    captureEnabled,
    pipeline: {
      scope: 'instance',
      droppedEvents: finiteNonNegative(pipeline.droppedEvents),
      droppedEventsPerSecond: finiteNonNegative(pipeline.droppedEventsPerSecond),
      bufferDepth: finiteNonNegative(pipeline.bufferDepth),
      bufferCapacity: CAPTURE_BUFFER_CAPACITY,
      flushErrorCount: finiteNonNegative(pipeline.flushErrorCount),
      latestFlushError: latest,
      ingestedEventsPerSecond: finiteNonNegative(pipeline.ingestedEventsPerSecond),
    },
    store: {
      scope: 'database',
      approximateStoreBytes: store.approximateStoreBytes,
      oldestRetainedEventAt: store.oldestRetainedEventAt,
    },
  };
}

export function createObservabilityOperationsService(
  deps: ObservabilityOperationsDeps = {},
): ObservabilityOperationsService {
  const drizzle: ObservabilityOperationsDb = deps.db ?? (defaultDb as unknown as ObservabilityOperationsDb);
  const getCaptureHealthSnapshot =
    deps.getCaptureHealth ?? (() => getObservabilityCaptureService().getHealth());
  const isCaptureEnabled = deps.isCaptureEnabled ?? isObservabilityCaptureEnabled;
  const now = deps.now ?? (() => new Date());
  const instanceId = deps.instanceId ?? `${os.hostname()}:${process.pid}`;
  const track = deps.track ?? trackEvent;

  let timer: ReturnType<typeof setInterval> | null = null;
  let isRunning = false;
  let lastSuccessfulUtcDate: string | null = null;

  async function readStoreStatistics(): Promise<{
    approximateStoreBytes: number;
    oldestRetainedEventAt: string | null;
  }> {
    try {
      const result = await drizzle.execute(sql`
        SELECT
          pg_total_relation_size('trace_events')::bigint AS bytes,
          (SELECT MIN(occurred_at) FROM trace_events) AS oldest
      `);
      const row = resultRows<{ bytes?: unknown; oldest?: unknown }>(result)[0];
      return {
        approximateStoreBytes: parseBytes(row?.bytes),
        oldestRetainedEventAt: toIsoOrNull(row?.oldest),
      };
    } catch {
      throw new CaptureHealthUnavailableError();
    }
  }

  async function getCaptureHealth(): Promise<CaptureHealthResponse> {
    let pipeline: CaptureHealthSnapshot;
    try {
      pipeline = getCaptureHealthSnapshot();
    } catch {
      throw new CaptureHealthUnavailableError();
    }
    const store = await readStoreStatistics();
    return projectHealth(
      pipeline,
      store,
      isCaptureEnabled(),
      instanceId,
      now().toISOString(),
    );
  }

  async function runRetentionCycle(): Promise<RetentionCycleResult> {
    const startedAt = now().getTime();
    try {
      track('observability.retention.started');
    } catch {
      // Telemetry must never affect retention.
    }

    let deletedCount = 0;
    try {
      while (true) {
        const chunk = (await drizzle.transaction(async (tx) => {
          const lockResult = await tx.execute(sql`
            SELECT pg_try_advisory_xact_lock(hashtext(${OBSERVABILITY_RETENTION_LOCK_KEY})) AS acquired
          `);
          const acquired = isLockAcquired(
            resultRows<{ acquired?: unknown }>(lockResult)[0]?.acquired,
          );
          if (!acquired) {
            return { skipped: true, deleted: 0 };
          }

          const deletedResult = await tx.execute(sql`
            DELETE FROM trace_events
            WHERE id IN (
              SELECT id
              FROM trace_events
              WHERE occurred_at < NOW() - INTERVAL '30 days'
              ORDER BY occurred_at ASC
              LIMIT ${OBSERVABILITY_RETENTION_CHUNK_SIZE}
            )
            RETURNING id
          `);
          return { skipped: false, deleted: resultRows(deletedResult).length };
        })) as { skipped: boolean; deleted: number };

        if (chunk.skipped) {
          try {
            track('observability.retention.skipped_lock');
          } catch {
            // ignore
          }
          return { skipped: true, deletedCount };
        }

        deletedCount += chunk.deleted;
        if (chunk.deleted < OBSERVABILITY_RETENTION_CHUNK_SIZE) {
          break;
        }
      }

      try {
        track('observability.retention.completed', undefined, {
          deletedCount,
          durationMs: Math.max(0, now().getTime() - startedAt),
        });
      } catch {
        // ignore
      }
      return { skipped: false, deletedCount };
    } catch (err) {
      try {
        track('observability.retention.failed', { category: errorCategory(err) });
      } catch {
        // ignore
      }
      throw err;
    }
  }

  async function tick(): Promise<void> {
    if (isRunning) return;
    const current = now();
    if (!isRetentionDue(current, lastSuccessfulUtcDate)) return;
    isRunning = true;
    try {
      const result = await runRetentionCycle();
      if (!result.skipped) {
        lastSuccessfulUtcDate = utcDateString(current);
      }
    } catch {
      // Contained: next hourly check remains eligible because lastSuccessfulUtcDate is unchanged.
    } finally {
      isRunning = false;
    }
  }

  function start(options?: { e2eMode?: boolean }): void {
    const e2eMode = options?.e2eMode ?? process.env.E2E_MODE === 'true';
    if (e2eMode) return;
    if (timer) return;
    timer = setInterval(() => {
      void tick();
    }, OBSERVABILITY_RETENTION_CHECK_INTERVAL_MS);
    timer.unref?.();
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { getCaptureHealth, runRetentionCycle, start, stop, tick };
}

let singleton: ObservabilityOperationsService | null = null;

function getOperations(): ObservabilityOperationsService {
  singleton ??= createObservabilityOperationsService();
  return singleton;
}

export function getCaptureHealth(): Promise<CaptureHealthResponse> {
  return getOperations().getCaptureHealth();
}

export function runRetentionCycle(): Promise<RetentionCycleResult> {
  return getOperations().runRetentionCycle();
}

export function startObservabilityOperations(): void {
  getOperations().start({ e2eMode: process.env.E2E_MODE === 'true' });
}

export function stopObservabilityOperations(): void {
  getOperations().stop();
}

export function resetObservabilityOperationsForTests(): void {
  singleton?.stop();
  singleton = null;
}
