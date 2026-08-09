const mockFindMany = jest.fn();
const mockFindFirst = jest.fn();
const mockUpdateWhere = jest.fn();
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));
const mockMarkTerminal = jest.fn();
const mockRecoverStaleDispatchedRuns = jest.fn();
const mockWorkerReaperAction = jest.fn();

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
jest.mock('../services/agentRunLifecycleService', () => {
  const actual = jest.requireActual('../services/agentRunLifecycleService');
  return {
    ...actual,
    markTerminal: (...args: unknown[]) => mockMarkTerminal(...args),
  };
});
jest.mock('../services/admissionGovernorService', () => ({
  recoverStaleDispatchedRuns: (...args: unknown[]) =>
    mockRecoverStaleDispatchedRuns(...args),
}));
jest.mock('../services/workerTierTelemetry', () => ({
  workerTierTelemetry: {
    inflight: jest.fn(),
    queueDepth: jest.fn(),
    queueOldestAge: jest.fn(),
    projectInflight: jest.fn(),
    admissionWait: jest.fn(),
    coldStart: jest.fn(),
    cancellation: jest.fn(),
    reaperAction: (...args: unknown[]) => mockWorkerReaperAction(...args),
    terminalReason: jest.fn(),
  },
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
  backgroundQueueTtlMs: 30 * 60_000,
  workerHeartbeatTimeoutMs: 90_000,
  dispatchColdStartMs: 5 * 60_000,
  workerProgressTimeoutMs: 10 * 60_000,
  cancelGraceMs: 60_000,
  progressStaleMs: 2 * 60_000,
  progressAbortMs: 5 * 60_000,
  inFlightToolMaxMs: 15 * 60_000,
  longRunMs: 30 * 60_000,
  hardLimitMs: 2 * 60 * 60_000,
};
const workerConfig = config;
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
    jest.mocked(finalizeReconciledAgentRun).mockResolvedValue(true);
    mockMarkTerminal.mockResolvedValue({
      ok: true,
      run: { status: 'failed' },
    });
    mockRecoverStaleDispatchedRuns.mockResolvedValue({
      selected: 1,
      published: 1,
      failed: 0,
    });
    mockWorkerReaperAction.mockReset();
  });

  it('TBI-005 DoD-3 defaults worker clocks and accepts positive env overrides', () => {
    const keys = [
      'AI_RUN_WORKER_HEARTBEAT_TIMEOUT_MS',
      'AI_RUN_DISPATCH_COLDSTART_MS',
      'AI_RUN_PROGRESS_TIMEOUT_MS',
      'AI_RUN_CANCEL_GRACE_MS',
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) delete process.env[key];
      expect(resolveAgentRunHealthConfig()).toEqual(expect.objectContaining({
        workerHeartbeatTimeoutMs: 90_000,
        dispatchColdStartMs: 5 * 60_000,
        workerProgressTimeoutMs: 10 * 60_000,
        cancelGraceMs: 60_000,
      }));

      process.env.AI_RUN_WORKER_HEARTBEAT_TIMEOUT_MS = '91000';
      process.env.AI_RUN_DISPATCH_COLDSTART_MS = '301000';
      process.env.AI_RUN_PROGRESS_TIMEOUT_MS = '601000';
      process.env.AI_RUN_CANCEL_GRACE_MS = '61000';
      expect(resolveAgentRunHealthConfig()).toEqual(expect.objectContaining({
        workerHeartbeatTimeoutMs: 91_000,
        dispatchColdStartMs: 301_000,
        workerProgressTimeoutMs: 601_000,
        cancelGraceMs: 61_000,
      }));

      for (const key of keys) process.env[key] = '0';
      expect(resolveAgentRunHealthConfig()).toEqual(expect.objectContaining({
        workerHeartbeatTimeoutMs: 90_000,
        dispatchColdStartMs: 5 * 60_000,
        workerProgressTimeoutMs: 10 * 60_000,
        cancelGraceMs: 60_000,
      }));
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('TBI-005 DoD-3 / PBI-004 AC-1 / VT-02 terminalizes worker loss through the current dispatch fence', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'run-worker-lost',
      threadId: 'thread-worker',
      status: 'running',
      lane: 'background',
      dispatchMessageId: 'dispatch-current',
      createdAt: timestamp(20 * 60_000),
      startedAt: timestamp(20 * 60_000),
      heartbeatAt: timestamp(90_001),
      progressAt: timestamp(10_000),
      updatedAt: timestamp(10_000),
      progressPhase: 'implementation',
      cancelRequested: false,
    }]);

    await reapOrphanedRuns({ now: () => now, config });

    expect(mockMarkTerminal).toHaveBeenCalledTimes(1);
    expect(mockMarkTerminal).toHaveBeenCalledWith(
      'run-worker-lost',
      expect.objectContaining({
        status: 'failed',
        terminalReason: 'worker_lost',
        dispatchMessageId: 'dispatch-current',
        detail: 'Background worker heartbeat expired',
        events: [
          expect.objectContaining({
            runId: 'run-worker-lost',
            threadId: 'thread-worker',
            type: 'health',
            status: 'failed',
            detail: 'Background worker heartbeat expired',
            event: expect.objectContaining({
              type: 'health',
              health: 'worker_lost',
            }),
          }),
        ],
      }),
    );
    expect(mockUpdateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(mockWorkerReaperAction).toHaveBeenCalledWith({
      runId: 'run-worker-lost',
      dispatchMessageId: 'dispatch-current',
      lane: 'background',
    });
  });

  it('TBI-005 DoD-3 / PBI-004 AC-1 / VT-03 terminalizes stale progress while heartbeat is fresh', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'run-progress-timeout',
      threadId: 'thread-worker',
      status: 'running',
      lane: 'background',
      dispatchMessageId: 'dispatch-current',
      createdAt: timestamp(20 * 60_000),
      startedAt: timestamp(20 * 60_000),
      heartbeatAt: timestamp(10_000),
      progressAt: timestamp(10 * 60_000 + 1),
      updatedAt: timestamp(10_000),
      progressPhase: 'implementation',
      cancelRequested: false,
    }]);

    await reapOrphanedRuns({ now: () => now, config });

    expect(mockMarkTerminal).toHaveBeenCalledWith(
      'run-progress-timeout',
      expect.objectContaining({
        status: 'failed',
        terminalReason: 'progress_timeout',
        dispatchMessageId: 'dispatch-current',
        detail: 'Background worker progress expired',
        events: [
          expect.objectContaining({
            type: 'health',
            status: 'failed',
            event: expect.objectContaining({
              type: 'health',
              health: 'progress_timeout',
            }),
          }),
        ],
      }),
    );
    expect(mockWorkerReaperAction).toHaveBeenCalledWith({
      runId: 'run-progress-timeout',
      dispatchMessageId: 'dispatch-current',
      lane: 'background',
    });
  });

  it('TBI-005 DoD-3 / PBI-004 AC-2 / VT-05 forces cancellation after grace and repeats through lifecycle idempotency', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'run-cancel-grace',
      threadId: 'thread-worker',
      status: 'dispatched',
      lane: 'background',
      dispatchMessageId: 'dispatch-current',
      dispatchedAt: timestamp(2 * 60_000),
      updatedAt: timestamp(60_001),
      progressPhase: null,
      cancelRequested: true,
      cancelState: 'requested',
    }]);

    await reapOrphanedRuns({ now: () => now, config });
    await reapOrphanedRuns({ now: () => now, config });

    expect(mockMarkTerminal).toHaveBeenCalledTimes(2);
    expect(mockMarkTerminal).toHaveBeenCalledWith(
      'run-cancel-grace',
      expect.objectContaining({
        status: 'cancelled',
        terminalReason: 'forced_cancel',
        dispatchMessageId: 'dispatch-current',
        detail: 'Background worker cancellation grace expired',
        events: [
          expect.objectContaining({
            type: 'cancel',
            status: 'cancelled',
            detail: 'Background worker cancellation grace expired',
            event: { type: 'cancel' },
          }),
        ],
      }),
    );
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(mockWorkerReaperAction).toHaveBeenCalledWith({
      runId: 'run-cancel-grace',
      dispatchMessageId: 'dispatch-current',
      lane: 'background',
    });
  });

  it('TBI-005 DoD-3 re-promotes dispatched cold starts once after five minutes', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'run-cold-start',
        threadId: 'thread-worker',
        status: 'dispatched',
        lane: 'background',
        dispatchMessageId: 'dispatch-current',
        dispatchedAt: timestamp(5 * 60_000 + 1),
        updatedAt: timestamp(5 * 60_000 + 1),
        cancelRequested: false,
      },
      {
        id: 'run-cold-start-2',
        threadId: 'thread-worker-2',
        status: 'dispatched',
        lane: 'background',
        dispatchMessageId: 'dispatch-current-2',
        dispatchedAt: timestamp(6 * 60_000),
        updatedAt: timestamp(6 * 60_000),
        cancelRequested: false,
      },
    ]);

    await reapOrphanedRuns({ now: () => now, config });

    expect(mockRecoverStaleDispatchedRuns).toHaveBeenCalledTimes(1);
    expect(mockMarkTerminal).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(mockWorkerReaperAction).toHaveBeenCalledWith({
      lane: 'background',
    });
  });

  it('TBI-005 DoD-3 leaves dispatched rows under the cold-start clock untouched', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'run-starting',
      threadId: 'thread-worker',
      status: 'dispatched',
      lane: 'background',
      dispatchMessageId: 'dispatch-current',
      dispatchedAt: timestamp(5 * 60_000 - 1),
      updatedAt: timestamp(5 * 60_000 - 1),
      cancelRequested: false,
    }]);

    await reapOrphanedRuns({ now: () => now, config });

    expect(mockRecoverStaleDispatchedRuns).not.toHaveBeenCalled();
    expect(mockMarkTerminal).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('TBI-005 DoD-3 / VT-09 keeps lane-null rows on legacy AGENT clocks', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'run-legacy-clock',
      threadId: 'thread-legacy',
      status: 'running',
      lane: null,
      dispatchMessageId: null,
      createdAt: timestamp(20 * 60_000),
      startedAt: timestamp(20 * 60_000),
      heartbeatAt: timestamp(2 * 60_000),
      progressAt: timestamp(10_000),
      updatedAt: timestamp(10_000),
      timeoutAt: timestamp(-60 * 60_000),
      lastError: null,
      eventDriven: false,
    }]);

    await reapOrphanedRuns({
      now: () => now,
      config,
      eventDrivenTerminationEnabled: jest.fn().mockResolvedValue(false),
    });

    expect(mockMarkTerminal).not.toHaveBeenCalled();
    expect(mockRecoverStaleDispatchedRuns).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(notifyRunEvent).not.toHaveBeenCalled();
  });

  it('AC-3/VT-04/queue_ttl defaults to 30 minutes and accepts only positive env overrides', () => {
    const previous = process.env.AI_RUNS_BACKGROUND_QUEUE_TTL_MS;
    try {
      delete process.env.AI_RUNS_BACKGROUND_QUEUE_TTL_MS;
      expect(resolveAgentRunHealthConfig().backgroundQueueTtlMs).toBe(30 * 60_000);

      process.env.AI_RUNS_BACKGROUND_QUEUE_TTL_MS = '60000';
      expect(resolveAgentRunHealthConfig().backgroundQueueTtlMs).toBe(60_000);

      for (const invalid of ['invalid', '0', '-1']) {
        process.env.AI_RUNS_BACKGROUND_QUEUE_TTL_MS = invalid;
        expect(resolveAgentRunHealthConfig().backgroundQueueTtlMs).toBe(30 * 60_000);
      }
    } finally {
      if (previous === undefined) delete process.env.AI_RUNS_BACKGROUND_QUEUE_TTL_MS;
      else process.env.AI_RUNS_BACKGROUND_QUEUE_TTL_MS = previous;
    }
  });

  it('AC-3/VT-04/queue_ttl finalizes an expired background queued run as failed', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'run-background-expired',
      threadId: 'thread-background',
      status: 'queued',
      lane: 'background',
      queuedAt: timestamp(31 * 60_000),
      createdAt: timestamp(60 * 60_000),
      progressPhase: null,
      lastError: null,
    }]);

    await reapOrphanedRuns({ now: () => now, config: workerConfig });

    expect(finalizeReconciledAgentRun).toHaveBeenCalledTimes(1);
    const input = jest.mocked(finalizeReconciledAgentRun).mock.calls[0][0];
    expect(input).toEqual(expect.objectContaining({
      runId: 'run-background-expired',
      threadId: 'thread-background',
      status: 'failed',
      terminalReason: 'queue_ttl',
      detail: 'Background run exceeded the configured queue TTL',
    }));
    expect(input.events).toEqual([
      expect.objectContaining({
        runId: 'run-background-expired',
        threadId: 'thread-background',
        type: 'error',
        phase: 'completion',
        status: 'failed',
        detail: 'Background run exceeded the configured queue TTL',
        event: {
          type: 'error',
          error: 'Background run exceeded the configured queue TTL',
        },
      }),
    ]);
    expect(notifyRunEvent).not.toHaveBeenCalled();
    expect(mockWorkerReaperAction).toHaveBeenCalledWith({
      runId: 'run-background-expired',
      lane: 'background',
    });
  });

  it('TBI-008 DoD-2/DoD-3: scans and losing reaper races emit no action telemetry or confidential row fields', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'run-background-expired',
      threadId: 'thread-background',
      status: 'queued',
      lane: 'background',
      projectId: 'project-1',
      queuedAt: timestamp(31 * 60_000),
      createdAt: timestamp(31 * 60_000),
      progressPhase: null,
      executionSnapshot: {
        prompt: 'prompt=confidential',
        workspaceRef: 'C:\\private\\workspace',
      },
    }]);
    jest.mocked(finalizeReconciledAgentRun).mockResolvedValue(false);

    await reapOrphanedRuns({ now: () => now, config: workerConfig });

    expect(mockWorkerReaperAction).not.toHaveBeenCalled();
    expect(JSON.stringify(mockWorkerReaperAction.mock.calls)).not.toMatch(
      /prompt=confidential|private\\\\workspace|snapshot|CURSOR_API_KEY/i,
    );
  });

  it('AC-3/VT-04/queue_ttl leaves a younger background queued run untouched', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'run-background-young',
      threadId: 'thread-background',
      status: 'queued',
      lane: 'background',
      queuedAt: timestamp(29 * 60_000),
      createdAt: timestamp(2 * 60 * 60_000),
      progressPhase: null,
      lastError: null,
    }]);

    await reapOrphanedRuns({ now: () => now, config: workerConfig });

    expect(finalizeReconciledAgentRun).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(notifyRunEvent).not.toHaveBeenCalled();
  });

  it('AC-3/VT-04/queue_ttl falls back to createdAt for compatible background rows', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'run-background-legacy-timestamp',
      threadId: 'thread-background',
      status: 'queued',
      lane: 'background',
      queuedAt: null,
      createdAt: timestamp(31 * 60_000),
      progressPhase: null,
      lastError: null,
    }]);

    await reapOrphanedRuns({ now: () => now, config: workerConfig });

    expect(finalizeReconciledAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-background-legacy-timestamp',
        status: 'failed',
        terminalReason: 'queue_ttl',
      }),
    );
  });

  it('AC-3/VT-04/queue_ttl preserves legacy AGENT_QUEUE_TIMEOUT_MS never_claimed behavior', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'run-legacy-queued',
      threadId: 'thread-legacy',
      status: 'queued',
      lane: null,
      queuedAt: timestamp(60 * 60_000),
      createdAt: timestamp(2 * 60_000),
      startedAt: null,
      heartbeatAt: null,
      progressAt: null,
      progressPhase: null,
      timeoutAt: null,
      lastError: null,
    }]);

    await reapOrphanedRuns({ now: () => now, config: workerConfig });

    expect(finalizeReconciledAgentRun).not.toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith({
      status: 'failed',
      lastError: 'Never claimed (worker lost before lease)',
      updatedAt: new Date(now).toISOString(),
    });
    expect(notifyRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-legacy-queued',
        type: 'health',
        status: 'failed',
        event: expect.objectContaining({ health: 'never_claimed' }),
      }),
      { persist: true },
    );
  });

  it('AC-3/VT-04/queue_ttl uses finalizer CAS during concurrent reaper evaluation', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'run-background-expired',
      threadId: 'thread-background',
      status: 'queued',
      lane: 'background',
      queuedAt: timestamp(31 * 60_000),
      createdAt: timestamp(31 * 60_000),
      progressPhase: null,
      lastError: null,
    }]);
    jest.mocked(finalizeReconciledAgentRun)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    await Promise.all([
      reapOrphanedRuns({ now: () => now, config: workerConfig }),
      reapOrphanedRuns({ now: () => now, config: workerConfig }),
      reapOrphanedRuns({ now: () => now, config: workerConfig }),
    ]);

    expect(finalizeReconciledAgentRun).toHaveBeenCalledTimes(3);
    expect(notifyRunEvent).not.toHaveBeenCalled();
  });

  it('FEAT-001 AC-2 / DoD-3 leaves under-TTL background rows to worker lifecycle clocks', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'run-background',
        threadId: 'thread-background',
        status: 'queued',
        lane: 'background',
        createdAt: timestamp(10 * 60_000),
        startedAt: timestamp(10 * 60_000),
        heartbeatAt: timestamp(10 * 60_000),
        progressAt: null,
        timeoutAt: timestamp(-60 * 60_000),
        lastError: null,
      },
    ]);

    await reapOrphanedRuns({ now: () => now, config });

    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(finalizeReconciledAgentRun).not.toHaveBeenCalled();
    expect(notifyRunEvent).not.toHaveBeenCalled();
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

  it('does not mislabel an event-driven run as worker_lost when its heartbeat is stale', async () => {
    // Event-driven runs never write a heartbeat by design. The persisted marker
    // must force the timeout_at-only branch even without a live flag lookup, so a
    // stale heartbeat is NOT treated as "Worker lost (heartbeat expired)".
    mockFindMany.mockResolvedValue([
      {
        id: 'run-ed',
        threadId: 'thread-ed',
        status: 'running',
        eventDriven: true,
        createdAt: timestamp(10 * 60_000),
        startedAt: timestamp(10 * 60_000),
        heartbeatAt: timestamp(10 * 60_000), // 10 min stale → legacy worker_lost
        progressAt: timestamp(10 * 60_000),
        timeoutAt: timestamp(-60 * 60_000), // 1h in the future → not expired
        lastError: null,
      },
    ]);

    // No eventDrivenTerminationEnabled option: classification must come from the row.
    await reapOrphanedRuns({ now: () => now, config });

    expect(mockUpdateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(finalizeReconciledAgentRun).not.toHaveBeenCalled();
    expect(notifyRunEvent).not.toHaveBeenCalled();
  });

  it('still reaps an event-driven run once its absolute timeout_at is reached', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'run-ed-expired',
        threadId: 'thread-ed',
        status: 'running',
        eventDriven: true,
        createdAt: timestamp(3 * 60 * 60_000),
        startedAt: timestamp(3 * 60 * 60_000),
        heartbeatAt: timestamp(3 * 60 * 60_000),
        progressAt: timestamp(3 * 60 * 60_000),
        timeoutAt: timestamp(60_000), // expired 60s ago
        lastError: null,
      },
    ]);

    await reapOrphanedRuns({ now: () => now, config, retireReconcileDue: true });

    expect(finalizeReconciledAgentRun).toHaveBeenCalledTimes(1);
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

describe('FEAT-001 legacy partitioning (PBI-001 AC-2 / VT-03)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('AC-2: does not apply legacy heartbeat reaping to worker-lane rows', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'worker-run',
        threadId: 't-worker',
        status: 'running',
        ownerInstance: 'runner-1',
        heartbeatAt: timestamp(60 * 60_000),
        startedAt: timestamp(60 * 60_000),
        timeoutAt: null,
        lane: 'background',
        dispatchMessageId: 'D1',
        eventDriven: false,
      },
      {
        id: 'legacy-run',
        threadId: 't-legacy',
        status: 'running',
        ownerInstance: 'worker-a',
        heartbeatAt: timestamp(60 * 60_000),
        startedAt: timestamp(60 * 60_000),
        timeoutAt: null,
        lane: null,
        dispatchMessageId: null,
        eventDriven: false,
      },
    ]);
    mockUpdateWhere.mockResolvedValue(undefined);

    await reapOrphanedRuns({
      now: () => now,
      config,
      eventDrivenTerminationEnabled: jest.fn().mockResolvedValue(false),
    });

    // Legacy orphan is reaped; worker-lane row is skipped by partitioning.
    expect(mockUpdateSet).toHaveBeenCalled();
    const setArgs = mockUpdateSet.mock.calls.map((c: unknown[]) => c[0] as { lastError?: string });
    expect(setArgs.some((s) => String(s.lastError || '').includes('Worker lost'))).toBe(true);
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
