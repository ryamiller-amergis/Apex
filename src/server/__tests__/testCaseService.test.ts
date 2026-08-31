import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../db/drizzle', () => {
  const mockUpdateChains: Array<{ set: jest.Mock; where: jest.Mock }> = [];
  const makeUpdateChain = () => {
    const chain = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    };
    mockUpdateChains.push(chain);
    return chain;
  };

  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 'tc-new' }]),
  });

  return {
    __mockUpdateChains: mockUpdateChains,
    db: {
      query: {
        agentRuns: { findFirst: jest.fn().mockResolvedValue(null) },
        chatThreads: { findFirst: jest.fn() },
        interviews: { findFirst: jest.fn() },
        prds: { findFirst: jest.fn() },
        testCases: { findFirst: jest.fn() },
      },
      update: jest.fn().mockImplementation(makeUpdateChain),
      insert: jest.fn().mockImplementation(makeInsertChain),
      select: jest.fn(),
    },
  };
});

jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn().mockResolvedValue({ id: 'thread-tc', workspaceDir: '' }),
  isThreadIdle: jest.fn().mockReturnValue(false),
  sendMessage: jest.fn().mockResolvedValue(undefined),
  prepareBackgroundWorkflowTurn: jest.fn().mockResolvedValue({
    prompt: 'complete frozen test-case prompt',
    model: 'gpt-5.5-test',
    skillPath: '.cursor/skills/test-cases/SKILL.md',
    projectId: 'proj-alpha',
    threadWorkspacePath: '/tmp/thread-tc',
  }),
  updateThreadKickoffContext: jest.fn(),
}));

jest.mock('../services/agentRunReaperService', () => ({
  isThreadRunAlive: jest.fn().mockResolvedValue(false),
  canThisInstanceFailGeneration: jest.fn().mockResolvedValue(true),
}));

jest.mock('../services/backgroundWorkflowRouter', () => ({
  routeBackgroundWorkflow: jest.fn().mockImplementation(async (input: { runInProcess(): void }) => {
    await input.runInProcess();
    return { route: 'in-process', reason: 'flag-disabled' };
  }),
}));

jest.mock('../services/runGroundingService', () => ({
  propagatePipelineGrounding: jest.fn().mockResolvedValue({ state: 'propagated' }),
  runGroundingService: {
    getGroundings: jest.fn().mockResolvedValue([{
      id: 'grounding-tc',
      runType: 'chat',
      runId: 'thread-tc',
      project: 'proj-alpha',
      repoRole: 'target',
      provider: 'github',
      repository: 'org/repo',
      branch: 'main',
      groundedSha: 'abc123',
      groundedAt: '2026-08-06T00:00:00.000Z',
      isActive: true,
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
    }]),
    persistThenMarkTerminalInactive: jest.fn().mockImplementation(
      async (_run: unknown, persist: () => Promise<unknown>) => persist(),
    ),
  },
}));

jest.mock('../services/projectSettingsService', () => {
  const getSkillConfig = jest.fn();
  return {
    getSkillConfig,
    resolveSkillConfig: jest.fn().mockImplementation((opts: { project: string }) => getSkillConfig(opts.project)),
    getSkillSettingsName: jest.fn().mockResolvedValue(null),
  };
});

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn().mockResolvedValue('default-model'),
}));

jest.mock('../services/prdService', () => ({
  arePrdValidationArtifactsReady: jest.fn().mockResolvedValue(false),
  autoStartPrdValidation: jest.fn().mockResolvedValue(undefined),
}));

import {
  getTestCases,
  isTestCaseWatcherActive,
  listLatestTestCaseSummariesForPrds,
  readOutputTestCases,
  readOutputTestCasesMd,
  startTestCaseWatcher,
  syncTestCaseOutput,
  triggerTestCaseGeneration,
  extractUncoveredCoverageItems,
  failGeneratingTestCasesForThread,
} from '../services/testCaseService';

const { db: mockDb, __mockUpdateChains: mockUpdateChains } = jest.requireMock('../db/drizzle') as {
  db: any;
  __mockUpdateChains: Array<{ set: jest.Mock; where: jest.Mock }>;
};

const {
  createThread: mockCreateThread,
  sendMessage: mockSendMessage,
  prepareBackgroundWorkflowTurn: mockPrepareBackgroundWorkflowTurn,
  updateThreadKickoffContext: mockUpdateThreadKickoffContext,
  isThreadIdle: mockIsThreadIdle,
} = jest.requireMock('../services/chatAgentService') as {
  createThread: jest.Mock;
  sendMessage: jest.Mock;
  prepareBackgroundWorkflowTurn: jest.Mock;
  updateThreadKickoffContext: jest.Mock;
  isThreadIdle: jest.Mock;
};

const {
  isThreadRunAlive: mockIsThreadRunAlive,
  canThisInstanceFailGeneration: mockCanThisInstanceFailGeneration,
} = jest.requireMock('../services/agentRunReaperService') as {
  isThreadRunAlive: jest.Mock;
  canThisInstanceFailGeneration: jest.Mock;
};

const { routeBackgroundWorkflow: mockRouteBackgroundWorkflow } = jest.requireMock(
  '../services/backgroundWorkflowRouter',
) as { routeBackgroundWorkflow: jest.Mock };
const { propagatePipelineGrounding: mockPropagatePipelineGrounding } = jest.requireMock(
  '../services/runGroundingService',
) as { propagatePipelineGrounding: jest.Mock };
const { runGroundingService: mockRunGroundingService } = jest.requireMock(
  '../services/runGroundingService',
) as {
  runGroundingService: {
    getGroundings: jest.Mock;
    persistThenMarkTerminalInactive: jest.Mock;
  };
};

const { getSkillConfig: mockGetSkillConfig } = jest.requireMock('../services/projectSettingsService') as {
  getSkillConfig: jest.Mock;
};

function makeSelectForGet(rows: unknown[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  return { from };
}

function makeSelectForList(rows: unknown[]) {
  const orderBy = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  return { from };
}

describe('testCaseService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateChains.length = 0;
  });

  describe('getTestCases', () => {
    it('returns the latest test-case record for a PRD', async () => {
      mockDb.select.mockReturnValue(
        makeSelectForGet([
          {
            id: 'tc-1',
            prdId: 'prd-1',
            chatThreadId: 'thread-tc',
            status: 'ready',
            testCasesJson: { suites: [] },
            testCasesMd: '# Test Cases',
            coverageSummary: { totalCases: 2, pbisCovered: 1, acCovered: '2/2', brCovered: '1/1', gaps: 0 },
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
          },
        ]),
      );

      const result = await getTestCases('prd-1');

      expect(result).toEqual({
        id: 'tc-1',
        prdId: 'prd-1',
        chatThreadId: 'thread-tc',
        status: 'ready',
        testCasesJson: { suites: [] },
        testCasesMd: '# Test Cases',
        coverageSummary: { totalCases: 2, pbisCovered: 1, acCovered: '2/2', brCovered: '1/1', gaps: 0 },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      });
    });
  });

  describe('listLatestTestCaseSummariesForPrds', () => {
    it('returns the newest test case per PRD from descending rows', async () => {
      mockDb.select.mockReturnValue(
        makeSelectForList([
          {
            id: 'tc-new',
            prdId: 'prd-1',
            chatThreadId: 'thread-new',
            status: 'ready',
            coverageSummary: { totalCases: 3, pbisCovered: 1, acCovered: '3/3', brCovered: '1/1', gaps: 0 },
            createdAt: '2026-01-02T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
          },
          {
            id: 'tc-old',
            prdId: 'prd-1',
            chatThreadId: 'thread-old',
            status: 'failed',
            coverageSummary: null,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          {
            id: 'tc-other',
            prdId: 'prd-2',
            chatThreadId: null,
            status: 'generating',
            coverageSummary: null,
            createdAt: '2026-01-02T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
          },
        ]),
      );

      const result = await listLatestTestCaseSummariesForPrds(['prd-1', 'prd-1', 'prd-2']);

      expect(result.get('prd-1')).toMatchObject({ id: 'tc-new', status: 'ready' });
      expect(result.get('prd-2')).toMatchObject({ id: 'tc-other', status: 'generating' });
      expect(result.size).toBe(2);
    });

    it('does not query the database when no PRD IDs are provided', async () => {
      const result = await listLatestTestCaseSummariesForPrds([]);

      expect(result.size).toBe(0);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('failGeneratingTestCasesForThread', () => {
    it('marks the generating row failed for that thread', async () => {
      mockDb.query.testCases.findFirst.mockResolvedValue({
        id: 'tc-1',
        prdId: 'prd-1',
        chatThreadId: 'thread-tc',
      });
      mockDb.query.prds.findFirst.mockResolvedValue({ chatThreadId: 'prd-thread' });
      mockDb.query.chatThreads.findFirst.mockResolvedValue(null);

      await failGeneratingTestCasesForThread('thread-tc');

      expect(mockUpdateChains[0].set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('is a no-op when no generating row exists', async () => {
      mockDb.query.testCases.findFirst.mockResolvedValue(null);

      await failGeneratingTestCasesForThread('thread-tc');

      expect(mockUpdateChains).toHaveLength(0);
    });
  });

  describe('startTestCaseWatcher', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      mockDb.query.testCases.findFirst.mockResolvedValue({
        id: 'tc-1',
        prdId: 'prd-1',
        chatThreadId: 'thread-tc',
        status: 'generating',
      });
      // No workspace dir resolves, so no output file is ever found.
      mockDb.query.chatThreads.findFirst.mockResolvedValue(null);
      mockDb.query.prds.findFirst.mockResolvedValue(null);
      mockIsThreadIdle.mockReturnValue(true);
      mockIsThreadRunAlive.mockResolvedValue(false);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    const tick = async (): Promise<void> => {
      jest.advanceTimersByTime(5_000);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    it('keeps polling while the generation run has not been enqueued yet', async () => {
      // The recovery sweep starts a watcher while triggerTestCaseGeneration is
      // still routing: thread idle, no agent_runs row at all.
      mockCanThisInstanceFailGeneration.mockResolvedValue(false);

      startTestCaseWatcher('tc-1', 'thread-tc');
      await tick();
      await tick();

      expect(mockUpdateChains).toHaveLength(0);
      expect(isTestCaseWatcherActive('tc-1')).toBe(true);

      mockDb.query.testCases.findFirst.mockResolvedValue(null);
      await tick();
    });

    it('marks failed once a terminal run confirms the agent produced no output', async () => {
      mockCanThisInstanceFailGeneration.mockResolvedValue(true);

      startTestCaseWatcher('tc-1', 'thread-tc');
      await tick();

      expect(mockUpdateChains[0].set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
      expect(isTestCaseWatcherActive('tc-1')).toBe(false);
    });
  });

  describe('triggerTestCaseGeneration', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('skips generation when test cases are disabled for the interview', async () => {
      mockDb.query.prds.findFirst.mockResolvedValue({
        id: 'prd-1',
        interviewId: 'interview-1',
        project: 'proj-alpha',
        title: 'Feature PRD',
      });
      mockDb.query.interviews.findFirst.mockResolvedValue({ testCasesEnabled: false });

      await expect(triggerTestCaseGeneration('prd-1', 'source-thread')).resolves.toBe(false);

      expect(mockDb.query.testCases.findFirst).not.toHaveBeenCalled();
      expect(mockGetSkillConfig).not.toHaveBeenCalled();
      expect(mockCreateThread).not.toHaveBeenCalled();
    });

    it('skips generation when the PRD project has no test-case skill configured', async () => {
      mockDb.query.prds.findFirst.mockResolvedValue({
        id: 'prd-1',
        project: 'proj-alpha',
        title: 'Feature PRD',
      });
      mockDb.query.testCases.findFirst.mockResolvedValue(null);
      mockGetSkillConfig.mockResolvedValue({ skillRepo: 'org/skills', skillBranch: 'main' });

      await expect(triggerTestCaseGeneration('prd-1', 'source-thread')).resolves.toBe(false);

      expect(mockCreateThread).not.toHaveBeenCalled();
    });

    it('AC-3 / DoD-1 creates files and runs disabled fallback without worker preparation', async () => {
      jest.useFakeTimers();
      const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pilot-test-cases-'));
      mockCreateThread.mockResolvedValue({ id: 'thread-tc', workspaceDir });
      mockDb.query.prds.findFirst.mockResolvedValue({
        id: 'prd-1',
        project: 'proj-alpha',
        authorId: 'user-1',
        title: 'Feature PRD',
        content: '# PRD',
        backlogJson: { items: [{ id: 'PBI-1' }] },
      });
      mockDb.query.testCases.findFirst.mockResolvedValue(null);
      mockGetSkillConfig.mockResolvedValue({
        skillRepo: 'org/skills',
        skillBranch: 'main',
        testCaseSkillPath: '.cursor/skills/test-cases/SKILL.md',
        testCaseModel: 'gpt-5.5-test',
      });

      try {
        await expect(triggerTestCaseGeneration('prd-1', 'source-thread')).resolves.toBe(true);

        expect(mockCreateThread).toHaveBeenCalledWith(
          'user-1',
          expect.objectContaining({
            project: 'proj-alpha',
            skillPath: '.cursor/skills/test-cases/SKILL.md',
            model: 'gpt-5.5-test',
          }),
          { skipAutoKickoff: true },
        );
        expect(mockUpdateThreadKickoffContext).toHaveBeenCalledWith(
          'thread-tc',
          expect.stringContaining('# Test Case Generation Context'),
        );
        expect(fs.existsSync(path.join(workspaceDir, '.ai-pilot', 'output', 'feature-prd.prd.md'))).toBe(true);
        expect(fs.existsSync(path.join(workspaceDir, '.ai-pilot', 'output', 'feature-prd.backlog.json'))).toBe(true);
        expect(mockSendMessage).toHaveBeenCalledWith(
          'thread-tc',
          expect.stringContaining('Generate QA test cases'),
          undefined,
          [],
          { hidden: true },
        );
        expect(mockRouteBackgroundWorkflow).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'user-1',
            workflowClass: 'test-cases',
            threadId: 'thread-tc',
            prepareWorker: expect.any(Function),
            destinationRun: {
              runType: 'chat',
              runId: 'thread-tc',
              project: 'proj-alpha',
            },
          }),
        );
        expect(mockPrepareBackgroundWorkflowTurn).not.toHaveBeenCalled();
        expect(mockRunGroundingService.getGroundings).not.toHaveBeenCalled();
        expect(mockPropagatePipelineGrounding).not.toHaveBeenCalled();
        expect(isTestCaseWatcherActive('tc-new')).toBe(true);

        // Drain the watcher started by triggerTestCaseGeneration so it cannot
        // keep polling after this test file moves on to other mocks.
        mockDb.query.testCases.findFirst.mockResolvedValue(null);
        jest.advanceTimersByTime(5_000);
        for (let i = 0; i < 10; i++) await Promise.resolve();
      } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    });

    it('AC-0: worker test-case decision preserves watcher and does not call sendMessage', async () => {
      jest.useFakeTimers();
      const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pilot-test-cases-worker-'));
      mockCreateThread.mockResolvedValue({ id: 'thread-tc', workspaceDir });
      mockDb.query.prds.findFirst.mockResolvedValue({
        id: 'prd-1',
        project: 'proj-alpha',
        authorId: 'user-1',
        title: 'Feature PRD',
        content: '# PRD',
        backlogJson: {},
      });
      mockDb.query.testCases.findFirst.mockResolvedValue(null);
      mockGetSkillConfig.mockResolvedValue({
        skillRepo: 'org/skills',
        testCaseSkillPath: '.cursor/skills/test-cases/SKILL.md',
      });
      mockRouteBackgroundWorkflow.mockImplementationOnce(async (input) => {
        const prepared = await input.prepareWorker();
        expect(prepared).toEqual(expect.objectContaining({
          prompt: 'complete frozen test-case prompt',
          targetGrounding: expect.objectContaining({
            repoRole: 'target',
            isActive: true,
          }),
        }));
        return {
          route: 'worker',
          workspacePath: '/pinned',
          runId: 'thread-tc',
        };
      });

      try {
        await expect(
          triggerTestCaseGeneration('prd-1', 'source-thread'),
        ).resolves.toBe(true);

        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(mockRouteBackgroundWorkflow).toHaveBeenCalledWith(
          expect.objectContaining({ workflowClass: 'test-cases' }),
        );
        expect(mockPropagatePipelineGrounding).toHaveBeenCalledWith(
          { runType: 'chat', runId: 'source-thread', project: 'proj-alpha' },
          { runType: 'chat', runId: 'thread-tc', project: 'proj-alpha' },
          'user-1',
          { deferMaterialization: true },
        );
        expect(isTestCaseWatcherActive('tc-new')).toBe(true);

        mockDb.query.testCases.findFirst.mockResolvedValue(null);
        jest.advanceTimersByTime(5_000);
        for (let i = 0; i < 10; i++) await Promise.resolve();
      } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    });

    it('cold external project: preparation failure starts in-process fallback and watcher', async () => {
      jest.useFakeTimers();
      const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pilot-test-cases-recover-'));
      mockCreateThread.mockResolvedValue({ id: 'thread-tc', workspaceDir });
      mockDb.query.prds.findFirst.mockResolvedValue({
        id: 'prd-1',
        project: 'proj-alpha',
        authorId: 'user-1',
        title: 'Feature PRD',
        content: '# PRD',
        backlogJson: {},
      });
      mockDb.query.testCases.findFirst.mockResolvedValue(null);
      mockGetSkillConfig.mockResolvedValue({
        skillRepo: 'org/skills',
        testCaseSkillPath: '.cursor/skills/test-cases/SKILL.md',
      });
      mockRouteBackgroundWorkflow.mockImplementationOnce(
        async (input: { runInProcess(): Promise<void> }) => {
          await input.runInProcess();
          return {
            route: 'in-process',
            reason: 'materialization-unavailable',
            fallbackStarted: true,
          };
        },
      );

      try {
        await triggerTestCaseGeneration('prd-1', 'source-thread');

        expect(mockUpdateChains.some(
          (chain) => chain.set.mock.calls.some(
            ([payload]) => payload.status === 'failed',
          ),
        )).toBe(false);
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        expect(isTestCaseWatcherActive('tc-new')).toBe(true);

        mockDb.query.testCases.findFirst.mockResolvedValue(null);
        jest.advanceTimersByTime(5_000);
        for (let i = 0; i < 10; i++) await Promise.resolve();
      } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    });

    it('marks test-case failed only after preparation and in-process fallback both fail', async () => {
      jest.useFakeTimers();
      const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pilot-test-cases-recover-'));
      mockCreateThread.mockResolvedValue({ id: 'thread-tc', workspaceDir });
      mockDb.query.prds.findFirst.mockResolvedValue({
        id: 'prd-1',
        project: 'proj-alpha',
        authorId: 'user-1',
        title: 'Feature PRD',
        content: '# PRD',
        backlogJson: {},
      });
      mockDb.query.testCases.findFirst.mockResolvedValue(null);
      mockGetSkillConfig.mockResolvedValue({
        skillRepo: 'org/skills',
        testCaseSkillPath: '.cursor/skills/test-cases/SKILL.md',
      });
      const deactivated = jest.fn();
      mockRunGroundingService.persistThenMarkTerminalInactive.mockImplementationOnce(
        async (_run, persist) => {
          await persist();
          deactivated();
        },
      );
      mockSendMessage.mockRejectedValueOnce(new Error('in-process unavailable'));
      mockRouteBackgroundWorkflow.mockImplementationOnce(
        async (input: {
          runInProcess(): Promise<void>;
          reportRecoverablePreparationFailure(): Promise<void>;
        }) => {
          try {
            await input.runInProcess();
          } catch {
            await input.reportRecoverablePreparationFailure();
          }
          return {
            route: 'in-process',
            reason: 'materialization-unavailable',
            fallbackStarted: true,
          };
        },
      );

      try {
        await triggerTestCaseGeneration('prd-1', 'source-thread');

        expect(mockUpdateChains.some(
          (chain) => chain.set.mock.calls.some(
            ([payload]) => payload.status === 'failed',
          ),
        )).toBe(true);
        const failedUpdate = mockUpdateChains.find(
          (chain) => chain.set.mock.calls.some(
            ([payload]) => payload.status === 'failed',
          ),
        );
        expect(failedUpdate?.where.mock.invocationCallOrder[0])
          .toBeLessThan(deactivated.mock.invocationCallOrder[0]);
        expect(mockSendMessage).toHaveBeenCalledTimes(1);

        mockDb.query.testCases.findFirst.mockResolvedValue(null);
        jest.advanceTimersByTime(5_000);
        for (let i = 0; i < 10; i++) await Promise.resolve();
      } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    });
  });

  describe('syncTestCaseOutput', () => {
    it('syncs generated test cases, extracts coverage, and patches backlog test counts', async () => {
      const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pilot-test-cases-'));
      const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(
        path.join(outputDir, 'feature.test-cases.json'),
        JSON.stringify({
          suites: [
            {
              pbiId: 'PBI-1',
              testCases: [
                { testCaseId: 'TC-1', steps: ['Do the thing'], expectedResult: 'It works' },
                { testCaseId: 'TC-2', steps: ['Do another thing'], expectedResult: 'It still works' },
              ],
            },
          ],
          coverageMatrix: {
            acceptanceCriteria: [
              { pbiId: 'PBI-1', covered: true },
              { pbiId: 'PBI-1', covered: false },
            ],
            businessRules: [{ covered: true }],
            gaps: [{ id: 'gap-1' }],
          },
        }),
        'utf-8',
      );
      fs.writeFileSync(path.join(outputDir, 'feature.test-cases.md'), '# Test Cases', 'utf-8');
      fs.writeFileSync(
        path.join(outputDir, 'feature.backlog.json'),
        JSON.stringify({ items: [{ id: 'PBI-1', title: 'Feature work' }] }),
        'utf-8',
      );
      mockDb.query.chatThreads.findFirst.mockResolvedValue({ workspaceDir });
      mockDb.query.testCases.findFirst.mockResolvedValue({ chatThreadId: 'thread-tc', status: 'generating' });
      mockDb.query.prds.findFirst.mockResolvedValue({
        chatThreadId: 'source-thread',
        backlogJson: { items: [{ id: 'PBI-1', title: 'Feature work' }] },
      });

      const result = await syncTestCaseOutput('tc-1', 'prd-1', 'thread-tc');

      expect(result).toBe(true);
      expect(mockUpdateChains[0].set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ready',
          testCasesMd: '# Test Cases',
          coverageSummary: {
            totalCases: 2,
            pbisCovered: 1,
            acCovered: '1/2',
            brCovered: '1/1',
            gaps: 1,
          },
        }),
      );
      expect(mockUpdateChains[1].set).toHaveBeenCalledWith(
        expect.objectContaining({
          backlogJson: {
            items: [{ id: 'PBI-1', title: 'Feature work', testCaseCount: 2 }],
          },
        }),
      );
      expect(fs.existsSync(workspaceDir)).toBe(false);
    });
  });

  describe('readOutputTestCases — fallback workspace search', () => {
    it('DoD-4 reads worker artifacts from the frozen workspace override', async () => {
      const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pilot-tc-worker-read-'));
      const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
      fs.mkdirSync(outputDir, { recursive: true });
      const payload = { suites: [{ pbiId: 'PBI-1', testCases: [{ id: 'TC-1' }] }] };
      fs.writeFileSync(
        path.join(outputDir, 'worker.test-cases.json'),
        JSON.stringify(payload),
        'utf-8',
      );
      mockDb.query.chatThreads.findFirst.mockResolvedValue({
        workspaceDir: 'C:\\stale-web-tier-workspace',
      });

      try {
        await expect(
          readOutputTestCases('thread-worker', workspaceDir),
        ).resolves.toEqual(payload);
        expect(mockDb.query.chatThreads.findFirst).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    });

    it('finds test-cases JSON in the standard output dir', async () => {
      const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pilot-tc-read-'));
      const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
      fs.mkdirSync(outputDir, { recursive: true });
      const payload = { suites: [{ pbiId: 'PBI-1', testCases: [] }] };
      fs.writeFileSync(path.join(outputDir, 'slug.test-cases.json'), JSON.stringify(payload), 'utf-8');
      mockDb.query.chatThreads.findFirst.mockResolvedValue({ workspaceDir });

      try {
        const result = await readOutputTestCases('thread-1');
        expect(result).toEqual(payload);
      } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    });

    it('falls back to workspace-wide search when file is outside output dir', async () => {
      const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pilot-tc-fallback-'));
      const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
      fs.mkdirSync(outputDir, { recursive: true });

      // Write the file to .ai-pilot/ instead of .ai-pilot/output/
      const payload = { suites: [{ pbiId: 'PBI-2', testCases: [{ id: 'TC-1' }] }] };
      fs.writeFileSync(
        path.join(workspaceDir, '.ai-pilot', 'slug.test-cases.json'),
        JSON.stringify(payload),
        'utf-8',
      );
      mockDb.query.chatThreads.findFirst.mockResolvedValue({ workspaceDir });

      try {
        const result = await readOutputTestCases('thread-2');
        expect(result).toEqual(payload);
      } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    });

    it('returns null when no test-cases JSON exists anywhere in the workspace', async () => {
      const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pilot-tc-empty-'));
      const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
      fs.mkdirSync(outputDir, { recursive: true });
      mockDb.query.chatThreads.findFirst.mockResolvedValue({ workspaceDir });

      try {
        const result = await readOutputTestCases('thread-3');
        expect(result).toBeNull();
      } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    });
  });

  describe('readOutputTestCasesMd — fallback workspace search', () => {
    it('falls back to workspace-wide search when md file is outside output dir', async () => {
      const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pilot-tc-md-'));
      const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
      fs.mkdirSync(outputDir, { recursive: true });

      fs.writeFileSync(
        path.join(workspaceDir, '.ai-pilot', 'slug.test-cases.md'),
        '# Fallback Test Cases',
        'utf-8',
      );
      mockDb.query.chatThreads.findFirst.mockResolvedValue({ workspaceDir });

      try {
        const result = await readOutputTestCasesMd('thread-4');
        expect(result).toBe('# Fallback Test Cases');
      } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    });
  });

  describe('extractUncoveredCoverageItems', () => {
    it('returns uncovered AC and BR entries from coverageMatrix', () => {
      const items = extractUncoveredCoverageItems({
        coverageMatrix: {
          acceptanceCriteria: [
            { pbiId: 'PBI-1', index: 0, text: 'Covered AC', covered: true },
            { pbiId: 'PBI-1', index: 1, text: 'Missing AC', covered: false },
          ],
          businessRules: [
            { id: 'BR-1', text: 'Covered BR', covered: true },
            { id: 'BR-2', text: 'Missing BR', covered: false },
          ],
        },
      });

      expect(items).toEqual([
        {
          kind: 'acceptance_criteria',
          pbiId: 'PBI-1',
          index: 1,
          text: 'Missing AC',
        },
        {
          kind: 'business_rule',
          id: 'BR-2',
          pbiId: undefined,
          text: 'Missing BR',
        },
      ]);
    });

    it('returns an empty array when there is no coverage matrix', () => {
      expect(extractUncoveredCoverageItems({ suites: [] })).toEqual([]);
    });
  });
});
