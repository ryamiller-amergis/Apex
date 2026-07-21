/**
 * Unit tests for addTestCaseToPrd — adding a REAL test case (with steps) to a PRD.
 * The Drizzle `db` instance and heavy service deps are fully mocked.
 */

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

  const mockInsertChains: Array<{ values: jest.Mock; returning: jest.Mock }> = [];
  const makeInsertChain = () => {
    const chain = {
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'tc-new' }]),
    };
    mockInsertChains.push(chain);
    return chain;
  };

  return {
    __mockUpdateChains: mockUpdateChains,
    __mockInsertChains: mockInsertChains,
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
  addTestCaseToPrd,
  recalculateTestCaseCoverage,
} from '../services/testCaseService';

const {
  db: mockDb,
  __mockUpdateChains: mockUpdateChains,
  __mockInsertChains: mockInsertChains,
} = jest.requireMock('../db/drizzle') as {
  db: any;
  __mockUpdateChains: Array<{ set: jest.Mock; where: jest.Mock }>;
  __mockInsertChains: Array<{ values: jest.Mock; returning: jest.Mock }>;
};

function makeSelectForGet(rows: unknown[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  return { from };
}

describe('addTestCaseToPrd', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateChains.length = 0;
    mockInsertChains.length = 0;
  });

  it('appends a properly-shaped test case to the matching suite with traceability', async () => {
    mockDb.select.mockReturnValue(
      makeSelectForGet([
        {
          id: 'tc-1',
          prdId: 'prd-1',
          chatThreadId: 'thread-tc',
          status: 'ready',
          testCasesJson: {
            suites: [
              {
                pbiId: 'PBI-1',
                testCases: [
                  { id: 'PBI-1-TC-1', title: 'Existing case', steps: [{ order: 1, action: 'Do' }] },
                ],
              },
            ],
          },
          testCasesMd: null,
          coverageSummary: { totalCases: 1, pbisCovered: 1, acCovered: '1/1', brCovered: '0/0', gaps: 0 },
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]),
    );
    mockDb.query.prds.findFirst.mockResolvedValue({
      backlogJson: { items: [{ id: 'PBI-1', title: 'Feature work' }] },
    });

    const result = await addTestCaseToPrd({
      prdId: 'prd-1',
      pbiId: 'PBI-1',
      title: 'New login test',
      steps: ['Open login page', 'Submit valid credentials'],
      acceptanceCriteriaIndex: 0,
    });

    expect(result.testCaseId).toBe('PBI-1-TC-2');

    // The test_cases row is updated (not inserted) since one already exists.
    const tcUpdate = mockUpdateChains[0];
    expect(tcUpdate.set).toHaveBeenCalled();
    const tcUpdateArg = tcUpdate.set.mock.calls[0][0];
    const suite = tcUpdateArg.testCasesJson.suites.find((s: any) => s.pbiId === 'PBI-1');
    expect(suite.testCases).toHaveLength(2);
    const appended = suite.testCases[1];
    expect(appended).toMatchObject({
      id: 'PBI-1-TC-2',
      title: 'New login test',
      steps: [
        { order: 1, action: 'Open login page' },
        { order: 2, action: 'Submit valid credentials' },
      ],
      traceability: { pbiId: 'PBI-1', acceptanceCriteriaIndex: 0 },
    });
  });

  it('marks traced acceptance criteria and business rules covered', async () => {
    mockDb.select.mockReturnValue(
      makeSelectForGet([
        {
          id: 'tc-1',
          prdId: 'prd-1',
          chatThreadId: 'thread-tc',
          status: 'ready',
          testCasesJson: {
            suites: [{ pbiId: 'PBI-1', testCases: [] }],
            coverageMatrix: {
              acceptanceCriteria: [
                { pbiId: 'PBI-1', index: 0, covered: false, testCaseIds: [] },
              ],
              businessRules: [
                { id: 'BR-001', covered: false, testCaseIds: [] },
              ],
              gaps: ['AC and BR are not covered'],
              explicitlyOutOfScope: [],
            },
          },
          testCasesMd: null,
          coverageSummary: { totalCases: 0, pbisCovered: 0, acCovered: '0/1', brCovered: '0/1', gaps: 1 },
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]),
    );
    mockDb.query.prds.findFirst.mockResolvedValue({
      backlogJson: { items: [{ id: 'PBI-1', title: 'Feature work' }] },
    });

    await addTestCaseToPrd({
      prdId: 'prd-1',
      pbiId: 'PBI-1',
      title: 'Cover login requirements',
      steps: ['Exercise the requirement'],
      acceptanceCriteriaIndex: 0,
      businessRules: ['BR-001'],
    });

    const update = mockUpdateChains[0].set.mock.calls[0][0];
    expect(update.coverageSummary).toMatchObject({
      totalCases: 1,
      pbisCovered: 1,
      acCovered: '1/1',
      brCovered: '1/1',
    });
    expect(update.testCasesJson.coverageMatrix.acceptanceCriteria[0]).toMatchObject({
      covered: true,
      testCaseIds: ['PBI-1-TC-1'],
    });
    expect(update.testCasesJson.coverageMatrix.businessRules[0]).toMatchObject({
      covered: true,
      testCaseIds: ['PBI-1-TC-1'],
    });
  });

  it('recomputes coverageSummary and re-applies backlog test counts', async () => {
    mockDb.select.mockReturnValue(
      makeSelectForGet([
        {
          id: 'tc-1',
          prdId: 'prd-1',
          chatThreadId: 'thread-tc',
          status: 'ready',
          testCasesJson: {
            suites: [
              {
                pbiId: 'PBI-1',
                testCases: [
                  { id: 'PBI-1-TC-1', title: 'Existing case', steps: [{ order: 1, action: 'Do' }] },
                ],
              },
            ],
            coverageSummary: { totalCases: 1, pbisCovered: 0, acCovered: '0/0', brCovered: '0/0', gaps: 0 },
          },
          testCasesMd: null,
          coverageSummary: { totalCases: 1, pbisCovered: 0, acCovered: '0/0', brCovered: '0/0', gaps: 0 },
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]),
    );
    mockDb.query.prds.findFirst.mockResolvedValue({
      backlogJson: { items: [{ id: 'PBI-1', title: 'Feature work', testCaseCount: 1 }] },
    });

    await addTestCaseToPrd({
      prdId: 'prd-1',
      pbiId: 'PBI-1',
      title: 'Second case',
      steps: ['Step A'],
    });

    const tcUpdate = mockUpdateChains[0];
    const tcUpdateArg = tcUpdate.set.mock.calls[0][0];
    expect(tcUpdateArg.coverageSummary.totalCases).toBe(2);

    const prdUpdate = mockUpdateChains[1];
    const prdUpdateArg = prdUpdate.set.mock.calls[0][0];
    expect(prdUpdateArg.backlogJson.items[0].testCaseCount).toBe(2);
  });

  it('creates a new test_cases row (status ready) when none exists for the PRD', async () => {
    mockDb.select.mockReturnValue(makeSelectForGet([]));
    mockDb.query.prds.findFirst.mockResolvedValue({
      backlogJson: { items: [{ id: 'PBI-9', title: 'New feature' }] },
    });

    const result = await addTestCaseToPrd({
      prdId: 'prd-2',
      pbiId: 'PBI-9',
      title: 'First ever case',
      steps: ['Only step'],
    });

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    const insertChain = mockInsertChains[0];
    const insertArg = insertChain.values.mock.calls[0][0];
    expect(insertArg.status).toBe('ready');
    expect(insertArg.prdId).toBe('prd-2');
    const suite = insertArg.testCasesJson.suites.find((s: any) => s.pbiId === 'PBI-9');
    expect(suite.testCases).toHaveLength(1);
    expect(suite.testCases[0].id).toBe('PBI-9-TC-1');
    expect(result.testCaseId).toBe('PBI-9-TC-1');
  });

  it('re-evaluates coverage for cases added before traceability recalculation', async () => {
    mockDb.select.mockReturnValue(
      makeSelectForGet([
        {
          id: 'tc-1',
          prdId: 'prd-1',
          chatThreadId: 'thread-tc',
          status: 'ready',
          testCasesJson: {
            suites: [
              {
                pbiId: 'PBI-1',
                testCases: [
                  {
                    id: 'PBI-1-TC-1',
                    title: 'Existing assistant case',
                    steps: [{ order: 1, action: 'Exercise AC' }],
                    traceability: { acceptanceCriteriaIndex: 0 },
                  },
                ],
              },
            ],
            coverageMatrix: {
              acceptanceCriteria: [
                { pbiId: 'PBI-1', index: 0, covered: false, testCaseIds: [] },
              ],
              businessRules: [],
              gaps: [],
              explicitlyOutOfScope: [],
            },
          },
          testCasesMd: null,
          coverageSummary: { totalCases: 1, pbisCovered: 0, acCovered: '0/1', brCovered: '0/0', gaps: 0 },
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]),
    );
    mockDb.query.prds.findFirst.mockResolvedValue({
      backlogJson: { items: [{ id: 'PBI-1', title: 'Feature work' }] },
    });

    const summary = await recalculateTestCaseCoverage('prd-1');

    expect(summary).toMatchObject({
      totalCases: 1,
      pbisCovered: 1,
      acCovered: '1/1',
      brCovered: '0/0',
    });
    const testCaseUpdate = mockUpdateChains[0].set.mock.calls[0][0];
    expect(testCaseUpdate.testCasesJson.coverageMatrix.acceptanceCriteria[0]).toMatchObject({
      covered: true,
      testCaseIds: ['PBI-1-TC-1'],
    });
  });
});
