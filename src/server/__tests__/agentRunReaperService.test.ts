const mockFindMany = jest.fn();
const mockFindFirst = jest.fn();
const mockUpdateWhere = jest.fn();
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      agentRuns: {
        findMany: (...args: unknown[]) => mockFindMany(...args),
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
    update: jest.fn(() => ({ set: mockUpdateSet })),
  },
}));
jest.mock('../services/pgNotifyService', () => ({
  RUN_EVENT_SOURCE_INSTANCE: 'worker-a',
  nextRunEventSequence: jest.fn().mockReturnValue(1),
  notifyRunEvent: jest.fn().mockResolvedValue(undefined),
  finalizeReconciledAgentRun: jest.fn().mockResolvedValue(true),
}));

import {
  assessAgentRunHealth,
  resolveAgentRunHealthConfig,
  isThreadRunAlive,
  isTerminalAgentRunStatus,
  isInFlightToolProgressLabel,
  getLatestThreadRun,
  canThisInstanceFailGeneration,
  reapOrphanedRuns,
  shouldRunRetireReconciler,
  type AgentRunHealthConfig,
} from '../services/agentRunReaperService';
import { finalizeReconciledAgentRun, notifyRunEvent } from '../services/pgNotifyService';

const config: AgentRunHealthConfig = {
  heartbeatTimeoutMs: 5 * 60_000,
  queuedTimeoutMs: 90_000,
  progressStaleMs: 2 * 60_000,
  progressAbortMs: 5 * 60_000,
  inFlightToolMaxMs: 15 * 60_000,
  longRunMs: 30 * 60_000,
  hardLimitMs: 2 * 60 * 60_000,
};
const now = Date.parse('2026-07-14T14:00:00.000Z');

function timestamp(msAgo: number): string {
  return new Date(now - msAgo).toISOString();
}

describe('assessAgentRunHealth', () => {
  it('TBI-001 DoD-3 uses the env-overridable two-hour hard-run budget', () => {
    const previous = process.env.AGENT_RUN_HARD_LIMIT_MS;
    try {
      delete process.env.AGENT_RUN_HARD_LIMIT_MS;
      expect(resolveAgentRunHealthConfig().hardLimitMs).toBe(7_200_000);
      process.env.AGENT_RUN_HARD_LIMIT_MS = '9000000';
      expect(resolveAgentRunHealthConfig().hardLimitMs).toBe(9_000_000);
    } finally {
      if (previous === undefined) delete process.env.AGENT_RUN_HARD_LIMIT_MS;
      else process.env.AGENT_RUN_HARD_LIMIT_MS = previous;
    }
  });

  it('defaults the in-flight tool wall-clock cap to six minutes', () => {
    const previous = process.env.AGENT_IN_FLIGHT_TOOL_MAX_MS;
    try {
      delete process.env.AGENT_IN_FLIGHT_TOOL_MAX_MS;
      expect(resolveAgentRunHealthConfig().inFlightToolMaxMs).toBe(6 * 60_000);
    } finally {
      if (previous === undefined) delete process.env.AGENT_IN_FLIGHT_TOOL_MAX_MS;
      else process.env.AGENT_IN_FLIGHT_TOOL_MAX_MS = previous;
    }
  });

  it('surfaces stale progress even while worker heartbeats remain healthy', () => {
    expect(
      assessAgentRunHealth(
        {
          status: 'running',
          createdAt: timestamp(10 * 60_000),
          startedAt: timestamp(10 * 60_000),
          heartbeatAt: timestamp(10_000),
          progressAt: timestamp(3 * 60_000),
          timeoutAt: timestamp(-60 * 60_000),
        },
        now,
        config
      )
    ).toBe('progress_stale');
  });

  it('aborts after sustained progress silence beyond progressAbortMs', () => {
    expect(
      assessAgentRunHealth(
        {
          status: 'running',
          createdAt: timestamp(10 * 60_000),
          startedAt: timestamp(10 * 60_000),
          heartbeatAt: timestamp(10_000),
          progressAt: timestamp(6 * 60_000),
          timeoutAt: timestamp(-60 * 60_000),
        },
        now,
        config
      )
    ).toBe('progress_timeout');
  });

  it('does not abort a healthy worker whose last progress is an in-flight tool (edit running)', () => {
    // Mirrors prod failure: design-doc generation spent >5 minutes inside `edit`
    // with heartbeat alive but progressAt frozen on "edit running".
    expect(
      assessAgentRunHealth(
        {
          status: 'running',
          createdAt: timestamp(10 * 60_000),
          startedAt: timestamp(10 * 60_000),
          heartbeatAt: timestamp(10_000),
          progressAt: timestamp(6 * 60_000),
          progressLabel: 'edit running',
          timeoutAt: timestamp(-60 * 60_000),
        },
        now,
        config,
      ),
    ).toBe('progress_stale');
  });

  it('aborts an in-flight tool that exceeds inFlightToolMaxMs even while heartbeat is alive', () => {
    expect(
      assessAgentRunHealth(
        {
          status: 'running',
          createdAt: timestamp(20 * 60_000),
          startedAt: timestamp(20 * 60_000),
          heartbeatAt: timestamp(10_000),
          progressAt: timestamp(16 * 60_000),
          progressLabel: 'edit running',
          timeoutAt: timestamp(-60 * 60_000),
        },
        now,
        config,
      ),
    ).toBe('progress_timeout');
  });

  it('still aborts when progress is stale after a completed tool (not in-flight)', () => {
    expect(
      assessAgentRunHealth(
        {
          status: 'running',
          createdAt: timestamp(10 * 60_000),
          startedAt: timestamp(10 * 60_000),
          heartbeatAt: timestamp(10_000),
          progressAt: timestamp(6 * 60_000),
          progressLabel: 'edit completed',
          timeoutAt: timestamp(-60 * 60_000),
        },
        now,
        config,
      ),
    ).toBe('progress_timeout');
  });

  it('still detects worker loss even when last progress was an in-flight tool', () => {
    expect(
      assessAgentRunHealth(
        {
          status: 'running',
          createdAt: timestamp(10 * 60_000),
          startedAt: timestamp(10 * 60_000),
          heartbeatAt: timestamp(6 * 60_000),
          progressAt: timestamp(6 * 60_000),
          progressLabel: 'edit running',
          timeoutAt: timestamp(-60 * 60_000),
        },
        now,
        config,
      ),
    ).toBe('worker_lost');
  });

  it('detects worker loss independently of recent meaningful progress', () => {
    expect(
      assessAgentRunHealth(
        {
          status: 'running',
          createdAt: timestamp(10 * 60_000),
          startedAt: timestamp(10 * 60_000),
          heartbeatAt: timestamp(6 * 60_000),
          progressAt: timestamp(10_000),
          timeoutAt: timestamp(-60 * 60_000),
        },
        now,
        config
      )
    ).toBe('worker_lost');
  });

  it('surfaces a long-running state while recent progress continues', () => {
    expect(
      assessAgentRunHealth(
        {
          status: 'running',
          createdAt: timestamp(45 * 60_000),
          startedAt: timestamp(45 * 60_000),
          heartbeatAt: timestamp(10_000),
          progressAt: timestamp(10_000),
          timeoutAt: timestamp(-60 * 60_000),
        },
        now,
        config
      )
    ).toBe('long_running');
  });

  it('enforces the configurable hard limit even when timeoutAt is later', () => {
    expect(
      assessAgentRunHealth(
        {
          status: 'running',
          createdAt: timestamp(3 * 60 * 60_000),
          startedAt: timestamp(3 * 60 * 60_000),
          heartbeatAt: timestamp(10_000),
          progressAt: timestamp(10_000),
          timeoutAt: timestamp(-60 * 60_000),
        },
        now,
        config
      )
    ).toBe('hard_timeout');
  });

  it('fails queued runs that were never claimed', () => {
    expect(
      assessAgentRunHealth(
        {
          status: 'queued',
          createdAt: timestamp(2 * 60_000),
          startedAt: null,
          heartbeatAt: null,
          progressAt: null,
          timeoutAt: null,
        },
        now,
        config
      )
    ).toBe('never_claimed');
  });
});

describe('reapOrphanedRuns', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateWhere.mockResolvedValue(undefined);
  });

  it('records a progress warning without failing a live run', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'run-1',
        threadId: 'thread-1',
        status: 'running',
        createdAt: timestamp(10 * 60_000),
        startedAt: timestamp(10 * 60_000),
        heartbeatAt: timestamp(10_000),
        progressAt: timestamp(3 * 60_000),
        timeoutAt: timestamp(-60 * 60_000),
        lastError: null,
      },
    ]);

    await reapOrphanedRuns({ now: () => now, config });

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        lastError: expect.stringMatching(/meaningful progress/i),
      })
    );
    expect(mockUpdateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({
        progressLabel: expect.stringMatching(/meaningful progress/i),
      })
    );
    expect(mockUpdateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ progressAt: expect.anything() })
    );
    expect(mockUpdateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' })
    );
    expect(notifyRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        runId: 'run-1',
        type: 'health',
        status: 'running',
        event: expect.objectContaining({
          type: 'health',
          health: 'progress_stale',
        }),
      }),
      { persist: true }
    );
  });

  it('PBI-001 AC-1 / VT-04 bounds a stalled stream with failure and cancel', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'run-1',
        threadId: 'thread-1',
        status: 'running',
        createdAt: timestamp(10 * 60_000),
        startedAt: timestamp(10 * 60_000),
        heartbeatAt: timestamp(10_000),
        progressAt: timestamp(6 * 60_000),
        timeoutAt: timestamp(-60 * 60_000),
        lastError: 'No meaningful progress for more than 2 minutes',
      },
    ]);

    await reapOrphanedRuns({ now: () => now, config });

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        lastError: expect.stringMatching(/run aborted/i),
      })
    );
    expect(notifyRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'health',
        status: 'failed',
        event: expect.objectContaining({ health: 'progress_timeout' }),
      }),
      { persist: true }
    );
    expect(notifyRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'cancel',
        status: 'cancelled',
        event: expect.objectContaining({ type: 'cancel' }),
      }),
      { persist: true }
    );
  });

  it('marks a heartbeat-expired run failed', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'run-1',
        threadId: 'thread-1',
        status: 'running',
        createdAt: timestamp(10 * 60_000),
        startedAt: timestamp(10 * 60_000),
        heartbeatAt: timestamp(6 * 60_000),
        progressAt: timestamp(10_000),
        timeoutAt: timestamp(-60 * 60_000),
        lastError: null,
      },
    ]);

    await reapOrphanedRuns({ now: () => now, config });

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        lastError: 'Worker lost (heartbeat expired)',
      })
    );
    expect(notifyRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'health',
        status: 'failed',
        event: expect.objectContaining({ health: 'worker_lost' }),
      }),
      { persist: true }
    );
  });

  it('TBI-001 S4 reconciles only expired timeout_at rows in event-driven enforce mode', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'run-unexpired',
        threadId: 'thread-1',
        status: 'running',
        createdAt: timestamp(10 * 60_000),
        startedAt: timestamp(10 * 60_000),
        heartbeatAt: timestamp(10 * 60_000),
        progressAt: timestamp(10 * 60_000),
        timeoutAt: timestamp(-60_000),
        lastError: null,
      },
      {
        id: 'run-expired',
        threadId: 'thread-2',
        status: 'running',
        createdAt: timestamp(3 * 60 * 60_000),
        startedAt: timestamp(3 * 60 * 60_000),
        heartbeatAt: timestamp(10_000),
        progressAt: timestamp(10_000),
        timeoutAt: timestamp(60_000),
        lastError: null,
      },
    ]);

    await reapOrphanedRuns({
      now: () => now,
      config,
      eventDrivenTerminationEnabled: jest.fn().mockResolvedValue(true),
    });

    expect(finalizeReconciledAgentRun).toHaveBeenCalledTimes(1);
    expect(finalizeReconciledAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-expired',
        status: 'failed',
        events: expect.arrayContaining([
          expect.objectContaining({ type: 'error' }),
          expect.objectContaining({ type: 'cancel' }),
        ]),
      }),
    );
    expect(JSON.stringify(jest.mocked(finalizeReconciledAgentRun).mock.calls))
      .not.toContain('run-unexpired');
    expect(JSON.stringify(jest.mocked(finalizeReconciledAgentRun).mock.calls))
      .not.toContain('"type":"health"');
    expect(notifyRunEvent).not.toHaveBeenCalled();
  });

  it('TBI-003 DoD-0 / NFR reconciles an expired row only once across instances', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'run-expired',
      threadId: 'thread-1',
      status: 'running',
      ownerInstance: 'worker-a',
      createdAt: timestamp(3 * 60 * 60_000),
      startedAt: timestamp(3 * 60 * 60_000),
      heartbeatAt: timestamp(10_000),
      progressAt: timestamp(10_000),
      timeoutAt: timestamp(60_000),
      lastError: null,
    }]);
    jest.mocked(finalizeReconciledAgentRun)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    const options = {
      now: () => now,
      config,
      eventDrivenTerminationEnabled: jest.fn().mockResolvedValue(true),
    };
    await Promise.all([
      reapOrphanedRuns(options),
      reapOrphanedRuns(options),
      reapOrphanedRuns(options),
    ]);

    expect(finalizeReconciledAgentRun).toHaveBeenCalledTimes(3);
    expect(notifyRunEvent).not.toHaveBeenCalled();
  });

  it('TBI-003 retire reconciler is due every five minutes', () => {
    expect(shouldRunRetireReconciler(0, 299_999)).toBe(false);
    expect(shouldRunRetireReconciler(0, 300_000)).toBe(true);
  });

  it('publishes a durable healthy recovery event without moving progressAt', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'run-1',
        threadId: 'thread-1',
        status: 'running',
        createdAt: timestamp(10 * 60_000),
        startedAt: timestamp(10 * 60_000),
        heartbeatAt: timestamp(10_000),
        progressAt: timestamp(10_000),
        progressPhase: 'testing',
        timeoutAt: timestamp(-60 * 60_000),
        lastError: 'No meaningful progress for more than 2 minutes',
      },
    ]);

    await reapOrphanedRuns({ now: () => now, config });

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: null })
    );
    expect(mockUpdateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ progressAt: expect.anything() })
    );
    expect(notifyRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'health',
          health: 'healthy',
        }),
      }),
      { persist: true }
    );
  });
});

describe('isThreadRunAlive', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns true while a healthy running agent_runs row exists', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'run-1',
        threadId: 'thread-1',
        status: 'running',
        createdAt: timestamp(10 * 60_000),
        startedAt: timestamp(10 * 60_000),
        heartbeatAt: timestamp(10_000),
        progressAt: timestamp(10_000),
        timeoutAt: timestamp(-60 * 60_000),
      },
    ]);

    await expect(
      isThreadRunAlive('thread-1', { now: () => now, config }),
    ).resolves.toBe(true);
  });

  it('returns true for progress_stale and long_running (worker still alive)', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'run-1',
        threadId: 'thread-1',
        status: 'running',
        createdAt: timestamp(45 * 60_000),
        startedAt: timestamp(45 * 60_000),
        heartbeatAt: timestamp(10_000),
        progressAt: timestamp(3 * 60_000),
        timeoutAt: timestamp(-60 * 60_000),
      },
    ]);

    await expect(
      isThreadRunAlive('thread-1', { now: () => now, config }),
    ).resolves.toBe(true);
  });

  it('returns true when progress has timed out but the worker heartbeat is still fresh', async () => {
    // progress_timeout is a reaper concern; hydrate/recover must not treat a
    // still-heartbeating run (e.g. long interview thinking) as dead.
    mockFindMany.mockResolvedValue([
      {
        id: 'run-1',
        threadId: 'thread-1',
        status: 'running',
        createdAt: timestamp(10 * 60_000),
        startedAt: timestamp(10 * 60_000),
        heartbeatAt: timestamp(10_000),
        progressAt: timestamp(6 * 60_000),
        timeoutAt: timestamp(-60 * 60_000),
      },
    ]);

    await expect(
      isThreadRunAlive('thread-1', { now: () => now, config }),
    ).resolves.toBe(true);
  });

  it('returns false when the only run is worker_lost', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'run-1',
        threadId: 'thread-1',
        status: 'running',
        createdAt: timestamp(10 * 60_000),
        startedAt: timestamp(10 * 60_000),
        heartbeatAt: timestamp(6 * 60_000),
        progressAt: timestamp(10_000),
        timeoutAt: timestamp(-60 * 60_000),
      },
    ]);

    await expect(
      isThreadRunAlive('thread-1', { now: () => now, config }),
    ).resolves.toBe(false);
  });

  it('returns false when no queued/running rows exist', async () => {
    mockFindMany.mockResolvedValue([]);

    await expect(
      isThreadRunAlive('thread-1', { now: () => now, config }),
    ).resolves.toBe(false);
  });

  it('PBI-002 AC-3 ignores missing liveness writes in event-driven mode before timeout_at', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'run-1',
      threadId: 'thread-1',
      status: 'running',
      createdAt: timestamp(10 * 60_000),
      startedAt: timestamp(10 * 60_000),
      heartbeatAt: timestamp(60 * 60_000),
      progressAt: null,
      timeoutAt: timestamp(-60_000),
    }]);

    await expect(isThreadRunAlive('thread-1', {
      now: () => now,
      config,
      eventDrivenTerminationEnabled: jest.fn().mockResolvedValue(true),
    })).resolves.toBe(true);
  });

  it('BR-006 treats only expired timeout_at as dead in event-driven mode', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'run-1',
      threadId: 'thread-1',
      status: 'running',
      createdAt: timestamp(10 * 60_000),
      startedAt: timestamp(10 * 60_000),
      heartbeatAt: timestamp(10_000),
      progressAt: timestamp(10_000),
      timeoutAt: timestamp(1),
    }]);

    await expect(isThreadRunAlive('thread-1', {
      now: () => now,
      config,
      eventDrivenTerminationEnabled: jest.fn().mockResolvedValue(true),
    })).resolves.toBe(false);
  });
});

describe('isTerminalAgentRunStatus', () => {
  it.each(['completed', 'failed', 'cancelled'])('returns true for %s', (status) => {
    expect(isTerminalAgentRunStatus(status)).toBe(true);
  });

  it.each(['queued', 'running', 'unknown'])('returns false for %s', (status) => {
    expect(isTerminalAgentRunStatus(status)).toBe(false);
  });
});

describe('isInFlightToolProgressLabel', () => {
  it('matches tool-running labels from inferRunEventDetail', () => {
    expect(isInFlightToolProgressLabel('edit running')).toBe(true);
    expect(isInFlightToolProgressLabel('Write running')).toBe(true);
    expect(isInFlightToolProgressLabel('Shell:npm running')).toBe(true);
  });

  it('rejects completed/idle labels', () => {
    expect(isInFlightToolProgressLabel('edit completed')).toBe(false);
    expect(isInFlightToolProgressLabel('Generating response')).toBe(false);
    expect(isInFlightToolProgressLabel(null)).toBe(false);
    expect(isInFlightToolProgressLabel(undefined)).toBe(false);
  });
});

describe('getLatestThreadRun', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the latest run status, ownerInstance, and updatedAt', async () => {
    mockFindFirst.mockResolvedValue({
      status: 'completed',
      ownerInstance: 'worker-a',
      updatedAt: '2026-07-14T13:59:00.000Z',
    });
    const result = await getLatestThreadRun('thread-1');
    expect(result).toEqual({
      status: 'completed',
      ownerInstance: 'worker-a',
      updatedAt: '2026-07-14T13:59:00.000Z',
    });
  });

  it('returns null when no runs exist', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    const result = await getLatestThreadRun('thread-1');
    expect(result).toBeNull();
  });
});

describe('canThisInstanceFailGeneration', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns false when no agent_runs row exists (kickoff in progress)', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    await expect(canThisInstanceFailGeneration('thread-1')).resolves.toBe(false);
  });

  it('returns false when the latest run is not terminal (still alive)', async () => {
    mockFindFirst.mockResolvedValue({
      status: 'running',
      ownerInstance: 'worker-a',
      updatedAt: timestamp(0),
    });
    await expect(canThisInstanceFailGeneration('thread-1')).resolves.toBe(false);
  });

  it('returns false when a foreign owner terminal run is still within orphan grace', async () => {
    mockFindFirst.mockResolvedValue({
      status: 'completed',
      ownerInstance: 'worker-b',
      updatedAt: timestamp(60_000), // 1 min ago — within 2 min grace
    });
    await expect(
      canThisInstanceFailGeneration('thread-1', { now: () => now }),
    ).resolves.toBe(false);
  });

  it('returns true when a foreign owner terminal run is past orphan grace (takeover)', async () => {
    mockFindFirst.mockResolvedValue({
      status: 'failed',
      ownerInstance: 'worker-b',
      updatedAt: timestamp(3 * 60_000), // 3 min ago — past 2 min grace
    });
    await expect(
      canThisInstanceFailGeneration('thread-1', { now: () => now }),
    ).resolves.toBe(true);
  });

  it('returns true when this instance owned the terminal run', async () => {
    mockFindFirst.mockResolvedValue({
      status: 'completed',
      ownerInstance: 'worker-a',
      updatedAt: timestamp(0),
    });
    await expect(canThisInstanceFailGeneration('thread-1')).resolves.toBe(true);
  });

  it('returns true when ownerInstance is null (legacy/reaped)', async () => {
    mockFindFirst.mockResolvedValue({
      status: 'failed',
      ownerInstance: null,
      updatedAt: timestamp(0),
    });
    await expect(canThisInstanceFailGeneration('thread-1')).resolves.toBe(true);
  });
});
