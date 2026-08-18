/**
 * TBI-006 — Operate retention and capture health.
 * Criterion ids are greppable: DoD-0, DoD-1, DoD-2, BR-006, BR-010, BR-012, VT-01–VT-06, VT-10–VT-12.
 */
jest.mock('../db/drizzle', () => ({
  db: {
    execute: jest.fn(),
    transaction: jest.fn(),
  },
}));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));
jest.mock('../services/observabilityCaptureService', () => ({
  getObservabilityCaptureService: jest.fn(() => ({
    getHealth: jest.fn(),
  })),
}));
jest.mock('../services/observabilityCaptureFlagSnapshot', () => ({
  isObservabilityCaptureEnabled: jest.fn(() => true),
}));

import { CAPTURE_BUFFER_CAPACITY, type CaptureHealthSnapshot } from '../../shared/types/observability';
import {
  CaptureHealthUnavailableError,
  OBSERVABILITY_RETENTION_CHUNK_SIZE,
  OBSERVABILITY_RETENTION_CHECK_INTERVAL_MS,
  OBSERVABILITY_RETENTION_LOCK_KEY,
  createObservabilityOperationsService,
  isRetentionDue,
} from '../services/observabilityOperationsService';
import { trackEvent } from '../services/telemetry';

function sqlText(arg: unknown): string {
  if (arg == null) return '';
  if (typeof arg === 'string') return arg;
  const chunks = (arg as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) {
    if (arg && typeof arg === 'object' && 'value' in (arg as object)) {
      return String((arg as { value: unknown }).value ?? '');
    }
    return String(arg);
  }
  return chunks.map((c) => sqlText(c)).join('');
}

function pipelineSnapshot(overrides: Partial<CaptureHealthSnapshot> = {}): CaptureHealthSnapshot {
  return {
    bufferDepth: 0,
    bufferCapacity: CAPTURE_BUFFER_CAPACITY,
    droppedEvents: 0,
    droppedEventsPerSecond: 0,
    flushErrorCount: 0,
    lastFlushError: null,
    acceptedEvents: 0,
    persistedEvents: 0,
    ingestedEventsPerSecond: 0,
    ...overrides,
  };
}

function createMockDb(ctrl: {
  lockAcquired?: boolean;
  deleteCounts?: number[];
  deleteError?: Error;
  storeBytes?: number;
  oldest?: string | null;
  storeError?: Error;
}) {
  let deleteIdx = 0;
  const execute = jest.fn(async (query: unknown) => {
    const text = sqlText(query).toLowerCase();
    if (text.includes('pg_try_advisory_xact_lock')) {
      return { rows: [{ acquired: ctrl.lockAcquired ?? true }] };
    }
    if (text.includes('delete from trace_events')) {
      if (ctrl.deleteError) throw ctrl.deleteError;
      const n = ctrl.deleteCounts?.[deleteIdx] ?? 0;
      deleteIdx += 1;
      return { rows: Array.from({ length: n }, (_, i) => ({ id: `expired-${deleteIdx}-${i}` })) };
    }
    if (ctrl.storeError) throw ctrl.storeError;
    if (text.includes('pg_total_relation_size') || text.includes('min(occurred_at)')) {
      return { rows: [{ bytes: ctrl.storeBytes ?? 0, oldest: ctrl.oldest ?? null }] };
    }
    return { rows: [] };
  });

  const transaction = jest.fn(async (fn: (tx: { execute: typeof execute }) => Promise<unknown>) =>
    fn({ execute }),
  );

  return { execute, transaction, deletedChunks: () => deleteIdx };
}

describe('observabilityOperationsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('isRetentionDue', () => {
    it('attempts after 02:00 UTC once per UTC date', () => {
      expect(isRetentionDue(new Date('2026-08-17T01:59:00.000Z'), null)).toBe(false);
      expect(isRetentionDue(new Date('2026-08-17T02:00:00.000Z'), null)).toBe(true);
      expect(isRetentionDue(new Date('2026-08-17T15:00:00.000Z'), '2026-08-17')).toBe(false);
      expect(isRetentionDue(new Date('2026-08-18T02:00:00.000Z'), '2026-08-17')).toBe(true);
    });
  });

  describe('runRetentionCycle', () => {
    it('VT-01 / DoD-0 / BR-006 deletes only strictly expired raw events using a 30-day predicate and never targets rollups', async () => {
      const db = createMockDb({ deleteCounts: [2] });
      const ops = createObservabilityOperationsService({ db });

      const result = await ops.runRetentionCycle();

      expect(result).toEqual({ skipped: false, deletedCount: 2 });
      const texts = db.execute.mock.calls.map(([query]) => sqlText(query));
      expect(texts.some((t) => t.includes(OBSERVABILITY_RETENTION_LOCK_KEY))).toBe(true);
      expect(texts.some((t) => /occurred_at\s*<\s*NOW\(\)\s*-\s*INTERVAL '30 days'/i.test(t))).toBe(true);
      expect(texts.every((t) => !/trace_path_rollups/i.test(t))).toBe(true);
      expect(trackEvent).toHaveBeenCalledWith('observability.retention.started');
      expect(trackEvent).toHaveBeenCalledWith(
        'observability.retention.completed',
        undefined,
        expect.objectContaining({ deletedCount: 2 }),
      );
    });

    it('VT-02 / DoD-1 / BR-012 skips deletion when another instance holds the advisory lock', async () => {
      const db = createMockDb({ lockAcquired: false, deleteCounts: [99] });
      const ops = createObservabilityOperationsService({ db });

      const result = await ops.runRetentionCycle();

      expect(result).toEqual({ skipped: true, deletedCount: 0 });
      const texts = db.execute.mock.calls.map(([query]) => sqlText(query));
      expect(texts.some((t) => /delete from trace_events/i.test(t))).toBe(false);
      expect(trackEvent).toHaveBeenCalledWith('observability.retention.skipped_lock');
    });

    it('VT-03 deletes expired rows in 5000-row chunks until a short chunk', async () => {
      const db = createMockDb({
        deleteCounts: [OBSERVABILITY_RETENTION_CHUNK_SIZE, OBSERVABILITY_RETENTION_CHUNK_SIZE, 12],
      });
      const ops = createObservabilityOperationsService({ db });

      const result = await ops.runRetentionCycle();

      expect(result.skipped).toBe(false);
      expect(result.deletedCount).toBe(OBSERVABILITY_RETENTION_CHUNK_SIZE * 2 + 12);
      expect(db.transaction).toHaveBeenCalledTimes(3);
      expect(db.deletedChunks()).toBe(3);
    });

    it('VT-03 / DoD-0 treats an empty store as a completed zero-delete cycle', async () => {
      const db = createMockDb({ deleteCounts: [0] });
      const ops = createObservabilityOperationsService({ db });

      await expect(ops.runRetentionCycle()).resolves.toEqual({ skipped: false, deletedCount: 0 });
    });

    it('VT-04 / DoD-2 surfaces a purge-chunk failure without swallowing it at the cycle boundary', async () => {
      const db = createMockDb({ deleteError: new Error('postgres://user:secret@db/apex') });
      const ops = createObservabilityOperationsService({ db });

      await expect(ops.runRetentionCycle()).rejects.toThrow(/postgres:\/\//);
      expect(trackEvent).toHaveBeenCalledWith('observability.retention.failed', {
        category: 'purge_failed',
      });
    });

    it('VT-11 / BR-010 still purges expired rows when capture is disabled', async () => {
      const db = createMockDb({ deleteCounts: [4] });
      const ops = createObservabilityOperationsService({
        db,
        isCaptureEnabled: () => false,
      });

      await expect(ops.runRetentionCycle()).resolves.toEqual({ skipped: false, deletedCount: 4 });
    });
  });

  describe('getCaptureHealth', () => {
    it('VT-05 / DoD-2 returns scoped payload-free health including capacity, rates, store size, and oldest timestamp', async () => {
      const db = createMockDb({
        storeBytes: 4096,
        oldest: '2026-07-18T02:00:00.000Z',
      });
      const ops = createObservabilityOperationsService({
        db,
        instanceId: 'host-a:42',
        now: () => new Date('2026-08-17T16:00:00.000Z'),
        isCaptureEnabled: () => true,
        getCaptureHealth: () =>
          pipelineSnapshot({
            droppedEvents: 3,
            droppedEventsPerSecond: 0.05,
            bufferDepth: CAPTURE_BUFFER_CAPACITY,
            flushErrorCount: 2,
            lastFlushError: { occurredAt: '2026-08-17T15:59:00.000Z', message: 'insert failed' },
            ingestedEventsPerSecond: 1.5,
          }),
      });

      const health = await ops.getCaptureHealth();

      expect(health).toEqual({
        capturedAt: '2026-08-17T16:00:00.000Z',
        instanceId: 'host-a:42',
        captureEnabled: true,
        pipeline: {
          scope: 'instance',
          droppedEvents: 3,
          droppedEventsPerSecond: 0.05,
          bufferDepth: CAPTURE_BUFFER_CAPACITY,
          bufferCapacity: CAPTURE_BUFFER_CAPACITY,
          flushErrorCount: 2,
          latestFlushError: { occurredAt: '2026-08-17T15:59:00.000Z', message: 'insert failed' },
          ingestedEventsPerSecond: 1.5,
        },
        store: {
          scope: 'database',
          approximateStoreBytes: 4096,
          oldestRetainedEventAt: '2026-07-18T02:00:00.000Z',
        },
      });
      expect(JSON.stringify(health)).not.toMatch(/details|actorUserId|traceId|sessionId|routeTemplate/);
      expect(Object.keys(health)).toEqual([
        'capturedAt',
        'instanceId',
        'captureEnabled',
        'pipeline',
        'store',
      ]);
    });

    it('VT-06 represents an empty store with a null oldest timestamp and non-negative counters', async () => {
      const db = createMockDb({ storeBytes: 0, oldest: null });
      const ops = createObservabilityOperationsService({
        db,
        instanceId: 'host-b:1',
        now: () => new Date('2026-08-17T16:00:00.000Z'),
        getCaptureHealth: () => pipelineSnapshot(),
      });

      const health = await ops.getCaptureHealth();
      expect(health.store.oldestRetainedEventAt).toBeNull();
      expect(health.store.approximateStoreBytes).toBe(0);
      expect(health.pipeline.droppedEvents).toBe(0);
      expect(health.pipeline.droppedEventsPerSecond).toBe(0);
      expect(health.pipeline.ingestedEventsPerSecond).toBe(0);
    });

    it('VT-10 throws CaptureHealthUnavailableError instead of a partial snapshot when store statistics fail', async () => {
      const db = createMockDb({ storeError: new Error('relation size denied') });
      const ops = createObservabilityOperationsService({
        db,
        getCaptureHealth: () => pipelineSnapshot({ droppedEvents: 9 }),
      });

      await expect(ops.getCaptureHealth()).rejects.toBeInstanceOf(CaptureHealthUnavailableError);
    });

    it('VT-11 reports captureEnabled false while still returning store statistics', async () => {
      const db = createMockDb({ storeBytes: 128, oldest: '2026-08-01T00:00:00.000Z' });
      const ops = createObservabilityOperationsService({
        db,
        isCaptureEnabled: () => false,
        now: () => new Date('2026-08-17T16:00:00.000Z'),
        instanceId: 'idle:1',
        getCaptureHealth: () => pipelineSnapshot(),
      });

      const health = await ops.getCaptureHealth();
      expect(health.captureEnabled).toBe(false);
      expect(health.store.approximateStoreBytes).toBe(128);
    });
  });

  describe('scheduler lifecycle', () => {
    it('start/stop are idempotent', () => {
      const db = createMockDb({ deleteCounts: [0] });
      const ops = createObservabilityOperationsService({ db });
      ops.start({ e2eMode: false });
      ops.start({ e2eMode: false });
      ops.stop();
      ops.stop();
    });

    it('VT-12 does not start when E2E_MODE is true', async () => {
      jest.useFakeTimers();
      const db = createMockDb({ deleteCounts: [1] });
      const ops = createObservabilityOperationsService({
        db,
        now: () => new Date('2026-08-17T03:00:00.000Z'),
      });

      ops.start({ e2eMode: true });
      await jest.advanceTimersByTimeAsync(OBSERVABILITY_RETENTION_CHECK_INTERVAL_MS);
      expect(db.transaction).not.toHaveBeenCalled();
      ops.stop();
    });

    it('VT-04 remains eligible after a failed cycle and does not overlap in-process', async () => {
      let hanging: ((value: unknown) => void) | undefined;
      const execute = jest.fn(async (query: unknown) => {
        const text = sqlText(query).toLowerCase();
        if (text.includes('pg_try_advisory_xact_lock')) {
          await new Promise((resolve) => {
            hanging = resolve;
          });
          return { rows: [{ acquired: true }] };
        }
        if (text.includes('delete from trace_events')) {
          return { rows: [] };
        }
        return { rows: [] };
      });
      const db = {
        execute,
        transaction: jest.fn(async (fn: (tx: { execute: typeof execute }) => Promise<unknown>) =>
          fn({ execute }),
        ),
      };
      const ops = createObservabilityOperationsService({
        db,
        now: () => new Date('2026-08-17T03:00:00.000Z'),
      });

      const first = ops.tick();
      const second = ops.tick();
      hanging?.({});
      await Promise.all([first, second]);
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('VT-04 retries on the next hourly check after a chunk failure', async () => {
      const db = createMockDb({ deleteError: new Error('chunk failed') });
      const ops = createObservabilityOperationsService({
        db,
        now: () => new Date('2026-08-17T03:00:00.000Z'),
      });

      await ops.tick();
      expect(db.transaction).toHaveBeenCalledTimes(1);

      db.execute.mockImplementation(async (query: unknown) => {
        const text = sqlText(query).toLowerCase();
        if (text.includes('pg_try_advisory_xact_lock')) {
          return { rows: [{ acquired: true }] };
        }
        if (text.includes('delete from trace_events')) {
          return { rows: [] };
        }
        return { rows: [] };
      });
      await ops.tick();
      expect(db.transaction).toHaveBeenCalledTimes(2);
    });

    it('hourly interval runs the due cycle after 02:00 UTC', async () => {
      jest.useFakeTimers();
      const db = createMockDb({ deleteCounts: [1] });
      const ops = createObservabilityOperationsService({
        db,
        now: () => new Date('2026-08-17T03:00:00.000Z'),
      });
      ops.start({ e2eMode: false });
      expect(db.transaction).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(OBSERVABILITY_RETENTION_CHECK_INTERVAL_MS);
      expect(db.transaction).toHaveBeenCalled();
      ops.stop();
    });
  });
});
