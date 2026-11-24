import { trackEvent } from '../services/telemetry';
import type { HarnessTimingMetric, HarnessTimingRecord } from './types';

export const CHAT_HARNESS_TIMING_EVENT = 'chat_harness_client_timing';

export const HARNESS_TIMING_METRICS: readonly HarnessTimingMetric[] = [
  'send_to_first_feedback',
  'send_to_first_token',
  'longest_silent_gap',
  'stop_ui_halt',
  'stop_confirmed',
  'steer_acknowledged',
  'reconnect_restored',
  'reload_restored',
];

const VALID_METRICS: ReadonlySet<string> = new Set<string>(HARNESS_TIMING_METRICS);

export interface RecordHarnessTimingInput {
  area: string;
  threadId: string;
  metric: HarnessTimingMetric;
  durationMs: number;
  status?: string;
  runId?: string;
  commandId?: string;
  recordedAt?: number;
}

export interface RecordHarnessTimingOptions {
  emit?: typeof trackEvent;
  now?: () => number;
}

export interface ChatHarnessTelemetryConfig {
  area: string;
  threadId: string;
  now?: () => number;
  emit?: typeof trackEvent;
}

export interface ChatHarnessTelemetry {
  markSendStarted(commandId: string): void;
  markFirstFeedback(commandId?: string): void;
  markFirstToken(runId?: string): void;
  markTurnActivity(): void;
  markTurnFinished(status: 'ok' | 'error' | 'cancelled', runId?: string): void;
  markStopRequested(commandId: string): void;
  markStopUiHalted(commandId?: string): void;
  markStopConfirmed(commandId?: string, status?: string): void;
  markSteerStarted(commandId: string): void;
  markSteerAcknowledged(commandId: string, status: string): void;
  markDisconnected(): void;
  markReconnected(): void;
  markReloadStarted(): void;
  markReloadRestored(): void;
}

function defaultMonotonicNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function sanitizeDurationMs(raw: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return 0;
  }
  return Math.max(0, Math.round(raw));
}

function sanitizeRequiredString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function sanitizeOptionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sanitizeStatus(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'ok';
}

function isHarnessTimingMetric(value: unknown): value is HarnessTimingMetric {
  return typeof value === 'string' && VALID_METRICS.has(value);
}

function pushToPlaywrightBuffer(record: HarnessTimingRecord): void {
  const buffer = (globalThis as { __APEX_CHAT_TIMINGS__?: unknown }).__APEX_CHAT_TIMINGS__;
  if (Array.isArray(buffer)) {
    buffer.push(record);
  }
}

/**
 * Records a single sanitized client chat-harness timing metric (BR-007).
 * Only allowlisted string properties (area, threadId, runId, commandId, metric,
 * durationMs, status) are forwarded to Application Insights, and only a sanitized
 * HarnessTimingRecord is pushed to window.__APEX_CHAT_TIMINGS__ when an array
 * buffer has been pre-initialized (e.g. by Playwright addInitScript).
 */
export function recordHarnessTiming(
  input: RecordHarnessTimingInput,
  options?: RecordHarnessTimingOptions,
): HarnessTimingRecord | null {
  if (!isHarnessTimingMetric(input.metric)) {
    return null;
  }

  const area = sanitizeRequiredString(input.area);
  const threadId = sanitizeRequiredString(input.threadId);
  const runId = sanitizeOptionalId(input.runId);
  const commandId = sanitizeOptionalId(input.commandId);
  const durationMs = sanitizeDurationMs(input.durationMs);
  const status = sanitizeStatus(input.status);
  const recordedAt =
    typeof input.recordedAt === 'number' && Number.isFinite(input.recordedAt)
      ? Math.round(input.recordedAt)
      : Math.round(options?.now ? options.now() : Date.now());

  const properties: Record<string, string> = {
    area,
    threadId,
    metric: input.metric,
    durationMs: String(durationMs),
    status,
  };
  if (runId !== undefined) {
    properties.runId = runId;
  }
  if (commandId !== undefined) {
    properties.commandId = commandId;
  }

  const record: HarnessTimingRecord = {
    area,
    threadId,
    metric: input.metric,
    durationMs,
    status,
    recordedAt,
  };
  if (runId !== undefined) {
    record.runId = runId;
  }
  if (commandId !== undefined) {
    record.commandId = commandId;
  }

  const emit = options?.emit ?? trackEvent;
  emit(CHAT_HARNESS_TIMING_EVENT, properties);
  pushToPlaywrightBuffer(record);

  return record;
}

export function createChatHarnessTelemetry(
  config: ChatHarnessTelemetryConfig,
): ChatHarnessTelemetry {
  const area = sanitizeRequiredString(config.area);
  const threadId = sanitizeRequiredString(config.threadId);
  const now = config.now ?? defaultMonotonicNow;
  const recordedAtNow = config.now ?? (() => Date.now());
  const emit = config.emit;

  let turnActive = false;
  let sendStartedAt: number | null = null;
  let sendCommandId: string | null = null;
  let activeRunId: string | null = null;
  let firstFeedbackEmitted = false;
  let firstTokenEmitted = false;
  let lastActivityAt: number | null = null;
  let longestSilentGapMs = 0;

  let stopStartedAt: number | null = null;
  let stopCommandId: string | null = null;
  let stopUiHaltedEmitted = false;
  let stopConfirmedEmitted = false;

  const steerStartedByCommandId = new Map<string, number>();

  let disconnectedAt: number | null = null;
  let reloadStartedAt: number | null = null;

  function emitMetric(
    metric: HarnessTimingMetric,
    durationMs: number,
    status: string,
    ids?: { runId?: string; commandId?: string },
  ): void {
    recordHarnessTiming(
      {
        area,
        threadId,
        metric,
        durationMs,
        status,
        runId: ids?.runId,
        commandId: ids?.commandId,
        recordedAt: recordedAtNow(),
      },
      { emit },
    );
  }

  function advanceSilentGap(ts: number): void {
    if (lastActivityAt !== null) {
      const gap = Math.max(0, ts - lastActivityAt);
      if (gap > longestSilentGapMs) {
        longestSilentGapMs = gap;
      }
    }
    lastActivityAt = ts;
  }

  return {
    markSendStarted(commandId: string): void {
      const ts = now();
      turnActive = true;
      sendStartedAt = ts;
      sendCommandId = commandId;
      activeRunId = null;
      firstFeedbackEmitted = false;
      firstTokenEmitted = false;
      lastActivityAt = ts;
      longestSilentGapMs = 0;
    },

    markFirstFeedback(commandId?: string): void {
      if (sendStartedAt === null || firstFeedbackEmitted) {
        return;
      }
      const ts = now();
      firstFeedbackEmitted = true;
      advanceSilentGap(ts);
      emitMetric('send_to_first_feedback', ts - sendStartedAt, 'ok', {
        commandId: commandId ?? sendCommandId ?? undefined,
      });
    },

    markFirstToken(runId?: string): void {
      if (sendStartedAt === null || firstTokenEmitted) {
        return;
      }
      const ts = now();
      firstTokenEmitted = true;
      if (runId) {
        activeRunId = runId;
      }
      advanceSilentGap(ts);
      emitMetric('send_to_first_token', ts - sendStartedAt, 'ok', {
        runId: runId ?? activeRunId ?? undefined,
        commandId: sendCommandId ?? undefined,
      });
    },

    markTurnActivity(): void {
      const ts = now();
      if (!turnActive) {
        turnActive = true;
        lastActivityAt = ts;
        longestSilentGapMs = 0;
        return;
      }
      advanceSilentGap(ts);
    },

    markTurnFinished(status: 'ok' | 'error' | 'cancelled', runId?: string): void {
      if (!turnActive) {
        return;
      }
      const ts = now();
      advanceSilentGap(ts);
      const effectiveRunId = runId ?? activeRunId ?? undefined;
      const effectiveCommandId = sendCommandId ?? undefined;
      const maxGap = longestSilentGapMs;

      turnActive = false;
      sendStartedAt = null;
      sendCommandId = null;
      activeRunId = null;
      firstFeedbackEmitted = false;
      firstTokenEmitted = false;
      lastActivityAt = null;
      longestSilentGapMs = 0;

      emitMetric('longest_silent_gap', maxGap, status, {
        runId: effectiveRunId,
        commandId: effectiveCommandId,
      });
    },

    markStopRequested(commandId: string): void {
      stopStartedAt = now();
      stopCommandId = commandId;
      stopUiHaltedEmitted = false;
      stopConfirmedEmitted = false;
    },

    markStopUiHalted(commandId?: string): void {
      if (stopStartedAt === null || stopUiHaltedEmitted) {
        return;
      }
      stopUiHaltedEmitted = true;
      emitMetric('stop_ui_halt', now() - stopStartedAt, 'ok', {
        runId: activeRunId ?? undefined,
        commandId: commandId ?? stopCommandId ?? undefined,
      });
    },

    markStopConfirmed(commandId?: string, status = 'ok'): void {
      if (stopStartedAt === null || stopConfirmedEmitted) {
        return;
      }
      stopConfirmedEmitted = true;
      emitMetric('stop_confirmed', now() - stopStartedAt, status, {
        runId: activeRunId ?? undefined,
        commandId: commandId ?? stopCommandId ?? undefined,
      });
    },

    markSteerStarted(commandId: string): void {
      steerStartedByCommandId.set(commandId, now());
    },

    markSteerAcknowledged(commandId: string, status: string): void {
      const startedAt = steerStartedByCommandId.get(commandId);
      if (startedAt === undefined) {
        return;
      }
      steerStartedByCommandId.delete(commandId);
      emitMetric('steer_acknowledged', now() - startedAt, status, {
        runId: activeRunId ?? undefined,
        commandId,
      });
    },

    markDisconnected(): void {
      if (disconnectedAt === null) {
        disconnectedAt = now();
      }
    },

    markReconnected(): void {
      if (disconnectedAt === null) {
        return;
      }
      const durationMs = now() - disconnectedAt;
      disconnectedAt = null;
      emitMetric('reconnect_restored', durationMs, 'ok', {
        runId: activeRunId ?? undefined,
      });
    },

    markReloadStarted(): void {
      reloadStartedAt = now();
    },

    markReloadRestored(): void {
      if (reloadStartedAt === null) {
        return;
      }
      const durationMs = now() - reloadStartedAt;
      reloadStartedAt = null;
      emitMetric('reload_restored', durationMs, 'ok', {
        runId: activeRunId ?? undefined,
      });
    },
  };
}
