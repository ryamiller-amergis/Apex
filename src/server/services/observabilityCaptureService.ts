/**
 * Failure-isolated Observability capture pipeline.
 * Bounded in-memory FIFO, single-flight batch flush, one retry, drop-on-overflow.
 * Callers must never await persistence from a user-request path.
 */
import {
  CAPTURE_BUFFER_CAPACITY,
  CAPTURE_FLUSH_BATCH_SIZE,
  CAPTURE_FLUSH_INTERVAL_MS,
  CAPTURE_HEALTH_RATE_WINDOW_MS,
  CAPTURE_RETRY_DELAY_MS,
  CAPTURE_SHUTDOWN_DRAIN_MS,
  TRACE_REDACTED_MARKER,
  type CaptureDisposition,
  type CaptureHealthSnapshot,
  type SafeTraceEventInput,
  type ServerTraceCandidate,
} from '../../shared/types/observability';
import { toSafeTraceEvent } from '../../shared/utils/traceRedaction';
import { insertSafeTraceEvents } from './traceEventStorageService';
import { isObservabilityCaptureEnabled } from './observabilityCaptureFlagSnapshot';
import { trackEvent } from './telemetry';

export interface ObservabilityCaptureServiceDeps {
  isCaptureEnabled?: () => boolean;
  insertBatch?: (events: SafeTraceEventInput[]) => Promise<{ insertedCount: number }>;
  retryDelayMs?: number;
  flushIntervalMs?: number;
  shutdownDrainMs?: number;
  now?: () => number;
}

export interface ObservabilityCaptureService {
  capture(candidate: ServerTraceCandidate): CaptureDisposition;
  getHealth(): CaptureHealthSnapshot;
  start(): void;
  stop(): Promise<void>;
  flush(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function scrubFlushError(err: unknown, occurredAt: string): { occurredAt: string; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw
    .replace(/\bBearer\s+[A-Za-z0-9._\-+=/]+/gi, `Bearer ${TRACE_REDACTED_MARKER}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+/g, TRACE_REDACTED_MARKER)
    .slice(0, 512);
  return { occurredAt, message };
}

function toCandidateForRedaction(candidate: ServerTraceCandidate) {
  const details: Record<string, unknown> =
    candidate.details && typeof candidate.details === 'object' && !Array.isArray(candidate.details)
      ? { ...(candidate.details as Record<string, unknown>) }
      : {};
  if (candidate.trigger) details.trigger = candidate.trigger;
  if (candidate.ssePhase) details.ssePhase = candidate.ssePhase;
  return {
    eventType: candidate.eventType,
    occurredAt: candidate.occurredAt,
    actorUserId: candidate.actorUserId,
    projectId: candidate.projectId,
    sessionId: candidate.sessionId,
    traceId: candidate.traceId,
    routeTemplate: candidate.routeTemplate,
    httpMethod: candidate.httpMethod,
    statusCode: candidate.statusCode,
    durationMs: candidate.durationMs,
    severity: candidate.severity,
    headers: candidate.headers,
    error: candidate.error,
    details,
  };
}

export function createObservabilityCaptureService(
  deps: ObservabilityCaptureServiceDeps = {},
): ObservabilityCaptureService {
  const isCaptureEnabled = deps.isCaptureEnabled ?? isObservabilityCaptureEnabled;
  const insertBatch = deps.insertBatch ?? insertSafeTraceEvents;
  const retryDelayMs = deps.retryDelayMs ?? CAPTURE_RETRY_DELAY_MS;
  const flushIntervalMs = deps.flushIntervalMs ?? CAPTURE_FLUSH_INTERVAL_MS;
  const shutdownDrainMs = deps.shutdownDrainMs ?? CAPTURE_SHUTDOWN_DRAIN_MS;
  const now = deps.now ?? Date.now;

  const queue: SafeTraceEventInput[] = [];
  let droppedEvents = 0;
  let flushErrorCount = 0;
  let lastFlushError: CaptureHealthSnapshot['lastFlushError'] = null;
  let acceptedEvents = 0;
  let persistedEvents = 0;
  const dropTimes: number[] = [];
  const ingestTimes: number[] = [];
  let flushInFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function pruneTimes(times: number[], nowMs: number): void {
    const cutoff = nowMs - CAPTURE_HEALTH_RATE_WINDOW_MS;
    let firstKept = 0;
    while (firstKept < times.length && times[firstKept]! < cutoff) {
      firstKept += 1;
    }
    if (firstKept > 0) times.splice(0, firstKept);
  }

  function ratePerSecond(times: number[], nowMs: number): number {
    const cutoff = nowMs - CAPTURE_HEALTH_RATE_WINDOW_MS;
    let count = 0;
    for (const t of times) {
      if (t >= cutoff) count += 1;
    }
    return count / (CAPTURE_HEALTH_RATE_WINDOW_MS / 1000);
  }

  function getHealth(): CaptureHealthSnapshot {
    const nowMs = now();
    return {
      bufferDepth: queue.length,
      bufferCapacity: CAPTURE_BUFFER_CAPACITY,
      droppedEvents,
      droppedEventsPerSecond: ratePerSecond(dropTimes, nowMs),
      flushErrorCount,
      lastFlushError,
      acceptedEvents,
      persistedEvents,
      ingestedEventsPerSecond: ratePerSecond(ingestTimes, nowMs),
    };
  }

  function emitMetric(name: string, measurements?: Record<string, number>): void {
    try {
      trackEvent(name, undefined, measurements);
    } catch {
      // Telemetry must never affect capture.
    }
  }

  async function persistBatch(batch: SafeTraceEventInput[]): Promise<void> {
    if (batch.length === 0) return;
    try {
      const result = await insertBatch(batch);
      persistedEvents += result.insertedCount;
      emitMetric('observability.capture.persisted', { count: result.insertedCount });
    } catch {
      try {
        await delay(retryDelayMs);
        const result = await insertBatch(batch);
        persistedEvents += result.insertedCount;
        emitMetric('observability.capture.persisted', { count: result.insertedCount });
      } catch (secondErr) {
        flushErrorCount += 1;
        lastFlushError = scrubFlushError(secondErr, new Date(now()).toISOString());
        emitMetric('observability.capture.flush_failed', { count: 1 });
      }
    }
  }

  async function runFlush(): Promise<void> {
    if (!isCaptureEnabled() || stopped) return;
    const batch = queue.splice(0, CAPTURE_FLUSH_BATCH_SIZE);
    if (batch.length === 0) return;
    const started = now();
    await persistBatch(batch);
    emitMetric('observability.capture.flush_duration_ms', { durationMs: Math.max(0, now() - started) });
    emitMetric('observability.capture.buffer_depth', { depth: queue.length });
  }

  function requestFlush(): Promise<void> {
    if (flushInFlight) return flushInFlight;
    const pending = runFlush().catch(() => undefined).finally(() => {
      if (flushInFlight === pending) flushInFlight = null;
    });
    flushInFlight = pending;
    return pending;
  }

  function capture(candidate: ServerTraceCandidate): CaptureDisposition {
    try {
      if (!isCaptureEnabled()) return 'disabled';

      const safe = toSafeTraceEvent(toCandidateForRedaction(candidate));
      if (queue.length >= CAPTURE_BUFFER_CAPACITY) {
        droppedEvents += 1;
        const nowMs = now();
        dropTimes.push(nowMs);
        pruneTimes(dropTimes, nowMs);
        emitMetric('observability.capture.dropped', { count: 1 });
        return 'dropped';
      }

      queue.push(safe);
      acceptedEvents += 1;
      const nowMs = now();
      ingestTimes.push(nowMs);
      pruneTimes(ingestTimes, nowMs);
      emitMetric('observability.capture.accepted', { count: 1, depth: queue.length });
      if (queue.length >= CAPTURE_FLUSH_BATCH_SIZE) {
        void requestFlush();
      }
      return 'queued';
    } catch {
      return 'dropped';
    }
  }

  function start(): void {
    stopped = false;
    if (timer) return;
    timer = setInterval(() => {
      void requestFlush();
    }, flushIntervalMs);
    timer.unref?.();
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    const drain = requestFlush();
    await Promise.race([
      drain,
      delay(shutdownDrainMs),
    ]);
  }

  async function flush(): Promise<void> {
    try {
      await requestFlush();
    } catch {
      // Flush is always contained.
    }
  }

  return { capture, getHealth, start, stop, flush };
}

let singleton: ObservabilityCaptureService | null = null;

export function getObservabilityCaptureService(): ObservabilityCaptureService {
  singleton ??= createObservabilityCaptureService();
  return singleton;
}

export function resetObservabilityCaptureServiceForTests(): void {
  singleton = null;
}
