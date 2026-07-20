const mockFindMany = jest.fn();
const mockUpdateWhere = jest.fn();
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      agentRuns: { findMany: (...args: unknown[]) => mockFindMany(...args) },
    },
    update: jest.fn(() => ({ set: mockUpdateSet })),
  },
}));
jest.mock('../services/pgNotifyService', () => ({
  RUN_EVENT_SOURCE_INSTANCE: 'worker-a',
  nextRunEventSequence: jest.fn().mockReturnValue(1),
  notifyRunEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
  assessAgentRunHealth,
  isThreadRunAlive,
  reapOrphanedRuns,
  type AgentRunHealthConfig,
} from '../services/agentRunReaperService';
import { notifyRunEvent } from '../services/pgNotifyService';

const config: AgentRunHealthConfig = {
  heartbeatTimeoutMs: 5 * 60_000,
  queuedTimeoutMs: 90_000,
  progressStaleMs: 2 * 60_000,
  longRunMs: 30 * 60_000,
  hardLimitMs: 2 * 60 * 60_000,
};
const now = Date.parse('2026-07-14T14:00:00.000Z');

function timestamp(msAgo: number): string {
  return new Date(now - msAgo).toISOString();
}

describe('assessAgentRunHealth', () => {
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
});
