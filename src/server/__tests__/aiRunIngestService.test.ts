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
const mockFailGeneratingTestCasesForThread = jest.fn();
const mockWorkerColdStart = jest.fn();
const mockSelect = jest.fn();
const mockTransaction = jest.fn();
const mockInsert = jest.fn();

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
    select: (...args: unknown[]) => mockSelect(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
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

const mockGetCursorAgentId = jest.fn();
const mockSetCursorAgentId = jest.fn();

jest.mock('../services/chatThreadRepository', () => ({
  getCursorAgentId: (...args: unknown[]) => mockGetCursorAgentId(...args),
  setCursorAgentId: (...args: unknown[]) => mockSetCursorAgentId(...args),
  insertMessage: jest.fn(),
}));

jest.mock('../services/testCaseService', () => ({
  failGeneratingTestCasesForThread: (...args: unknown[]) =>
    mockFailGeneratingTestCasesForThread(...args),
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
  mockFailGeneratingTestCasesForThread.mockResolvedValue(undefined);
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
    mockGetCursorAgentId.mockResolvedValue('persisted-agent');

    await expect(getBootstrap('run-1', 'dispatch-current')).resolves.toEqual({
      projectId: 'project-1',
      cursorAgentId: 'persisted-agent',
      run: expect.objectContaining({
        id: 'run-1',
        lane: 'ai-runs-interactive',
        status: 'dispatched',
        dispatchMessageId: 'dispatch-current',
        executionSnapshot,
      }),
    });
    expect(mockGetCursorAgentId).toHaveBeenCalledWith('thread-1');
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

  it('strips U+0000 from progress detail before writing clocks', async () => {
    mockFindFirst.mockResolvedValue(baseRow());

    await ingest('project-1', 'run-1', {
      dispatchMessageId: 'dispatch-current',
      kind: 'progress',
      phase: 'implementation',
      status: 'running',
      detail: 'reading file\u0000.bin',
    });

    expect(mockSet.mock.calls[0][0].progressLabel).toBe('reading file.bin');
    expect(mockNotifyRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'reading file.bin' }),
      { persist: true },
    );
  });

  it('accepts a caller-supplied progress eventId for Redis↔Postgres identity', async () => {
    mockFindFirst.mockResolvedValue(baseRow());
    const eventId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    await ingest('project-1', 'run-1', {
      dispatchMessageId: 'dispatch-current',
      kind: 'progress',
      phase: 'implementation',
      status: 'running',
      eventId,
      event: {
        type: 'token',
        text: 'hi',
        streamOffset: 0,
        streamEndOffset: 2,
      },
    });

    expect(mockNotifyRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId,
        type: 'token',
        event: expect.objectContaining({
          type: 'token',
          text: 'hi',
          streamOffset: 0,
          streamEndOffset: 2,
        }),
      }),
      { persist: true },
    );
  });

  it('rejects a non-UUID progress eventId', async () => {
    mockFindFirst.mockResolvedValue(baseRow());

    await expect(
      ingest('project-1', 'run-1', {
        dispatchMessageId: 'dispatch-current',
        kind: 'progress',
        eventId: 'not-a-uuid',
        event: { type: 'token', text: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'AI_RUN_VALIDATION' });
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
    expect(mockFailGeneratingTestCasesForThread).toHaveBeenCalledWith('thread-1');
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
      expect(mockFailGeneratingTestCasesForThread).toHaveBeenCalledWith('thread-1');
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
    expect(mockFailGeneratingTestCasesForThread).toHaveBeenCalledWith('thread-1');
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

  it('retries a failed terminal and still flips generating test-case rows', async () => {
    mockFindFirst.mockResolvedValue(baseRow({
      status: 'failed',
      executionSnapshot,
    }));

    await ingest('project-1', 'run-1', {
      dispatchMessageId: 'dispatch-current',
      kind: 'terminal',
      status: 'failed',
      artifactsFlushed: true,
    }, {
      consumeCompletedArtifacts: mockConsumeCompletedArtifacts,
    });

    expect(mockConsumeCompletedArtifacts).not.toHaveBeenCalled();
    expect(mockFailGeneratingTestCasesForThread).toHaveBeenCalledWith('thread-1');
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

describe('aiRunIngestService durable final interactive message', () => {
  const finalMessage = {
    id: 'msg-final',
    role: 'agent' as const,
    text: 'here is the full answer',
    ts: '2026-08-08T00:00:00.000Z',
  };

  it('persists the interactive assistant message durably alongside the event', async () => {
    mockFindFirst.mockResolvedValue(baseRow({ lane: 'ai-runs-interactive' }));
    const persistThreadMessage = jest.fn().mockResolvedValue(undefined);

    const result = await ingest(
      'project-1',
      'run-1',
      {
        dispatchMessageId: 'dispatch-current',
        kind: 'progress',
        event: { type: 'message', message: finalMessage },
      },
      { persistThreadMessage },
    );

    expect(result.run).toBeDefined();
    expect(mockNotifyRunEvent).toHaveBeenCalled(); // replayable event copy
    expect(persistThreadMessage).toHaveBeenCalledWith('thread-1', finalMessage);
  });

  it('does not persist chat messages for the background lane', async () => {
    mockFindFirst.mockResolvedValue(baseRow({ lane: 'background' }));
    const persistThreadMessage = jest.fn().mockResolvedValue(undefined);

    await ingest(
      'project-1',
      'run-1',
      {
        dispatchMessageId: 'dispatch-current',
        kind: 'progress',
        event: { type: 'message', message: finalMessage },
      },
      { persistThreadMessage },
    );

    expect(persistThreadMessage).not.toHaveBeenCalled();
  });

  it('accepts the callback even when durable message persistence fails', async () => {
    mockFindFirst.mockResolvedValue(baseRow({ lane: 'ai-runs-interactive' }));
    const persistThreadMessage = jest
      .fn()
      .mockRejectedValue(new Error('db down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      ingest(
        'project-1',
        'run-1',
        {
          dispatchMessageId: 'dispatch-current',
          kind: 'progress',
          event: { type: 'message', message: finalMessage },
        },
        { persistThreadMessage },
      ),
    ).resolves.toBeDefined();
  });

  it('Stop race: progress on an already-cancelled run returns cancelRequested (no throw)', async () => {
    mockFindFirst.mockResolvedValue(baseRow({
      status: 'cancelled',
      cancelRequested: false,
      lane: 'ai-runs-interactive',
    }));

    await expect(
      ingest('project-1', 'run-1', {
        dispatchMessageId: 'dispatch-current',
        kind: 'progress',
        phase: 'implementation',
        status: 'running',
      }),
    ).resolves.toMatchObject({
      cancelRequested: true,
      run: { status: 'cancelled' },
    });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockNotifyRunEvent).not.toHaveBeenCalled();
  });

  it('Stop race: heartbeat on an already-cancelled run returns cancelRequested (no throw)', async () => {
    mockFindFirst.mockResolvedValue(baseRow({
      status: 'cancelled',
      lane: 'ai-runs-interactive',
    }));

    await expect(
      ingest('project-1', 'run-1', {
        dispatchMessageId: 'dispatch-current',
        kind: 'heartbeat',
      }),
    ).resolves.toMatchObject({ cancelRequested: true });
  });
});

describe('aiRunIngestService background usage recording', () => {
  const mockRecordUsage = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    mockRecordUsage.mockClear();
  });

  it('records background terminal usage against the run thread', async () => {
    mockFindFirst.mockResolvedValue(baseRow({ executionSnapshot }));

    await ingest('project-1', 'run-1', {
      dispatchMessageId: 'dispatch-current',
      kind: 'terminal',
      status: 'completed',
      artifactsFlushed: true,
      durationMs: 4200,
      inputTokens: 42_000,
      outputTokens: 900,
      cacheReadTokens: 118_000,
      cacheWriteTokens: 3_000,
    }, {
      consumeCompletedArtifacts: mockConsumeCompletedArtifacts,
      recordCursorChatUsage: mockRecordUsage,
    });

    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'claude-sonnet-4-5',
        threadId: 'thread-1',
        runId: 'run-1',
        inputTokens: 42_000,
        outputTokens: 900,
        cacheReadTokens: 118_000,
        cacheWriteTokens: 3_000,
        tokenSource: 'exact',
        durationMs: 4200,
        status: 'success',
        kickoff: expect.objectContaining({
          skillPath: executionSnapshot.skillPath,
          project: 'project-1',
        }),
      }),
    );
  });

  it('does not record interactive-lane usage (that path already records in-process)', async () => {
    mockFindFirst.mockResolvedValue(baseRow({
      executionSnapshot,
      lane: 'ai-runs-interactive',
    }));

    await ingest('project-1', 'run-1', {
      dispatchMessageId: 'dispatch-current',
      kind: 'terminal',
      status: 'completed',
      artifactsFlushed: true,
      durationMs: 4200,
      inputTokens: 100,
      outputTokens: 20,
    }, {
      consumeCompletedArtifacts: mockConsumeCompletedArtifacts,
      recordCursorChatUsage: mockRecordUsage,
    });

    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('rejects a negative token count before mutating the run', async () => {
    mockFindFirst.mockResolvedValue(baseRow({ executionSnapshot }));

    await expect(ingest('project-1', 'run-1', {
      dispatchMessageId: 'dispatch-current',
      kind: 'terminal',
      status: 'completed',
      artifactsFlushed: true,
      inputTokens: -1,
    }, {
      consumeCompletedArtifacts: mockConsumeCompletedArtifacts,
      recordCursorChatUsage: mockRecordUsage,
    })).rejects.toMatchObject({
      code: 'AI_RUN_VALIDATION',
    });

    expect(mockMarkTerminal).not.toHaveBeenCalled();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });
});

describe('dapr-actor-v2 bootstrap + terminal remediation', () => {
  const durableSpec = {
    schemaVersion: 1,
    kind: 'interactive-turn',
    turnId: '10000000-0000-4000-8000-000000000001',
    threadId: '10000000-0000-4000-8000-000000000002',
    userId: '10000000-0000-4000-8000-000000000003',
    projectId: 'project-1',
    interactiveClass: 'fast',
    workflowClass: 'home-chat',
    model: 'model-a',
    effort: 'low',
    skill: null,
    currentMessage: {
      id: '10000000-0000-4000-8000-000000000001',
      text: 'Hello',
      hidden: false,
      attachments: [],
    },
    transcript: [],
    grounding: null,
    mcpServers: [],
    toolGrant: null,
    currentPrompt: 'Hello',
    recreationPrompt: 'Hello',
    deadlines: {
      absoluteTurnMs: 300_000,
      repositoryPreparationMs: null,
      firstEventMs: 30_000,
      toolCallMs: 60_000,
    },
  };

  function chainSelect(rows: unknown[]) {
    const limit = jest.fn().mockResolvedValue(rows);
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where, limit });
    mockSelect.mockReturnValue({ from });
    return { from, where, limit };
  }

  beforeEach(() => {
    process.env.SESSION_SECRET = 'test-session-secret-for-proxy-tokens';
    mockGetCursorAgentId.mockResolvedValue(null);
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: mockSelect,
        update: mockUpdate,
        insert: mockInsert,
        execute: jest.fn().mockResolvedValue(undefined),
      };
      return fn(tx);
    });
    mockInsert.mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
      }),
    });
  });

  it('rejects interactive bootstrap when timeoutAt is missing (never synthesizes)', async () => {
    mockFindFirst.mockResolvedValue(
      baseRow({
        transportVersion: 'dapr-actor-v2',
        timeoutAt: null,
        lane: 'ai-runs-interactive',
        status: 'dispatched',
      }),
    );
    chainSelect([
      {
        id: 'attempt-1',
        runId: 'run-1',
        attemptNumber: 1,
        status: 'dispatched',
        dispatchMessageId: 'dispatch-current',
        specSnapshot: durableSpec,
      },
    ]);

    await expect(
      getBootstrap('run-1', 'dispatch-current'),
    ).rejects.toMatchObject({
      code: 'AI_RUN_ILLEGAL_TRANSITION',
      message: expect.stringMatching(/timeoutAt/i),
    });
  });

  it('runs dapr-actor-v2 terminal writes inside one db.transaction after fence', async () => {
    mockFindFirst.mockResolvedValue(
      baseRow({
        transportVersion: 'dapr-actor-v2',
        lane: 'ai-runs-interactive',
        status: 'running',
      }),
    );

    // assertAttemptFence + loadAttemptNumber + txn fence re-check
    const attemptRow = {
      id: 'attempt-1',
      runId: 'run-1',
      attemptNumber: 1,
      status: 'running',
      dispatchMessageId: 'dispatch-current',
    };
    let selectCall = 0;
    mockSelect.mockImplementation(() => {
      selectCall += 1;
      const limit = jest.fn().mockImplementation(async () => {
        if (selectCall <= 2) {
          return [
            {
              ...attemptRow,
              dispatchMessageId: 'dispatch-current',
              status: 'running',
            },
          ];
        }
        // Inside txn: fence re-check
        return [{ dispatchMessageId: 'dispatch-current', status: 'running' }];
      });
      const where = jest.fn().mockReturnValue({ limit });
      const from = jest.fn().mockReturnValue({ where, limit });
      return { from };
    });

    mockReturning.mockResolvedValue([
      baseRow({
        transportVersion: 'dapr-actor-v2',
        lane: 'ai-runs-interactive',
        status: 'failed',
      }),
    ]);

    const result = await ingest('project-1', 'run-1', {
      dispatchMessageId: 'dispatch-current',
      attemptId: 'attempt-1',
      kind: 'terminal',
      status: 'failed',
      artifactsFlushed: false,
      failureCategory: 'tool_timeout',
      detail: 'Interactive tool deadline exceeded',
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockMarkTerminal).not.toHaveBeenCalled();
    expect(result.run.status).toBe('failed');
  });

  it('returns 409 semantics before transactional writes on fence mismatch', async () => {
    mockFindFirst.mockResolvedValue(
      baseRow({
        transportVersion: 'dapr-actor-v2',
        lane: 'ai-runs-interactive',
        status: 'running',
        dispatchMessageId: 'dispatch-current',
      }),
    );
    chainSelect([]); // attempt fence miss

    await expect(
      ingest('project-1', 'run-1', {
        dispatchMessageId: 'dispatch-current',
        attemptId: 'attempt-stale',
        kind: 'terminal',
        status: 'failed',
        artifactsFlushed: false,
      }),
    ).rejects.toMatchObject({
      code: 'AI_RUN_DISPATCH_MISMATCH',
    });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockMarkTerminal).not.toHaveBeenCalled();
  });
});
