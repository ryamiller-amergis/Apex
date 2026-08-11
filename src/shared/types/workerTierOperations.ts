/** Allowlisted interactive actor latency stages (never free-form). */
export const INTERACTIVE_STAGE_NAMES = [
  'actor_receipt',
  'bootstrap',
  'checkout_hit',
  'checkout_open',
  'agent_cache_hit',
  'agent_create',
  'agent_resume',
  'send',
  'first_sdk_event',
  'first_token',
  'completion',
] as const;

export type InteractiveStageName = (typeof INTERACTIVE_STAGE_NAMES)[number];

export function isInteractiveStageName(value: unknown): value is InteractiveStageName {
  return (
    typeof value === 'string'
    && (INTERACTIVE_STAGE_NAMES as readonly string[]).includes(value)
  );
}

export const WORKER_TIER_TELEMETRY_EVENT_NAMES = {
  inflight: 'worker.inflight',
  queueDepth: 'worker.queue.depth',
  queueOldestAgeMs: 'worker.queue.oldestAgeMs',
  projectInflight: 'worker.project.inflight',
  admissionWait: 'worker.admission.wait',
  coldStart: 'worker.coldstart',
  cancellation: 'worker.cancellation',
  reaperAction: 'worker.reaper.action',
  terminalReason: 'worker.terminal.reason',
  // FEAT-007 / TBI-012 — interactive lane telemetry (WebSocket + Dapr actors).
  interactiveFirstToken: 'interactive.firsttoken',
  interactiveTurn: 'interactive.turn',
  interactiveInflight: 'interactive.inflight',
  interactiveShed: 'interactive.shed',
  interactiveActorHealth: 'interactive.actor.health',
  interactiveReplay: 'interactive.replay',
  interactiveStage: 'interactive.stage',
} as const;

export type WorkerTierTelemetryEventName =
  (typeof WORKER_TIER_TELEMETRY_EVENT_NAMES)[keyof typeof WORKER_TIER_TELEMETRY_EVENT_NAMES];

export type WorkerTierSafePropertyKey =
  | 'runId'
  | 'dispatchMessageId'
  | 'project'
  | 'lane'
  | 'terminalReason'
  | 'stage';

export interface WorkerTierTelemetryEventProperties {
  runId?: string;
  dispatchMessageId?: string;
  project?: string;
  lane?: string;
  terminalReason?: string;
  /** Allowlisted InteractiveStageName only — sanitized at emit time. */
  stage?: InteractiveStageName;
}

/**
 * Call-site input may contain additional operational context. The telemetry
 * service retains only WorkerTierTelemetryEventProperties.
 */
export interface WorkerTierTelemetryContext
  extends WorkerTierTelemetryEventProperties {
  [key: string]: unknown;
}

export type WorkerTierTerminalReasonEventProperties =
  WorkerTierTelemetryEventProperties & {
    terminalReason: string;
  };

export interface WorkerInflightMeasurements extends Record<string, number> {
  inFlight: number;
  cap: number;
  utilization: number;
}

export interface WorkerQueueDepthMeasurements extends Record<string, number> {
  depth: number;
}

export interface WorkerQueueOldestAgeMeasurements
  extends Record<string, number> {
  ageMs: number;
}

export interface WorkerProjectInflightMeasurements
  extends Record<string, number> {
  inFlight: number;
}

export interface WorkerDurationMeasurements extends Record<string, number> {
  durationMs: number;
}

export interface WorkerCancellationMeasurements
  extends Record<string, number> {
  cancellationCount: number;
}

export interface WorkerReaperActionMeasurements
  extends Record<string, number> {
  actionCount: number;
}

export interface WorkerTerminalReasonMeasurements
  extends Record<string, number> {
  terminalCount: number;
}

export interface InteractiveInflightMeasurements
  extends Record<string, number> {
  inFlight: number;
  reserved: number;
  burstMax: number;
  saturation: number;
}

export interface InteractiveShedMeasurements extends Record<string, number> {
  shedCount: number;
}

export interface InteractiveActorHealthMeasurements
  extends Record<string, number> {
  healthy: number;
}

export interface InteractiveReplayMeasurements extends Record<string, number> {
  replayedEvents: number;
}
