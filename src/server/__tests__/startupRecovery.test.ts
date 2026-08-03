const mockFindMany = jest.fn();
const mockUpdateWhere = jest.fn();
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      devSessions: { findMany: (...args: unknown[]) => mockFindMany(...args) },
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
}));
jest.mock('../services/designDocService', () => ({
  startSingleFeatureDocWatcher: jest.fn(),
  startValidationWatcher: jest.fn(),
  isValidationWatcherActive: jest.fn(),
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
jest.mock('../services/pdfAssemblyService', () => ({
  expireOldSessions: jest.fn(),
}));
jest.mock('../services/featureRequestAnalysisService', () => ({
  recoverAnalyzingFeatureRequests: jest.fn(),
}));
jest.mock('../services/agentRunReaperService', () => ({
  isThreadRunAlive: jest.fn(),
}));

import {
  recoverStaleDevSessionSetups,
  recoverStuckInterviewThreads,
  registerProcessGuards,
} from '../services/startupRecovery';
import { findRunningInterviewThreads, clearStaleRun } from '../services/chatThreadRepository';
import {
  hydrateThread,
  reevaluateThreadGroundingForRecovery,
} from '../services/chatAgentService';
import { isThreadRunAlive } from '../services/agentRunReaperService';

const mockedFindRunning = findRunningInterviewThreads as jest.MockedFunction<typeof findRunningInterviewThreads>;
const mockedClearStale = clearStaleRun as jest.MockedFunction<typeof clearStaleRun>;
const mockedHydrate = hydrateThread as jest.MockedFunction<typeof hydrateThread>;
const mockedReevaluateGrounding = reevaluateThreadGroundingForRecovery as jest.MockedFunction<
  typeof reevaluateThreadGroundingForRecovery
>;
const mockedIsAlive = isThreadRunAlive as jest.MockedFunction<typeof isThreadRunAlive>;

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
    mockUpdateWhere.mockResolvedValue(undefined);
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
