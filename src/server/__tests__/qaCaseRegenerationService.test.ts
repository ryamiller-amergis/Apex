import fs from 'fs';
import os from 'os';
import path from 'path';
import { qaAdoTestSuites, qaCaseComments, qaCaseRegenerations } from '../db/schema';
import { AdoTestSuiteConflictError } from '../services/adoTestCaseSuiteService';
import { createThread } from '../services/chatAgentService';
import { resolveSkillConfig } from '../services/projectSettingsService';
import {
  applyRegenerationOutput,
  regenerateAdoTestCase,
  resetCaseRegenerationWatchersForTests,
  restoreCaseRegeneration,
} from '../services/qaCaseRegenerationService';

interface DbState {
  suite: Record<string, unknown> | null;
  comments: Array<Record<string, unknown>>;
  regeneration: Record<string, unknown> | null;
  inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
  updates: Array<{ table: unknown; values: Record<string, unknown> }>;
}

jest.mock('../db/drizzle', () => {
  const state: DbState = { suite: null, comments: [], regeneration: null, inserts: [], updates: [] };
  const update = (table: unknown) => {
    const chain = {
      set(values: Record<string, unknown>) {
        state.updates.push({ table, values });
        return chain;
      },
      where() {
        return chain;
      },
      returning() {
        return Promise.resolve([{ ...state.regeneration, ...state.updates[state.updates.length - 1]?.values }]);
      },
      then(resolve: (value: unknown) => void) {
        resolve(undefined);
      },
    };
    return chain;
  };
  const db = {
    query: {
      qaAdoTestSuites: { findFirst: jest.fn(async () => state.suite) },
      qaCaseComments: { findMany: jest.fn(async () => state.comments) },
      qaCaseRegenerations: {
        findFirst: jest.fn(async () => state.regeneration),
        findMany: jest.fn(async () => (state.regeneration ? [state.regeneration] : [])),
      },
      chatThreads: { findFirst: jest.fn(async () => null) },
    },
    insert: jest.fn((table: unknown) => ({
      values(values: Record<string, unknown>) {
        state.inserts.push({ table, values });
        return {
          returning: () => Promise.resolve([{
            id: 'regen-1',
            status: 'generating',
            error: null,
            createdAt: '2026-11-03T10:00:00.000Z',
            updatedAt: '2026-11-03T10:00:00.000Z',
            ...values,
          }]),
        };
      },
    })),
    update: jest.fn(update),
    transaction: jest.fn(async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => run(db)),
  };
  return { db, __qaCaseDbMock: state };
});

jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn(),
  isThreadIdle: jest.fn(),
  prepareBackgroundWorkflowTurn: jest.fn(),
  sendMessage: jest.fn(),
  updateThreadKickoffContext: jest.fn(),
}));

jest.mock('../services/backgroundWorkflowRouter', () => ({
  routeBackgroundWorkflow: jest.fn().mockResolvedValue(undefined),
  usesV2DocumentTransport: jest.fn().mockResolvedValue(false),
}));

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn(),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn().mockResolvedValue('default-model'),
}));

jest.mock('../services/agentRunReaperService', () => ({
  isThreadRunAlive: jest.fn(),
  canThisInstanceFailGeneration: jest.fn(),
}));

jest.mock('../services/runGroundingService', () => ({
  propagatePipelineGrounding: jest.fn(),
  runGroundingService: {
    getGroundings: jest.fn().mockResolvedValue([]),
    persistThenMarkTerminalInactive: jest.fn(),
  },
}));

jest.mock('../services/adoFactory', () => ({
  adoWriteForRequest: jest.fn(),
  adoWriteFromToken: jest.fn(),
}));

jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: jest.fn(),
}));

const { __qaCaseDbMock: dbState } = jest.requireMock('../db/drizzle') as { __qaCaseDbMock: DbState };

const ado = {
  getQaTestGenerationContext: jest.fn(),
  listStaticTestPlanSuites: jest.fn().mockResolvedValue([]),
};

function readySuite(publishedCases: unknown[] = []): Record<string, unknown> {
  return {
    id: 'suite-1',
    project: 'MatterWorx',
    rootWorkItemId: 58977,
    rootTitle: 'Approval notifications',
    status: 'ready',
    publishedCases,
    sourceSnapshot: {
      root: { id: 58977, parentId: null, workItemType: 'Feature', title: 'Approval notifications', state: 'New', areaPath: 'MWx', description: '', acceptanceCriteria: '', reproSteps: '' },
      targets: [{ id: 18452, parentId: 58977, workItemType: 'Product Backlog Item', title: 'Notify approver', state: 'New', areaPath: 'MWx', description: 'Send an email', acceptanceCriteria: 'Email is sent', reproSteps: '' }],
      technicalContext: [],
    },
    testCasesJson: {
      suites: [{
        pbiId: 'PBI-18452',
        testCases: [
          { id: 'TC-1', title: 'Validate Approve Timesheet', steps: [{ order: 1, action: 'Access Env.', expected: 'QA Environment is available.' }] },
          { id: 'TC-2', title: 'Validate Reject Timesheet', steps: [{ order: 1, action: 'Access Env.', expected: 'QA Environment is available.' }] },
        ],
      }],
    },
  };
}

function savedCases(): Array<Record<string, unknown>> {
  const update = [...dbState.updates].reverse().find((entry) => entry.table === qaAdoTestSuites);
  const json = update?.values.testCasesJson as { suites: Array<{ testCases: Array<Record<string, unknown>> }> };
  return json.suites[0].testCases;
}

describe('qaCaseRegenerationService', () => {
  let workspaceDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-case-regen-'));
    dbState.suite = readySuite();
    dbState.comments = [];
    dbState.regeneration = null;
    dbState.inserts = [];
    dbState.updates = [];
    (resolveSkillConfig as jest.Mock).mockResolvedValue({
      testCaseSkillPath: '/.agents/skills/create-test-case/SKILL.md',
      testCaseModel: 'skill-model',
      skillRepo: 'org/repo',
      skillBranch: 'main',
      skillProvider: 'ado',
    });
    (createThread as jest.Mock).mockResolvedValue({ id: 'thread-1', workspaceDir });
  });

  afterEach(() => {
    resetCaseRegenerationWatchersForTests();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('refuses to regenerate a published case', async () => {
    dbState.suite = readySuite([{ localCaseId: 'TC-2', adoTestCaseId: 9, adoTestCaseUrl: 'u', parentWorkItemId: 18452, publishedAt: 'now' }]);
    dbState.comments = [{ id: 'c1', body: 'Add a step', authorName: 'QA', status: 'open' }];

    await expect(regenerateAdoTestCase({ suiteId: 'suite-1', localCaseId: 'TC-2', userId: 'u1', ado }))
      .rejects.toBeInstanceOf(AdoTestSuiteConflictError);
    expect(createThread).not.toHaveBeenCalled();
  });

  it('refuses to regenerate without an open comment', async () => {
    await expect(regenerateAdoTestCase({ suiteId: 'suite-1', localCaseId: 'TC-2', userId: 'u1', ado }))
      .rejects.toThrow('Add a comment that says what to change first');
  });

  it('starts one agent run for the case with its comments and keeps the old case', async () => {
    dbState.comments = [{ id: 'c1', body: 'Login as Hiring Manager, not Admin', authorName: 'Priya', status: 'open' }];

    const run = await regenerateAdoTestCase({ suiteId: 'suite-1', localCaseId: 'TC-2', userId: 'u1', ado });

    expect(run.status).toBe('generating');
    const context = (createThread as jest.Mock).mock.calls[0][1].freeformContext as string;
    expect(context).toContain('Login as Hiring Manager, not Admin (Priya)');
    expect(context).toContain('"title": "Validate Reject Timesheet"');
    expect(context).toContain('Keep `id` as `TC-2`');
    expect(context).not.toContain('Validate Approve Timesheet');
    const inserted = dbState.inserts.find((entry) => entry.table === qaCaseRegenerations);
    expect(inserted?.values.previousCase).toEqual(expect.objectContaining({ id: 'TC-2', title: 'Validate Reject Timesheet' }));
  });

  it('writes every Test Plan to a file instead of the kickoff context', async () => {
    dbState.comments = [{ id: 'c1', body: 'File under Reject Timesheet', authorName: 'QA', status: 'open' }];
    const plans = Array.from({ length: 300 }, (_, index) => ({
      id: index,
      name: `${String(index).padStart(2, '0')} Module`,
      suites: [{ id: 1, path: '' }, { id: 2, path: 'Approve Timesheet' }, { id: 3, path: 'Reject Timesheet' }],
    }));
    ado.listStaticTestPlanSuites.mockResolvedValueOnce(plans);

    await regenerateAdoTestCase({ suiteId: 'suite-1', localCaseId: 'TC-2', userId: 'u1', ado });

    const context = (createThread as jest.Mock).mock.calls[0][1].freeformContext as string;
    expect(context).toContain('.ai-pilot/test-plans.md');
    expect(context).not.toContain('00 Module');
    const file = fs.readFileSync(path.join(workspaceDir, '.ai-pilot', 'test-plans.md'), 'utf-8');
    expect(file).toContain('- 299 Module\n  - Approve Timesheet\n  - Reject Timesheet');
  });

  it('replaces only that case, keeps its id, and marks the comments addressed', async () => {
    dbState.regeneration = { id: 'regen-1', suiteId: 'suite-1', localCaseId: 'TC-2', status: 'generating', createdAt: '2026-11-03T10:00:00.000Z' };
    const output = path.join(workspaceDir, '.ai-pilot', 'output');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'x.case.json'), JSON.stringify({
      id: 'TC-99',
      title: 'Validate Reject Timesheet - Hiring Manager',
      steps: [{ order: 1, action: 'Access Env.', expected: 'QA Environment is available.' }],
    }));

    const outcome = await applyRegenerationOutput('regen-1', 'thread-1', workspaceDir);

    expect(outcome).toBe('applied');
    expect(savedCases().map((testCase) => [testCase.id, testCase.title])).toEqual([
      ['TC-1', 'Validate Approve Timesheet'],
      ['TC-2', 'Validate Reject Timesheet - Hiring Manager'],
    ]);
    expect(dbState.updates.find((entry) => entry.table === qaCaseRegenerations)?.values.status).toBe('ready');
    expect(dbState.updates.find((entry) => entry.table === qaCaseComments)?.values)
      .toEqual(expect.objectContaining({ status: 'addressed', regenerationId: 'regen-1' }));
  });

  it('fails the run when the case was published while it was regenerating', async () => {
    dbState.suite = readySuite([{ localCaseId: 'TC-2', adoTestCaseId: 9, adoTestCaseUrl: 'u', parentWorkItemId: 18452, publishedAt: 'now' }]);
    dbState.regeneration = { id: 'regen-1', suiteId: 'suite-1', localCaseId: 'TC-2', status: 'generating', createdAt: '2026-11-03T10:00:00.000Z' };
    const output = path.join(workspaceDir, '.ai-pilot', 'output');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'x.case.json'), JSON.stringify({ title: 'New', steps: [{ order: 1, action: 'a', expected: 'b' }] }));

    const outcome = await applyRegenerationOutput('regen-1', 'thread-1', workspaceDir);

    expect(outcome).toBe('failed');
    expect(dbState.updates.some((entry) => entry.table === qaAdoTestSuites)).toBe(false);
    expect(dbState.updates.find((entry) => entry.table === qaCaseRegenerations)?.values)
      .toEqual(expect.objectContaining({ status: 'failed', error: 'The case was published while it was regenerating' }));
  });

  it('restores the case a finished regeneration replaced', async () => {
    dbState.regeneration = {
      id: 'regen-1',
      suiteId: 'suite-1',
      localCaseId: 'TC-2',
      status: 'ready',
      previousCase: { id: 'TC-2', title: 'Original reject case', steps: [{ order: 1, action: 'a', expected: 'b' }] },
      createdAt: '2026-11-03T10:00:00.000Z',
      updatedAt: '2026-11-03T10:00:00.000Z',
    };

    const restored = await restoreCaseRegeneration('suite-1', 'regen-1');

    expect(restored.status).toBe('restored');
    expect(savedCases().find((testCase) => testCase.id === 'TC-2')?.title).toBe('Original reject case');
  });
});
