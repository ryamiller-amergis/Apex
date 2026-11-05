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
  updateThreadKickoffContext,
} from '../services/chatAgentService';
import { resolveSkillConfig } from '../services/projectSettingsService';
import { readRemoteBranchTip } from '../services/repoCacheService';
import { propagatePipelineGrounding, runGroundingService } from '../services/runGroundingService';
import {
  ADO_TEST_SUITE_WATCHER_INTERVAL_MS,
  AdoTestSuiteConflictError,
  adoBacklogPbiId,
  adoBacklogTbiId,
  buildSyntheticAdoBacklog,
  buildTestCaseStepsXml,
  deleteAdoTestCases,
  getLatestAdoTestSuite,
  inferUserTypes,
  isAdoTestSuiteWatcherActive,
  listAdoGenerationCandidates,
  newPlacementsFrom,
  publishAdoTestCases,
  resetAdoTestSuiteWatchersForTests,
  syncAdoTestSuiteOutput,
  syncAdoTestSuiteRunOutput,
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

jest.mock('../services/repoCacheService', () => ({
  readRemoteBranchTip: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/runGroundingService', () => ({
  propagatePipelineGrounding: jest.fn(),
  runGroundingService: {
    getGroundings: jest.fn().mockResolvedValue([]),
    activateGroundings: jest.fn().mockResolvedValue(undefined),
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

async function settleBackgroundDispatch(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
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

  it('falls back to a generic User when the work items name no user type', () => {
    const backlog = buildSyntheticAdoBacklog(generationContext());

    expect(backlog.personas.map((persona) => persona.name)).toEqual(['User']);
    expect(backlog.epics[0].features[0].affectedPersonas).toEqual(['User']);
    expect(pbiItem(backlog, 'PBI-18452').userStory.persona).toBe('User');
  });

  it('uses the user types named in the work items as personas', () => {
    const context = generationContext();
    context.targets[0].description = '<p>As an External User, I want to toggle alerts.</p>';
    context.targets[1].reproSteps = '<div>Internal users see the toggle reset after reload.</div>';

    const backlog = buildSyntheticAdoBacklog(context);

    expect(backlog.personas.map((persona) => persona.name)).toEqual(['External User', 'Internal User']);
    expect(backlog.epics[0].features[0].affectedPersonas).toEqual(['External User', 'Internal User']);
    expect(pbiItem(backlog, 'PBI-18452').userStory.persona).toBe('External User');
    expect(pbiItem(backlog, 'PBI-18499').userStory.persona).toBe('Internal User');
  });
});

describe('buildTestCaseStepsXml', () => {
  it('keeps line breaks and escapes step text as HTML inside XML', () => {
    expect(buildTestCaseStepsXml([
      { action: 'Go to Test Environment:\n- For QA, use https://qa.example.com', expected: 'Login & <Home> display.' },
      { action: 'Precondition: Status = Submitted.', expected: '' },
    ])).toBe(
      '<steps id="0" last="2">'
      + '<step id="1" type="ActionStep">'
      + '<parameterizedString isformatted="true">Go to Test Environment:&lt;br/&gt;- For QA, use https://qa.example.com</parameterizedString>'
      + '<parameterizedString isformatted="true">Login &amp;amp; &amp;lt;Home&amp;gt; display.</parameterizedString>'
      + '</step>'
      + '<step id="2" type="ActionStep">'
      + '<parameterizedString isformatted="true">Precondition: Status = Submitted.</parameterizedString>'
      + '<parameterizedString isformatted="true"></parameterizedString>'
      + '</step></steps>',
    );
  });
});

describe('inferUserTypes', () => {
  it('reads "As a …" stories and user-type phrases in order', () => {
    expect(inferUserTypes('As a recruiter, I want to post jobs. Guest users can only browse.'))
      .toEqual(['Recruiter', 'Guest User']);
  });

  it('ignores phrases that are not user types', () => {
    expect(inferUserTypes('As a result, the list refreshes. As an example, I click Save.')).toEqual([]);
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
    await settleBackgroundDispatch();

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

  it('writes the existing Test Cases and suite index the skill checks before writing new cases', async () => {
    const plans = [{ planId: 7, planName: 'Release 1', suites: [] }];
    const linkedCase = {
      id: 900,
      title: 'Sends a notification',
      state: 'Design',
      steps: [{ action: 'Open', expected: 'Opens' }],
      url: 'https://dev.azure.com/org/Apex/_workitems/edit/900',
    };
    const ado = {
      getQaTestGenerationContext: jest.fn().mockResolvedValue(generationContext()),
      listStaticTestPlanSuites: jest.fn().mockResolvedValue(plans),
      listLinkedTestCases: jest.fn().mockResolvedValue(new Map([[18452, [linkedCase]], [18499, []]])),
      listSuiteCaseIndex: jest.fn().mockResolvedValue({
        entries: [
          { id: 901, title: 'Mutes a channel', planName: 'Release 1', suitePath: 'Settings' },
          { id: 902, title: 'Opens the bell', planName: 'Release 1', suitePath: '' },
        ],
        truncated: true,
      }),
    };

    await triggerAdoTestCaseGeneration({ project: 'Apex', rootWorkItemId: 100, userId: 'user-1', ado });
    await settleBackgroundDispatch();

    expect(ado.listLinkedTestCases).toHaveBeenCalledWith([18452, 18499]);
    expect(ado.listSuiteCaseIndex).toHaveBeenCalledWith(plans);
    expect(JSON.parse(fs.readFileSync(
      path.join(workspaceDir, '.ai-pilot', 'existing-test-cases.json'),
      'utf-8',
    ))).toEqual({ 'PBI-18452': [linkedCase] });
    const index = fs.readFileSync(path.join(workspaceDir, '.ai-pilot', 'test-case-index.md'), 'utf-8');
    expect(index).toContain('## Release 1');
    expect(index).toContain('- 901 | Settings | Mutes a channel');
    expect(index).toContain('- 902 | (plan root) | Opens the bell');
    const kickoff = jest.mocked(updateThreadKickoffContext).mock.lastCall?.[1] as string;
    expect(kickoff).toContain('## Existing test cases');
    expect(kickoff).toContain('.ai-pilot/existing-test-cases.json');
    expect(kickoff).toContain('Suite case index incomplete');
  });

  it('tells the skill existing cases were not checked when Azure DevOps cannot list them', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ado = {
      getQaTestGenerationContext: jest.fn().mockResolvedValue(generationContext()),
      listLinkedTestCases: jest.fn().mockRejectedValue(new Error('403')),
      listSuiteCaseIndex: jest.fn().mockResolvedValue({ entries: [], truncated: false }),
    };

    const result = await triggerAdoTestCaseGeneration({ project: 'Apex', rootWorkItemId: 100, userId: 'user-1', ado });
    await settleBackgroundDispatch();

    expect(result).toEqual(expect.objectContaining({ started: true }));
    expect(fs.existsSync(path.join(workspaceDir, '.ai-pilot', 'existing-test-cases.json'))).toBe(false);
    const kickoff = jest.mocked(updateThreadKickoffContext).mock.lastCall?.[1] as string;
    expect(kickoff).toContain('Existing cases not checked');
  });

  describe('commit pin before routing', () => {
    const SHA = 'a'.repeat(40);
    const pinned = {
      repoRole: 'target',
      isActive: true,
      project: 'Apex',
      groundedSha: SHA,
    };
    let preparedGrounding: unknown;

    beforeEach(() => {
      preparedGrounding = 'unset';
      jest.mocked(readRemoteBranchTip).mockReset();
      jest.mocked(runGroundingService.getGroundings).mockReset();
      jest.mocked(runGroundingService.activateGroundings).mockReset();
      jest.mocked(routeBackgroundWorkflow).mockImplementation(async (input) => {
        preparedGrounding = (await input.prepareWorker()).targetGrounding;
        return { route: 'v2', reason: 'flag-enabled' } as never;
      });
    });

    async function generate(): Promise<void> {
      const ado = { getQaTestGenerationContext: jest.fn().mockResolvedValue(generationContext()) };
      await triggerAdoTestCaseGeneration({ project: 'Apex', rootWorkItemId: 100, userId: 'user-1', ado });
      await settleBackgroundDispatch();
    }

    it('keeps a commit pin the run already has', async () => {
      jest.mocked(runGroundingService.getGroundings).mockResolvedValue([pinned] as never);

      await generate();

      expect(preparedGrounding).toBe(pinned);
      expect(readRemoteBranchTip).not.toHaveBeenCalled();
      expect(runGroundingService.activateGroundings).not.toHaveBeenCalled();
    });

    it('pins the skill branch tip when the run has no commit pin', async () => {
      jest.mocked(runGroundingService.getGroundings)
        .mockResolvedValueOnce([])
        .mockResolvedValue([pinned] as never);
      jest.mocked(readRemoteBranchTip).mockResolvedValue(SHA);

      await generate();

      expect(readRemoteBranchTip).toHaveBeenCalledWith({
        provider: 'ado',
        project: 'Apex',
        repo: 'org/skills',
        branch: 'main',
      });
      expect(runGroundingService.activateGroundings).toHaveBeenCalledWith({
        run: { runType: 'chat', runId: 'thread-ado', project: 'Apex' },
        target: {
          provider: 'azure_devops',
          repository: 'org/skills',
          branch: 'main',
          groundedSha: SHA,
        },
      });
      expect(preparedGrounding).toBe(pinned);
    });
  });

  it('generates only the chosen targets and keeps TBIs as context', async () => {
    const ado = { getQaTestGenerationContext: jest.fn().mockResolvedValue(generationContext()) };

    const result = await triggerAdoTestCaseGeneration({
      project: 'Apex',
      rootWorkItemId: 100,
      userId: 'user-1',
      targetIds: [18499],
      ado,
    });
    await settleBackgroundDispatch();

    expect(result).toEqual(expect.objectContaining({ started: true }));
    const inserted = dbMock.state.inserts[0] as { sourceSnapshot: QaAdoGenerationContext };
    expect(inserted.sourceSnapshot.targets.map((target) => target.id)).toEqual([18499]);
    expect(inserted.sourceSnapshot.technicalContext.map((item) => item.id)).toEqual([18500]);
    expect(JSON.parse(fs.readFileSync(
      path.join(workspaceDir, '.ai-pilot', 'output', 'qa-lab-scope.json'),
      'utf-8',
    ))).toEqual({ pbiIds: ['PBI-18499'] });
  });

  it('returns no-targets when none of the chosen ids are under the root', async () => {
    const ado = { getQaTestGenerationContext: jest.fn().mockResolvedValue(generationContext()) };

    const result = await triggerAdoTestCaseGeneration({
      project: 'Apex',
      rootWorkItemId: 100,
      userId: 'user-1',
      targetIds: [999],
      ado,
    });

    expect(result).toEqual({ started: false, reason: 'no-targets' });
    expect(dbMock.state.inserts).toHaveLength(0);
  });

  it('lists PBI and Bug candidates beneath the root', async () => {
    const ado = { getQaTestGenerationContext: jest.fn().mockResolvedValue(generationContext()) };

    const candidates = await listAdoGenerationCandidates('Apex', 100, ado);

    expect(candidates?.rootWorkItemId).toBe(100);
    expect(candidates?.items.map((item) => item.id)).toEqual([18452, 18499]);
    expect(candidates?.items[0]).toEqual(expect.objectContaining({
      title: expect.any(String),
      workItemType: expect.any(String),
    }));
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
    await settleBackgroundDispatch();

    expect(result).toEqual({
      started: true,
      suiteId: 'suite-new',
      threadId: 'thread-ado',
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
    await settleBackgroundDispatch();

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

  it('stores the current version of flagged existing cases and treats unknown ids as new', async () => {
    const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const flag = (adoTestCaseId: number) => ({
      adoTestCaseId,
      status: 'needs-update',
      reason: 'Steps changed',
      source: 'suite',
    });
    fs.writeFileSync(
      path.join(outputDir, 'notifications.test-cases.json'),
      JSON.stringify({
        suites: [{
          pbiId: 'PBI-18452',
          testCases: [
            { id: 'TC-1', title: 'Saves', steps: [], existing: flag(900) },
            { id: 'TC-2', title: 'Mutes', steps: [], existing: flag(404) },
            { id: 'TC-3', title: 'Opens', steps: [], existing: { adoTestCaseId: 'abc' } },
          ],
        }],
      }),
    );
    dbMock.state.threadRow = { workspaceDir };
    dbMock.state.suiteRow = { id: 'suite-1', chatThreadId: 'thread-ado', status: 'generating', project: 'Apex' };
    const current = {
      id: 900,
      title: 'Saves the form',
      state: 'Ready',
      steps: [{ order: 1, action: 'Click save', expected: 'Saved' }],
      url: 'https://dev.azure.com/org/Apex/_workitems/edit/900',
    };
    const ado = { getTestCasesById: jest.fn().mockResolvedValue([current]) };

    await expect(syncAdoTestSuiteOutput('suite-1', 'thread-ado', undefined, ado)).resolves.toBe(true);

    expect(ado.getTestCasesById).toHaveBeenCalledWith([900, 404]);
    const stored = dbMock.state.updates[0].testCasesJson as {
      suites: Array<{ testCases: Array<Record<string, unknown>> }>;
    };
    const [saves, mutes, opens] = stored.suites[0].testCases;
    expect(saves.existing).toEqual({ ...flag(900), current });
    expect(mutes).not.toHaveProperty('existing');
    expect(opens).not.toHaveProperty('existing');
  });

  it('records whether each existing case is in a Test Plan, and leaves it unknown when the read fails', async () => {
    const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const flag = (adoTestCaseId: number) => ({ adoTestCaseId, status: 'up-to-date', reason: 'Same', source: 'linked' });
    const output = JSON.stringify({
      suites: [{
        pbiId: 'PBI-18452',
        testCases: [
          { id: 'TC-1', title: 'Saves', steps: [], existing: flag(900) },
          { id: 'TC-2', title: 'Mutes', steps: [], existing: flag(901) },
        ],
      }],
    });
    const caseFor = (id: number) => ({ id, title: `Case ${id}`, state: 'Ready', steps: [], url: `https://ado.example/${id}` });
    const getTestCasesById = jest.fn().mockResolvedValue([caseFor(900), caseFor(901)]);
    const storedExisting = () => (dbMock.state.updates[dbMock.state.updates.length - 1].testCasesJson as {
      suites: Array<{ testCases: Array<{ existing: Record<string, unknown> }> }>;
    }).suites[0].testCases.map((testCase) => testCase.existing);
    dbMock.state.threadRow = { workspaceDir };

    fs.writeFileSync(path.join(outputDir, 'notifications.test-cases.json'), output);
    dbMock.state.suiteRow = { id: 'suite-1', chatThreadId: 'thread-ado', status: 'generating', project: 'Apex' };
    const listTestCasesInSuites = jest.fn().mockResolvedValue(new Set([900]));
    await syncAdoTestSuiteOutput('suite-1', 'thread-ado', undefined, { getTestCasesById, listTestCasesInSuites });
    expect(listTestCasesInSuites).toHaveBeenCalledWith([900, 901]);
    expect(storedExisting().map((existing) => existing.inTestPlan)).toEqual([true, false]);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'notifications.test-cases.json'), output);
    dbMock.state.suiteRow = { id: 'suite-1', chatThreadId: 'thread-ado', status: 'generating', project: 'Apex' };
    await syncAdoTestSuiteOutput('suite-1', 'thread-ado', undefined, {
      getTestCasesById,
      listTestCasesInSuites: jest.fn().mockRejectedValue(new Error('403')),
    });
    expect(storedExisting().every((existing) => !('inTestPlan' in existing))).toBe(true);
  });

  it('syncs worker-harvested output from a workspace other than the thread workspace', async () => {
    const harvestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-suite-harvest-'));
    try {
      const outputDir = path.join(harvestDir, '.ai-pilot', 'output');
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(
        path.join(outputDir, 'notifications.test-cases.json'),
        JSON.stringify({ suites: [{ pbiId: 'PBI-18452', testCases: [{ id: 'TC-1', title: 'Saves' }] }] }),
      );
      fs.writeFileSync(path.join(outputDir, 'notifications.test-cases.md'), '# harvested');
      dbMock.state.threadRow = { workspaceDir };
      dbMock.state.suiteRow = { id: 'suite-1', chatThreadId: 'thread-ado', status: 'generating' };

      await expect(syncAdoTestSuiteRunOutput('thread-ado', harvestDir)).resolves.toBe(true);

      expect(dbMock.state.updates[0]).toEqual(expect.objectContaining({
        status: 'ready',
        testCasesMd: '# harvested',
      }));
    } finally {
      fs.rmSync(harvestDir, { recursive: true, force: true });
    }
  });

  it('marks the suite failed when a finished run left no output', async () => {
    dbMock.state.threadRow = { workspaceDir };
    dbMock.state.suiteRow = { id: 'suite-1', chatThreadId: 'thread-ado', status: 'generating' };

    await expect(syncAdoTestSuiteRunOutput('thread-ado', workspaceDir)).resolves.toBe(true);

    expect(dbMock.state.updates).toContainEqual(expect.objectContaining({ status: 'failed' }));
  });

  it('logs the harvest failure reason when a run left no output', async () => {
    dbMock.state.threadRow = { workspaceDir };
    dbMock.state.suiteRow = { id: 'suite-1', chatThreadId: 'thread-ado', status: 'generating' };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await syncAdoTestSuiteRunOutput('thread-ado', workspaceDir, 'Artifact manifest contains unexpected document output');

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Artifact manifest contains unexpected document output'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores threads that do not belong to an ADO suite', async () => {
    dbMock.state.suiteRow = null;

    await expect(syncAdoTestSuiteRunOutput('thread-other', workspaceDir)).resolves.toBe(false);

    expect(dbMock.state.updates).toHaveLength(0);
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

  describe('publishing and deleting chosen cases', () => {
    const twoCaseSuite = (publishedCases: unknown[] = []) => ({
      id: 'suite-1',
      project: 'Apex',
      status: 'ready',
      sourceSnapshot: { root: { areaPath: 'Apex\\QA' } },
      publishedCases,
      testCasesJson: {
        suites: [{
          pbiId: 'PBI-18452',
          testCaseCount: 2,
          testCases: [
            { id: 'TC-1', title: 'Keep me', steps: ['Open'] },
            { id: 'TC-2', title: 'Drop me', steps: ['Close'] },
          ],
        }],
      },
    });

    it('publishes only the requested case ids', async () => {
      const createTestCaseWorkItem = jest.fn().mockResolvedValue({ id: 9001, url: 'https://ado.example/9001' });
      dbMock.state.suiteRow = twoCaseSuite();

      const result = await publishAdoTestCases('suite-1', {
        ado: { createTestCaseWorkItem },
        localCaseIds: ['TC-2'],
      });

      expect(result.published.map((item) => item.localCaseId)).toEqual(['TC-2']);
      expect(createTestCaseWorkItem).toHaveBeenCalledTimes(1);
      expect(createTestCaseWorkItem).toHaveBeenCalledWith(expect.objectContaining({ title: 'Drop me' }));
    });

    it('never publishes unit or integration checks as Test Cases', async () => {
      const createTestCaseWorkItem = jest.fn().mockResolvedValue({ id: 9001, url: 'https://ado.example/9001' });
      const row = twoCaseSuite();
      const testCases = (row.testCasesJson.suites[0].testCases as Array<Record<string, unknown>>);
      testCases[1].automation = { recommendedTier: 'unit' };
      dbMock.state.suiteRow = row;

      const all = await publishAdoTestCases('suite-1', { ado: { createTestCaseWorkItem } });
      const forced = await publishAdoTestCases('suite-1', {
        ado: { createTestCaseWorkItem },
        localCaseIds: ['TC-2'],
      });

      expect(all.published.map((item) => item.localCaseId)).toEqual(['TC-1']);
      expect(forced.failures).toEqual([{
        localCaseId: 'TC-2',
        message: 'Unit and integration checks are not published as Test Cases',
      }]);
      expect(createTestCaseWorkItem).toHaveBeenCalledTimes(1);
    });

    it('skips existing cases and updates a needs-update case only when QA chooses it', async () => {
      const createTestCaseWorkItem = jest.fn().mockResolvedValue({ id: 9001, url: 'https://ado.example/9001' });
      const updateTestCaseWorkItem = jest.fn().mockResolvedValue({ id: 700, url: 'https://ado.example/700' });
      const ado = { createTestCaseWorkItem, updateTestCaseWorkItem };
      const row = twoCaseSuite();
      const testCases = (row.testCasesJson.suites[0].testCases as Array<Record<string, unknown>>);
      testCases[0].existing = { adoTestCaseId: 600, status: 'up-to-date', reason: 'Same', source: 'linked' };
      testCases[1].existing = { adoTestCaseId: 700, status: 'needs-update', reason: 'New step', source: 'suite' };
      dbMock.state.suiteRow = row;

      const all = await publishAdoTestCases('suite-1', { ado });
      const forced = await publishAdoTestCases('suite-1', { ado, localCaseIds: ['TC-1', 'TC-2'] });
      const wrongUpdate = await publishAdoTestCases('suite-1', { ado, localCaseIds: [], updateLocalCaseIds: ['TC-1'] });
      const updated = await publishAdoTestCases('suite-1', { ado, localCaseIds: [], updateLocalCaseIds: ['TC-2'] });
      const retried = await publishAdoTestCases('suite-1', { ado, localCaseIds: [], updateLocalCaseIds: ['TC-2'] });

      expect(all.published).toEqual([]);
      expect(forced.skippedLocalCaseIds).toEqual(['TC-1', 'TC-2']);
      expect(wrongUpdate.failures).toEqual([{
        localCaseId: 'TC-1',
        message: 'Only cases that need an update can update an existing Test Case',
      }]);
      expect(createTestCaseWorkItem).not.toHaveBeenCalled();
      expect(updateTestCaseWorkItem).toHaveBeenCalledTimes(1);
      expect(updateTestCaseWorkItem).toHaveBeenCalledWith(expect.objectContaining({
        id: 700,
        title: 'Drop me',
        testedById: 18452,
      }));
      expect(updated.published).toEqual([expect.objectContaining({
        localCaseId: 'TC-2',
        adoTestCaseId: 700,
        action: 'updated',
      })]);
      expect(retried.skippedLocalCaseIds).toEqual(['TC-2']);
    });

    it('adds an existing case that is in no Test Plan to the chosen suite without creating one', async () => {
      const createTestCaseWorkItem = jest.fn();
      const addTestCasesToSuite = jest.fn().mockResolvedValue(undefined);
      const ado = { createTestCaseWorkItem, addTestCasesToSuite };
      const row = twoCaseSuite();
      const testCases = (row.testCasesJson.suites[0].testCases as Array<Record<string, unknown>>);
      testCases[0].existing = {
        adoTestCaseId: 600,
        status: 'up-to-date',
        reason: 'Same',
        source: 'linked',
        inTestPlan: false,
        current: { id: 600, title: 'Keep me', state: 'Ready', steps: [], url: 'https://ado.example/600' },
      };
      testCases[1].existing = { adoTestCaseId: 700, status: 'up-to-date', reason: 'Same', source: 'linked', inTestPlan: true };
      dbMock.state.suiteRow = row;
      const selections = { 'TC-1': { planId: 15, suiteId: 151 }, 'TC-2': { planId: 15, suiteId: 151 } };

      const unplaced = await publishAdoTestCases('suite-1', { ado, localCaseIds: ['TC-1'] });
      const placed = await publishAdoTestCases('suite-1', { ado, selections });

      expect(unplaced.skippedLocalCaseIds).toEqual(['TC-1']);
      expect(createTestCaseWorkItem).not.toHaveBeenCalled();
      expect(addTestCasesToSuite).toHaveBeenCalledTimes(1);
      expect(addTestCasesToSuite).toHaveBeenCalledWith(15, 151, [600]);
      expect(placed.published).toEqual([expect.objectContaining({
        localCaseId: 'TC-1',
        adoTestCaseId: 600,
        adoTestCaseUrl: 'https://ado.example/600',
        parentWorkItemId: 18452,
        testPlanId: 15,
        testSuiteId: 151,
        action: 'placed',
      })]);
      expect(placed.skippedLocalCaseIds).toEqual([]);
    });

    describe('approved new Test Plans and suites', () => {
      const existingPlans = [{
        id: 15,
        name: '15 Timesheets',
        suites: [{ id: 150, path: '' }, { id: 151, path: 'Geofence' }],
      }];
      const planWriter = () => ({
        createTestCaseWorkItem: jest.fn()
          .mockResolvedValueOnce({ id: 9001, url: 'https://ado.example/9001' })
          .mockResolvedValueOnce({ id: 9002, url: 'https://ado.example/9002' }),
        addTestCasesToSuite: jest.fn().mockResolvedValue(undefined),
        listStaticTestPlanSuites: jest.fn().mockResolvedValue(existingPlans),
        createTestPlan: jest.fn().mockResolvedValue({ id: 50, rootSuiteId: 500 }),
        createTestSuite: jest.fn()
          .mockResolvedValueOnce(501)
          .mockResolvedValueOnce(502),
      });

      it('creates a plan with a requirement suite once and links the cases without adding them', async () => {
        const ado = planWriter();
        dbMock.state.suiteRow = {
          ...twoCaseSuite(),
          sourceSnapshot: {
            root: { id: 18452, areaPath: 'Apex\\QA', title: 'Delete user', workItemType: 'Product Backlog Item' },
            targets: [{ id: 18452, title: 'Delete user', workItemType: 'Product Backlog Item' }],
          },
        };
        const approval = {
          key: 'delete user - functional testing|',
          testPlan: 'Delete User - Functional Testing',
          createPlan: true,
          suiteType: 'requirement' as const,
        };

        const result = await publishAdoTestCases('suite-1', {
          ado,
          newPlacements: [approval],
          newPlacementSelections: { 'TC-1': approval.key, 'TC-2': approval.key },
        });

        expect(result.failures).toEqual([]);
        expect(ado.createTestPlan).toHaveBeenCalledTimes(1);
        expect(ado.createTestPlan).toHaveBeenCalledWith('Delete User - Functional Testing');
        expect(ado.createTestSuite).toHaveBeenCalledTimes(1);
        expect(ado.createTestSuite).toHaveBeenCalledWith(50, 500, { name: '18452 : Delete user', requirementId: 18452 });
        expect(ado.addTestCasesToSuite).not.toHaveBeenCalled();
        expect(ado.createTestCaseWorkItem).toHaveBeenCalledWith(expect.objectContaining({ linkType: 'tested-by' }));
        expect(result.published).toEqual([
          expect.objectContaining({ localCaseId: 'TC-1', testPlanId: 50, testSuiteId: 501 }),
          expect.objectContaining({ localCaseId: 'TC-2', testPlanId: 50, testSuiteId: 501 }),
        ]);
      });

      it('reuses an existing plan and creates only the missing static suite segments', async () => {
        const ado = planWriter();
        dbMock.state.suiteRow = twoCaseSuite();
        const approval = {
          key: 'k',
          testPlan: '15 timesheets',
          testSuite: 'Geofence > Outside Radius',
          createPlan: true,
          suiteType: 'static' as const,
        };

        const result = await publishAdoTestCases('suite-1', {
          ado,
          localCaseIds: ['TC-1'],
          newPlacements: [approval],
          newPlacementSelections: { 'TC-1': 'k' },
        });

        expect(result.failures).toEqual([]);
        expect(ado.createTestPlan).not.toHaveBeenCalled();
        expect(ado.createTestSuite).toHaveBeenCalledTimes(1);
        expect(ado.createTestSuite).toHaveBeenCalledWith(15, 151, { name: 'Outside Radius' });
        expect(ado.addTestCasesToSuite).toHaveBeenCalledWith(15, 501, [9001]);
      });

      it('fails only the cases whose plan could not be created, and refuses unapproved keys', async () => {
        const ado = { ...planWriter(), createTestPlan: jest.fn().mockRejectedValue(new Error('Access denied')) };
        dbMock.state.suiteRow = twoCaseSuite();
        const approval = { key: 'k', testPlan: 'New Plan', createPlan: true, suiteType: 'requirement' as const };

        const result = await publishAdoTestCases('suite-1', {
          ado,
          newPlacements: [approval],
          newPlacementSelections: { 'TC-1': 'k', 'TC-2': 'not-approved' },
        });

        expect(ado.createTestPlan).toHaveBeenCalledTimes(1);
        expect(ado.createTestCaseWorkItem).not.toHaveBeenCalled();
        expect(result.failures).toEqual([
          { localCaseId: 'TC-1', message: 'Could not create the Test Plan or suite "New Plan": Access denied' },
          { localCaseId: 'TC-2', message: 'Approve the new Test Plan or suite for this case before publishing' },
        ]);
      });
    });

    it('keeps valid skill proposals and drops malformed ones', () => {
      expect(newPlacementsFrom({
        newPlacements: [
          { testPlan: 'Delete User - Functional Testing', createPlan: true, suiteType: 'requirement', reason: 'New feature' },
          { testPlan: '15 Timesheets', testSuite: 'Geofence > Radius', createPlan: false, suiteType: 'static', reason: 'r' },
          { testPlan: '15 Timesheets', createPlan: false, suiteType: 'static' },
          { testPlan: 'X', createPlan: 'yes', suiteType: 'static', testSuite: 'A' },
          { testPlan: 'X', createPlan: true, suiteType: 'query' },
          { testPlan: 'delete user - functional testing', createPlan: true, suiteType: 'requirement' },
        ],
      })).toEqual([
        {
          key: 'delete user - functional testing|',
          testPlan: 'Delete User - Functional Testing',
          createPlan: true,
          suiteType: 'requirement',
          reason: 'New feature',
        },
        {
          key: '15 timesheets|geofence > radius',
          testPlan: '15 Timesheets',
          testSuite: 'Geofence > Radius',
          createPlan: false,
          suiteType: 'static',
          reason: 'r',
        },
      ]);
    });

    it('removes unpublished cases and updates the suite count', async () => {
      dbMock.state.suiteRow = twoCaseSuite();

      const result = await deleteAdoTestCases('suite-1', ['TC-2', 'TC-missing']);

      expect(result.deletedLocalCaseIds).toEqual(['TC-2']);
      const saved = dbMock.state.suiteRow?.testCasesJson as {
        suites: Array<{ testCaseCount: number; testCases: Array<{ id: string }> }>;
      };
      expect(saved.suites[0].testCases.map((entry) => entry.id)).toEqual(['TC-1']);
      expect(saved.suites[0].testCaseCount).toBe(1);
    });

    it('refuses to delete a case already published to Azure DevOps', async () => {
      dbMock.state.suiteRow = twoCaseSuite([{
        localCaseId: 'TC-1',
        adoTestCaseId: 9001,
        adoTestCaseUrl: 'https://ado.example/9001',
        parentWorkItemId: 18452,
        publishedAt: '2026-11-03T00:00:00.000Z',
      }]);

      await expect(deleteAdoTestCases('suite-1', ['TC-1'])).rejects.toBeInstanceOf(AdoTestSuiteConflictError);
      const saved = dbMock.state.suiteRow?.testCasesJson as { suites: Array<{ testCases: unknown[] }> };
      expect(saved.suites[0].testCases).toHaveLength(2);
    });

    it('refuses to delete while the suite is generating', async () => {
      dbMock.state.suiteRow = { ...twoCaseSuite(), status: 'generating' };

      await expect(deleteAdoTestCases('suite-1', ['TC-2'])).rejects.toBeInstanceOf(AdoTestSuiteConflictError);
    });
  });

  it('files cases where the skill placement says, with per-case overrides', async () => {
    const createTestCaseWorkItem = jest.fn()
      .mockResolvedValueOnce({ id: 9101, url: 'https://ado.example/9101' })
      .mockResolvedValueOnce({ id: 9102, url: 'https://ado.example/9102' });
    dbMock.state.suiteRow = {
      id: 'suite-1',
      project: 'Apex',
      status: 'ready',
      sourceSnapshot: {
        root: { id: 18000, parentId: 17000, workItemType: 'Feature', title: 'Alerts', areaPath: 'Apex\\QA' },
        targets: [{ id: 18452, parentId: 18000, workItemType: 'Product Backlog Item', title: 'Save' }],
        technicalContext: [],
      },
      publishedCases: [],
      testCasesJson: {
        placement: { linkTo: 'parent', linkType: 'related', areaPath: 'Apex\\Alerts', tags: ['qa-lab'] },
        suites: [{
          pbiId: 'PBI-18452',
          testCases: [
            { id: 'TC-1', title: 'Saves', steps: ['Save'] },
            {
              id: 'TC-2',
              title: 'Reloads',
              steps: ['Reload'],
              placement: { linkTo: 'root', iterationPath: 'Apex\\Sprint 9', tags: ['regression'] },
            },
          ],
        }],
      },
    };

    const result = await publishAdoTestCases('suite-1', { ado: { createTestCaseWorkItem } });

    expect(result.failures).toEqual([]);
    expect(createTestCaseWorkItem).toHaveBeenNthCalledWith(1, expect.objectContaining({
      parentId: 18000,
      linkType: 'related',
      areaPath: 'Apex\\Alerts',
      tags: ['qa-lab'],
    }));
    expect(createTestCaseWorkItem).toHaveBeenNthCalledWith(2, expect.objectContaining({
      parentId: 18000,
      linkType: 'related',
      areaPath: 'Apex\\Alerts',
      iterationPath: 'Apex\\Sprint 9',
      tags: ['qa-lab', 'regression'],
    }));
    expect(result.published.map((item) => item.parentWorkItemId)).toEqual([18000, 18000]);
  });

  it('defaults to a Tested By link and the root area when the skill sets no placement', async () => {
    const createTestCaseWorkItem = jest.fn().mockResolvedValue({ id: 9201, url: 'https://ado.example/9201' });
    dbMock.state.suiteRow = {
      id: 'suite-1',
      project: 'Apex',
      status: 'ready',
      sourceSnapshot: { root: { areaPath: 'Apex\\QA' } },
      publishedCases: [],
      testCasesJson: {
        suites: [{ pbiId: 'PBI-18452', testCases: [{ id: 'TC-1', title: 'Saves', steps: ['Save'] }] }],
      },
    };

    await publishAdoTestCases('suite-1', { ado: { createTestCaseWorkItem } });

    const spec = createTestCaseWorkItem.mock.calls[0][0];
    expect(spec).toEqual(expect.objectContaining({
      parentId: 18452,
      linkType: 'tested-by',
      areaPath: 'Apex\\QA',
    }));
    expect(spec).not.toHaveProperty('tags');
  });

  it('reports invalid or out-of-project placement as a failure without writing', async () => {
    const createTestCaseWorkItem = jest.fn();
    dbMock.state.suiteRow = {
      id: 'suite-1',
      project: 'Apex',
      status: 'ready',
      sourceSnapshot: { root: { areaPath: 'Apex\\QA' } },
      publishedCases: [],
      testCasesJson: {
        suites: [{
          pbiId: 'PBI-18452',
          testCases: [
            { id: 'TC-1', title: 'Bad link', steps: ['x'], placement: { linkTo: 'epic' } },
            { id: 'TC-2', title: 'Other project', steps: ['x'], placement: { areaPath: 'OtherProject\\Team' } },
            { id: 'TC-3', title: 'No parent', steps: ['x'], placement: { linkTo: 'parent' } },
          ],
        }],
      },
    };

    const result = await publishAdoTestCases('suite-1', { ado: { createTestCaseWorkItem } });

    expect(createTestCaseWorkItem).not.toHaveBeenCalled();
    expect(result.failures).toEqual([
      { localCaseId: 'TC-1', message: expect.stringContaining('placement.linkTo must be one of') },
      { localCaseId: 'TC-2', message: expect.stringContaining('is not under the Apex project') },
      { localCaseId: 'TC-3', message: 'Work item 18452 has no parent to link to' },
    ]);
  });

  it('adds created cases to the confirmed suite and blocks unconfirmed cases when the skill requires a suite', async () => {
    const createTestCaseWorkItem = jest.fn().mockResolvedValue({ id: 9301, url: 'https://ado.example/9301' });
    const addTestCasesToSuite = jest.fn().mockResolvedValue(undefined);
    dbMock.state.suiteRow = {
      id: 'suite-1',
      project: 'Apex',
      status: 'ready',
      sourceSnapshot: { root: { areaPath: 'Apex\\QA' } },
      publishedCases: [],
      testCasesJson: {
        placement: { requireSuite: true },
        suites: [{
          pbiId: 'PBI-18452',
          testCases: [
            { id: 'TC-1', title: 'Saves', steps: ['Save'], placement: { testPlan: '15 Timesheets', testSuite: 'Create' } },
            { id: 'TC-2', title: 'Reloads', steps: ['Reload'] },
          ],
        }],
      },
    };

    const result = await publishAdoTestCases('suite-1', {
      ado: { createTestCaseWorkItem, addTestCasesToSuite },
      selections: { 'TC-1': { planId: 15, suiteId: 150 } },
    });

    expect(addTestCasesToSuite).toHaveBeenCalledWith(15, 150, [9301]);
    expect(createTestCaseWorkItem).toHaveBeenCalledTimes(1);
    expect(result.published).toEqual([
      expect.objectContaining({ localCaseId: 'TC-1', testPlanId: 15, testSuiteId: 150 }),
    ]);
    expect(result.failures).toEqual([{
      localCaseId: 'TC-2',
      message: 'Confirm a Test Plan and suite for this case before publishing',
    }]);
  });

  it('keeps a created case when the suite add fails and retries only the suite add', async () => {
    const createTestCaseWorkItem = jest.fn().mockResolvedValue({ id: 9401, url: 'https://ado.example/9401' });
    const addTestCasesToSuite = jest.fn()
      .mockRejectedValueOnce(new Error('suite locked'))
      .mockResolvedValueOnce(undefined);
    dbMock.state.suiteRow = {
      id: 'suite-1',
      project: 'Apex',
      status: 'ready',
      sourceSnapshot: { root: { areaPath: 'Apex\\QA' } },
      publishedCases: [],
      testCasesJson: {
        suites: [{ pbiId: 'PBI-18452', testCases: [{ id: 'TC-1', title: 'Saves', steps: ['Save'] }] }],
      },
    };
    const options = {
      ado: { createTestCaseWorkItem, addTestCasesToSuite },
      selections: { 'TC-1': { planId: 15, suiteId: 150 } },
    };

    const first = await publishAdoTestCases('suite-1', options);
    expect(first.failures).toEqual([{
      localCaseId: 'TC-1',
      message: 'Created Test Case 9401 but could not add it to the suite: suite locked',
    }]);
    expect(dbMock.state.suiteRow?.publishedCases).toEqual([
      expect.objectContaining({ adoTestCaseId: 9401, suiteError: 'suite locked' }),
    ]);

    const second = await publishAdoTestCases('suite-1', options);
    expect(createTestCaseWorkItem).toHaveBeenCalledTimes(1);
    expect(addTestCasesToSuite).toHaveBeenCalledTimes(2);
    expect(second.failures).toEqual([]);
    expect(dbMock.state.suiteRow?.publishedCases).toEqual([
      expect.not.objectContaining({ suiteError: expect.anything() }),
    ]);
    expect((dbMock.state.suiteRow?.publishedCases as unknown[])[0]).toEqual(
      expect.objectContaining({ adoTestCaseId: 9401, testPlanId: 15, testSuiteId: 150 }),
    );
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
