/**
 * V2 AI orchestrator domain types (Task 5).
 * Live App Service traffic stays on V1; this process is separate.
 */

import {
  AI_RUN_V2_WORKLOAD_LANES,
  type AiRunV2CapacityClass,
  type AiRunV2WorkloadLane,
} from '../../../shared/types/aiRunV2';

export const AI_ORCHESTRATOR_PROVIDERS = ['cursor', 'bedrock'] as const;
export type AiOrchestratorProvider =
  (typeof AI_ORCHESTRATOR_PROVIDERS)[number];

/** Lanes are a wire contract shared with the workers, not orchestrator-local. */
export type AiOrchestratorLane = AiRunV2WorkloadLane;

export type ProviderCapacityConfig = Readonly<{
  cursorCap: number;
  bedrockCap: number;
  /** Bedrock slots batch work cannot consume. Interactive work may use any free slot. */
  interactiveReservedBedrockSlots: number;
  /** Per-lane reserved floors that may borrow from unused shared capacity. */
  laneFloors: Readonly<Record<AiOrchestratorLane, number>>;
}>;

export const DEFAULT_PROVIDER_CAPACITY: ProviderCapacityConfig = {
  cursorCap: 20,
  bedrockCap: 2,
  interactiveReservedBedrockSlots: 1,
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
  providerClassInFlight: Readonly<
    Record<
      AiOrchestratorProvider,
      Readonly<Record<AiRunV2CapacityClass, number>>
    >
  >;
}>;

export type DispatchDecision =
  | { status: 'allow'; provider: AiOrchestratorProvider; lane: AiOrchestratorLane }
  | {
      status: 'deny';
      reason:
        | 'provider_cap'
        | 'lane_cap'
        | 'interactive_reserved'
        | 'unknown_capacity_class'
        | 'uncertain_workers_paused'
        | 'unknown_lane';
    };

export type PeekLockedMessage = Readonly<{
  lockToken: string;
  messageId: string;
  body: Record<string, unknown>;
  deliveryCount: number;
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
