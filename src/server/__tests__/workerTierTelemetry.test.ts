import type { AgentRunPhase } from '../../shared/types/chat';
import {
  WORKER_TIER_TELEMETRY_EVENT_NAMES,
} from '../../shared/types/workerTierOperations';
import {
  SAFE_PROPERTY_KEYS,
  createWorkerTierTelemetry,
  sanitizeWorkerTierTelemetryProperties,
} from '../services/workerTierTelemetry';

describe('TBI-008 DoD-1 / VT-01 shared worker phases', () => {
  it('accepts queued and dispatched in the shared AgentRunPhase contract', () => {
    const phases: AgentRunPhase[] = ['queued', 'dispatched'];

    expect(phases).toEqual(['queued', 'dispatched']);
  });
});

describe('TBI-008 DoD-2 / VT-09 worker-tier telemetry vocabulary', () => {
  it('emits every required event with expected numeric measurements', () => {
    const emit = jest.fn();
    const telemetry = createWorkerTierTelemetry(emit);
    const context = {
      runId: 'run-1',
      dispatchMessageId: 'dispatch-1',
      project: 'Apex',
      lane: 'default',
    };

    telemetry.inflight(context, 8, 10);
    telemetry.queueDepth(context, 4);
    telemetry.queueOldestAge(context, 1_500);
    telemetry.projectInflight(context, 2);
    telemetry.admissionWait(context, 450);
    telemetry.coldStart(context, 1_200);
    telemetry.cancellation(context);
    telemetry.reaperAction(context);
    telemetry.terminalReason(context, 'completed');

    expect(emit.mock.calls).toEqual([
      [
        WORKER_TIER_TELEMETRY_EVENT_NAMES.inflight,
        context,
        { inFlight: 8, cap: 10, utilization: 0.8 },
      ],
      [
        WORKER_TIER_TELEMETRY_EVENT_NAMES.queueDepth,
        context,
        { depth: 4 },
      ],
      [
        WORKER_TIER_TELEMETRY_EVENT_NAMES.queueOldestAgeMs,
        context,
        { ageMs: 1_500 },
      ],
      [
        WORKER_TIER_TELEMETRY_EVENT_NAMES.projectInflight,
        context,
        { inFlight: 2 },
      ],
      [
        WORKER_TIER_TELEMETRY_EVENT_NAMES.admissionWait,
        context,
        { durationMs: 450 },
      ],
      [
        WORKER_TIER_TELEMETRY_EVENT_NAMES.coldStart,
        context,
        { durationMs: 1_200 },
      ],
      [
        WORKER_TIER_TELEMETRY_EVENT_NAMES.cancellation,
        context,
        { cancellationCount: 1 },
      ],
      [
        WORKER_TIER_TELEMETRY_EVENT_NAMES.reaperAction,
        context,
        { actionCount: 1 },
      ],
      [
        WORKER_TIER_TELEMETRY_EVENT_NAMES.terminalReason,
        { ...context, terminalReason: 'completed' },
        { terminalCount: 1 },
      ],
    ]);
  });
});

describe('TBI-008 DoD-3 / security NFR / VT-09 sanitizer', () => {
  it('allowlists exactly the five approved structured property keys', () => {
    expect([...SAFE_PROPERTY_KEYS]).toEqual([
      'runId',
      'dispatchMessageId',
      'project',
      'lane',
      'terminalReason',
    ]);
  });

  it('retains safe identifiers and terminalReason while dropping unsafe properties', () => {
    const sanitized = sanitizeWorkerTierTelemetryProperties({
      runId: 'run-1',
      dispatchMessageId: 'dispatch-1',
      project: 'Apex',
      lane: 'default',
      terminalReason: 'cancelled',
      prompt: 'private prompt content',
      executionSnapshot: '{"prompt":"private"}',
      snapshot: 'private snapshot content',
      workspace: 'private workspace content',
      workspaceDir: 'C:\\Users\\owner\\private-workspace',
      CURSOR_API_KEY: 'cursor-secret',
      authorization: 'Bearer top-secret-token',
      unknown: 'must-not-emit',
    });

    expect(sanitized).toEqual({
      runId: 'run-1',
      dispatchMessageId: 'dispatch-1',
      project: 'Apex',
      lane: 'default',
      terminalReason: 'cancelled',
    });
  });

  it('drops local paths, Bearer credentials, and API-key-like values in safe fields', () => {
    expect(
      sanitizeWorkerTierTelemetryProperties({
        runId: 'C:\\Users\\owner\\run',
        dispatchMessageId: '\\\\server\\share\\dispatch',
        project: '/home/owner/project',
        lane: 'Bearer top-secret-token',
        terminalReason: 'CURSOR_API_KEY=cursor-secret',
      }),
    ).toEqual({});
  });

  it('sanitizes properties through the injected emitter factory boundary', () => {
    const emit = jest.fn();
    const telemetry = createWorkerTierTelemetry(emit);

    telemetry.cancellation({
      runId: 'run-safe',
      project: 'Apex',
      lane: 'default',
      prompt: 'do not emit',
      workspacePath: '/tmp/private-workspace',
      credential: 'Bearer top-secret-token',
    });

    expect(emit).toHaveBeenCalledWith(
      WORKER_TIER_TELEMETRY_EVENT_NAMES.cancellation,
      { runId: 'run-safe', project: 'Apex', lane: 'default' },
      { cancellationCount: 1 },
    );
    expect(JSON.stringify(emit.mock.calls)).not.toMatch(
      /prompt|workspace|Bearer|top-secret/i,
    );
  });
});

describe('TBI-008 DoD-4 / VT-10 enabling contracts', () => {
  it('exposes saturation and queue-age measurements for later health wiring', () => {
    const emit = jest.fn();
    const telemetry = createWorkerTierTelemetry(emit);

    telemetry.inflight({ lane: 'default' }, 9, 10);
    telemetry.queueOldestAge({ lane: 'default' }, 30_000);

    expect(emit).toHaveBeenNthCalledWith(
      1,
      WORKER_TIER_TELEMETRY_EVENT_NAMES.inflight,
      { lane: 'default' },
      { inFlight: 9, cap: 10, utilization: 0.9 },
    );
    expect(emit).toHaveBeenNthCalledWith(
      2,
      WORKER_TIER_TELEMETRY_EVENT_NAMES.queueOldestAgeMs,
      { lane: 'default' },
      { ageMs: 30_000 },
    );
  });
});
