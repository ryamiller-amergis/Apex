import fs from 'fs';
import os from 'os';
import path from 'path';
import { qaAdoTestSuites, qaCaseRegenerations } from '../db/schema';
import { AdoTestSuiteConflictError } from '../services/adoTestCaseSuiteService';
import { createThread, getThread } from '../services/chatAgentService';
import { resolveSkillConfig } from '../services/projectSettingsService';
import {
  applyAddCase,
  applyEditCase,
  listAssistantCases,
  openQaLabAssistantThread,
  QaLabAssistantThreadError,
} from '../services/qaLabAssistantService';

interface DbState {
  suite: Record<string, unknown> | null;
  otherSuites: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
  updates: Array<{ table: unknown; values: Record<string, unknown> }>;
}

jest.mock('../db/drizzle', () => {
  const state: DbState = { suite: null, otherSuites: [], runs: [], inserts: [], updates: [] };
  const update = (table: unknown) => {
    const chain = {
      set(values: Record<string, unknown>) {
        state.updates.push({ table, values });
        return chain;
      },
      where() {
        return chain;
      },
      then(resolve: (value: unknown) => void) {
        resolve(undefined);
      },
    };
    return chain;
  };
  const db = {
    query: {
      qaAdoTestSuites: { findFirst: jest.fn(async () => state.suite), findMany: jest.fn(async () => state.otherSuites) },
      qaCaseComments: { findMany: jest.fn(async () => []) },
      qaCaseRuns: { findMany: jest.fn(async () => state.runs) },
      qaLabAssistantProposals: { findMany: jest.fn(async () => []) },
      qaCaseRegenerations: { findFirst: jest.fn(async () => null) },
    },
    insert: jest.fn((table: unknown) => ({
      values(values: Record<string, unknown>) {
        state.inserts.push({ table, values });
        return {
          returning: () => Promise.resolve([{
            id: 'edit-1',
            chatThreadId: null,
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
  return { db, __qaAssistantDbMock: state };
});

jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn(),
  getThread: jest.fn(),
  isThreadIdle: jest.fn(),
  updateThreadKickoffContext: jest.fn(),
}));

jest.mock('../services/backgroundWorkflowRouter', () => ({
  routeBackgroundWorkflow: jest.fn().mockResolvedValue(undefined),
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

const { __qaAssistantDbMock: dbState } = jest.requireMock('../db/drizzle') as { __qaAssistantDbMock: DbState };

const ado = {
  getQaTestGenerationContext: jest.fn(),
  listStaticTestPlanSuites: jest.fn().mockResolvedValue([]),
};

const step = (order: number, action: string) => ({ order, action, expected: `${action} done` });

function readySuite(publishedCases: unknown[] = []): Record<string, unknown> {
  return {
    id: 'suite-1',
    project: 'MatterWorx',
    rootWorkItemId: 58977,
    rootTitle: 'Approval notifications',
    status: 'ready',
    publishedCases,
    sourceSnapshot: { root: { id: 58977 }, targets: [], technicalContext: [] },
    testCasesJson: {
      suites: [{
        pbiId: 'PBI-58989',
        testCases: [
          { id: 'PBI-58989-1', title: 'Validate Approve Timesheet', steps: [step(1, 'Access Env.'), step(2, 'Login as Worker')], placement: { testPlan: '15 Timesheet' } },
          { id: 'PBI-58989-2', title: 'Validate Reject Timesheet', steps: [step(1, 'Access Env.')] },
        ],
      }],
    },
  };
}

function thread(overrides: Record<string, unknown> = {}) {
  return { id: 'thread-qa', userId: 'u1', workspaceDir: null, kickoff: { qaLabSuiteId: 'suite-1' }, ...overrides };
}

function savedCases(): Array<Record<string, unknown>> {
  const update = [...dbState.updates].reverse().find((entry) => entry.table === qaAdoTestSuites);
  const json = update?.values.testCasesJson as { suites: Array<{ testCases: Array<Record<string, unknown>> }> };
  return json.suites[0].testCases;
}

describe('qaLabAssistantService', () => {
  let workspaceDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-lab-assistant-'));
    dbState.suite = readySuite();
    dbState.otherSuites = [];
    dbState.runs = [];
    dbState.inserts = [];
    dbState.updates = [];
    (getThread as jest.Mock).mockResolvedValue(thread());
    (resolveSkillConfig as jest.Mock).mockResolvedValue({
      testCaseSkillPath: '/.agents/skills/create-test-case/SKILL.md',
      skillRepo: 'org/repo',
      skillBranch: 'main',
    });
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('refuses tool calls from a thread that is not bound to a suite', async () => {
    (getThread as jest.Mock).mockResolvedValue(thread({ kickoff: {} }));

    await expect(listAssistantCases('thread-other')).rejects.toBeInstanceOf(QaLabAssistantThreadError);
    expect(dbState.updates).toHaveLength(0);
  });

  it('edits only the given fields, keeps the id, and records the old case for restore', async () => {
    const edit = await applyEditCase({
      suiteId: 'suite-1',
      userId: 'u1',
      localCaseId: 'PBI-58989-1',
      patch: { id: 'renamed', steps: [step(1, 'Access Env.'), step(2, 'Login as Location Timesheet Approver')] },
    });

    const saved = savedCases()[0];
    expect(saved.id).toBe('PBI-58989-1');
    expect(saved.title).toBe('Validate Approve Timesheet');
    expect(saved.placement).toEqual({ testPlan: '15 Timesheet' });
    expect((saved.steps as Array<{ action: string }>)[1].action).toBe('Login as Location Timesheet Approver');
    const history = dbState.inserts.find((entry) => entry.table === qaCaseRegenerations);
    expect(history?.values).toEqual(expect.objectContaining({ status: 'ready', source: 'assistant', createdBy: 'u1' }));
    expect((history?.values.previousCase as { steps: unknown[] }).steps).toHaveLength(2);
    expect(edit.source).toBe('assistant');
    expect(edit.previousCase?.title).toBe('Validate Approve Timesheet');
  });

  it('will not edit a published case', async () => {
    dbState.suite = readySuite([{ localCaseId: 'PBI-58989-1', adoTestCaseId: 9, adoTestCaseUrl: 'u', parentWorkItemId: 58989, publishedAt: 'now' }]);

    await expect(applyEditCase({ suiteId: 'suite-1', userId: 'u1', localCaseId: 'PBI-58989-1', patch: { title: 'x' } }))
      .rejects.toBeInstanceOf(AdoTestSuiteConflictError);
  });

  it('adds a case to the work item under a new id', async () => {
    const added = await applyAddCase({
      suiteId: 'suite-1',
      pbiId: '58989',
      testCase: { id: 'PBI-58989-1', title: 'Validate approval email', steps: [step(1, 'Access Env.')] },
    });

    expect(added.localCaseId).toBe('PBI-58989-3');
    expect(savedCases().map((testCase) => testCase.id)).toEqual(['PBI-58989-1', 'PBI-58989-2', 'PBI-58989-3']);
    await expect(applyAddCase({ suiteId: 'suite-1', pbiId: 'PBI-58989', testCase: { title: 'No steps', steps: [] } }))
      .rejects.toThrow('A case needs at least one step');
  });

  it('gives the chat runs, Bugs, every other work item, and how QA Lab works', async () => {
    (getThread as jest.Mock).mockResolvedValue(thread({ workspaceDir }));
    dbState.runs = [{
      localCaseId: 'PBI-58989-1',
      status: 'draft',
      outcome: 'failed',
      stepResults: [{ order: 1, outcome: 'passed' }, { order: 2, outcome: 'failed' }],
      bugs: [{ id: 777, title: 'Failed: Approve', url: 'https://ado.example/777' }],
      publishedAt: null,
      adoRunUrl: null,
    }];
    dbState.otherSuites = [
      { id: 'suite-2', rootWorkItemId: 60001, rootWorkItemType: 'Feature', rootTitle: 'Timesheet export', testCasesJson: { suites: [] }, publishedCases: [], updatedAt: 'now' },
      { id: 'suite-old', rootWorkItemId: 60001, rootWorkItemType: 'Feature', rootTitle: 'Timesheet export', testCasesJson: { suites: [] }, publishedCases: [], updatedAt: 'then' },
      { id: 'suite-1', rootWorkItemId: 58977, rootWorkItemType: 'Feature', rootTitle: 'Approval notifications', testCasesJson: { suites: [] }, publishedCases: [], updatedAt: 'now' },
    ];

    await openQaLabAssistantThread({ suiteId: 'suite-1', userId: 'u1', threadId: 'thread-qa', ado });

    const context = fs.readFileSync(path.join(workspaceDir, '.ai-pilot', 'kickoff-context.md'), 'utf-8');
    expect(context).toContain('Every change you make is a proposal');
    expect(context).toContain('## How QA Lab works');
    expect(context).toContain('Feature 60001 Timesheet export: 0 cases, 0 published (suiteId: suite-2)');
    expect(context).not.toContain('suite-old');
    expect(context).toContain('"stepsFailed": 1');
    expect(context).toContain('"id": 777');
  });

  it("reuses the user's own thread for the suite and replaces anyone else's", async () => {
    (getThread as jest.Mock).mockResolvedValue(thread({ workspaceDir }));
    await expect(openQaLabAssistantThread({ suiteId: 'suite-1', userId: 'u1', threadId: 'thread-qa', ado }))
      .resolves.toEqual({ threadId: 'thread-qa' });
    expect(createThread).not.toHaveBeenCalled();
    const context = fs.readFileSync(path.join(workspaceDir, '.ai-pilot', 'kickoff-context.md'), 'utf-8');
    expect(context).toContain('threadId: "thread-qa"');
    expect(context).toContain('qa_lab_update_case');
    expect(context).toContain('/.agents/skills/create-test-case/SKILL.md');
    expect(context).toContain('"localCaseId": "PBI-58989-2"');

    (createThread as jest.Mock).mockResolvedValue({ id: 'thread-new', workspaceDir });
    await expect(openQaLabAssistantThread({ suiteId: 'suite-1', userId: 'u2', threadId: 'thread-qa', ado }))
      .resolves.toEqual({ threadId: 'thread-new' });
    expect((createThread as jest.Mock).mock.calls[0][1]).toEqual(expect.objectContaining({ qaLabSuiteId: 'suite-1' }));
  });
});
