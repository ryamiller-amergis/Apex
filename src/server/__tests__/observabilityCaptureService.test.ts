/**
 * TBI-003 / PBI-001 — buffered server capture pipeline.
 * Criterion ids are greppable: AC-0, AC-1, AC-2, AC-3, DoD-0, DoD-2, VT-01–VT-08, VT-11.
 */
jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));
import {
  CAPTURE_BUFFER_CAPACITY,
  CAPTURE_FLUSH_BATCH_SIZE,
  CAPTURE_HEALTH_RATE_WINDOW_MS,
  TRACE_REDACTED_MARKER,
  type SafeTraceEventInput,
  type ServerTraceCandidate,
} from '../../shared/types/observability';
import { createObservabilityCaptureService } from '../services/observabilityCaptureService';

const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

function candidate(overrides: Partial<ServerTraceCandidate> = {}): ServerTraceCandidate {
  return {
    eventType: 'api_request',
    occurredAt: '2026-08-17T16:00:00.000Z',
    actorUserId: 'user-oid-1',
    projectId: 'Apex',
    sessionId: 'session-1',
    traceId: VALID_TRACE_ID,
    routeTemplate: '/api/projects',
    httpMethod: 'GET',
    statusCode: 200,
    durationMs: 8,
    severity: 'info',
    trigger: 'human',
    ...overrides,
  };
}

function createService(options?: {
  enabled?: boolean;
  insert?: jest.Mock;
  retryDelayMs?: number;
  shutdownDrainMs?: number;
  now?: () => number;
}) {
  const insertBatch =
    options?.insert ??
    jest.fn(async (events: SafeTraceEventInput[]) => ({ insertedCount: events.length }));
  let enabled = options?.enabled ?? true;
  const service = createObservabilityCaptureService({
    isCaptureEnabled: () => enabled,
    insertBatch,
    retryDelayMs: options?.retryDelayMs ?? 0,
    shutdownDrainMs: options?.shutdownDrainMs ?? 0,
    now: options?.now,
  });
  return {
    service,
    insertBatch,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('observabilityCaptureService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('VT-01 / AC-0 / DoD-0 queues a redacted event synchronously without awaiting the writer', () => {
    let resolveInsert: ((value: { insertedCount: number }) => void) | undefined;
    const insertBatch = jest.fn(
      () =>
        new Promise<{ insertedCount: number }>((resolve) => {
          resolveInsert = resolve;
        }),
    );
    const { service } = createService({ insert: insertBatch });

    const disposition = service.capture(candidate());
    const health = service.getHealth();

    expect(disposition).toBe('queued');
    expect(health.bufferDepth).toBe(1);
    expect(health.acceptedEvents).toBe(1);
    expect(insertBatch).not.toHaveBeenCalled();
    resolveInsert?.({ insertedCount: 0 });
  });

  it('VT-11 / AC-0 redacts secrets before the event enters the buffer', async () => {
    const { service, insertBatch } = createService();
    service.capture(
      candidate({
        headers: {
          authorization: 'Bearer super-secret',
          cookie: 'sid=abc',
          'content-type': 'application/json',
        },
        details: {
          body: { interviewText: 'BODY-MARKER' },
          token: 'should-not-buffer',
          note: 'ok',
        },
      }),
    );

    await service.flush();

    expect(insertBatch).toHaveBeenCalledTimes(1);
    const [rows] = insertBatch.mock.calls[0] as [SafeTraceEventInput[]];
    const buffered = rows[0];
    expect(buffered?.details.note).toBe('ok');
    expect(buffered?.details.token).toBe(TRACE_REDACTED_MARKER);
    expect(JSON.stringify(buffered)).not.toMatch(/super-secret|sid=abc|BODY-MARKER|should-not-buffer/);
    expect(buffered?.actorUserId).toBe('user-oid-1');
    expect(buffered?.traceId).toBe(VALID_TRACE_ID);
    expect(buffered?.routeTemplate).toBe('/api/projects');
  });

  it('VT-03 / AC-0 flushes 100 FIFO events asynchronously when the batch threshold is reached', async () => {
    const { service, insertBatch } = createService();

    for (let i = 0; i < CAPTURE_FLUSH_BATCH_SIZE - 1; i += 1) {
      service.capture(candidate({ durationMs: i }));
    }
    expect(insertBatch).not.toHaveBeenCalled();

    service.capture(candidate({ durationMs: 99 }));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(insertBatch).toHaveBeenCalledTimes(1);
    const [rows] = insertBatch.mock.calls[0] as [SafeTraceEventInput[]];
    expect(rows).toHaveLength(CAPTURE_FLUSH_BATCH_SIZE);
    expect(rows[0]?.durationMs).toBe(0);
    expect(rows[99]?.durationMs).toBe(99);
    expect(service.getHealth().bufferDepth).toBe(0);
    expect(service.getHealth().persistedEvents).toBe(CAPTURE_FLUSH_BATCH_SIZE);
  });

  it('VT-04 / DoD-2 starts one flush after exactly two seconds and not earlier', async () => {
    jest.useFakeTimers();
    const { service, insertBatch } = createService();
    service.start();
    service.capture(candidate());

    await jest.advanceTimersByTimeAsync(1999);
    expect(insertBatch).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(insertBatch).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('VT-05 / AC-1 retries a failed batch once then drops it and records a scrubbed flush error', async () => {
    const insertBatch = jest.fn(async () => {
      throw new Error('insert failed Bearer secret-token');
    });
    const { service } = createService({ insert: insertBatch, retryDelayMs: 0 });
    service.capture(candidate());

    await service.flush();

    expect(insertBatch).toHaveBeenCalledTimes(2);
    const health = service.getHealth();
    expect(health.bufferDepth).toBe(0);
    expect(health.flushErrorCount).toBe(1);
    expect(health.persistedEvents).toBe(0);
    expect(health.lastFlushError?.message).toContain(TRACE_REDACTED_MARKER);
    expect(health.lastFlushError?.message).not.toMatch(/secret-token/);
  });

  it('AC-1 / DoD-2 contains flush failures so capture() never rejects', async () => {
    const insertBatch = jest.fn(async () => {
      throw new Error('db down');
    });
    const { service } = createService({ insert: insertBatch });
    expect(() => service.capture(candidate())).not.toThrow();
    await expect(service.flush()).resolves.toBeUndefined();
    expect(service.getHealth().flushErrorCount).toBe(1);
  });

  it('VT-07 / AC-2 / DoD-2 drops overflow while a single in-flight flush holds the first batch', async () => {
    let resolveInsert: ((value: { insertedCount: number }) => void) | undefined;
    const insertBatch = jest.fn(
      () =>
        new Promise<{ insertedCount: number }>((resolve) => {
          resolveInsert = resolve;
        }),
    );
    const { service } = createService({ insert: insertBatch });

    for (let i = 0; i < CAPTURE_FLUSH_BATCH_SIZE; i += 1) {
      service.capture(candidate({ durationMs: i }));
    }
    await flushMicrotasks();
    expect(insertBatch).toHaveBeenCalledTimes(1);

    for (let i = 0; i < CAPTURE_BUFFER_CAPACITY; i += 1) {
      expect(service.capture(candidate({ durationMs: 1_000 + i }))).toBe('queued');
    }

    expect(service.getHealth().bufferDepth).toBe(CAPTURE_BUFFER_CAPACITY);
    expect(service.capture(candidate({ durationMs: 99_999 }))).toBe('dropped');
    const health = service.getHealth();
    expect(health.bufferDepth).toBe(CAPTURE_BUFFER_CAPACITY);
    expect(health.droppedEvents).toBe(1);
    resolveInsert?.({ insertedCount: 0 });
  });

  it('VT-08 / AC-3 / BR-010 is a complete no-op when capture is disabled', async () => {
    jest.useFakeTimers();
    const { service, insertBatch } = createService({ enabled: false });
    service.start();

    expect(service.capture(candidate())).toBe('disabled');
    await jest.advanceTimersByTimeAsync(2_000);
    await service.flush();

    expect(insertBatch).not.toHaveBeenCalled();
    expect(service.getHealth()).toEqual({
      bufferDepth: 0,
      bufferCapacity: CAPTURE_BUFFER_CAPACITY,
      droppedEvents: 0,
      droppedEventsPerSecond: 0,
      flushErrorCount: 0,
      lastFlushError: null,
      acceptedEvents: 0,
      persistedEvents: 0,
      ingestedEventsPerSecond: 0,
    });
    service.stop();
  });

  it('DoD-2 keeps a second instance independently capped', () => {
    const first = createService();
    const second = createService();
    first.service.capture(candidate());
    expect(first.service.getHealth().bufferDepth).toBe(1);
    expect(second.service.getHealth().bufferDepth).toBe(0);
  });

  it('FEAT-004 / VT-05 overflow increments droppedEvents and droppedEventsPerSecond without resetting on snapshot read', async () => {
    const nowMs = 1_700_000_000_000;
    let resolveInsert: ((value: { insertedCount: number }) => void) | undefined;
    const insertBatch = jest.fn(
      () =>
        new Promise<{ insertedCount: number }>((resolve) => {
          resolveInsert = resolve;
        }),
    );
    const { service } = createService({ insert: insertBatch, now: () => nowMs });

    for (let i = 0; i < CAPTURE_FLUSH_BATCH_SIZE; i += 1) {
      service.capture(candidate({ durationMs: i }));
    }
    await Promise.resolve();
    for (let i = 0; i < CAPTURE_BUFFER_CAPACITY; i += 1) {
      service.capture(candidate({ durationMs: 1_000 + i }));
    }
    expect(service.capture(candidate({ durationMs: 99_999 }))).toBe('dropped');

    const first = service.getHealth();
    expect(first.droppedEvents).toBe(1);
    expect(first.droppedEventsPerSecond).toBeCloseTo(1 / (CAPTURE_HEALTH_RATE_WINDOW_MS / 1000));
    expect(first.bufferDepth).toBe(CAPTURE_BUFFER_CAPACITY);

    const second = service.getHealth();
    expect(second.droppedEvents).toBe(1);
    expect(second.droppedEventsPerSecond).toBe(first.droppedEventsPerSecond);
    resolveInsert?.({ insertedCount: 0 });
  });

  it('FEAT-004 / VT-05 ingest throughput window rolls forward without resetting counters', () => {
    let nowMs = 1_700_000_000_000;
    const { service } = createService({ now: () => nowMs });
    service.capture(candidate());

    const duringWindow = service.getHealth();
    expect(duringWindow.acceptedEvents).toBe(1);
    expect(duringWindow.ingestedEventsPerSecond).toBeCloseTo(1 / (CAPTURE_HEALTH_RATE_WINDOW_MS / 1000));

    nowMs += CAPTURE_HEALTH_RATE_WINDOW_MS + 1;
    const afterWindow = service.getHealth();
    expect(afterWindow.acceptedEvents).toBe(1);
    expect(afterWindow.ingestedEventsPerSecond).toBe(0);
  });

  it('VT-12 / NFR keeps capture() P95 under 5 ms', () => {
    const { service } = createService();
    const samples: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const start = process.hrtime.bigint();
      service.capture(candidate({ durationMs: i }));
      samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    expect(p95).toBeLessThan(5);
  });

  it('drains queued events on stop after the interval is cleared', async () => {
    const { service, insertBatch } = createService({ shutdownDrainMs: 1_000 });
    service.start();
    expect(service.capture(candidate())).toBe('queued');
    expect(service.getHealth().bufferDepth).toBe(1);

    await service.stop();

    expect(insertBatch).toHaveBeenCalledTimes(1);
    expect(service.getHealth().bufferDepth).toBe(0);
    expect(service.getHealth().persistedEvents).toBe(1);
    expect(service.capture(candidate())).toBe('disabled');
  });
});
