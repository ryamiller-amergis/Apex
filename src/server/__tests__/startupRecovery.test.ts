const mockFindMany = jest.fn();
const mockAgentRunsFindMany = jest.fn();
const mockPrdsFindMany = jest.fn();
const mockDesignDocsFindMany = jest.fn();
const mockTestCasesFindMany = jest.fn();
const mockAgentRunsFindFirst = jest.fn();
const mockUpdateReturning = jest.fn();
const mockUpdateWhere = jest.fn(() => ({ returning: mockUpdateReturning }));
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      devSessions: { findMany: (...args: unknown[]) => mockFindMany(...args) },
      prds: { findMany: (...args: unknown[]) => mockPrdsFindMany(...args) },
      designDocs: { findMany: (...args: unknown[]) => mockDesignDocsFindMany(...args) },
      testCases: { findMany: (...args: unknown[]) => mockTestCasesFindMany(...args) },
      agentRuns: {
        findMany: (...args: unknown[]) => mockAgentRunsFindMany(...args),
        findFirst: (...args: unknown[]) => mockAgentRunsFindFirst(...args),
      },
    },
    update: jest.fn(() => ({ set: mockUpdateSet })),
  },
}));
jest.mock('../services/chatAgentService', () => ({
  hydrateThread: jest.fn(),
  isThreadIdle: jest.fn(),
  reevaluateThreadGroundingForRecovery: jest.fn().mockResolvedValue(true),
  sendMessage: jest.fn(),
}));
jest.mock('../services/prdService', () => ({
  startPrdWatcher: jest.fn(),
  isPrdWatcherActive: jest.fn(),
  isPrdValidationWatcherActive: jest.fn(),
  rehydratePrdValidationWatcher: jest.fn(),
  routePrdGenerationKickoff: jest.fn(),
}));
jest.mock('../services/designDocService', () => ({
  startSingleFeatureDocWatcher: jest.fn(),
  startValidationWatcher: jest.fn(),
  isValidationWatcherActive: jest.fn(),
  routeDesignDocGenerationKickoff: jest.fn(),
}));
jest.mock('../services/testCaseService', () => ({
  startTestCaseWatcher: jest.fn(),
  isTestCaseWatcherActive: jest.fn(),
}));
jest.mock('../services/designPrototypeService', () => ({
  failStalePrototypes: jest.fn(),
}));
jest.mock('../services/chatThreadRepository', () => ({
  findRunningInterviewThreads: jest.fn(),
  clearStaleRun: jest.fn(),
}));
jest.mock('../services/featureRequestAnalysisService', () => ({
  recoverAnalyzingFeatureRequests: jest.fn(),
}));
jest.mock('../services/agentRunReaperService', () => ({
  isThreadRunAlive: jest.fn(),
}));
jest.mock('../services/pgNotifyService', () => ({
  RUN_EVENT_SOURCE_INSTANCE: 'worker-a',
  finalizeOwnedAgentRun: jest.fn(),
  nextRunEventSequence: jest.fn()
    .mockReturnValueOnce(1)
    .mockReturnValueOnce(2),
}));

import {
  recoverStaleDevSessionSetups,
  recoverInFlightWork,
  recoverStuckInterviewThreads,
  finalizeOwnedRunsForShutdown,
  isGenerationRecoveryStale,
  registerProcessGuards,
} from '../services/startupRecovery';
import { findRunningInterviewThreads, clearStaleRun } from '../services/chatThreadRepository';
import {
  hydrateThread,
  reevaluateThreadGroundingForRecovery,
} from '../services/chatAgentService';
import { isThreadRunAlive } from '../services/agentRunReaperService';
import { finalizeOwnedAgentRun } from '../services/pgNotifyService';
import { routeDesignDocGenerationKickoff } from '../services/designDocService';

const mockedFindRunning = findRunningInterviewThreads as jest.MockedFunction<typeof findRunningInterviewThreads>;
const mockedClearStale = clearStaleRun as jest.MockedFunction<typeof clearStaleRun>;
const mockedHydrate = hydrateThread as jest.MockedFunction<typeof hydrateThread>;
const mockedReevaluateGrounding = reevaluateThreadGroundingForRecovery as jest.MockedFunction<
  typeof reevaluateThreadGroundingForRecovery
>;
const mockedIsAlive = isThreadRunAlive as jest.MockedFunction<typeof isThreadRunAlive>;

describe('generation preparation recovery lease', () => {
  const now = Date.parse('2026-08-11T05:16:37.000Z');

  it('does not re-kick preparation that outlives the 60-second recovery interval', () => {
    expect(isGenerationRecoveryStale(
      '2026-08-11T05:15:00.000Z',
      now,
      15 * 60_000,
    )).toBe(false);
  });

  it('allows recovery after the bounded preparation lease expires', () => {
    expect(isGenerationRecoveryStale(
      '2026-08-11T05:01:37.000Z',
      now,
      15 * 60_000,
    )).toBe(true);
  });
});

describe('design-doc generation recovery claim', () => {
  const routeDesignDoc = routeDesignDocGenerationKickoff as jest.MockedFunction<
    typeof routeDesignDocGenerationKickoff
  >;
  const mockIsThreadIdle = jest.requireMock('../services/chatAgentService')
    .isThreadIdle as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateWhere.mockImplementation(() => ({ returning: mockUpdateReturning }));
    mockFindMany.mockResolvedValue([]);
    mockPrdsFindMany.mockResolvedValue([]);
    mockTestCasesFindMany.mockResolvedValue([]);
    mockAgentRunsFindFirst.mockResolvedValue(null);
    mockDesignDocsFindMany
      .mockResolvedValueOnce([{
        id: 'doc-1',
        chatThreadId: 'thread-design',
        prdId: 'prd-1',
        project: 'Apex',
        designPrototypeId: 'prototype-1',
        authorId: 'user-1',
        updatedAt: '2026-08-11T05:15:00.000Z',
      }])
      .mockResolvedValueOnce([]);
    mockedHydrate.mockResolvedValue(true);
    mockIsThreadIdle.mockReturnValue(true);
    mockedFindRunning.mockResolvedValue([]);
    jest.requireMock('../services/designPrototypeService')
      .failStalePrototypes.mockResolvedValue(0);
    jest.requireMock('../services/featureRequestAnalysisService')
      .recoverAnalyzingFeatureRequests.mockResolvedValue(0);
    routeDesignDoc.mockResolvedValue();
  });

  it('does not duplicate a slow preparation during the next recovery sweep', async () => {
    const nowSpy = jest.spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-08-11T05:16:37.000Z'));
    try {
      await recoverInFlightWork();
    } finally {
      nowSpy.mockRestore();
    }

    expect(routeDesignDoc).not.toHaveBeenCalled();
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it('re-kicks an expired row only after winning the atomic claim', async () => {
    mockDesignDocsFindMany.mockReset()
      .mockResolvedValueOnce([{
        id: 'doc-1',
        chatThreadId: 'thread-design',
        prdId: 'prd-1',
        project: 'Apex',
        designPrototypeId: 'prototype-1',
        authorId: 'user-1',
        updatedAt: '2026-08-11T05:00:00.000Z',
      }])
      .mockResolvedValueOnce([]);
    mockUpdateReturning.mockResolvedValueOnce([{ id: 'doc-1' }]);
    const nowSpy = jest.spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-08-11T05:16:37.000Z'));
    try {
      await recoverInFlightWork();
    } finally {
      nowSpy.mockRestore();
    }

    expect(mockUpdateReturning).toHaveBeenCalledTimes(1);
    expect(routeDesignDoc).toHaveBeenCalledTimes(1);
    expect(routeDesignDoc).toHaveBeenCalledWith(expect.objectContaining({
      designDocId: 'doc-1',
      threadId: 'thread-design',
    }));
  });

  it('does not re-kick when another instance wins the atomic claim', async () => {
    mockDesignDocsFindMany.mockReset()
      .mockResolvedValueOnce([{
        id: 'doc-1',
        chatThreadId: 'thread-design',
        prdId: 'prd-1',
        project: 'Apex',
        designPrototypeId: 'prototype-1',
        authorId: 'user-1',
        updatedAt: '2026-08-11T05:00:00.000Z',
      }])
      .mockResolvedValueOnce([]);
    mockUpdateReturning.mockResolvedValueOnce([]);
    const nowSpy = jest.spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-08-11T05:16:37.000Z'));
    try {
      await recoverInFlightWork();
    } finally {
      nowSpy.mockRestore();
    }

    expect(mockUpdateReturning).toHaveBeenCalledTimes(1);
    expect(routeDesignDoc).not.toHaveBeenCalled();
  });
});

describe('PBI-001 AC-1 / VT-10 Cursor SDK process guard', () => {
  it.each([
    ['uncaughtException', 'EPIPE'],
    ['unhandledRejection', 'ERR_STREAM_DESTROYED'],
  ] as const)('contains %s %s without exiting the process', (eventName, code) => {
    // Given the SDK local CLI reports a closed transport through a process event.
    let guardedHandler: ((reason: unknown) => void) | undefined;
    const onSpy = jest.spyOn(process, 'on').mockImplementation(
      ((registeredEvent: string, handler: (reason: unknown) => void) => {
        if (registeredEvent === eventName) guardedHandler = handler;
        return process;
      }) as typeof process.on,
    );
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(
      (() => undefined) as never,
    );
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      registerProcessGuards();

      // When the registered guard receives the SDK pipe failure.
      guardedHandler?.(Object.assign(new Error('Cursor CLI pipe closed'), { code }));

      // Then the error is contained and the process remains alive.
      expect(guardedHandler).toBeDefined();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Ignoring .*stream|Ignoring .*EPIPE/),
        expect.objectContaining({ code }),
      );
    } finally {
      onSpy.mockRestore();
      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});

describe('recoverStaleDevSessionSetups', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateWhere.mockImplementation(() => ({ returning: mockUpdateReturning }));
  });

  it('fails abandoned setting_up sessions after the bounded setup window', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'stale-session',
        status: 'setting_up',
        updatedAt: '2026-07-14T13:40:00.000Z',
      },
      {
        id: 'live-session',
        status: 'setting_up',
        updatedAt: '2026-07-14T13:55:00.000Z',
      },
    ]);

    const recovered = await recoverStaleDevSessionSetups({
      now: () => Date.parse('2026-07-14T14:00:00.000Z'),
      setupTimeoutMs: 15 * 60_000,
    });

    expect(recovered).toBe(1);
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        setupError: expect.stringMatching(/setup timed out/i),
        setupPhase: 'dependencies_failed',
        setupDetail: expect.stringMatching(/setup timed out/i),
        setupProgressAt: '2026-07-14T14:00:00.000Z',
        updatedAt: '2026-07-14T14:00:00.000Z',
      })
    );
  });

  it('does not fail a recently updated setup', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'live-session',
        status: 'setting_up',
        updatedAt: '2026-07-14T13:59:00.000Z',
      },
    ]);

    const recovered = await recoverStaleDevSessionSetups({
      now: () => Date.parse('2026-07-14T14:00:00.000Z'),
      setupTimeoutMs: 15 * 60_000,
    });

    expect(recovered).toBe(0);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });
});

describe('TBI-001 DoD-2 / VT-05 graceful owner finalization', () => {
  it('finalizes only this instance non-terminal runs and persists terminal events', async () => {
    mockAgentRunsFindMany.mockResolvedValue([
      { id: 'run-owned', threadId: 'thread-owned' },
    ]);
    jest.mocked(finalizeOwnedAgentRun).mockResolvedValue(true);

    const finalized = await finalizeOwnedRunsForShutdown({
      ownerInstance: 'worker-a',
      now: () => Date.parse('2026-08-04T12:00:00.000Z'),
    });

    expect(finalized).toBe(1);
    expect(finalizeOwnedAgentRun).toHaveBeenCalledTimes(1);
    expect(finalizeOwnedAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-owned',
        threadId: 'thread-owned',
        ownerInstance: 'worker-a',
        status: 'failed',
        detail: expect.stringMatching(/shutdown/i),
      }),
    );
  });

  it('leaves owner-mismatched runs untouched when the CAS loses', async () => {
    mockAgentRunsFindMany.mockResolvedValue([
      { id: 'run-raced', threadId: 'thread-raced' },
    ]);
    jest.mocked(finalizeOwnedAgentRun).mockResolvedValue(false);

    await expect(finalizeOwnedRunsForShutdown({
      ownerInstance: 'worker-a',
    })).resolves.toBe(0);
  });
});

describe('recoverStuckInterviewThreads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('leaves live interview runs alone', async () => {
    mockedFindRunning.mockResolvedValue([
      { threadId: 't1', interviewId: 'i1', activeRunId: 'run-1' },
    ]);
    mockedIsAlive.mockResolvedValue(true);

    const recovered = await recoverStuckInterviewThreads();

    expect(recovered).toBe(0);
    expect(mockedHydrate).not.toHaveBeenCalled();
    expect(mockedClearStale).not.toHaveBeenCalled();
  });

  it('resets interviews with no live agent run', async () => {
    mockedFindRunning.mockResolvedValue([
      { threadId: 't1', interviewId: 'i1', activeRunId: 'run-1' },
    ]);
    mockedIsAlive.mockResolvedValue(false);
    mockedHydrate.mockResolvedValue(true);
    mockedClearStale.mockResolvedValue(undefined);

    const recovered = await recoverStuckInterviewThreads();

    expect(recovered).toBe(1);
    expect(mockedHydrate).toHaveBeenCalledWith('t1');
    expect(mockedReevaluateGrounding).toHaveBeenCalledWith('t1');
    expect(mockedClearStale).toHaveBeenCalledWith('t1');
  });
});
