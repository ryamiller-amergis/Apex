import type {
  InteractiveActorHealthMeasurements,
  InteractiveInflightMeasurements,
  InteractiveReplayMeasurements,
  InteractiveShedMeasurements,
  WorkerCancellationMeasurements,
  WorkerDurationMeasurements,
  WorkerInflightMeasurements,
  WorkerProjectInflightMeasurements,
  WorkerQueueDepthMeasurements,
  WorkerQueueOldestAgeMeasurements,
  WorkerReaperActionMeasurements,
  WorkerTerminalReasonMeasurements,
  WorkerTierSafePropertyKey,
  WorkerTierTelemetryContext,
} from '../../shared/types/workerTierOperations';
import { WORKER_TIER_TELEMETRY_EVENT_NAMES } from '../../shared/types/workerTierOperations';
import { trackEvent } from './telemetry';

type EventEmitter = typeof trackEvent;

export const SAFE_PROPERTY_KEYS: ReadonlySet<WorkerTierSafePropertyKey> =
  new Set([
    'runId',
    'dispatchMessageId',
    'project',
    'lane',
    'terminalReason',
  ]);

const MAX_PROPERTY_LENGTH = 256;

function isLocalPath(value: string): boolean {
  return (
    /(?:^|[\s"'=])(?:[a-z]:[\\/]|\\\\)/i.test(value) ||
    /(?:^|[\s"'=])\/(?:home|users?|tmp|var|opt|mnt|root|private)\//i.test(
      value,
    ) ||
    /^file:\/\//i.test(value)
  );
}

function containsSensitiveValue(value: string): boolean {
  return (
    /\bBearer\s+\S+/i.test(value) ||
    /\bCURSOR_API_KEY\b/i.test(value) ||
    /(?:password|passwd|token|secret|credential|api[_-]?key)\s*[=:]/i.test(
      value,
    ) ||
    /(?:prompt|snapshot|workspace(?:Dir|Path|Content)?)\s*[=:]/i.test(value) ||
    /https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value) ||
    /^(?:sk|pk)[-_][A-Za-z0-9_-]{16,}$/i.test(value) ||
    /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/.test(
      value,
    )
  );
}

function sanitizeValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (
    !value.trim() ||
    value.length > MAX_PROPERTY_LENGTH ||
    isLocalPath(value) ||
    containsSensitiveValue(value)
  ) {
    return null;
  }
  return value;
}

export function sanitizeWorkerTierTelemetryProperties(
  properties: Record<string, unknown>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!SAFE_PROPERTY_KEYS.has(key as WorkerTierSafePropertyKey)) continue;
    const sanitized = sanitizeValue(value);
    if (sanitized !== null) safe[key] = sanitized;
  }
  return safe;
}

function properties(
  context: WorkerTierTelemetryContext,
  extra: Record<string, unknown> = {},
): Record<string, string> {
  return sanitizeWorkerTierTelemetryProperties({ ...context, ...extra });
}

export interface WorkerTierTelemetry {
  inflight(
    context: WorkerTierTelemetryContext,
    inFlight: number,
    cap: number,
  ): void;
  queueDepth(context: WorkerTierTelemetryContext, depth: number): void;
  queueOldestAge(context: WorkerTierTelemetryContext, ageMs: number): void;
  projectInflight(
    context: WorkerTierTelemetryContext,
    inFlight: number,
  ): void;
  admissionWait(
    context: WorkerTierTelemetryContext,
    durationMs: number,
  ): void;
  coldStart(context: WorkerTierTelemetryContext, durationMs: number): void;
  cancellation(context: WorkerTierTelemetryContext): void;
  reaperAction(context: WorkerTierTelemetryContext): void;
  terminalReason(
    context: WorkerTierTelemetryContext,
    terminalReason: string,
  ): void;
  // FEAT-007 / TBI-012 — interactive lane telemetry.
  interactiveFirstToken(
    context: WorkerTierTelemetryContext,
    durationMs: number,
  ): void;
  interactiveTurn(
    context: WorkerTierTelemetryContext,
    durationMs: number,
  ): void;
  interactiveInflight(
    context: WorkerTierTelemetryContext,
    inFlight: number,
    reserved: number,
    burstMax: number,
  ): void;
  interactiveShed(context: WorkerTierTelemetryContext): void;
  interactiveActorHealth(
    context: WorkerTierTelemetryContext,
    healthy: boolean,
  ): void;
  interactiveReplay(
    context: WorkerTierTelemetryContext,
    replayedEvents: number,
  ): void;
}

export function createWorkerTierTelemetry(
  emit: EventEmitter = trackEvent,
): WorkerTierTelemetry {
  return {
    inflight(context, inFlight, cap) {
      const measurements: WorkerInflightMeasurements = {
        inFlight,
        cap,
        utilization: cap > 0 ? inFlight / cap : 0,
      };
      emit(
        WORKER_TIER_TELEMETRY_EVENT_NAMES.inflight,
        properties(context),
        measurements,
      );
    },
    queueDepth(context, depth) {
      const measurements: WorkerQueueDepthMeasurements = { depth };
      emit(
        WORKER_TIER_TELEMETRY_EVENT_NAMES.queueDepth,
        properties(context),
        measurements,
      );
    },
    queueOldestAge(context, ageMs) {
      const measurements: WorkerQueueOldestAgeMeasurements = { ageMs };
      emit(
        WORKER_TIER_TELEMETRY_EVENT_NAMES.queueOldestAgeMs,
        properties(context),
        measurements,
      );
    },
    projectInflight(context, inFlight) {
      const measurements: WorkerProjectInflightMeasurements = { inFlight };
      emit(
        WORKER_TIER_TELEMETRY_EVENT_NAMES.projectInflight,
        properties(context),
        measurements,
      );
    },
    admissionWait(context, durationMs) {
      const measurements: WorkerDurationMeasurements = { durationMs };
      emit(
        WORKER_TIER_TELEMETRY_EVENT_NAMES.admissionWait,
        properties(context),
        measurements,
      );
    },
    coldStart(context, durationMs) {
      const measurements: WorkerDurationMeasurements = { durationMs };
      emit(
        WORKER_TIER_TELEMETRY_EVENT_NAMES.coldStart,
        properties(context),
        measurements,
      );
    },
    cancellation(context) {
      const measurements: WorkerCancellationMeasurements = {
        cancellationCount: 1,
      };
      emit(
        WORKER_TIER_TELEMETRY_EVENT_NAMES.cancellation,
        properties(context),
        measurements,
      );
    },
    reaperAction(context) {
      const measurements: WorkerReaperActionMeasurements = { actionCount: 1 };
      emit(
        WORKER_TIER_TELEMETRY_EVENT_NAMES.reaperAction,
        properties(context),
        measurements,
      );
    },
    terminalReason(context, terminalReason) {
      const measurements: WorkerTerminalReasonMeasurements = {
        terminalCount: 1,
      };
      emit(
        WORKER_TIER_TELEMETRY_EVENT_NAMES.terminalReason,
        properties(context, { terminalReason }),
        measurements,
      );
    },
    interactiveFirstToken(context, durationMs) {
      const measurements: WorkerDurationMeasurements = { durationMs };
      emit(
        WORKER_TIER_TELEMETRY_EVENT_NAMES.interactiveFirstToken,
        properties(context),
        measurements,
      );
    },
    interactiveTurn(context, durationMs) {
      const measurements: WorkerDurationMeasurements = { durationMs };
      emit(
        WORKER_TIER_TELEMETRY_EVENT_NAMES.interactiveTurn,
        properties(context),
        measurements,
      );
    },
    interactiveInflight(context, inFlight, reserved, burstMax) {
      const capacity = reserved + burstMax;
      const measurements: InteractiveInflightMeasurements = {
        inFlight,
        reserved,
        burstMax,
        saturation: capacity > 0 ? inFlight / capacity : 0,
      };
      emit(
        WORKER_TIER_TELEMETRY_EVENT_NAMES.interactiveInflight,
        properties(context),
        measurements,
      );
    },
    interactiveShed(context) {
      const measurements: InteractiveShedMeasurements = { shedCount: 1 };
      emit(
        WORKER_TIER_TELEMETRY_EVENT_NAMES.interactiveShed,
        properties(context),
        measurements,
      );
    },
    interactiveActorHealth(context, healthy) {
      const measurements: InteractiveActorHealthMeasurements = {
        healthy: healthy ? 1 : 0,
      };
      emit(
        WORKER_TIER_TELEMETRY_EVENT_NAMES.interactiveActorHealth,
        properties(context),
        measurements,
      );
    },
    interactiveReplay(context, replayedEvents) {
      const measurements: InteractiveReplayMeasurements = { replayedEvents };
      emit(
        WORKER_TIER_TELEMETRY_EVENT_NAMES.interactiveReplay,
        properties(context),
        measurements,
      );
    },
  };
}

export const workerTierTelemetry = createWorkerTierTelemetry();
