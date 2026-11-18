/**
 * PBI-001 (AC-0, AC-1, AC-2, AC-3) and TBI-001 (VT-07, VT-08, VT-09, VT-10):
 * My Work local development pack generation, Cloud Agent error/cancel/resume
 * behavior, and Developer/Admin access gating on `@cursor/sdk` 1.4.0.
 */
const mockPrdsFindFirst = jest.fn();
const mockTestCasesFindFirst = jest.fn();
const mockDesignDocsFindFirst = jest.fn();
const mockDesignPrototypesFindFirst = jest.fn();
const mockDevSessionFindFirst = jest.fn();
const mockAgentRunFindFirst = jest.fn();
const mockSelect = jest.fn();
const mockTransaction = jest.fn();
const mockUpdateSet = jest.fn();
const mockUpdateWhere = jest.fn();
const mockGetSkillConfig = jest.fn();
const mockIsFeatureEnabled = jest.fn().mockResolvedValue(true);
const mockEnqueue = jest.fn();
const mockCaptureCloudAgentIdentity = jest.fn();
const mockRequestCancel = jest.fn();
const mockMarkTerminal = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      prds: { findFirst: (...args: unknown[]) => mockPrdsFindFirst(...args) },
      testCases: { findFirst: (...args: unknown[]) => mockTestCasesFindFirst(...args) },
      designDocs: { findFirst: (...args: unknown[]) => mockDesignDocsFindFirst(...args) },
      designPrototypes: { findFirst: (...args: unknown[]) => mockDesignPrototypesFindFirst(...args) },
      devSessions: { findFirst: (...args: unknown[]) => mockDevSessionFindFirst(...args) },
      agentRuns: { findFirst: (...args: unknown[]) => mockAgentRunFindFirst(...args) },
    },
    select: (...args: unknown[]) => mockSelect(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
    update: () => ({
      set: (...setArgs: unknown[]) => {
        mockUpdateSet(...setArgs);
        return {
          where: (...whereArgs: unknown[]) => {
            const result = mockUpdateWhere(...whereArgs);
            const pending = result instanceof Promise ? result : Promise.resolve(result);
            return Object.assign(pending, { returning: () => pending });
          },
        };
      },
    }),
  },
}));

jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: (...args: unknown[]) => mockGetSkillConfig(...args),
}));

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

jest.mock('../services/agentRunLifecycleService', () => ({
  enqueue: (...args: unknown[]) => mockEnqueue(...args),
  captureCloudAgentIdentity: (...args: unknown[]) => mockCaptureCloudAgentIdentity(...args),
  requestCancel: (...args: unknown[]) => mockRequestCancel(...args),
  markTerminal: (...args: unknown[]) => mockMarkTerminal(...args),
}));

jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));
jest.mock('../services/myWorkSessionLogger', () => ({ logMyWorkSession: jest.fn() }));
jest.mock('../services/agentRunReaperService', () => ({
  resolveAgentRunHardLimitMs: jest.fn().mockReturnValue(7_200_000),
}));
jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/cloudAgentUsageService', () => ({
  recordCloudAgentUsage: jest.fn(),
}));
jest.mock('../services/workItemPrLinkService', () => ({
  ...jest.requireActual('../services/workItemPrLinkService'),
  linkWorkItemToPullRequest: jest.fn(),
}));

import { buildLocalDevContext } from '../services/localDevContextService';
import {
  cancelCloudAgentRun,
  CloudAgentLaunchError,
  getCloudAgentRunStatus,
  startCloudAgentRun,
  type CloudAgentServiceDeps,
} from '../services/cloudAgentService';
import { canAccessMyWork } from '../../client/utils/canAccessMyWork';

function emptySelectChain() {
  return {
    from: () => ({
      where: jest.fn().mockResolvedValue([]),
    }),
  };
}

function makeDeps(overrides: Partial<CloudAgentServiceDeps> = {}): CloudAgentServiceDeps {
  return {
    isFeatureEnabled: mockIsFeatureEnabled,
    getSkillConfig: mockGetSkillConfig,
    launchCloudAgent: jest.fn().mockResolvedValue({
      cloudAgentId: 'bc-140',
      cursorRunId: 'cursor-run-140',
      jobName: 'cursor-sdk',
    }),
    getCloudAgentRun: jest.fn(),
    streamCloudAgentRun: jest.fn() as unknown as CloudAgentServiceDeps['streamCloudAgentRun'],
    cancelCursorCloudAgentRun: jest.fn().mockResolvedValue(undefined),
    linkWorkItemToPullRequest: jest.fn().mockResolvedValue(undefined),
    transitionWorkItemForPullRequest: jest.fn().mockResolvedValue(undefined),
    addAdoWorkItemHyperlink: jest.fn().mockResolvedValue(undefined),
    prepareCloudAgentKickoff: jest.fn().mockResolvedValue(undefined),
    alignCloudAgentPullRequest: jest.fn().mockResolvedValue(undefined),
    getAdoPullRequestStatus: jest.fn().mockResolvedValue('open'),
    getGithubPullRequestStatus: jest.fn().mockResolvedValue('open'),
    retryWithBackoff: async <T>(fn: () => Promise<T>) => fn(),
    buildPrompt: jest.fn().mockResolvedValue('Implement #42 on 1.4.0'),
    persistLeftoverWork: jest.fn().mockResolvedValue({ firstWrite: true }),
    writeLeftoverWorkToAdo: jest.fn().mockResolvedValue(undefined),
    openCloudAgentPullRequest: jest.fn().mockResolvedValue('https://dev.azure.com/org/MaxView/_git/MaxView/pullrequest/9'),
    findWorkItemPullRequest: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('My Work on Cursor SDK 1.4.0 (PBI-001)', () => {
  let setImmediateSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    setImmediateSpy = jest
      .spyOn(global, 'setImmediate')
      .mockImplementation((() => ({})) as unknown as typeof setImmediate);
    mockSelect.mockImplementation(emptySelectChain);
    mockIsFeatureEnabled.mockResolvedValue(true);
    mockGetSkillConfig.mockResolvedValue({
      skillProvider: 'ado',
      skillRepo: 'MaxView',
      skillBranch: 'main',
      developmentSkillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
      developmentModel: 'composer-2.5',
    });
  });

  afterEach(() => {
    setImmediateSpy.mockRestore();
  });

  it('PBI-001 AC-0 / VT-07: builds the local development context pack with short paths and dev-orchestrator kickoff', async () => {
    mockPrdsFindFirst.mockResolvedValue({
      id: 'prd-140',
      project: 'Apex',
      status: 'approved',
      title: 'SDK 1.4 Upgrade',
      content: '# PRD content',
      backlogJson: {
        epics: [
          {
            title: 'SDK Upgrade',
            features: [{ id: 'FEAT-001', title: 'SDK adapter', items: [] }],
          },
        ],
      },
    });
    mockTestCasesFindFirst.mockResolvedValue(null);
    mockDesignDocsFindFirst.mockResolvedValue({
      title: 'SDK adapter',
      designContent: '# Design',
      techSpecContent: '# Tech spec',
      assumptionsContent: '# Assumptions',
      designPrototypeId: null,
    });
    mockDesignPrototypesFindFirst.mockResolvedValue(null);

    const pack = await buildLocalDevContext({
      project: 'Apex',
      prdId: 'prd-140',
      featureId: 'FEAT-001',
    });

    expect(pack.slug).toBe('feat-001');
    expect(pack.files.map((file) => file.name)).toEqual([
      '.ai-pilot/local-dev/feat-001/prd.md',
      '.ai-pilot/local-dev/feat-001/backlog.json',
      '.ai-pilot/local-dev/feat-001/design-spec/design.md',
      '.ai-pilot/local-dev/feat-001/design-spec/tech-spec.md',
      '.ai-pilot/local-dev/feat-001/design-spec/assumptions.md',
      '.ai-pilot/local-dev/feat-001/KICKOFF-PROMPT.md',
      '.ai-pilot/local-dev/feat-001/README.md',
    ]);
    expect(pack.prompt).toContain('/dev-orchestrator feature feat-001 FEAT-001');
  });

  it('PBI-001 AC-1 / VT-08: marks a Cloud Agent run failed with the SDK error and leaves the session ready to resume or retry', async () => {
    mockTransaction.mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        execute: jest.fn().mockResolvedValue(undefined),
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({ limit: jest.fn().mockResolvedValue([]) }),
            }),
          }),
        }),
        insert: () => ({ values: jest.fn().mockResolvedValue(undefined) }),
        update: () => ({ set: () => ({ where: jest.fn().mockResolvedValue(undefined) }) }),
      }),
    );
    mockEnqueue.mockResolvedValueOnce({ runId: 'run-sdk-err' });
    mockUpdateWhere.mockResolvedValueOnce([{ id: 'run-sdk-err' }]);
    mockAgentRunFindFirst.mockResolvedValueOnce({
      id: 'run-sdk-err',
      status: 'queued',
      cloudAgentIdentity: null,
      devSessionId: 'session-err',
      executionSnapshot: {
        prompt: 'Implement #42',
        model: 'composer-2.5',
        projectId: 'MaxView',
        repository: 'MaxView',
        provider: 'ado',
        threadId: 'session-err',
        cloudAgent: { baseBranch: 'main', workItemId: 42 },
      },
    });
    mockMarkTerminal.mockResolvedValueOnce({
      ok: true,
      run: { id: 'run-sdk-err', status: 'failed' },
    });

    const launchError = new Error('Cursor SDK 1.4.0 cloud agent rejected repository credentials');
    await startCloudAgentRun(
      {
        userId: 'user-1',
        project: 'MaxView',
        workItemId: 42,
        item: { workItemType: 'Feature', state: 'Committed', tags: 'apex' },
      },
      makeDeps({
        launchCloudAgent: jest.fn().mockRejectedValue(launchError),
      }),
    );

    expect(mockMarkTerminal).toHaveBeenCalledWith(
      'run-sdk-err',
      expect.objectContaining({
        status: 'failed',
        detail: 'Cursor SDK 1.4.0 cloud agent rejected repository credentials',
      }),
    );

    mockDevSessionFindFirst.mockResolvedValueOnce({
      id: 'session-err',
      authorId: 'user-1',
      project: 'MaxView',
      workItemId: 42,
      currentRunId: 'run-sdk-err',
      currentRunPrUrl: null,
    });
    mockAgentRunFindFirst.mockResolvedValueOnce({
      id: 'run-sdk-err',
      lane: 'cloud-agent',
      status: 'failed',
      terminalReason: null,
      lastError: launchError.message,
      checkResults: null,
      cloudAgentManaged: true,
      cloudAgentIdentity: null,
      cloudBranchName: 'feat/42-wi-42',
      cloudPrUrl: null,
      dispatchMessageId: null,
      createdAt: '2026-11-18T12:00:00.000Z',
      executionSnapshot: {},
    });

    const summary = await getCloudAgentRunStatus('session-err', 'user-1', makeDeps());
    expect(summary).toMatchObject({
      runId: 'run-sdk-err',
      status: 'failed',
      lastError: 'Cursor SDK 1.4.0 cloud agent rejected repository credentials',
      prUrl: null,
    });
  });

  it('PBI-001 AC-2 / VT-09: cancels a pre-upgrade Cloud Agent run and returns a clear message when resume lacks saved settings', async () => {
    const cancelVendor = jest.fn().mockResolvedValue(undefined);
    mockDevSessionFindFirst.mockResolvedValueOnce({
      id: 'session-legacy',
      authorId: 'user-1',
      project: 'MaxView',
      workItemId: 42,
      currentRunId: 'run-1037',
    });
    mockAgentRunFindFirst.mockResolvedValueOnce({
      id: 'run-1037',
      status: 'running',
      cloudAgentIdentity: 'bc-1037',
      dispatchMessageId: 'cursor-run-1037',
    });
    mockRequestCancel.mockResolvedValueOnce({
      ok: true,
      run: {
        id: 'run-1037',
        status: 'running',
        cloudAgentIdentity: 'bc-1037',
        dispatchMessageId: 'cursor-run-1037',
      },
    });
    mockMarkTerminal.mockResolvedValueOnce({
      ok: true,
      run: {
        id: 'run-1037',
        status: 'cancelled',
        terminalReason: 'forced_cancel',
        cloudAgentIdentity: 'bc-1037',
        dispatchMessageId: 'cursor-run-1037',
      },
    });

    const cancelled = await cancelCloudAgentRun(
      'session-legacy',
      'user-1',
      makeDeps({ cancelCursorCloudAgentRun: cancelVendor }),
    );
    expect(cancelled).toEqual({ ok: true, status: 'cancelled' });
    expect(cancelVendor).toHaveBeenCalledWith({
      project: 'MaxView',
      cloudAgentId: 'bc-1037',
      cursorRunId: 'cursor-run-1037',
    });

    // loadLiveRunWorkItemIds (1), resolveCloudAgentCustomPrompt->loadPrior (2), resolveChooserLaunch->loadPrior (3)
    const priorSessionChain = {
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: jest.fn().mockResolvedValue([{ currentRunId: 'run-1037' }]),
          }),
        }),
      }),
    };
    mockSelect
      .mockReturnValueOnce(emptySelectChain())
      .mockReturnValueOnce(priorSessionChain)
      .mockReturnValueOnce(priorSessionChain);
    mockAgentRunFindFirst.mockResolvedValue({
      id: 'run-1037',
      executionSnapshot: { prompt: 'legacy prompt without model' },
    });

    await expect(
      startCloudAgentRun(
        {
          userId: 'user-1',
          project: 'MaxView',
          workItemId: 42,
          item: { workItemType: 'Feature', state: 'Committed', tags: 'apex' },
          launchChooser: true,
          intent: 'resume',
          availableSkills: [{ name: 'dev-orchestrator', path: '.cursor/skills/dev-orchestrator/SKILL.md', description: '' }],
          allowedModelIds: ['composer-2.5'],
        },
        makeDeps(),
      ),
    ).rejects.toThrow(
      new CloudAgentLaunchError(
        'Resume needs the skill and model saved on the original run. Retry to choose new ones.',
      ),
    );
  });

  it('PBI-001 AC-3 / VT-10: denies My Work access when the user is outside Developer, Project Admin, and Platform Admin', () => {
    expect(
      canAccessMyWork({
        can: (permission) => permission === 'dev-workbench:view',
        isSuperAdmin: false,
        isInAnyGroup: (groups) => groups.includes('BA'),
        enabledViews: ['my-work'],
      }),
    ).toBe(false);
  });
});
