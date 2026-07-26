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
  sendMessage: jest.fn(),
}));
jest.mock('../services/prdService', () => ({
  startPrdWatcher: jest.fn(),
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

import { recoverStaleDevSessionSetups, recoverStuckInterviewThreads } from '../services/startupRecovery';
import { findRunningInterviewThreads, clearStaleRun } from '../services/chatThreadRepository';
import { hydrateThread } from '../services/chatAgentService';
import { isThreadRunAlive } from '../services/agentRunReaperService';

const mockedFindRunning = findRunningInterviewThreads as jest.MockedFunction<typeof findRunningInterviewThreads>;
const mockedClearStale = clearStaleRun as jest.MockedFunction<typeof clearStaleRun>;
const mockedHydrate = hydrateThread as jest.MockedFunction<typeof hydrateThread>;
const mockedIsAlive = isThreadRunAlive as jest.MockedFunction<typeof isThreadRunAlive>;

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
    expect(mockedClearStale).toHaveBeenCalledWith('t1');
  });
});
