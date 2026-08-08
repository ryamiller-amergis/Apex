/**
 * FEAT-004 / TBI-005 fenced ingest — DoD-1/2, PBI-004 AC-2/3, VT-04/06/10.
 */
const mockFindFirst = jest.fn();
const mockUpdate = jest.fn();
const mockSet = jest.fn();
const mockWhere = jest.fn();
const mockReturning = jest.fn();
const mockTransition = jest.fn();
const mockMarkTerminal = jest.fn();
const mockNotifyRunEvent = jest.fn();
const mockConsumeCompletedArtifacts = jest.fn();
const mockWorkerColdStart = jest.fn();

const executionSnapshot = {
  prompt: 'Frozen prompt',
  model: 'claude-sonnet-4-5',
  workspaceRef: 'C:\\shared\\runs\\run-1',
  workflowClass: 'development',
  skillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
  projectId: 'project-1',
  threadId: 'thread-1',
};

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      agentRuns: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

jest.mock('../services/agentRunLifecycleService', () => ({
  transition: (...args: unknown[]) => mockTransition(...args),
  markTerminal: (...args: unknown[]) => mockMarkTerminal(...args),
}));

jest.mock('../services/pgNotifyService', () => ({
  RUN_EVENT_SOURCE_INSTANCE: 'test-instance',
  nextRunEventSequence: jest.fn().mockReturnValue(7),
  notifyRunEvent: (...args: unknown[]) => mockNotifyRunEvent(...args),
}));

jest.mock('../services/workerTierTelemetry', () => ({
  workerTierTelemetry: {
    inflight: jest.fn(),
    queueDepth: jest.fn(),
    queueOldestAge: jest.fn(),
    projectInflight: jest.fn(),
    admissionWait: jest.fn(),
    coldStart: (...args: unknown[]) => mockWorkerColdStart(...args),
    cancellation: jest.fn(),
    reaperAction: jest.fn(),
    terminalReason: jest.fn(),
  },
}));

import {
  AiRunIngestError,
  getBootstrap,
  ingest,
} from '../services/aiRunIngestService';
import type { AiRunIngestBody } from '../../shared/types/aiRunIngest';

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    threadId: 'thread-1',
    status: 'running',
    projectId: 'project-1',
    lane: 'background',
    queuedAt: '2026-08-05T12:00:00.000Z',
    dispatchedAt: '2026-08-05T12:00:01.000Z',
    dispatchMessageId: 'dispatch-current',
    executionSnapshot: null,
    cancelRequested: false,
    cancelState: null,
    terminalReason: null,
    timeoutAt: '2026-08-05T14:00:00.000Z',
    ownerInstance: null,
    updatedAt: '2026-08-05T12:00:02.000Z',
    heartbeatAt: '2026-08-05T12:00:02.000Z',
    progressAt: null,
    progressLabel: null,
    progressPhase: null,
    startedAt: '2026-08-05T12:00:01.000Z',
    createdAt: '2026-08-05T12:00:00.000Z',
    eventDriven: true,
    lastError: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSet.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ returning: mockReturning });
  mockUpdate.mockReturnValue({ set: mockSet });
  mockReturning.mockImplementation(async () => [baseRow()]);
  mockNotifyRunEvent.mockResolvedValue(undefined);
  mockConsumeCompletedArtifacts.mockResolvedValue(undefined);
  mockWorkerColdStart.mockReset();
  mockTransition.mockImplementation(async (_runId, status) => ({
    ok: true,
    run: baseRow({ status }),
  }));
  mockMarkTerminal.mockImplementation(async (_runId, input) => ({
    ok: true,
    run: baseRow({ status: input.status }),
  }));
});

describe('aiRunIngestService fence validation', () => {
  it.each<AiRunIngestBody>([
    { dispatchMessageId: 'dispatch-stale', kind: 'heartbeat' },
    {
      dispatchMessageId: 'dispatch-stale',
      kind: 'progress',
      phase: 'testing',
      status: 'running',
      detail: 'Running tests',
    },
    { dispatchMessageId: 'dispatch-stale', kind: 'cancel_ack' },
    {
      dispatchMessageId: 'dispatch-stale',
      kind: 'terminal',
      status: 'completed',
      artifactsFlushed: true,
    },
  ])(
    'TBI-005 DoD-1 / PBI-004 AC-3 / BR-005 / VT-06: stale $kind changes nothing',
    async (body) => {
      mockFindFirst.mockResolvedValue(baseRow());

      await expect(ingest('project-1', 'run-1', body)).rejects.toMatchObject({
        code: 'AI_RUN_DISPATCH_MISMATCH',
      });

      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockTransition).not.toHaveBeenCalled();
      expect(mockMarkTerminal).not.toHaveBeenCalled();
      expect(mockNotifyRunEvent).not.toHaveBeenCalled();
    },
  );

  it('TBI-005 DoD-1 / AC-3: validates the fence before terminal idempotency', async () => {
    mockFindFirst.mockResolvedValue(baseRow({
      status: 'completed',
      dispatchMessageId: 'dispatch-current',
    }));

    await expect(ingest('project-1', 'run-1', {
      dispatchMessageId: 'dispatch-stale',
      kind: 'terminal',
      status: 'completed',
      artifactsFlushed: true,
    })).rejects.toBeInstanceOf(AiRunIngestError);

    expect(mockMarkTerminal).not.toHaveBeenCalled();
  });
});

describe('GET bootstrap fenced snapshot seam', () => {
  it('TBI-004 DoD-1: returns the project and frozen snapshot for the current background dispatch', async () => {
    mockFindFirst.mockResolvedValue(baseRow({
      status: 'dispatched',
      executionSnapshot,
    }));

    await expect(getBootstrap('run-1', 'dispatch-current')).resolves.toEqual({
      projectId: 'project-1',
      run: expect.objectContaining({
        id: 'run-1',
        lane: 'background',
        status: 'dispatched',
        dispatchMessageId: 'dispatch-current',
        executionSnapshot,
      }),
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('FEAT-007: returns the frozen snapshot for the current interactive dispatch', async () => {
    mockFindFirst.mockResolvedValue(baseRow({
      status: 'dispatched',
      lane: 'ai-runs-interactive',
      executionSnapshot,
    }));

    await expect(getBootstrap('run-1', 'dispatch-current')).resolves.toEqual({
      projectId: 'project-1',
      run: expect.objectContaining({
        id: 'run-1',
        lane: 'ai-runs-interactive',
        status: 'dispatched',
        dispatchMessageId: 'dispatch-current',
        executionSnapshot,
      }),
    });
  });

  it('TBI-004 DoD-2 / PBI-004 AC-3 / VT-06: rejects a stale bootstrap fence without mutation', async () => {
    mockFindFirst.mockResolvedValue(baseRow({
      status: 'running',
      executionSnapshot,
    }));

    await expect(getBootstrap('run-1', 'dispatch-stale')).rejects.toMatchObject({
      code: 'AI_RUN_DISPATCH_MISMATCH',
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockMarkTerminal).not.toHaveBeenCalled();
  });

  it.each([
    ['queued', 'background'],
    ['completed', 'background'],
    ['dispatched', null],
  ])(
    'TBI-004 bootstrap contract: rejects status=%s lane=%s as a conflict',
    async (status, lane) => {
      mockFindFirst.mockResolvedValue(baseRow({
        status,
        lane,
        executionSnapshot,
      }));

      await expect(getBootstrap('run-1', 'dispatch-current')).rejects.toMatchObject({
        code: 'AI_RUN_ILLEGAL_TRANSITION',
      });
    },
  );

  it('TBI-004 bootstrap contract: missing run is consistently not found', async () => {
    mockFindFirst.mockResolvedValue(null);

    await expect(getBootstrap('missing', 'dispatch-current')).rejects.toMatchObject({
      code: 'AI_RUN_NOT_FOUND',
    });
  });
});

describe('aiRunIngestService accepted events', () => {
  it.each(['queued', 'dispatched'] as const)(
    'TBI-008 DoD-1: accepts the shared %s runtime phase',
    async (phase) => {
      mockFindFirst.mockResolvedValue(baseRow());

      await expect(ingest('project-1', 'run-1', {
        dispatchMessageId: 'dispatch-current',
        kind: 'progress',
        phase,
        status: 'running',
        detail: phase,
      })).resolves.toMatchObject({ run: { id: 'run-1' } });
    },
  );

  it('TBI-008 DoD-2 / performance NFR: first accepted worker callback emits cold-start duration once', async () => {
    mockFindFirst
      .mockResolvedValueOnce(baseRow({
        status: 'dispatched',
        dispatchedAt: '2026-08-05T12:00:00.000Z',
        executionSnapshot: {
          ...executionSnapshot,
          prompt: 'prompt=confidential',
          workspaceRef: 'C:\\private\\workspace',
        },
      }))
      .mockResolvedValueOnce(baseRow({
        status: 'running',
        dispatchedAt: '2026-08-05T12:00:00.000Z',
      }));

    jest.useFakeTimers().setSystemTime(
      new Date('2026-08-05T12:00:02.500Z'),
    );
    try {
      await ingest('project-1', 'run-1', {
        dispatchMessageId: 'dispatch-current',
        kind: 'heartbeat',
      });
      await ingest('project-1', 'run-1', {
        dispatchMessageId: 'dispatch-current',
        kind: 'heartbeat',
      });
    } finally {
      jest.useRealTimers();
    }

    expect(mockWorkerColdStart).toHaveBeenCalledTimes(1);
    expect(mockWorkerColdStart).toHaveBeenCalledWith(
      {
        runId: 'run-1',
        dispatchMessageId: 'dispatch-current',
        project: 'project-1',
        lane: 'background',
      },
      2_500,
    );
    expect(JSON.stringify(mockWorkerColdStart.mock.calls)).not.toMatch(
      /prompt=confidential|private\\\\workspace|snapshot|CURSOR_API_KEY/i,
    );
  });

  it('TBI-005 DoD-2 / VT-10: progress updates clocks and durably fans out sanitized detail', async () => {
    mockFindFirst.mockResolvedValue(baseRow());
    const unsafeDetail = `  Running\nfocused\t tests ${'x'.repeat(600)}  `;

    const result = await ingest('project-1', 'run-1', {
      dispatchMessageId: 'dispatch-current',
      kind: 'progress',
      phase: 'testing',
      status: 'running',
      detail: unsafeDetail,
    });

    expect(result.cancelRequested).toBe(false);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      heartbeatAt: expect.any(String),
      progressAt: expect.any(String),
      progressLabel: expect.not.stringMatching(/\s{2,}|\n|\t/),
      progressPhase: 'testing',
    }));
    expect(mockSet.mock.calls[0][0].progressLabel).toHaveLength(500);
    expect(mockNotifyRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        runId: 'run-1',
        sourceInstance: 'test-instance',
        sequence: 7,
        type: 'phase',
        phase: 'testing',
        status: 'running',
        detail: mockSet.mock.calls[0][0].progressLabel,
      }),
      { persist: true },
    );
  });

  it('PBI-004 AC-2 / VT-04: next callback reports cancellation request', async () => {
    mockFindFirst.mockResolvedValue(baseRow({ cancelRequested: true }));
    mockReturning.mockResolvedValue([baseRow({ cancelRequested: true })]);

    const result = await ingest('project-1', 'run-1', {
      dispatchMessageId: 'dispatch-current',
      kind: 'heartbeat',
    });

    expect(result.cancelRequested).toBe(true);
  });

  it('PBI-004 AC-2 / VT-04: cancel_ack invokes fenced cancelled lifecycle', async () => {
    mockFindFirst.mockResolvedValue(baseRow({ cancelRequested: true }));
    mockMarkTerminal.mockResolvedValue({
      ok: true,
      run: baseRow({ status: 'cancelled', cancelRequested: true }),
    });
    mockReturning.mockResolvedValue([
      baseRow({
        status: 'cancelled',
        cancelRequested: true,
        cancelState: 'completed',
      }),
    ]);

    const result = await ingest('project-1', 'run-1', {
      dispatchMessageId: 'dispatch-current',
      kind: 'cancel_ack',
      detail: 'Worker stopped',
    });

    expect(mockMarkTerminal).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'cancelled',
        dispatchMessageId: 'dispatch-current',
      }),
    );
    expect(result.run.status).toBe('cancelled');
    expect(result.cancelRequested).toBe(true);
  });
});

describe('aiRunIngestService durable terminal completion', () => {
  const ingestCompleted = () => ingest('project-1', 'run-1', {
    dispatchMessageId: 'dispatch-current',
    kind: 'terminal',
    status: 'completed',
    artifactsFlushed: true,
  }, {
    consumeCompletedArtifacts: mockConsumeCompletedArtifacts,
  });

  it.each([undefined, false])(
    'TBI-005 DoD-4 / VT-01: rejects artifactsFlushed=%s without consuming or marking terminal',
    async (artifactsFlushed) => {
      mockFindFirst.mockResolvedValue(baseRow({ executionSnapshot }));

      await expect(ingest('project-1', 'run-1', {
        dispatchMessageId: 'dispatch-current',
        kind: 'terminal',
        status: 'completed',
        artifactsFlushed,
      }, {
        consumeCompletedArtifacts: mockConsumeCompletedArtifacts,
      })).rejects.toMatchObject({
        code: 'AI_RUN_ARTIFACTS_NOT_FLUSHED',
      });

      expect(mockConsumeCompletedArtifacts).not.toHaveBeenCalled();
      expect(mockMarkTerminal).not.toHaveBeenCalled();
    },
  );

  it('BR-008 / DoD-3 / BR-010: consumes durable artifacts before lifecycle terminal handling', async () => {
    mockFindFirst.mockResolvedValue(baseRow({ executionSnapshot }));

    await ingestCompleted();

    expect(mockConsumeCompletedArtifacts).toHaveBeenCalledWith(
      'thread-1',
      executionSnapshot.workspaceRef,
    );
    expect(mockConsumeCompletedArtifacts.mock.invocationCallOrder[0])
      .toBeLessThan(mockMarkTerminal.mock.invocationCallOrder[0]);
    expect(mockMarkTerminal).toHaveBeenCalledTimes(1);
  });

  it('TBI-005 DoD-4 / VT-01: consumer failure leaves lifecycle unchanged', async () => {
    mockFindFirst.mockResolvedValue(baseRow({ executionSnapshot }));
    mockConsumeCompletedArtifacts.mockRejectedValueOnce(new Error('sync failed'));

    await expect(ingestCompleted()).rejects.toThrow('sync failed');

    expect(mockConsumeCompletedArtifacts).toHaveBeenCalledTimes(1);
    expect(mockMarkTerminal).not.toHaveBeenCalled();
  });

  it('BR-008 / PBI-004 AC-0: repeated completed terminal skips artifacts but retries lifecycle cleanup', async () => {
    mockFindFirst
      .mockResolvedValueOnce(baseRow({ executionSnapshot }))
      .mockResolvedValueOnce(baseRow({
        status: 'completed',
        executionSnapshot,
      }));

    await expect(ingestCompleted()).resolves.toMatchObject({
      run: { status: 'completed' },
    });
    await expect(ingestCompleted()).resolves.toMatchObject({
      run: { status: 'completed' },
    });

    expect(mockConsumeCompletedArtifacts).toHaveBeenCalledTimes(1);
    expect(mockMarkTerminal).toHaveBeenCalledTimes(2);
    expect(mockMarkTerminal).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'completed',
        events: [
          expect.objectContaining({
            status: 'completed',
            event: { type: 'done', runId: 'run-1' },
          }),
        ],
      }),
    );
  });

  it('BR-008 / PBI-004 AC-0: same-status terminal retries lifecycle cleanup before flush validation', async () => {
    mockFindFirst.mockResolvedValue(baseRow({
      status: 'completed',
      executionSnapshot,
    }));

    await expect(ingest('project-1', 'run-1', {
      dispatchMessageId: 'dispatch-current',
      kind: 'terminal',
      status: 'completed',
    }, {
      consumeCompletedArtifacts: mockConsumeCompletedArtifacts,
    })).resolves.toMatchObject({
      run: { status: 'completed' },
    });

    expect(mockConsumeCompletedArtifacts).not.toHaveBeenCalled();
    expect(mockMarkTerminal).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('PBI-004 AC-0: different terminal conflicts without consumption or terminal CAS', async () => {
    mockFindFirst.mockResolvedValue(baseRow({
      status: 'failed',
      executionSnapshot,
    }));

    await expect(ingestCompleted()).rejects.toMatchObject({
      code: 'AI_RUN_ILLEGAL_TRANSITION',
    });

    expect(mockConsumeCompletedArtifacts).not.toHaveBeenCalled();
    expect(mockMarkTerminal).not.toHaveBeenCalled();
  });

  it.each(['failed', 'cancelled'] as const)(
    'TBI-005 DoD-4: flushed %s terminal skips successful artifact consumption',
    async (status) => {
      mockFindFirst.mockResolvedValue(baseRow({ executionSnapshot }));

      await ingest('project-1', 'run-1', {
        dispatchMessageId: 'dispatch-current',
        kind: 'terminal',
        status,
        artifactsFlushed: true,
      }, {
        consumeCompletedArtifacts: mockConsumeCompletedArtifacts,
      });

      expect(mockConsumeCompletedArtifacts).not.toHaveBeenCalled();
      expect(mockMarkTerminal).toHaveBeenCalledTimes(1);
    },
  );

  it('FEAT-007: accepts an unflushed actor failure and emits error plus done', async () => {
    mockFindFirst.mockResolvedValue(baseRow({
      lane: 'ai-runs-interactive',
      executionSnapshot,
    }));

    await ingest('project-1', 'run-1', {
      dispatchMessageId: 'dispatch-current',
      kind: 'terminal',
      status: 'failed',
      artifactsFlushed: false,
    }, {
      consumeCompletedArtifacts: mockConsumeCompletedArtifacts,
    });

    expect(mockConsumeCompletedArtifacts).not.toHaveBeenCalled();
    expect(mockMarkTerminal).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'failed',
        events: [
          expect.objectContaining({
            status: 'failed',
            event: expect.objectContaining({ type: 'error' }),
          }),
          expect.objectContaining({
            status: 'failed',
            event: expect.objectContaining({ type: 'done', runId: 'run-1' }),
          }),
        ],
      }),
    );
  });

  it('PBI-004 AC-3 regression: stale completed callback consumes nothing', async () => {
    mockFindFirst.mockResolvedValue(baseRow({ executionSnapshot }));

    await expect(ingest('project-1', 'run-1', {
      dispatchMessageId: 'dispatch-stale',
      kind: 'terminal',
      status: 'completed',
      artifactsFlushed: true,
    }, {
      consumeCompletedArtifacts: mockConsumeCompletedArtifacts,
    })).rejects.toMatchObject({
      code: 'AI_RUN_DISPATCH_MISMATCH',
    });

    expect(mockConsumeCompletedArtifacts).not.toHaveBeenCalled();
    expect(mockMarkTerminal).not.toHaveBeenCalled();
  });
});
