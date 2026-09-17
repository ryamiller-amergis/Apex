const mockFindMany = jest.fn();
const mockAgentRunsFindMany = jest.fn();
const mockPrdsFindMany = jest.fn();
const mockPrdsFindFirst = jest.fn();
const mockDesignDocsFindMany = jest.fn();
const mockTestCasesFindMany = jest.fn();
const mockAgentRunsFindFirst = jest.fn();
const mockUpdateReturning = jest.fn();
const mockUpdateWhere = jest.fn(() => ({ returning: mockUpdateReturning }));
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));
const mockWithRepoCacheLease = jest.fn();
const mockStopReaper = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      devSessions: { findMany: (...args: unknown[]) => mockFindMany(...args) },
      prds: {
        findMany: (...args: unknown[]) => mockPrdsFindMany(...args),
        findFirst: (...args: unknown[]) => mockPrdsFindFirst(...args),
      },
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
jest.mock('../services/repoCacheLeaseService', () => {
  class NonblockingRepoCacheLeaseUnavailableError extends Error {
    constructor(cacheKey: string) {
      super(`Nonblocking repository cache lease unavailable: ${cacheKey}`);
      this.name = 'NonblockingRepoCacheLeaseUnavailableError';
    }
  }

  class RepoCacheLeaseLostError extends Error {
    constructor(detail = 'Repository cache lease was lost') {
      super(detail);
      this.name = 'RepoCacheLeaseLostError';
    }
  }

  return {
    withRepoCacheLease: (...args: unknown[]) => mockWithRepoCacheLease(...args),
    NonblockingRepoCacheLeaseUnavailableError,
    RepoCacheLeaseLostError,
  };
});
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
  tryStartSingleFeatureDocWatcher: jest.fn(),
  startValidationWatcher: jest.fn(),
  isValidationWatcherActive: jest.fn(),
  isDocWatcherActive: jest.fn(),
  routeDesignDocGenerationKickoff: jest.fn(),
}));
jest.mock('../services/testCaseService', () => ({
  startTestCaseWatcher: jest.fn(),
  isTestCaseWatcherActive: jest.fn(),
  routeTestCaseGenerationKickoff: jest.fn(),
}));
jest.mock('../services/documentValidationService', () => ({
  routeDocumentValidationKickoff: jest.fn(),
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
  stopReaper: (...args: unknown[]) => mockStopReaper(...args),
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
  registerGracefulShutdown,
  registerProcessGuards,
  startRecoveryLoop,
  stopRecoveryLoop,
} from '../services/startupRecovery';
import { findRunningInterviewThreads, clearStaleRun } from '../services/chatThreadRepository';
import {
  hydrateThread,
  reevaluateThreadGroundingForRecovery,
  sendMessage,
} from '../services/chatAgentService';
import { isThreadRunAlive } from '../services/agentRunReaperService';
import { finalizeOwnedAgentRun } from '../services/pgNotifyService';
import {
  routeDesignDocGenerationKickoff,
  tryStartSingleFeatureDocWatcher,
  isDocWatcherActive,
} from '../services/designDocService';
import { routeDocumentValidationKickoff } from '../services/documentValidationService';
import { routeTestCaseGenerationKickoff } from '../services/testCaseService';
import {
  NonblockingRepoCacheLeaseUnavailableError,
  RepoCacheLeaseLostError,
} from '../services/repoCacheLeaseService';

const mockedFindRunning = findRunningInterviewThreads as jest.MockedFunction<typeof findRunningInterviewThreads>;
const mockedClearStale = clearStaleRun as jest.MockedFunction<typeof clearStaleRun>;
const mockedHydrate = hydrateThread as jest.MockedFunction<typeof hydrateThread>;
const mockedReevaluateGrounding = reevaluateThreadGroundingForRecovery as jest.MockedFunction<
  typeof reevaluateThreadGroundingForRecovery
>;
const mockedIsAlive = isThreadRunAlive as jest.MockedFunction<typeof isThreadRunAlive>;

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('startRecoveryLoop leader election', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockWithRepoCacheLease.mockResolvedValue(undefined);
    mockFindMany.mockResolvedValue([]);
    mockPrdsFindMany.mockResolvedValue([]);
    mockDesignDocsFindMany.mockResolvedValue([]);
    mockTestCasesFindMany.mockResolvedValue([]);
    mockedFindRunning.mockResolvedValue([]);
    jest.requireMock('../services/designPrototypeService')
      .failStalePrototypes.mockResolvedValue(0);
    jest.requireMock('../services/pdfAssemblyService')
      .expireOldSessions.mockResolvedValue({ expired: 0, errors: 0 });
    jest.requireMock('../services/featureRequestAnalysisService')
      .recoverAnalyzingFeatureRequests.mockResolvedValue(0);
  });

  afterEach(() => {
    stopRecoveryLoop();
    jest.useRealTimers();
  });

  it('routes immediate and periodic recovery cycles through the sweep lease', async () => {
    startRecoveryLoop();
    await flushAsyncWork();

    expect(mockWithRepoCacheLease).toHaveBeenCalledTimes(1);
    expect(mockWithRepoCacheLease).toHaveBeenNthCalledWith(
      1,
      'startup-recovery:sweep',
      expect.any(Function),
      {
        leaseMs: 55_000,
        heartbeatMs: 15_000,
        waitMs: 0,
        releaseOnComplete: false,
      },
    );

    await jest.advanceTimersByTimeAsync(60_000);
    await flushAsyncWork();

    expect(mockWithRepoCacheLease).toHaveBeenCalledTimes(2);
    expect(mockWithRepoCacheLease).toHaveBeenNthCalledWith(
      2,
      'startup-recovery:sweep',
      expect.any(Function),
      {
        leaseMs: 55_000,
        heartbeatMs: 15_000,
        waitMs: 0,
        releaseOnComplete: false,
      },
    );
  });

  it('skips quietly when another instance holds the sweep lease', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockWithRepoCacheLease.mockRejectedValueOnce(
      new NonblockingRepoCacheLeaseUnavailableError('startup-recovery:sweep'),
    );

    startRecoveryLoop();
    await flushAsyncWork();

    expect(mockWithRepoCacheLease).toHaveBeenCalledTimes(1);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('does not overlap local recovery cycles while one is still running', async () => {
    let resolveLease: (() => void) | null = null;
    mockWithRepoCacheLease.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveLease = resolve;
      }),
    );

    startRecoveryLoop();
    await flushAsyncWork();
    await jest.advanceTimersByTimeAsync(120_000);
    await flushAsyncWork();

    expect(mockWithRepoCacheLease).toHaveBeenCalledTimes(1);

    resolveLease?.();
    await flushAsyncWork();
    await jest.advanceTimersByTimeAsync(60_000);
    await flushAsyncWork();

    expect(mockWithRepoCacheLease).toHaveBeenCalledTimes(2);
  });

  it('logs unexpected failures and still allows the next cycle to run', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockWithRepoCacheLease
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    startRecoveryLoop();
    await flushAsyncWork();

    expect(consoleSpy).toHaveBeenCalledWith(
      '[recovery] Initial recovery failed:',
      expect.objectContaining({ message: 'boom' }),
    );

    await jest.advanceTimersByTimeAsync(60_000);
    await flushAsyncWork();

    expect(mockWithRepoCacheLease).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });

  it('clears scheduler state when stopped so a fresh start can run again', async () => {
    let resolveLease: (() => void) | null = null;
    mockWithRepoCacheLease.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveLease = resolve;
      }),
    );

    startRecoveryLoop();
    await flushAsyncWork();
    stopRecoveryLoop();

    mockWithRepoCacheLease.mockResolvedValueOnce(undefined);
    startRecoveryLoop();
    await flushAsyncWork();

    expect(mockWithRepoCacheLease).toHaveBeenCalledTimes(1);

    resolveLease?.();
    await flushAsyncWork();
    await jest.advanceTimersByTimeAsync(60_000);
    await flushAsyncWork();

    expect(mockWithRepoCacheLease).toHaveBeenCalledTimes(2);
  });

  it('runs recovery work exactly once when the lease holder callback executes', async () => {
    mockWithRepoCacheLease.mockImplementationOnce(async (_cacheKey, operation) => {
      await operation({
        signal: new AbortController().signal,
        assertOwned: jest.fn().mockResolvedValue(undefined),
      });
    });

    startRecoveryLoop();
    await flushAsyncWork();

    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(mockDesignDocsFindMany).toHaveBeenCalled();
  });
});

describe('recovery cooperative aborts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindMany.mockReset();
    mockFindMany.mockResolvedValue([]);
    mockPrdsFindMany.mockReset();
    mockPrdsFindMany.mockResolvedValue([]);
    mockDesignDocsFindMany.mockReset();
    mockDesignDocsFindMany.mockResolvedValue([]);
    mockTestCasesFindMany.mockReset();
    mockTestCasesFindMany.mockResolvedValue([]);
    mockedFindRunning.mockReset();
    mockedFindRunning.mockResolvedValue([]);
    mockedHydrate.mockReset();
    mockedHydrate.mockResolvedValue(true);
    mockedIsAlive.mockReset();
    jest.mocked(routeDocumentValidationKickoff).mockResolvedValue(undefined);
    jest.requireMock('../services/designDocService')
      .isValidationWatcherActive.mockReturnValue(false);
    jest.requireMock('../services/prdService')
      .isPrdValidationWatcherActive.mockReturnValue(false);
    jest.requireMock('../services/prdService')
      .rehydratePrdValidationWatcher.mockResolvedValue(undefined);
    jest.requireMock('../services/designPrototypeService')
      .failStalePrototypes.mockResolvedValue(0);
    jest.requireMock('../services/pdfAssemblyService')
      .expireOldSessions.mockResolvedValue({ expired: 0, errors: 0 });
    jest.requireMock('../services/featureRequestAnalysisService')
      .recoverAnalyzingFeatureRequests.mockResolvedValue(0);
  });

  it('stops before the next recovery section after lease ownership is lost', async () => {
    const controller = new AbortController();
    mockFindMany.mockImplementationOnce(async () => {
      controller.abort(new RepoCacheLeaseLostError('Repository cache lease was lost'));
      return [];
    });

    await expect(
      recoverInFlightWork({ signal: controller.signal }),
    ).rejects.toBeInstanceOf(RepoCacheLeaseLostError);

    expect(mockPrdsFindMany).not.toHaveBeenCalled();
  });

  it('aborts after validation liveness for design docs before dispatching validation work', async () => {
    const controller = new AbortController();
    const mockIsThreadIdle = jest.requireMock('../services/chatAgentService')
      .isThreadIdle as jest.Mock;
    mockPrdsFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockDesignDocsFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'doc-1',
        validationThreadId: 'thread-validation',
        chatThreadId: 'thread-source',
        authorId: 'user-1',
        project: 'Apex',
      }]);
    mockedHydrate.mockResolvedValue(true);
    mockIsThreadIdle.mockReturnValue(true);
    mockedIsAlive.mockImplementationOnce(async () => {
      controller.abort(new RepoCacheLeaseLostError('Repository cache lease was lost'));
      return false;
    });

    await expect(
      recoverInFlightWork({ signal: controller.signal }),
    ).rejects.toBeInstanceOf(RepoCacheLeaseLostError);

    expect(jest.mocked(routeDocumentValidationKickoff)).not.toHaveBeenCalled();
  });

  it('aborts after validation liveness for PRDs before dispatching validation work', async () => {
    const controller = new AbortController();
    const mockIsThreadIdle = jest.requireMock('../services/chatAgentService')
      .isThreadIdle as jest.Mock;
    mockPrdsFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'prd-1',
        validationThreadId: 'thread-validation',
        chatThreadId: 'thread-source',
        authorId: 'user-1',
        project: 'Apex',
      }]);
    mockDesignDocsFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockedHydrate.mockResolvedValue(true);
    mockIsThreadIdle.mockReturnValue(true);
    mockedIsAlive.mockImplementation(async () => {
      controller.abort(new RepoCacheLeaseLostError('Repository cache lease was lost'));
      return false;
    });

    await expect(
      recoverInFlightWork({ signal: controller.signal }),
    ).rejects.toBeInstanceOf(RepoCacheLeaseLostError);

    expect(jest.mocked(routeDocumentValidationKickoff)).not.toHaveBeenCalled();
  });
});

describe('graceful shutdown scheduler stop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockWithRepoCacheLease.mockResolvedValue(undefined);
    mockFindMany.mockResolvedValue([]);
    mockPrdsFindMany.mockResolvedValue([]);
    mockDesignDocsFindMany.mockResolvedValue([]);
    mockTestCasesFindMany.mockResolvedValue([]);
    mockedFindRunning.mockResolvedValue([]);
    mockAgentRunsFindMany.mockImplementation(async () => []);
    jest.requireMock('../services/designPrototypeService')
      .failStalePrototypes.mockResolvedValue(0);
    jest.requireMock('../services/pdfAssemblyService')
      .expireOldSessions.mockResolvedValue({ expired: 0, errors: 0 });
    jest.requireMock('../services/featureRequestAnalysisService')
      .recoverAnalyzingFeatureRequests.mockResolvedValue(0);
  });

  afterEach(() => {
    stopRecoveryLoop();
    jest.useRealTimers();
  });

  it('stops both global schedulers before owned-run finalization', async () => {
    const events: string[] = [];
    let sigtermHandler: (() => void) | undefined;
    const onSpy = jest.spyOn(process, 'on').mockImplementation(
      ((event: string, handler: () => void) => {
        if (event === 'SIGTERM') {
          sigtermHandler = handler;
        }
        return process;
      }) as typeof process.on,
    );
    mockStopReaper.mockImplementation(() => {
      events.push('stopReaper');
    });
    mockAgentRunsFindMany.mockImplementation(async () => {
      events.push('finalizeRuns');
      return [];
    });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const server = {
      close: (callback: () => void) => callback(),
    } as unknown as import('http').Server;

    startRecoveryLoop();
    await flushAsyncWork();
    registerGracefulShutdown(server);
    sigtermHandler?.();
    await flushAsyncWork();
    await jest.advanceTimersByTimeAsync(60_000);
    await flushAsyncWork();

    expect(mockStopReaper).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['stopReaper', 'finalizeRuns']);
    expect(mockWithRepoCacheLease).toHaveBeenCalledTimes(1);

    onSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

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
  const tryStartDocWatcher = tryStartSingleFeatureDocWatcher as jest.MockedFunction<
    typeof tryStartSingleFeatureDocWatcher
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
    jest.requireMock('../services/pdfAssemblyService')
      .expireOldSessions.mockResolvedValue({ expired: 0, errors: 0 });
    jest.requireMock('../services/featureRequestAnalysisService')
      .recoverAnalyzingFeatureRequests.mockResolvedValue(0);
    routeDesignDoc.mockResolvedValue();
    tryStartDocWatcher.mockResolvedValue(true);
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

  it('leaves a watcher that is already running alone', async () => {
    // The sweep runs every 60s and a doc generates for far longer, so adopting
    // a live watcher tore one down and built another ~30 times per doc. That
    // churn is how two watchers came to read the same workspace mid-write.
    (isDocWatcherActive as jest.Mock).mockReturnValue(true);

    await recoverInFlightWork();

    expect(tryStartDocWatcher).not.toHaveBeenCalled();
  });

  it('adopts a doc whose watcher was lost with the process', async () => {
    (isDocWatcherActive as jest.Mock).mockReturnValue(false);
    // Lose the re-kick claim: this test is only about adopting the watcher.
    mockUpdateReturning.mockResolvedValue([]);

    await recoverInFlightWork();

    expect(tryStartDocWatcher).toHaveBeenCalledWith(
      'doc-1',
      'thread-design',
      'prd-1',
      'Apex',
    );
  });

  it('counts recovery only when the watcher lease is acquired and started', async () => {
    (isDocWatcherActive as jest.Mock).mockReturnValue(false);
    tryStartDocWatcher.mockResolvedValueOnce(false);
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await recoverInFlightWork();

    expect(tryStartDocWatcher).toHaveBeenCalledWith(
      'doc-1',
      'thread-design',
      'prd-1',
      'Apex',
    );
    expect(mockedHydrate).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalledWith(
      '[recovery] Restarted design doc watcher (designDocId=doc-1)',
    );
    expect(consoleSpy).not.toHaveBeenCalledWith('[recovery] Recovered 1 in-flight item(s)');
    consoleSpy.mockRestore();
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

describe('test-case generation recovery routing', () => {
  const routeTestCases = routeTestCaseGenerationKickoff as jest.MockedFunction<
    typeof routeTestCaseGenerationKickoff
  >;
  const mockSendMessage = sendMessage as jest.MockedFunction<typeof sendMessage>;
  const mockIsThreadIdle = jest.requireMock('../services/chatAgentService')
    .isThreadIdle as jest.Mock;
  const mockIsTestCaseWatcherActive = jest.requireMock('../services/testCaseService')
    .isTestCaseWatcherActive as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateWhere.mockImplementation(() => ({ returning: mockUpdateReturning }));
    mockFindMany.mockResolvedValue([]);
    mockPrdsFindMany.mockResolvedValue([]);
    mockDesignDocsFindMany.mockResolvedValue([]);
    mockAgentRunsFindFirst.mockResolvedValue(null);
    mockTestCasesFindMany.mockResolvedValue([{
      id: 'tc-1',
      prdId: 'prd-1',
      chatThreadId: 'thread-tc',
      updatedAt: '2026-08-11T05:00:00.000Z',
    }]);
    mockPrdsFindFirst.mockResolvedValue({
      authorId: 'user-1',
      project: 'Apex',
      chatThreadId: 'thread-prd',
    });
    mockedHydrate.mockResolvedValue(true);
    mockIsThreadIdle.mockReturnValue(true);
    mockedIsAlive.mockResolvedValue(false);
    mockIsTestCaseWatcherActive.mockReturnValue(false);
    mockedFindRunning.mockResolvedValue([]);
    jest.requireMock('../services/designPrototypeService')
      .failStalePrototypes.mockResolvedValue(0);
    jest.requireMock('../services/pdfAssemblyService')
      .expireOldSessions.mockResolvedValue({ expired: 0, errors: 0 });
    jest.requireMock('../services/featureRequestAnalysisService')
      .recoverAnalyzingFeatureRequests.mockResolvedValue(0);
    routeTestCases.mockResolvedValue(true);
  });

  it('re-kicks a stale test-case row through the background worker, not sendMessage', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ id: 'tc-1' }]);
    const nowSpy = jest.spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-08-11T05:16:37.000Z'));
    try {
      await recoverInFlightWork();
    } finally {
      nowSpy.mockRestore();
    }

    expect(routeTestCases).toHaveBeenCalledWith(expect.objectContaining({
      testCaseId: 'tc-1',
      prdId: 'prd-1',
      userId: 'user-1',
      project: 'Apex',
      threadId: 'thread-tc',
      sourceThreadId: 'thread-prd',
    }));
    expect(mockSendMessage).not.toHaveBeenCalled();
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
