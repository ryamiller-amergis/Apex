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
        chatThreads: { findFirst: jest.fn() },
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
  updateThreadKickoffContext: jest.fn(),
}));

jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn(),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn().mockResolvedValue('default-model'),
}));

jest.mock('../services/prdService', () => ({
  arePrdValidationArtifactsReady: jest.fn().mockResolvedValue(false),
  autoStartPrdValidation: jest.fn().mockResolvedValue(undefined),
}));

import {
  getTestCases,
  listLatestTestCaseSummariesForPrds,
  readOutputTestCases,
  readOutputTestCasesMd,
  syncTestCaseOutput,
  triggerTestCaseGeneration,
} from '../services/testCaseService';

const { db: mockDb, __mockUpdateChains: mockUpdateChains } = jest.requireMock('../db/drizzle') as {
  db: any;
  __mockUpdateChains: Array<{ set: jest.Mock; where: jest.Mock }>;
};

const {
  createThread: mockCreateThread,
  sendMessage: mockSendMessage,
  updateThreadKickoffContext: mockUpdateThreadKickoffContext,
} = jest.requireMock('../services/chatAgentService') as {
  createThread: jest.Mock;
  sendMessage: jest.Mock;
  updateThreadKickoffContext: jest.Mock;
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

  describe('triggerTestCaseGeneration', () => {
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

    it('creates a generation thread and writes kickoff files when a test-case skill is configured', async () => {
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
});
