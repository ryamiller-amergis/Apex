/**
 * Provider and lane capacity with borrowable shared floors.
 * Caps: Cursor 20, Bedrock 2 (Task 5 locked defaults).
 */
import type {
  AiOrchestratorLane,
  AiOrchestratorProvider,
  DispatchDecision,
  ProviderCapacityConfig,
  ProviderUtilization,
} from './types';
import { DEFAULT_PROVIDER_CAPACITY } from './types';

export function laneForQueueName(queueName: string): AiOrchestratorLane | null {
  if (queueName.includes('document')) return 'document';
  if (queueName.includes('visual')) return 'visual';
  if (queueName.includes('fast')) return 'fast';
  if (queueName.includes('agentic')) return 'agentic';
  return null;
}

export function providerForLane(lane: AiOrchestratorLane): AiOrchestratorProvider {
  return lane === 'visual' ? 'bedrock' : 'cursor';
}

export function evaluateDispatchCapacity(input: {
  lane: AiOrchestratorLane;
  utilization: ProviderUtilization;
  config?: ProviderCapacityConfig;
  uncertainWorkerCount: number;
  uncertainPauseThreshold: number;
}): DispatchDecision {
  const config = input.config ?? DEFAULT_PROVIDER_CAPACITY;
  if (input.uncertainWorkerCount >= input.uncertainPauseThreshold) {
    return { status: 'deny', reason: 'uncertain_workers_paused' };
  }

  const provider = providerForLane(input.lane);
  const providerInFlight =
    provider === 'cursor'
      ? input.utilization.cursorInFlight
      : input.utilization.bedrockInFlight;
  const providerCap =
    provider === 'cursor' ? config.cursorCap : config.bedrockCap;
  if (providerInFlight >= providerCap) {
    return { status: 'deny', reason: 'provider_cap' };
  }

  const laneFloor = config.laneFloors[input.lane];
  const laneInFlight = input.utilization.laneInFlight[input.lane] ?? 0;
  if (laneInFlight < laneFloor) {
    return { status: 'allow', provider, lane: input.lane };
  }

  // Borrow from unused shared capacity across lanes for the same provider.
  const sharedRemaining = remainingSharedCapacity(
    provider,
    input.utilization,
    config,
  );
  if (sharedRemaining <= 0) {
    return { status: 'deny', reason: 'lane_cap' };
  }
  return { status: 'allow', provider, lane: input.lane };
}

function remainingSharedCapacity(
  provider: AiOrchestratorProvider,
  utilization: ProviderUtilization,
  config: ProviderCapacityConfig,
): number {
  const providerCap = provider === 'cursor' ? config.cursorCap : config.bedrockCap;
  const providerInFlight =
    provider === 'cursor'
      ? utilization.cursorInFlight
      : utilization.bedrockInFlight;
  return Math.max(0, providerCap - providerInFlight);
}

export function emptyUtilization(): ProviderUtilization {
  return {
    cursorInFlight: 0,
    bedrockInFlight: 0,
    laneInFlight: {
      document: 0,
      visual: 0,
      fast: 0,
      agentic: 0,
    },
  };
}
