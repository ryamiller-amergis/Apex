const mockDevSessionFindFirst = jest.fn();
const mockAgentRunFindFirst = jest.fn();
const mockRequestCancel = jest.fn();
const mockMarkTerminal = jest.fn();
const mockVendorCancel = jest.fn();
const mockUpdateSet = jest.fn();
const mockUpdateWhere = jest.fn();
const mockLinkWorkItemToPullRequest = jest.fn();
const mockAddAdoWorkItemHyperlink = jest.fn();
const mockGetAdoPullRequestStatus = jest.fn();
const mockGetGithubPullRequestStatus = jest.fn();
const mockTrackEvent = jest.fn();
const mockBuildLocalDevContext = jest.fn().mockResolvedValue({ files: [] });
const mockPersistLeftoverWork = jest.fn(async () => ({ firstWrite: true }));
const mockWriteLeftoverWorkToAdo = jest.fn(async () => undefined);

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      devSessions: { findFirst: (...args: unknown[]) => mockDevSessionFindFirst(...args) },
      agentRuns: { findFirst: (...args: unknown[]) => mockAgentRunFindFirst(...args) },
    },
    select: jest.fn(),
    update: () => ({
      set: (...setArgs: unknown[]) => {
        mockUpdateSet(...setArgs);
        return { where: (...whereArgs: unknown[]) => mockUpdateWhere(...whereArgs) };
      },
    }),
    transaction: jest.fn(),
  },
}));
jest.mock('../services/agentRunLifecycleService', () => ({
  enqueue: jest.fn(),
  captureCloudAgentIdentity: jest.fn(),
  requestCancel: (...args: unknown[]) => mockRequestCancel(...args),
  markTerminal: (...args: unknown[]) => mockMarkTerminal(...args),
}));
jest.mock('../services/telemetry', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));
jest.mock('../services/myWorkSessionLogger', () => ({
  logMyWorkSession: jest.fn(),
}));
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn().mockResolvedValue(true),
}));
jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/localDevContextService', () => ({
  buildLocalDevContext: (...args: unknown[]) => mockBuildLocalDevContext(...args),
}));
jest.mock('../services/agentRunReaperService', () => ({
  resolveAgentRunHardLimitMs: jest.fn().mockReturnValue(7_200_000),
}));
jest.mock('../services/cursorCloudAgentClient', () => ({
  launchCloudAgent: jest.fn(),
  getCloudAgentRun: jest.fn(),
  streamCloudAgentRun: jest.fn(),
  cancelCursorCloudAgentRun: (...args: unknown[]) => mockVendorCancel(...args),
}));
jest.mock('../services/workItemPrLinkService', () => ({
  ...jest.requireActual('../services/workItemPrLinkService'),
  linkWorkItemToPullRequest: (...args: unknown[]) => mockLinkWorkItemToPullRequest(...args),
}));

import {
  applyCloudAgentCompletion,
  buildCloudAgentPrompt,
  cancelCloudAgentRun,
  CloudAgentConflictError,
  evaluateCloudAgentEligibility,
  getCloudAgentActivityStream,
  getCloudAgentRunStatus,
  startCloudAgentRun,
  type CloudAgentServiceDeps,
} from '../services/cloudAgentService';
import type { RunCheckResult } from '../../shared/types/agentRunLifecycle';
import { shouldClaimAllChecksPassed } from '../../shared/utils/runCheckResults';
import { getSkillConfig } from '../services/projectSettingsService';

const eligibleItem = {
  workItemType: 'Feature',
  state: 'Committed',
  tags: 'apex; wave-1',
};

describe('evaluateCloudAgentEligibility (VT-01 / VT-02 / VT-05 / VT-11)', () => {
  it('allows an APEX Feature when flag, skill settings, and uniqueness are satisfied', () => {
    expect(evaluateCloudAgentEligibility({
      flagEnabled: true,
      project: 'MaxView',
      item: eligibleItem,
      isSuperAdmin: false,
      skillProvider: 'ado',
      skillRepo: 'MaxView',
      skillBranch: 'main',
      hasLiveRun: false,
    })).toEqual({ allowed: true });
  });

  it('rejects when the rollout flag is off', () => {
    expect(evaluateCloudAgentEligibility({
      flagEnabled: false,
      project: 'MaxView',
      item: eligibleItem,
      isSuperAdmin: false,
      skillProvider: 'ado',
      skillRepo: 'MaxView',
      skillBranch: 'main',
      hasLiveRun: false,
    })).toEqual({
      allowed: false,
      reason: 'Cloud Development is not enabled for this project.',
    });
  });

  it('rejects app-native projects before ADO type checks', () => {
    expect(evaluateCloudAgentEligibility({
      flagEnabled: true,
      project: 'Apex',
      item: eligibleItem,
      isSuperAdmin: false,
      skillProvider: 'ado',
      skillRepo: 'Apex',
      skillBranch: 'main',
      hasLiveRun: false,
    }).reason).toMatch(/Azure DevOps-configured projects/);
  });

  it('reuses Start Development type and origin rules for non-admins', () => {
    expect(evaluateCloudAgentEligibility({
      flagEnabled: true,
      project: 'MaxView',
      item: { ...eligibleItem, workItemType: 'Bug' },
      isSuperAdmin: false,
      skillProvider: 'ado',
      skillRepo: 'MaxView',
      skillBranch: 'main',
      hasLiveRun: false,
    }).reason).toMatch(/only available on Features/);
  });

  it('names the missing skillRepo field', () => {
    expect(evaluateCloudAgentEligibility({
      flagEnabled: true,
      project: 'MaxView',
      item: eligibleItem,
      isSuperAdmin: false,
      skillProvider: 'ado',
      skillRepo: '',
      skillBranch: 'main',
      hasLiveRun: false,
    })).toEqual({
      allowed: false,
      reason: 'Skill settings are incomplete: skillRepo is not set.',
    });
  });

  it('rejects a second live implementation run on the same work item', () => {
    expect(evaluateCloudAgentEligibility({
      flagEnabled: true,
      project: 'MaxView',
      item: eligibleItem,
      isSuperAdmin: false,
      skillProvider: 'github',
      skillRepo: 'org/repo',
      skillBranch: 'main',
      hasLiveRun: true,
    })).toEqual({
      allowed: false,
      reason: 'A Cloud Agent run is already in progress on this work item.',
    });
  });
});

const SESSION_ID = 'session-1';
const USER_ID = 'user-1';
const RUN_ID = 'run-1';

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    authorId: USER_ID,
    project: 'MaxView',
    currentRunId: RUN_ID,
    currentRunPrUrl: null,
    currentRunPrStatus: 'none',
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    threadId: SESSION_ID,
    status: 'running',
    projectId: 'MaxView',
    lane: 'cloud-agent',
    dispatchMessageId: 'cursor-run-1',
    cloudAgentIdentity: 'bc-agent-1',
    cloudAgentManaged: true,
    cancelRequested: false,
    cancelState: null,
    terminalReason: null,
    checkResults: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CloudAgentServiceDeps> = {}): CloudAgentServiceDeps {
  return {
    isFeatureEnabled: jest.fn().mockResolvedValue(true),
    getSkillConfig: jest.fn().mockResolvedValue(null),
    launchCloudAgent: jest.fn(),
    getCloudAgentRun: jest.fn(),
    streamCloudAgentRun: jest.fn(),
    cancelCursorCloudAgentRun: mockVendorCancel,
    linkWorkItemToPullRequest: mockLinkWorkItemToPullRequest,
    addAdoWorkItemHyperlink: mockAddAdoWorkItemHyperlink,
    getAdoPullRequestStatus: mockGetAdoPullRequestStatus,
    getGithubPullRequestStatus: mockGetGithubPullRequestStatus,
    retryWithBackoff: async <T>(fn: () => Promise<T>) => fn(),
    buildPrompt: jest.fn().mockResolvedValue('prompt'),
    persistLeftoverWork: mockPersistLeftoverWork,
    writeLeftoverWorkToAdo: mockWriteLeftoverWorkToAdo,
    ...overrides,
  } as unknown as CloudAgentServiceDeps;
}

describe('getCloudAgentActivityStream', () => {
  it('opens the vendor stream with the stored agent and run identities', async () => {
    mockDevSessionFindFirst.mockResolvedValue(session());
    mockAgentRunFindFirst.mockResolvedValue(run());
    const stream = (async function* () {
      yield {
        id: '1:status:RUNNING',
        kind: 'status' as const,
        title: 'Cloud agent running',
      };
    })();
    const streamCloudAgentRun = jest.fn().mockReturnValue(stream);

    await expect(getCloudAgentActivityStream(
      SESSION_ID,
      USER_ID,
      RUN_ID,
      makeDeps({ streamCloudAgentRun }),
    )).resolves.toBe(stream);
    expect(streamCloudAgentRun).toHaveBeenCalledWith({
      project: 'MaxView',
      cloudAgentId: 'bc-agent-1',
      cursorRunId: 'cursor-run-1',
    });
  });

  it('does not expose a stream for another user or a replaced run', async () => {
    mockDevSessionFindFirst.mockResolvedValueOnce(undefined);

    await expect(getCloudAgentActivityStream(
      SESSION_ID,
      'other-user',
      RUN_ID,
      makeDeps(),
    )).rejects.toMatchObject({ status: 404 });

    mockDevSessionFindFirst.mockResolvedValueOnce(session({ currentRunId: 'run-2' }));
    await expect(getCloudAgentActivityStream(
      SESSION_ID,
      USER_ID,
      RUN_ID,
      makeDeps(),
    )).rejects.toMatchObject({ status: 409 });
  });

  it('requires the cloud identity before opening the stream', async () => {
    mockDevSessionFindFirst.mockResolvedValue(session());
    mockAgentRunFindFirst.mockResolvedValue(run({ cloudAgentIdentity: null }));

    await expect(getCloudAgentActivityStream(
      SESSION_ID,
      USER_ID,
      RUN_ID,
      makeDeps(),
    )).rejects.toMatchObject({ status: 409 });
  });
});

describe('startCloudAgentRun Resume prompt (TBI-007 DoD-1)', () => {
  it('appends prior leftover work to the dispatched snapshot, clears it at enqueue, and keeps the API response unchanged', async () => {
    const { db: mockedDb } = jest.requireMock('../db/drizzle') as {
      db: {
        select: jest.Mock;
        transaction: jest.Mock;
      };
    };
    const { enqueue: mockEnqueue } = jest.requireMock('../services/agentRunLifecycleService') as {
      enqueue: jest.Mock;
    };
    const txSet = jest.fn();
    const txWhere = jest.fn().mockResolvedValue(undefined);
    const priorSummary = {
      failingChecks: ['e2e'],
      missingPr: true,
      incompleteAcceptanceCriteria: ['AC-9'],
    };

    mockedDb.select.mockReturnValueOnce({
      from: () => ({ where: jest.fn().mockResolvedValue([]) }),
    });
    mockedDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: jest.fn().mockResolvedValue(undefined),
        select: jest.fn(() => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: jest.fn().mockResolvedValue([session({
                  leftoverWork: priorSummary,
                  currentRunId: null,
                })]),
              }),
            }),
          }),
        })),
        insert: jest.fn(),
        update: jest.fn(() => ({
          set: (...args: unknown[]) => {
            txSet(...args);
            return { where: txWhere };
          },
        })),
      };
      return callback(tx);
    });
    mockEnqueue.mockResolvedValueOnce({ runId: 'run-resume' });
    const setImmediateSpy = jest
      .spyOn(global, 'setImmediate')
      .mockImplementation((() => ({}) as NodeJS.Immediate) as unknown as typeof setImmediate);

    const result = await startCloudAgentRun({
      userId: USER_ID,
      project: 'MaxView',
      workItemId: 42,
      isSuperAdmin: false,
      item: eligibleItem,
    }, makeDeps({
      getSkillConfig: jest.fn().mockResolvedValue({
        skillProvider: 'ado',
        skillRepo: 'MaxView',
        skillBranch: 'main',
      }),
      buildPrompt: jest.fn().mockResolvedValue('base execution prompt'),
    }));

    expect(result).toEqual({ sessionId: SESSION_ID, runId: 'run-resume' });
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({
        prompt: expect.stringMatching(
          /base execution prompt[\s\S]*Failing check: e2e[\s\S]*No pull request was opened[\s\S]*AC-9/,
        ),
      }),
    }));
    expect(txSet).toHaveBeenCalledWith(expect.objectContaining({
      currentRunId: 'run-resume',
      leftoverWork: null,
    }));

    setImmediateSpy.mockRestore();
  });
});

describe('Cloud Agent work-item PR integration (PBI-009 / TBI-008)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildLocalDevContext.mockResolvedValue({ files: [] });
    mockMarkTerminal.mockResolvedValue({ ok: true, run: run({ status: 'completed' }) });
    mockDevSessionFindFirst.mockResolvedValue(session({ workItemId: 123 }));
    mockPersistLeftoverWork.mockResolvedValue({ firstWrite: true });
    mockLinkWorkItemToPullRequest.mockResolvedValue({
      mechanism: 'ab-mention',
      verified: true,
    });
    mockAddAdoWorkItemHyperlink.mockResolvedValue(undefined);
    mockGetAdoPullRequestStatus.mockResolvedValue('open');
    mockGetGithubPullRequestStatus.mockResolvedValue('open');
  });

  it('AC-0 / DoD-0: instructs GitHub runs to include the AB# mention', async () => {
    await expect(buildCloudAgentPrompt({
      project: 'MaxView',
      workItemId: 123,
    })).resolves.toContain(
      'When the repository is hosted on GitHub, include AB#123 in the pull request title or body.',
    );
  });

  it('includes project development skill and model defaults in the kickoff prompt', async () => {
    (getSkillConfig as jest.Mock).mockResolvedValueOnce({
      developmentSkillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
      developmentModel: null,
    });
    const prompt = await buildCloudAgentPrompt({
      project: 'MaxView',
      workItemId: 123,
    });
    expect(prompt).toContain('This project is configured to use the **dev-orchestrator**');
    expect(prompt).toContain('`.cursor/skills/dev-orchestrator/SKILL.md`');
    expect(prompt).toContain('Default model: `composer-2.5`');
  });

  it('states the fallback plainly when the project has no development skill', async () => {
    (getSkillConfig as jest.Mock).mockResolvedValueOnce(null);
    const prompt = await buildCloudAgentPrompt({
      project: 'MaxView',
      workItemId: 123,
    });
    expect(prompt).toContain('No development skill is configured for this project.');
    expect(prompt).not.toContain('This project is configured to use');
  });

  it('includes a configured development model override in the kickoff prompt', async () => {
    (getSkillConfig as jest.Mock).mockResolvedValueOnce({
      developmentSkillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
      developmentModel: 'claude-sonnet-4-6',
    });
    const prompt = await buildCloudAgentPrompt({
      project: 'MaxView',
      workItemId: 123,
    });
    expect(prompt).toContain('Model override: `claude-sonnet-4-6`');
  });

  it('AC-3 / DoD-2: persists completion without linking when no PR exists', async () => {
    await applyCloudAgentCompletion({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      project: 'MaxView',
      status: 'completed',
      prUrl: null,
    }, makeDeps());

    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      currentRunPrUrl: null,
    }));
    expect(mockLinkWorkItemToPullRequest).not.toHaveBeenCalled();
  });

  it('uses the frozen run repository context to link a reported PR', async () => {
    mockDevSessionFindFirst.mockResolvedValue(session({ workItemId: 123 }));
    mockMarkTerminal.mockResolvedValue({
      ok: true,
      run: run({
        status: 'completed',
        executionSnapshot: {
          provider: 'github',
          repository: 'amergis/MaxView',
        },
      }),
    });

    await applyCloudAgentCompletion({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      project: 'MaxView',
      status: 'completed',
      prUrl: 'https://github.com/amergis/MaxView/pull/42',
    }, makeDeps());

    expect(mockLinkWorkItemToPullRequest).toHaveBeenCalledWith({
      provider: 'github',
      project: 'MaxView',
      repo: 'amergis/MaxView',
      prUrl: 'https://github.com/amergis/MaxView/pull/42',
      workItemId: 123,
      runId: RUN_ID,
      sessionId: SESSION_ID,
    });
  });

  it('does not roll back terminal persistence when external linking fails', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation();
    mockDevSessionFindFirst.mockResolvedValue(session({ workItemId: 123 }));
    mockMarkTerminal.mockResolvedValue({
      ok: true,
      run: run({
        status: 'completed',
        executionSnapshot: { provider: 'ado', repository: 'MaxView' },
      }),
    });
    mockLinkWorkItemToPullRequest.mockRejectedValue(new Error('ADO unavailable'));

    await expect(applyCloudAgentCompletion({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      project: 'MaxView',
      status: 'completed',
      prUrl: 'https://dev.azure.com/amergis/MaxView/_git/MaxView/pullrequest/42',
    }, makeDeps())).resolves.toBeUndefined();

    expect(mockMarkTerminal).toHaveBeenCalled();
    expect(mockUpdateWhere).toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      '[cloud-agent] work-item PR write exhausted retries',
      expect.stringContaining('ADO unavailable'),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'cloud_agent_run.work_item_reference_failed',
      expect.objectContaining({ runId: RUN_ID, sessionId: SESSION_ID }),
    );
    errorLog.mockRestore();
  });
});

describe('cancelCloudAgentRun (PBI-004)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVendorCancel.mockResolvedValue(undefined);
  });

  it('AC-0: finalizes a running run as durably cancelled with forced_cancel', async () => {
    mockDevSessionFindFirst.mockResolvedValue(session());
    mockAgentRunFindFirst.mockResolvedValue(run());
    mockRequestCancel.mockResolvedValue({
      ok: true,
      run: run({ cancelRequested: true, cancelState: 'requested' }),
    });
    mockMarkTerminal.mockResolvedValue({
      ok: true,
      run: run({ status: 'cancelled', terminalReason: 'forced_cancel' }),
    });

    const result = await cancelCloudAgentRun(SESSION_ID, USER_ID, makeDeps());

    expect(result).toEqual({ ok: true, status: 'cancelled' });
    expect(mockVendorCancel).toHaveBeenCalledWith({
      project: 'MaxView',
      cloudAgentId: 'bc-agent-1',
      cursorRunId: 'cursor-run-1',
    });
    expect(mockMarkTerminal).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({
      status: 'cancelled',
      terminalReason: 'forced_cancel',
      dispatchMessageId: 'cursor-run-1',
    }));
  });

  it('AC-0: finalizes a dispatched run that has no vendor identity yet', async () => {
    mockDevSessionFindFirst.mockResolvedValue(session());
    mockAgentRunFindFirst.mockResolvedValue(run({
      status: 'dispatched',
      cloudAgentIdentity: null,
      dispatchMessageId: null,
    }));
    mockRequestCancel.mockResolvedValue({
      ok: true,
      run: run({
        status: 'dispatched',
        cloudAgentIdentity: null,
        dispatchMessageId: null,
        cancelRequested: true,
      }),
    });
    mockMarkTerminal.mockResolvedValue({
      ok: true,
      run: run({
        status: 'cancelled',
        terminalReason: 'forced_cancel',
        cloudAgentIdentity: null,
        dispatchMessageId: null,
      }),
    });

    const result = await cancelCloudAgentRun(SESSION_ID, USER_ID, makeDeps());

    expect(result).toEqual({ ok: true, status: 'cancelled' });
    expect(mockVendorCancel).not.toHaveBeenCalled();
    expect(mockMarkTerminal).toHaveBeenCalledWith(RUN_ID, expect.not.objectContaining({
      dispatchMessageId: expect.anything(),
    }));
  });

  it('AC-0: a failed vendor cancellation still finalizes the Apex row as cancelled', async () => {
    mockDevSessionFindFirst.mockResolvedValue(session());
    mockAgentRunFindFirst.mockResolvedValue(run());
    mockRequestCancel.mockResolvedValue({ ok: true, run: run({ cancelRequested: true }) });
    mockVendorCancel.mockRejectedValue(new Error('cursor 503'));
    mockMarkTerminal.mockResolvedValue({
      ok: true,
      run: run({ status: 'cancelled', terminalReason: 'forced_cancel' }),
    });

    const result = await cancelCloudAgentRun(SESSION_ID, USER_ID, makeDeps());

    expect(result).toEqual({ ok: true, status: 'cancelled' });
    expect(mockMarkTerminal).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({
      status: 'cancelled',
      terminalReason: 'forced_cancel',
    }));
  });

  it('AC-2: a queued run is cancelled immediately by requestCancel alone', async () => {
    mockDevSessionFindFirst.mockResolvedValue(session());
    mockAgentRunFindFirst.mockResolvedValue(run({
      status: 'queued',
      cloudAgentIdentity: null,
      dispatchMessageId: null,
    }));
    mockRequestCancel.mockResolvedValue({
      ok: true,
      run: run({
        status: 'cancelled',
        terminalReason: 'forced_cancel',
        cloudAgentIdentity: null,
        dispatchMessageId: null,
      }),
    });

    const result = await cancelCloudAgentRun(SESSION_ID, USER_ID, makeDeps());

    expect(result).toEqual({ ok: true, status: 'cancelled' });
    expect(mockVendorCancel).not.toHaveBeenCalled();
    expect(mockMarkTerminal).not.toHaveBeenCalled();
  });

  it('AC-1: rejects a run that is already terminal before cancel is attempted', async () => {
    mockDevSessionFindFirst.mockResolvedValue(session());
    mockAgentRunFindFirst.mockResolvedValue(run({ status: 'completed' }));

    await expect(cancelCloudAgentRun(SESSION_ID, USER_ID, makeDeps()))
      .rejects.toThrow(CloudAgentConflictError);
    expect(mockRequestCancel).not.toHaveBeenCalled();
    expect(mockMarkTerminal).not.toHaveBeenCalled();
  });

  it('AC-1: rejects when requestCancel loses a race to a completing run', async () => {
    mockDevSessionFindFirst.mockResolvedValue(session());
    mockAgentRunFindFirst.mockResolvedValue(run());
    mockRequestCancel.mockResolvedValue({
      ok: false,
      conflict: true,
      run: run({ status: 'completed' }),
      reason: 'cancel_race',
    });

    await expect(cancelCloudAgentRun(SESSION_ID, USER_ID, makeDeps()))
      .rejects.toThrow('The Cloud Agent run is already finished.');
    expect(mockMarkTerminal).not.toHaveBeenCalled();
  });

  it('AC-1: rejects when requestCancel observes a run that finished as completed', async () => {
    mockDevSessionFindFirst.mockResolvedValue(session());
    mockAgentRunFindFirst.mockResolvedValue(run());
    mockRequestCancel.mockResolvedValue({ ok: true, run: run({ status: 'completed' }) });

    await expect(cancelCloudAgentRun(SESSION_ID, USER_ID, makeDeps()))
      .rejects.toThrow(CloudAgentConflictError);
    expect(mockMarkTerminal).not.toHaveBeenCalled();
  });

  it('AC-1: does not overwrite a terminal result when markTerminal loses the race', async () => {
    mockDevSessionFindFirst.mockResolvedValue(session());
    mockAgentRunFindFirst.mockResolvedValue(run());
    mockRequestCancel.mockResolvedValue({ ok: true, run: run({ cancelRequested: true }) });
    mockMarkTerminal.mockResolvedValue({
      ok: false,
      conflict: true,
      run: run({ status: 'completed' }),
      reason: 'already_terminal:completed',
    });

    await expect(cancelCloudAgentRun(SESSION_ID, USER_ID, makeDeps()))
      .rejects.toThrow('The Cloud Agent run is already finished.');
  });

  it('AC-1: rejects a session owned by another user', async () => {
    mockDevSessionFindFirst.mockResolvedValue(undefined);

    await expect(cancelCloudAgentRun(SESSION_ID, 'other-user', makeDeps()))
      .rejects.toMatchObject({ message: 'Session not found', status: 404 });
    expect(mockRequestCancel).not.toHaveBeenCalled();
  });
});

const passedCheck = (kind: RunCheckResult['kind']): RunCheckResult => ({
  kind,
  outcome: 'passed',
});
const failedCheck = (kind: RunCheckResult['kind']): RunCheckResult => ({
  kind,
  outcome: 'failed',
});

const linkableSession = (overrides: Record<string, unknown> = {}) =>
  session({ workItemId: 42, ...overrides });

const linkableRun = (overrides: Record<string, unknown> = {}) =>
  run({
    executionSnapshot: { provider: 'ado', repository: 'MaxView' },
    ...overrides,
  });

describe('getCloudAgentRunStatus check projection (TBI-005 DoD-0/DoD-1/DoD-2; PBI-006 AC-0/AC-1/AC-2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMarkTerminal.mockResolvedValue({ ok: true, run: run({ status: 'completed' }) });
    mockPersistLeftoverWork.mockResolvedValue({ firstWrite: true });
    mockLinkWorkItemToPullRequest.mockResolvedValue({ mechanism: 'ab-mention', verified: true });
  });

  it('PBI-006 AC-0: Given all suites passed and a PR exists, when the session is read, then the summary reports a PR and no failing checks', async () => {
    const checkResults = [passedCheck('unit'), passedCheck('e2e'), passedCheck('wcag')];
    mockDevSessionFindFirst.mockResolvedValue(session({ currentRunPrUrl: 'https://pr/1' }));
    mockAgentRunFindFirst.mockResolvedValue(run({ status: 'completed', checkResults }));

    const summary = await getCloudAgentRunStatus(SESSION_ID, USER_ID, makeDeps());

    expect(summary).toEqual({
      runId: RUN_ID,
      status: 'completed',
      prUrl: 'https://pr/1',
      prStatus: 'open',
      finishedWithoutPr: false,
      terminalReason: null,
      checkResults,
      failingChecks: [],
      lastError: null,
    });
    expect(shouldClaimAllChecksPassed(summary!.checkResults, summary!.finishedWithoutPr)).toBe(true);
  });

  it('PBI-006 AC-1: Given mixed outcomes and a PR exists, when the session is read, then the PR is reported alongside the failing kinds', async () => {
    const checkResults = [passedCheck('unit'), failedCheck('e2e'), failedCheck('wcag')];
    mockDevSessionFindFirst.mockResolvedValue(session({ currentRunPrUrl: 'https://pr/2' }));
    mockAgentRunFindFirst.mockResolvedValue(run({ status: 'completed', checkResults }));

    const summary = await getCloudAgentRunStatus(SESSION_ID, USER_ID, makeDeps());

    expect(summary).toEqual(expect.objectContaining({
      prUrl: 'https://pr/2',
      finishedWithoutPr: false,
      checkResults,
      failingChecks: ['e2e', 'wcag'],
    }));
    expect(shouldClaimAllChecksPassed(summary!.checkResults, summary!.finishedWithoutPr)).toBe(false);
  });

  it('PBI-006 AC-2 / TBI-005 DoD-2: Given a completed run with no PR, when the session is read, then it stays terminal and claims no passing checks', async () => {
    const checkResults = [passedCheck('unit'), passedCheck('e2e'), passedCheck('wcag')];
    mockDevSessionFindFirst.mockResolvedValue(session({ currentRunPrUrl: null }));
    mockAgentRunFindFirst.mockResolvedValue(run({ status: 'completed', checkResults }));

    const summary = await getCloudAgentRunStatus(SESSION_ID, USER_ID, makeDeps());

    expect(summary).toEqual(expect.objectContaining({
      status: 'completed',
      prUrl: null,
      finishedWithoutPr: true,
      failingChecks: [],
    }));
    expect(shouldClaimAllChecksPassed(summary!.checkResults, summary!.finishedWithoutPr)).toBe(false);
  });

  it('TBI-005 DoD-0: Given a run reported no results, when the session is read, then checkResults is null and no failing kinds are claimed', async () => {
    mockDevSessionFindFirst.mockResolvedValue(session({ currentRunPrUrl: 'https://pr/3' }));
    mockAgentRunFindFirst.mockResolvedValue(run({ status: 'completed', checkResults: null }));

    const summary = await getCloudAgentRunStatus(SESSION_ID, USER_ID, makeDeps());

    expect(summary).toEqual(expect.objectContaining({
      checkResults: null,
      failingChecks: [],
      lastError: null,
    }));
  });

  it('exposes lastError when a cloud run failed before or during launch', async () => {
    const message = 'Service-account validation for Azure DevOps repositories is not yet implemented';
    mockDevSessionFindFirst.mockResolvedValue(session());
    mockAgentRunFindFirst.mockResolvedValue(run({
      status: 'failed',
      lastError: message,
      cloudAgentIdentity: null,
      dispatchMessageId: null,
    }));

    const summary = await getCloudAgentRunStatus(SESSION_ID, USER_ID, makeDeps());

    expect(summary).toEqual(expect.objectContaining({
      status: 'failed',
      lastError: message,
    }));
  });

  it('TBI-005 DoD-0: Given a live run observed terminal by the poll adapter, when the summary is projected, then it carries the check fields without parsed results', async () => {
    mockDevSessionFindFirst.mockResolvedValue(linkableSession({ currentRunPrUrl: null }));
    mockAgentRunFindFirst.mockResolvedValue(linkableRun({ status: 'running' }));
    const deps = makeDeps({
      getCloudAgentRun: jest.fn().mockResolvedValue({
        status: 'finished',
        prUrl: 'https://pr/4',
        resultText: 'unit tests passed, e2e failed',
      }),
    });

    const summary = await getCloudAgentRunStatus(SESSION_ID, USER_ID, deps);

    expect(summary).toEqual(expect.objectContaining({
      status: 'completed',
      prUrl: 'https://pr/4',
      checkResults: null,
      failingChecks: [],
    }));
    expect(mockMarkTerminal).toHaveBeenCalledWith(RUN_ID, expect.not.objectContaining({
      checkResults: expect.anything(),
    }));
  });
});

describe('Cloud Agent PR write-back and host status (PBI-007 / TBI-006)', () => {
  const adoPrUrl = 'https://dev.azure.com/amergis/MaxView/_git/MaxView/pullrequest/42';
  const githubPrUrl = 'https://github.com/amergis/MaxView/pull/42';
  const immediateThreeAttemptRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockDevSessionFindFirst.mockResolvedValue(linkableSession());
    mockMarkTerminal.mockResolvedValue({
      ok: true,
      run: linkableRun({ status: 'completed' }),
    });
    mockPersistLeftoverWork.mockResolvedValue({ firstWrite: true });
    mockLinkWorkItemToPullRequest.mockResolvedValue({
      mechanism: 'native-link',
      verified: true,
    });
    mockGetAdoPullRequestStatus.mockResolvedValue('open');
    mockGetGithubPullRequestStatus.mockResolvedValue('open');
    mockAddAdoWorkItemHyperlink.mockResolvedValue(undefined);
  });

  it('PBI-007 AC-1 / TBI-006 DoD-0/DoD-2 / VT-03: transient ADO link write retries and succeeds', async () => {
    mockLinkWorkItemToPullRequest
      .mockRejectedValueOnce(new Error('temporary one'))
      .mockRejectedValueOnce(new Error('temporary two'))
      .mockResolvedValueOnce({ mechanism: 'native-link', verified: true });

    await applyCloudAgentCompletion({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      project: 'MaxView',
      status: 'completed',
      prUrl: adoPrUrl,
    }, makeDeps({ retryWithBackoff: immediateThreeAttemptRetry }));

    expect(mockLinkWorkItemToPullRequest).toHaveBeenCalledTimes(3);
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      currentRunPrUrl: adoPrUrl,
      currentRunPrStatus: 'open',
    }));
  });

  it('PBI-007 AC-1 / VT-04: retries exhausted, completion resolves, currentRunPrUrl/prStatus persist, error logged', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation();
    mockLinkWorkItemToPullRequest.mockRejectedValue(new Error('ADO unavailable'));

    await expect(applyCloudAgentCompletion({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      project: 'MaxView',
      status: 'completed',
      prUrl: adoPrUrl,
    }, makeDeps({ retryWithBackoff: immediateThreeAttemptRetry }))).resolves.toBeUndefined();

    expect(mockLinkWorkItemToPullRequest).toHaveBeenCalledTimes(3);
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      currentRunPrUrl: adoPrUrl,
      currentRunPrStatus: 'open',
    }));
    expect(errorLog).toHaveBeenCalledWith(
      '[cloud-agent] work-item PR write exhausted retries',
      expect.stringContaining('ADO unavailable'),
    );
    errorLog.mockRestore();
  });

  it('PBI-007 AC-1 / TBI-006 DoD-0: GitHub completion verifies AB# and retries the ADO hyperlink write', async () => {
    mockMarkTerminal.mockResolvedValue({
      ok: true,
      run: linkableRun({
        status: 'completed',
        executionSnapshot: { provider: 'github', repository: 'amergis/MaxView' },
      }),
    });
    mockAddAdoWorkItemHyperlink
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(undefined);

    await applyCloudAgentCompletion({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      project: 'MaxView',
      status: 'completed',
      prUrl: githubPrUrl,
    }, makeDeps({ retryWithBackoff: immediateThreeAttemptRetry }));

    expect(mockLinkWorkItemToPullRequest).toHaveBeenCalledTimes(1);
    expect(mockAddAdoWorkItemHyperlink).toHaveBeenCalledTimes(2);
    expect(mockAddAdoWorkItemHyperlink).toHaveBeenLastCalledWith(
      'MaxView',
      42,
      githubPrUrl,
      'Implementation PR',
    );
  });

  it('PBI-007 AC-2 / TBI-006 DoD-1 / VT-05: ADO status active=>open in summary', async () => {
    mockDevSessionFindFirst.mockResolvedValue(linkableSession({
      currentRunPrUrl: adoPrUrl,
      currentRunPrStatus: 'open',
    }));
    mockAgentRunFindFirst.mockResolvedValue(linkableRun({ status: 'completed' }));
    mockGetAdoPullRequestStatus.mockResolvedValue('open');

    const summary = await getCloudAgentRunStatus(SESSION_ID, USER_ID, makeDeps());

    expect(mockGetAdoPullRequestStatus).toHaveBeenCalledWith('MaxView', 'MaxView', 42);
    expect(mockGetGithubPullRequestStatus).not.toHaveBeenCalled();
    expect(summary?.prStatus).toBe('open');
  });

  it.each([
    ['open', 'open'],
    ['merged', 'merged'],
  ] as const)('PBI-007 AC-0 / TBI-006 DoD-1: GitHub %s maps through the injected lookup', async (hostStatus, expected) => {
    mockDevSessionFindFirst.mockResolvedValue(linkableSession({
      currentRunPrUrl: githubPrUrl,
      currentRunPrStatus: 'open',
    }));
    mockAgentRunFindFirst.mockResolvedValue(linkableRun({
      status: 'completed',
      executionSnapshot: { provider: 'github', repository: 'amergis/MaxView' },
    }));
    mockGetGithubPullRequestStatus.mockResolvedValue(hostStatus);

    const summary = await getCloudAgentRunStatus(SESSION_ID, USER_ID, makeDeps());

    expect(summary?.prStatus).toBe(expected);
    if (hostStatus === 'merged') {
      expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
        currentRunPrStatus: 'merged',
      }));
    }
  });

  it('BR-006 / TBI-006 DoD-1: cached merged status skips the host lookup', async () => {
    mockDevSessionFindFirst.mockResolvedValue(linkableSession({
      currentRunPrUrl: githubPrUrl,
      currentRunPrStatus: 'merged',
    }));
    mockAgentRunFindFirst.mockResolvedValue(linkableRun({
      status: 'completed',
      executionSnapshot: { provider: 'github', repository: 'amergis/MaxView' },
    }));

    const summary = await getCloudAgentRunStatus(SESSION_ID, USER_ID, makeDeps());

    expect(summary?.prStatus).toBe('merged');
    expect(mockGetGithubPullRequestStatus).not.toHaveBeenCalled();
    expect(mockGetAdoPullRequestStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed URL', 'not-a-pr-url', undefined],
    ['host failure', githubPrUrl, new Error('GitHub unavailable')],
  ])('BR-006 / VT-05: %s returns the cached last-known status', async (_case, prUrl, failure) => {
    const warning = jest.spyOn(console, 'warn').mockImplementation();
    mockDevSessionFindFirst.mockResolvedValue(linkableSession({
      currentRunPrUrl: prUrl,
      currentRunPrStatus: 'open',
    }));
    mockAgentRunFindFirst.mockResolvedValue(linkableRun({
      status: 'completed',
      executionSnapshot: { provider: 'github', repository: 'amergis/MaxView' },
    }));
    if (failure) mockGetGithubPullRequestStatus.mockRejectedValue(failure);

    const summary = await getCloudAgentRunStatus(SESSION_ID, USER_ID, makeDeps());

    expect(summary?.prStatus).toBe('open');
    expect(warning).toHaveBeenCalledWith(
      '[cloud-agent] PR status refresh failed',
      expect.any(String),
    );
    warning.mockRestore();
  });
});

describe('applyCloudAgentCompletion check forwarding (TBI-005 DoD-0; TBI-005 NFR)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMarkTerminal.mockResolvedValue({ ok: true, run: run({ status: 'completed' }) });
    mockDevSessionFindFirst.mockResolvedValue(linkableSession());
    mockAgentRunFindFirst.mockResolvedValue(linkableRun({ status: 'completed' }));
    mockLinkWorkItemToPullRequest.mockResolvedValue({ mechanism: 'ab-mention', verified: true });
    mockPersistLeftoverWork.mockResolvedValue({ firstWrite: true });
    mockWriteLeftoverWorkToAdo.mockResolvedValue(undefined);
  });

  it('TBI-005 DoD-0: Given a completion reports suite outcomes, when it is applied, then the results are forwarded to the terminal write', async () => {
    const checkResults = [passedCheck('unit'), failedCheck('e2e'), passedCheck('wcag')];

    await applyCloudAgentCompletion({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      project: 'MaxView',
      status: 'completed',
      prUrl: 'https://pr/5',
      checkResults,
    }, makeDeps());

    expect(mockMarkTerminal).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({
      status: 'completed',
      checkResults,
    }));
  });

  it('TBI-005 NFR / PBI-006 AC-1: Given row failures are reported, when the completion is applied, then the PR url is still written to the session', async () => {
    await applyCloudAgentCompletion({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      project: 'MaxView',
      status: 'completed',
      prUrl: 'https://pr/6',
      checkResults: [failedCheck('unit'), failedCheck('e2e'), failedCheck('wcag')],
    }, makeDeps());

    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      currentRunPrUrl: 'https://pr/6',
    }));
    expect(mockUpdateWhere).toHaveBeenCalled();
  });

  it('TBI-005 DoD-0: Given no structured results are available, when the completion is applied, then no check results are forwarded', async () => {
    await applyCloudAgentCompletion({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      project: 'MaxView',
      status: 'completed',
      prUrl: null,
    }, makeDeps());

    expect(mockMarkTerminal).toHaveBeenCalledWith(RUN_ID, expect.not.objectContaining({
      checkResults: expect.anything(),
    }));
  });

  it('TBI-007 DoD-0: persists a summary from checks, PR, and incomplete criteria', async () => {
    const checkResults = [failedCheck('e2e'), passedCheck('wcag')];
    mockMarkTerminal.mockResolvedValue({
      ok: true,
      run: linkableRun({ status: 'completed', checkResults }),
    });

    await applyCloudAgentCompletion({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      project: 'MaxView',
      status: 'completed',
      prUrl: null,
      checkResults,
      incompleteAcceptanceCriteria: ['AC-7'],
    }, makeDeps());

    const summary = {
      failingChecks: ['e2e'],
      missingPr: true,
      incompleteAcceptanceCriteria: ['AC-7'],
    };
    expect(mockPersistLeftoverWork).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      project: 'MaxView',
      summary,
    });
    expect(mockWriteLeftoverWorkToAdo).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      project: 'MaxView',
      workItemId: 42,
      runId: RUN_ID,
      summary,
    });
  });

  it('PBI-008 AC-2: clean completion persists null and makes no ADO call', async () => {
    const checkResults = [passedCheck('unit'), passedCheck('e2e'), passedCheck('wcag')];
    mockMarkTerminal.mockResolvedValue({
      ok: true,
      run: linkableRun({ status: 'completed', checkResults }),
    });

    await applyCloudAgentCompletion({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      project: 'MaxView',
      status: 'completed',
      prUrl: 'https://pr/clean',
      checkResults,
      incompleteAcceptanceCriteria: [],
    }, makeDeps());

    expect(mockPersistLeftoverWork).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      project: 'MaxView',
      summary: null,
    });
    expect(mockWriteLeftoverWorkToAdo).not.toHaveBeenCalled();
  });

  it('TBI-007 DoD-2: sequential retry does not append ADO when leftover persist is not firstWrite', async () => {
    mockPersistLeftoverWork.mockResolvedValue({ firstWrite: false });
    mockMarkTerminal.mockResolvedValue({
      ok: true,
      run: linkableRun({
        status: 'completed',
        checkResults: [failedCheck('unit')],
      }),
    });

    await applyCloudAgentCompletion({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      project: 'MaxView',
      status: 'completed',
      prUrl: 'https://pr/retry',
      checkResults: [failedCheck('unit')],
    }, makeDeps());

    expect(mockPersistLeftoverWork).toHaveBeenCalled();
    expect(mockWriteLeftoverWorkToAdo).not.toHaveBeenCalled();
  });

  it('TBI-007 DoD-2: simultaneous completion callbacks append ADO only for the persist winner', async () => {
    mockPersistLeftoverWork
      .mockResolvedValueOnce({ firstWrite: true })
      .mockResolvedValueOnce({ firstWrite: false });
    mockMarkTerminal.mockResolvedValue({
      ok: true,
      run: linkableRun({
        status: 'completed',
        checkResults: [failedCheck('e2e')],
      }),
    });
    const payload = {
      runId: RUN_ID,
      sessionId: SESSION_ID,
      project: 'MaxView',
      status: 'completed' as const,
      prUrl: null,
      checkResults: [failedCheck('e2e')],
    };

    await Promise.all([
      applyCloudAgentCompletion(payload, makeDeps()),
      applyCloudAgentCompletion(payload, makeDeps()),
    ]);

    expect(mockPersistLeftoverWork).toHaveBeenCalledTimes(2);
    expect(mockWriteLeftoverWorkToAdo).toHaveBeenCalledTimes(1);
  });
});
