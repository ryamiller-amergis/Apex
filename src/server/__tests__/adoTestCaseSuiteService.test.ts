import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request } from 'express';
import type { QaAdoGenerationContext, QaAdoGenerationItem } from '../../shared/types/qaLab';
import { adoWriteForRequest, adoWriteFromToken } from '../services/adoFactory';
import { AzureDevOpsService } from '../services/azureDevOps';
import { canThisInstanceFailGeneration, isThreadRunAlive } from '../services/agentRunReaperService';
import { getDefaultModel } from '../services/appSettingsService';
import { routeBackgroundWorkflow } from '../services/backgroundWorkflowRouter';
import {
  createThread,
  isThreadIdle,
  prepareBackgroundWorkflowTurn,
  sendMessage,
} from '../services/chatAgentService';
import { resolveSkillConfig } from '../services/projectSettingsService';
import { propagatePipelineGrounding } from '../services/runGroundingService';
import {
  ADO_TEST_SUITE_WATCHER_INTERVAL_MS,
  adoBacklogPbiId,
  adoBacklogTbiId,
  buildSyntheticAdoBacklog,
  getLatestAdoTestSuite,
  isAdoTestSuiteWatcherActive,
  publishAdoTestCases,
  resetAdoTestSuiteWatchersForTests,
  syncAdoTestSuiteOutput,
  triggerAdoTestCaseGeneration,
  type SyntheticAdoPbiItem,
  type SyntheticAdoTbiItem,
} from '../services/adoTestCaseSuiteService';

interface DbMockState {
  suiteRow: Record<string, unknown> | null;
  threadRow: { workspaceDir: string | null } | null;
  inserts: unknown[];
  updates: Array<Record<string, unknown>>;
}

interface DbMockHandles {
  state: DbMockState;
  findSuite: jest.Mock;
  findThread: jest.Mock;
}

jest.mock('../db/drizzle', () => {
  const state: DbMockState = {
    suiteRow: null,
    threadRow: null,
    inserts: [],
    updates: [],
  };
  const findSuite = jest.fn(async () => state.suiteRow);
  const findThread = jest.fn(async () => state.threadRow);
  const chain = {
    set(values: Record<string, unknown>) {
      state.updates.push(values);
      if (state.suiteRow) Object.assign(state.suiteRow, values);
      return chain;
    },
    where() {
      return chain;
    },
    returning() {
      return Promise.resolve([{ id: String(state.suiteRow?.id ?? 'suite-new') }]);
    },
  };
  const db = {
    query: {
      qaAdoTestSuites: { findFirst: findSuite },
      chatThreads: { findFirst: findThread },
    },
    insert: jest.fn(() => ({
      values(values: unknown) {
        state.inserts.push(values);
        return {
          returning: () => Promise.resolve([{ id: 'suite-new' }]),
        };
      },
    })),
    update: jest.fn(() => chain),
  };
  return { db, __adoSuiteDbMock: { state, findSuite, findThread } };
});

jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn(),
  isThreadIdle: jest.fn(),
  prepareBackgroundWorkflowTurn: jest.fn(),
  sendMessage: jest.fn(),
  updateThreadKickoffContext: jest.fn(),
}));

jest.mock('../services/backgroundWorkflowRouter', () => ({
  routeBackgroundWorkflow: jest.fn(),
}));

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn(),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(),
}));

jest.mock('../services/agentRunReaperService', () => ({
  isThreadRunAlive: jest.fn(),
  canThisInstanceFailGeneration: jest.fn(),
}));

jest.mock('../services/runGroundingService', () => ({
  propagatePipelineGrounding: jest.fn(),
  runGroundingService: {
    getGroundings: jest.fn().mockResolvedValue([]),
    persistThenMarkTerminalInactive: jest.fn(
      async (_ref: unknown, persist: () => Promise<unknown>) => {
        const persisted = await persist();
        return { persisted, deactivatedCount: 0 };
      },
    ),
  },
}));

jest.mock('../services/adoFactory', () => ({
  adoWriteForRequest: jest.fn(),
  adoWriteFromToken: jest.fn(),
}));

jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: jest.fn(),
}));

const { __adoSuiteDbMock: dbMock } = jest.requireMock('../db/drizzle') as {
  __adoSuiteDbMock: DbMockHandles;
};

const skillConfig = {
  testCaseSkillPath: '.cursor/skills/create-test-case/SKILL.md',
  testCaseModel: 'gpt-skill',
  testCaseEffort: 'medium',
  skillRepo: 'org/skills',
  skillBranch: 'main',
  skillProvider: 'ado',
};

function item(overrides: Partial<QaAdoGenerationItem> & Pick<QaAdoGenerationItem, 'id' | 'workItemType' | 'title'>): QaAdoGenerationItem {
  return {
    parentId: 100,
    state: 'New',
    areaPath: 'Apex\\QA',
    description: '',
    acceptanceCriteria: '',
    reproSteps: '',
    ...overrides,
  };
}

function generationContext(): QaAdoGenerationContext {
  return {
    root: item({
      id: 100,
      parentId: null,
      workItemType: 'Feature',
      title: 'Notifications',
      description: '<p>Users manage alerts.</p>',
    }),
    targets: [
      item({
        id: 18452,
        workItemType: 'Product Backlog Item',
        title: 'Toggle alerts',
        description: '<p>Toggle</p>',
        acceptanceCriteria: '<ul><li>Given the user is signed in When they toggle an alert Then the preference is saved</li><li>A failure shows an error</li></ul>',
      }),
      item({
        id: 18499,
        workItemType: 'Bug',
        title: 'Toggle does not persist',
        reproSteps: '<div>Given the toggle is off When the page reloads Then the toggle is on</div>',
      }),
    ],
    technicalContext: [
      item({
        id: 18500,
        parentId: 18452,
        workItemType: 'Technical Backlog Item',
        title: 'Add preferences table',
        description: 'Create the table',
      }),
    ],
  };
}

function pbiItem(backlog: ReturnType<typeof buildSyntheticAdoBacklog>, id: string): SyntheticAdoPbiItem {
  const found = backlog.epics[0].features[0].items.find((entry) => entry.id === id);
  if (!found || found.type !== 'PBI') throw new Error(`Missing PBI ${id}`);
  return found;
}

describe('buildSyntheticAdoBacklog', () => {
  it('maps PBI and Bug targets to PBI-{adoId} and keeps TBIs as context', () => {
    const backlog = buildSyntheticAdoBacklog(generationContext());
    const items = backlog.epics[0].features[0].items;

    expect(items.map((entry) => entry.id)).toEqual([
      adoBacklogPbiId(18452),
      adoBacklogPbiId(18499),
      adoBacklogTbiId(18500),
    ]);
    expect(items.map((entry) => entry.type)).toEqual(['PBI', 'PBI', 'TBI']);
    expect(backlog.epics[0].features[0].id).toBe('FEAT-001');
    expect(backlog.implementationPhases[0].epics).toEqual(['Notifications']);

    const pbi = pbiItem(backlog, 'PBI-18452');
    expect(pbi.dependsOn).toEqual(['TBI-18500']);
    expect(pbi.acceptanceCriteria[0]).toEqual({
      given: 'the user is signed in',
      when: 'they toggle an alert',
      then: 'the preference is saved',
    });
    expect(pbi.acceptanceCriteria[1].then).toBe('A failure shows an error');

    const bug = pbiItem(backlog, 'PBI-18499');
    expect(bug.acceptanceCriteria[0]).toEqual({
      given: 'the toggle is off',
      when: 'the page reloads',
      then: 'the toggle is on',
    });

    const tbi = items.find((entry) => entry.id === 'TBI-18500') as SyntheticAdoTbiItem;
    expect(tbi.description).toBe('Create the table');
    expect(tbi.definitionOfDone).toHaveLength(3);
  });
});

describe('ADO test suite generation and publish', () => {
  let workspaceDir = '';

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-suite-'));
    dbMock.state.suiteRow = null;
    dbMock.state.threadRow = null;
    dbMock.state.inserts.length = 0;
    dbMock.state.updates.length = 0;
    dbMock.findSuite.mockReset();
    dbMock.findSuite.mockImplementation(async () => dbMock.state.suiteRow);
    dbMock.findThread.mockReset();
    dbMock.findThread.mockImplementation(async () => dbMock.state.threadRow);
    jest.mocked(resolveSkillConfig).mockReset();
    jest.mocked(resolveSkillConfig).mockResolvedValue(skillConfig as never);
    jest.mocked(getDefaultModel).mockReset();
    jest.mocked(getDefaultModel).mockResolvedValue('default-model');
    jest.mocked(createThread).mockReset();
    jest.mocked(createThread).mockResolvedValue({
      id: 'thread-ado',
      workspaceDir,
    } as never);
    jest.mocked(prepareBackgroundWorkflowTurn).mockReset();
    jest.mocked(prepareBackgroundWorkflowTurn).mockResolvedValue({
      prompt: 'prompt',
      model: 'gpt-test',
      skillPath: skillConfig.testCaseSkillPath,
      projectId: 'Apex',
      threadWorkspacePath: workspaceDir,
      repository: {
        provider: 'ado',
        project: 'Apex',
        repository: 'skills',
        branch: 'main',
      },
    } as never);
    jest.mocked(sendMessage).mockReset();
    jest.mocked(sendMessage).mockResolvedValue({ route: 'legacy' });
    jest.mocked(isThreadIdle).mockReset();
    jest.mocked(isThreadIdle).mockReturnValue(false);
    jest.mocked(isThreadRunAlive).mockReset();
    jest.mocked(isThreadRunAlive).mockResolvedValue(false);
    jest.mocked(canThisInstanceFailGeneration).mockReset();
    jest.mocked(canThisInstanceFailGeneration).mockResolvedValue(true);
    jest.mocked(propagatePipelineGrounding).mockReset();
    jest.mocked(propagatePipelineGrounding).mockResolvedValue(null);
    jest.mocked(routeBackgroundWorkflow).mockReset();
    jest.mocked(routeBackgroundWorkflow).mockImplementation(async (input) => {
      await input.prepareWorker();
      await input.runInProcess();
      return { route: 'in-process', reason: 'flag-disabled' };
    });
    jest.mocked(adoWriteForRequest).mockReset();
    jest.mocked(adoWriteFromToken).mockReset();
    jest.mocked(AzureDevOpsService).mockReset();
  });

  afterEach(() => {
    resetAdoTestSuiteWatchersForTests();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    jest.useRealTimers();
  });

  it('returns root-not-found without inserting a suite', async () => {
    const ado = { getQaTestGenerationContext: jest.fn().mockResolvedValue(null) };

    const result = await triggerAdoTestCaseGeneration({
      project: 'Apex',
      rootWorkItemId: 100,
      userId: 'user-1',
      ado,
    });

    expect(result).toEqual({ started: false, reason: 'root-not-found' });
    expect(dbMock.state.inserts).toHaveLength(0);
    expect(createThread).not.toHaveBeenCalled();
  });

  it('returns no-targets when the hierarchy has no PBI or Bug', async () => {
    const context = generationContext();
    context.targets = [];
    const ado = { getQaTestGenerationContext: jest.fn().mockResolvedValue(context) };

    const result = await triggerAdoTestCaseGeneration({
      project: 'Apex',
      rootWorkItemId: 100,
      userId: 'user-1',
      ado,
    });

    expect(result).toEqual({ started: false, reason: 'no-targets' });
    expect(dbMock.state.inserts).toHaveLength(0);
  });

  it('returns skill-not-configured before reading Azure DevOps', async () => {
    jest.mocked(resolveSkillConfig).mockResolvedValue({ testCaseSkillPath: null } as never);
    const ado = { getQaTestGenerationContext: jest.fn() };

    const result = await triggerAdoTestCaseGeneration({
      project: 'Apex',
      rootWorkItemId: 100,
      userId: 'user-1',
      ado,
    });

    expect(result).toEqual({ started: false, reason: 'skill-not-configured' });
    expect(ado.getQaTestGenerationContext).not.toHaveBeenCalled();
  });

  it('returns already-generating and does not start another thread', async () => {
    dbMock.state.suiteRow = { id: 'suite-existing', status: 'generating' };
    const ado = { getQaTestGenerationContext: jest.fn() };

    const result = await triggerAdoTestCaseGeneration({
      project: 'Apex',
      rootWorkItemId: 100,
      userId: 'user-1',
      ado,
    });

    expect(result).toEqual({
      started: false,
      reason: 'already-generating',
      suiteId: 'suite-existing',
    });
    expect(createThread).not.toHaveBeenCalled();
    expect(ado.getQaTestGenerationContext).not.toHaveBeenCalled();
  });

  it('requires a project, a positive work item id, and a user', async () => {
    await expect(triggerAdoTestCaseGeneration({
      project: ' ',
      rootWorkItemId: 100,
      userId: 'user-1',
    })).rejects.toThrow('project is required');
    await expect(triggerAdoTestCaseGeneration({
      project: 'Apex',
      rootWorkItemId: 0,
      userId: 'user-1',
    })).rejects.toThrow('rootWorkItemId must be a positive integer');
  });

  it('persists a generating suite, writes the synthetic backlog, and routes the skill', async () => {
    const ado = {
      getQaTestGenerationContext: jest.fn().mockResolvedValue(generationContext()),
      createTestCaseWorkItem: jest.fn(),
    };

    const result = await triggerAdoTestCaseGeneration({
      project: 'Apex',
      rootWorkItemId: 100,
      userId: 'user-1',
      sourceThreadId: 'thread-source',
      model: 'override-model',
      ado,
    });

    expect(result).toEqual({
      started: true,
      suiteId: 'suite-new',
      threadId: 'thread-ado',
    });
    expect(dbMock.state.inserts[0]).toEqual(expect.objectContaining({
      project: 'Apex',
      rootWorkItemId: 100,
      rootWorkItemType: 'Feature',
      rootTitle: 'Notifications',
      status: 'generating',
      chatThreadId: 'thread-ado',
      createdBy: 'user-1',
      sourceSnapshot: expect.objectContaining({
        root: expect.objectContaining({ id: 100 }),
      }),
    }));
    expect(dbMock.state.updates).toHaveLength(0);

    const backlog = JSON.parse(fs.readFileSync(
      path.join(workspaceDir, '.ai-pilot', 'output', 'notifications.backlog.json'),
      'utf-8',
    )) as { epics: Array<{ features: Array<{ items: Array<{ id: string; type: string }> }> }> };
    expect(backlog.epics[0].features[0].items.map((entry) => entry.id)).toEqual([
      'PBI-18452',
      'PBI-18499',
      'TBI-18500',
    ]);
    expect(JSON.parse(fs.readFileSync(
      path.join(workspaceDir, '.ai-pilot', 'output', 'qa-lab-scope.json'),
      'utf-8',
    ))).toEqual({ pbiIds: ['PBI-18452', 'PBI-18499'] });
    expect(fs.existsSync(path.join(workspaceDir, '.ai-pilot', 'output', 'notifications.prd.md'))).toBe(true);

    expect(createThread).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        project: 'Apex',
        agentModule: 'testCase',
        skillPath: skillConfig.testCaseSkillPath,
        model: 'override-model',
      }),
      { skipAutoKickoff: true },
    );
    expect(prepareBackgroundWorkflowTurn).toHaveBeenCalledWith(
      'thread-ado',
      'Generate QA test cases only for these backlog items: PBI-18452, PBI-18499. Do not write cases for any other PBI. Write the required output files.',
    );
    expect(routeBackgroundWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      workflowClass: 'test-cases',
      threadId: 'thread-ado',
      userId: 'user-1',
    }));
    expect(propagatePipelineGrounding).toHaveBeenCalledWith(
      { runType: 'chat', runId: 'thread-source', project: 'Apex' },
      { runType: 'chat', runId: 'thread-ado', project: 'Apex' },
      'user-1',
      { deferMaterialization: true },
    );
    expect(ado.createTestCaseWorkItem).not.toHaveBeenCalled();
    expect(isAdoTestSuiteWatcherActive('suite-new')).toBe(true);
  });

  it('marks the suite failed when workflow routing throws', async () => {
    jest.mocked(routeBackgroundWorkflow).mockRejectedValue(new Error('route down'));
    const ado = { getQaTestGenerationContext: jest.fn().mockResolvedValue(generationContext()) };

    const result = await triggerAdoTestCaseGeneration({
      project: 'Apex',
      rootWorkItemId: 100,
      userId: 'user-1',
      ado,
    });

    expect(result).toEqual({
      started: false,
      reason: 'routing-failed',
      suiteId: 'suite-new',
    });
    expect(dbMock.state.updates).toContainEqual(expect.objectContaining({ status: 'failed' }));
    expect(isAdoTestSuiteWatcherActive('suite-new')).toBe(false);
  });

  it('marks the suite failed when the agent finishes without output', async () => {
    jest.useFakeTimers();
    const ado = { getQaTestGenerationContext: jest.fn().mockResolvedValue(generationContext()) };
    const generatingRow = {
      id: 'suite-new',
      status: 'generating',
      chatThreadId: 'thread-ado',
    };
    let calls = 0;
    dbMock.findSuite.mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? null : generatingRow;
    });
    jest.mocked(isThreadIdle).mockReturnValue(true);

    const result = await triggerAdoTestCaseGeneration({
      project: 'Apex',
      rootWorkItemId: 100,
      userId: 'user-1',
      ado,
    });
    expect(result).toEqual(expect.objectContaining({ started: true }));

    jest.advanceTimersByTime(ADO_TEST_SUITE_WATCHER_INTERVAL_MS);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    expect(dbMock.state.updates).toContainEqual(expect.objectContaining({ status: 'failed' }));
    expect(AzureDevOpsService).not.toHaveBeenCalled();
    expect(isAdoTestSuiteWatcherActive('suite-new')).toBe(false);
  });

  it('marks a generating suite ready from output files and does not publish', async () => {
    const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const testCasesJson = {
      suites: [{
        pbiId: 'PBI-18452',
        testCases: [{
          id: 'TC-1',
          title: 'Saves',
          steps: [{ action: 'Click save', expected: 'Saved' }],
        }],
      }],
    };
    fs.writeFileSync(
      path.join(outputDir, 'notifications.test-cases.json'),
      JSON.stringify(testCasesJson),
    );
    fs.writeFileSync(path.join(outputDir, 'notifications.test-cases.md'), '# cases');
    dbMock.state.threadRow = { workspaceDir };
    dbMock.state.suiteRow = {
      id: 'suite-1',
      chatThreadId: 'thread-ado',
      status: 'generating',
    };

    const synced = await syncAdoTestSuiteOutput('suite-1', 'thread-ado');

    expect(synced).toBe(true);
    expect(dbMock.state.updates[0]).toEqual(expect.objectContaining({
      status: 'ready',
      testCasesMd: '# cases',
      coverageSummary: expect.objectContaining({ totalCases: 1, pbisCovered: 1 }),
    }));
    expect(dbMock.state.updates[0].testCasesJson).toEqual(testCasesJson);
    expect(AzureDevOpsService).not.toHaveBeenCalled();
    expect(adoWriteForRequest).not.toHaveBeenCalled();
  });

  it('creates linked test cases once and skips those local ids on retry', async () => {
    const createTestCaseWorkItem = jest.fn()
      .mockResolvedValueOnce({ id: 9001, url: 'https://ado.example/9001' })
      .mockRejectedValueOnce(new Error('ado down'))
      .mockResolvedValueOnce({ id: 9002, url: 'https://ado.example/9002' });
    dbMock.state.suiteRow = {
      id: 'suite-1',
      project: 'Apex',
      status: 'ready',
      sourceSnapshot: { root: { areaPath: 'Apex\\QA' } },
      publishedCases: [],
      testCasesJson: {
        suites: [
          {
            pbiId: 'PBI-18452',
            testCases: [{
              id: 'TC-PBI-18452-001',
              title: 'Saves the preference',
              steps: [{ action: 'Toggle the alert', expected: 'The preference is saved' }],
            }],
          },
          {
            pbiId: 'PBI-18499',
            testCases: [{
              id: 'TC-PBI-18499-001',
              title: 'Reload keeps the toggle',
              steps: ['Reload the page'],
            }],
          },
        ],
      },
    };

    const first = await publishAdoTestCases('suite-1', { ado: { createTestCaseWorkItem } });
    const second = await publishAdoTestCases('suite-1', { createTestCaseWorkItem });

    expect(first.published.map((item) => item.localCaseId)).toEqual(['TC-PBI-18452-001']);
    expect(first.failures).toEqual([{ localCaseId: 'TC-PBI-18499-001', message: 'ado down' }]);
    expect(first.published[0]).toEqual(expect.objectContaining({
      adoTestCaseId: 9001,
      parentWorkItemId: 18452,
    }));
    expect(createTestCaseWorkItem).toHaveBeenNthCalledWith(1, expect.objectContaining({
      title: 'Saves the preference',
      parentId: 18452,
      stepsHtml: expect.stringContaining('Toggle the alert'),
    }));
    expect(second.published.map((item) => item.localCaseId)).toEqual(['TC-PBI-18499-001']);
    expect(second.skippedLocalCaseIds).toEqual(['TC-PBI-18452-001']);
    expect(second.published[0].parentWorkItemId).toBe(18499);
    expect(createTestCaseWorkItem).toHaveBeenCalledTimes(3);
    expect(dbMock.state.suiteRow?.publishedCases).toEqual([
      expect.objectContaining({ localCaseId: 'TC-PBI-18452-001', adoTestCaseId: 9001 }),
      expect.objectContaining({ localCaseId: 'TC-PBI-18499-001', adoTestCaseId: 9002 }),
    ]);
    expect(dbMock.state.updates.every((update) => update.status === undefined)).toBe(true);
  });

  it('uses the request token writer and refuses publish before the suite is ready', async () => {
    const createTestCaseWorkItem = jest.fn().mockResolvedValue({ id: 1, url: 'https://ado.example/1' });
    jest.mocked(adoWriteForRequest).mockResolvedValue({ createTestCaseWorkItem } as never);
    const req = { headers: {} } as Request;
    dbMock.state.suiteRow = {
      id: 'suite-1',
      project: 'Apex',
      status: 'ready',
      sourceSnapshot: { root: { areaPath: 'Apex\\QA' } },
      publishedCases: [],
      testCasesJson: {
        suites: [{
          pbiId: 'PBI-18452',
          testCases: [{ id: 'TC-1', title: 'Saves', steps: ['Save'] }],
        }],
      },
    };

    await publishAdoTestCases('suite-1', { req });

    expect(adoWriteForRequest).toHaveBeenCalledWith(req, 'Apex', 'Apex\\QA');
    expect(createTestCaseWorkItem).toHaveBeenCalledTimes(1);

    dbMock.state.suiteRow.status = 'generating';
    await expect(publishAdoTestCases('suite-1', { ado: { createTestCaseWorkItem } }))
      .rejects.toThrow('publish waits until generation is ready');
    expect(createTestCaseWorkItem).toHaveBeenCalledTimes(1);
  });

  it('returns the latest suite and drops incomplete publish mappings', async () => {
    dbMock.state.suiteRow = {
      id: 'suite-1',
      project: 'Apex',
      rootWorkItemId: 100,
      rootWorkItemType: 'Feature',
      rootTitle: 'Notifications',
      status: 'ready',
      chatThreadId: 'thread-ado',
      sourceSnapshot: { root: { id: 100 } },
      testCasesJson: { suites: [] },
      testCasesMd: '# cases',
      coverageSummary: null,
      publishedCases: [
        {
          localCaseId: 'TC-1',
          adoTestCaseId: 9,
          adoTestCaseUrl: 'https://ado.example/9',
          parentWorkItemId: 18452,
          publishedAt: '2026-10-10T00:00:00.000Z',
        },
        { localCaseId: 'broken' },
      ],
      createdBy: 'user-1',
      createdAt: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-10T01:00:00.000Z',
    };

    const latest = await getLatestAdoTestSuite('Apex', 100);

    expect(latest).toEqual(expect.objectContaining({
      id: 'suite-1',
      project: 'Apex',
      rootWorkItemId: 100,
      status: 'ready',
    }));
    expect(latest?.publishedCases).toEqual([{
      localCaseId: 'TC-1',
      adoTestCaseId: 9,
      adoTestCaseUrl: 'https://ado.example/9',
      parentWorkItemId: 18452,
      publishedAt: '2026-10-10T00:00:00.000Z',
    }]);
    await expect(getLatestAdoTestSuite(undefined, undefined, 'suite-1')).resolves.toEqual(latest);
    await expect(getLatestAdoTestSuite('Apex', 100)).resolves.toEqual(latest);
    dbMock.state.suiteRow = null;
    await expect(getLatestAdoTestSuite('Apex', 404)).resolves.toBeNull();
  });

  it('requires a write client when publishing', async () => {
    dbMock.state.suiteRow = {
      id: 'suite-1',
      project: 'Apex',
      status: 'ready',
      publishedCases: [],
      testCasesJson: {
        suites: [{
          pbiId: 'PBI-18452',
          testCases: [{ id: 'TC-1', title: 'Saves', steps: [] }],
        }],
      },
    };

    await expect(publishAdoTestCases('suite-1')).rejects.toThrow(
      'An Azure DevOps write client, request, or token is required to publish test cases',
    );
    expect(adoWriteFromToken).not.toHaveBeenCalled();
  });
});
