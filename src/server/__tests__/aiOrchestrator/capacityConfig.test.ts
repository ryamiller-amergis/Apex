import { resolveProviderCapacityFromEnvironment } from '../../services/aiOrchestrator/capacityConfig';
import { DEFAULT_PROVIDER_CAPACITY } from '../../services/aiOrchestrator/types';

describe('resolveProviderCapacityFromEnvironment', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AI_ORCHESTRATOR_INTERACTIVE_CAP;
    delete process.env.AI_ORCHESTRATOR_LANE_FLOOR_FAST;
    delete process.env.AI_ORCHESTRATOR_LANE_FLOOR_AGENTIC;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns locked defaults when env is unset', () => {
    expect(resolveProviderCapacityFromEnvironment()).toEqual(
      DEFAULT_PROVIDER_CAPACITY,
    );
  });

  it('reads DEV-style caps from orchestrator env', () => {
    process.env.AI_ORCHESTRATOR_INTERACTIVE_CAP = '4';
    process.env.AI_ORCHESTRATOR_LANE_FLOOR_FAST = '1';
    process.env.AI_ORCHESTRATOR_LANE_FLOOR_AGENTIC = '1';
    const config = resolveProviderCapacityFromEnvironment();
    expect(config.interactiveCap).toBe(4);
    expect(config.laneFloors.fast).toBe(1);
    expect(config.laneFloors.agentic).toBe(1);
    expect(config.laneFloors.document).toBe(
      DEFAULT_PROVIDER_CAPACITY.laneFloors.document,
    );
  });
});
