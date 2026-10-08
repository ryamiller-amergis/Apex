/**
 * Environment-backed orchestrator capacity (Terraform sets env on the orchestrator CA).
 */
import {
  DEFAULT_INTERACTIVE_USER_LIMITS,
  DEFAULT_PROVIDER_CAPACITY,
  type ProviderCapacityConfig,
} from './types';
import type { AiOrchestratorLane } from './types';

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readLaneFloor(
  lane: Extract<AiOrchestratorLane, 'fast' | 'agentic'>,
  fallback: number,
): number {
  const envKey =
    lane === 'fast'
      ? 'AI_ORCHESTRATOR_LANE_FLOOR_FAST'
      : 'AI_ORCHESTRATOR_LANE_FLOOR_AGENTIC';
  return readPositiveInt(envKey, fallback);
}

export function resolveProviderCapacityFromEnvironment(): ProviderCapacityConfig {
  const defaults = DEFAULT_PROVIDER_CAPACITY;
  return {
    ...defaults,
    interactiveCap: readPositiveInt(
      'AI_ORCHESTRATOR_INTERACTIVE_CAP',
      defaults.interactiveCap,
    ),
    laneFloors: {
      ...defaults.laneFloors,
      fast: readLaneFloor('fast', defaults.laneFloors.fast),
      agentic: readLaneFloor('agentic', defaults.laneFloors.agentic),
    },
    userLimits: {
      total: readPositiveInt(
        'AI_ORCHESTRATOR_USER_INTERACTIVE_LIMIT',
        DEFAULT_INTERACTIVE_USER_LIMITS.total,
      ),
      agentic: readPositiveInt(
        'AI_ORCHESTRATOR_USER_AGENTIC_LIMIT',
        DEFAULT_INTERACTIVE_USER_LIMITS.agentic,
      ),
    },
  };
}
