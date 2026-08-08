import { createWorkerTierTelemetry } from '../services/workerTierTelemetry';
import { WORKER_TIER_TELEMETRY_EVENT_NAMES } from '../../shared/types/workerTierOperations';

describe('interactive lane telemetry (TBI-012)', () => {
  it('emits first-token and turn latency measurements', () => {
    const emit = jest.fn();
    const telemetry = createWorkerTierTelemetry(emit);

    telemetry.interactiveFirstToken({ lane: 'ai-runs-interactive' }, 850);
    telemetry.interactiveTurn({ lane: 'ai-runs-interactive' }, 4_200);

    expect(emit).toHaveBeenNthCalledWith(
      1,
      WORKER_TIER_TELEMETRY_EVENT_NAMES.interactiveFirstToken,
      { lane: 'ai-runs-interactive' },
      { durationMs: 850 },
    );
    expect(emit).toHaveBeenNthCalledWith(
      2,
      WORKER_TIER_TELEMETRY_EVENT_NAMES.interactiveTurn,
      { lane: 'ai-runs-interactive' },
      { durationMs: 4_200 },
    );
  });

  it('reports interactive in-flight utilization against reserved+burst', () => {
    const emit = jest.fn();
    createWorkerTierTelemetry(emit).interactiveInflight(
      { lane: 'ai-runs-interactive', project: 'Apex' },
      8,
      4,
      12,
    );

    expect(emit).toHaveBeenCalledWith(
      WORKER_TIER_TELEMETRY_EVENT_NAMES.interactiveInflight,
      { lane: 'ai-runs-interactive', project: 'Apex' },
      { inFlight: 8, reserved: 4, burstMax: 12, saturation: 0.5 },
    );
  });

  it('counts sheds and reports actor health and replay counts', () => {
    const emit = jest.fn();
    const telemetry = createWorkerTierTelemetry(emit);

    telemetry.interactiveShed({ lane: 'ai-runs-interactive' });
    telemetry.interactiveActorHealth({ lane: 'ai-runs-interactive' }, false);
    telemetry.interactiveReplay({ lane: 'ai-runs-interactive', runId: 'run-1' }, 12);

    expect(emit).toHaveBeenCalledWith(
      WORKER_TIER_TELEMETRY_EVENT_NAMES.interactiveShed,
      { lane: 'ai-runs-interactive' },
      { shedCount: 1 },
    );
    expect(emit).toHaveBeenCalledWith(
      WORKER_TIER_TELEMETRY_EVENT_NAMES.interactiveActorHealth,
      { lane: 'ai-runs-interactive' },
      { healthy: 0 },
    );
    expect(emit).toHaveBeenCalledWith(
      WORKER_TIER_TELEMETRY_EVENT_NAMES.interactiveReplay,
      { lane: 'ai-runs-interactive', runId: 'run-1' },
      { replayedEvents: 12 },
    );
  });

  it('VT-10 / BR-019: interactive telemetry drops prompt/snapshot/workspace/secret properties', () => {
    const emit = jest.fn();
    createWorkerTierTelemetry(emit).interactiveInflight(
      {
        lane: 'ai-runs-interactive',
        runId: 'run-1',
        // Unsafe keys and values that must never be emitted.
        prompt: 'confidential interview prompt',
        workspacePath: 'C:/home/data/workspace',
        cursorApiKey: 'sk-live-abcdef0123456789',
      } as never,
      2,
      4,
      12,
    );

    const [, properties] = emit.mock.calls[0];
    expect(properties).toEqual({ lane: 'ai-runs-interactive', runId: 'run-1' });
    expect(JSON.stringify(emit.mock.calls)).not.toContain('confidential interview prompt');
    expect(JSON.stringify(emit.mock.calls)).not.toContain('sk-live-abcdef0123456789');
  });
});
