/**
 * V2 AI orchestrator domain types (Task 5).
 * Live App Service traffic stays on V1; this process is separate.
 */

export const AI_ORCHESTRATOR_PROVIDERS = ['cursor', 'bedrock'] as const;
export type AiOrchestratorProvider =
  (typeof AI_ORCHESTRATOR_PROVIDERS)[number];

export const AI_ORCHESTRATOR_LANES = [
  'document',
  'visual',
  'fast',
  'agentic',
] as const;
export type AiOrchestratorLane = (typeof AI_ORCHESTRATOR_LANES)[number];

export type ProviderCapacityConfig = Readonly<{
  cursorCap: number;
  bedrockCap: number;
  /** Per-lane reserved floors that may borrow from unused shared capacity. */
  laneFloors: Readonly<Record<AiOrchestratorLane, number>>;
}>;

export const DEFAULT_PROVIDER_CAPACITY: ProviderCapacityConfig = {
  cursorCap: 20,
  bedrockCap: 2,
  laneFloors: {
    document: 4,
    visual: 2,
    fast: 4,
    agentic: 2,
  },
};

export type ProviderUtilization = Readonly<{
  cursorInFlight: number;
  bedrockInFlight: number;
  laneInFlight: Readonly<Record<AiOrchestratorLane, number>>;
}>;

export type DispatchDecision =
  | { status: 'allow'; provider: AiOrchestratorProvider; lane: AiOrchestratorLane }
  | { status: 'deny'; reason: 'provider_cap' | 'lane_cap' | 'uncertain_workers_paused' };

export type PeekLockedMessage = Readonly<{
  lockToken: string;
  messageId: string;
  body: Record<string, unknown>;
  deliveryCount: number;
}>;

export type CheckpointMessageBody = Readonly<{
  schemaVersion: number;
  eventId: string;
  runId: string;
  attemptId: string;
  attemptNumber: number;
  dispatchMessageId: string;
  timestamp: string;
  kind: 'started' | 'heartbeat' | 'progress';
  checkpointSequence: number;
  progressPercent?: number;
  containerAppExecutionId?: string;
}>;

export type TerminalResultMessageBody = Readonly<{
  schemaVersion: number;
  eventId: string;
  runId: string;
  attemptId: string;
  attemptNumber: number;
  dispatchMessageId: string;
  timestamp: string;
  kind: 'terminal';
  executionStatus: 'completed' | 'failed' | 'cancelled';
  failureCategory?: string;
  failureDetail?: string;
  artifactStatus?: string;
  manifestRef?: { container: string; key: string };
}>;

export type CommandPublishRequest = Readonly<{
  queueName: string;
  messageId: string;
  body: Record<string, unknown>;
}>;

export type ExecutionProbeResult =
  | { status: 'running' }
  | { status: 'succeeded' }
  | { status: 'failed' }
  | { status: 'not_found' }
  | { status: 'unknown'; detail?: string };

export const UNCERTAIN_WORKER_PAUSE_THRESHOLD = 2;
export const OUTBOX_SAFETY_SWEEP_MS = 30_000;
export const DEFAULT_OUTBOX_CLAIM_MS = 30_000;
export const DEFAULT_OUTBOX_BATCH_SIZE = 10;
