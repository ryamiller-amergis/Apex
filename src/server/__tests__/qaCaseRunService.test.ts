import {
  QaCaseRunInputError,
  createRunBug,
  describeFailure,
  getCaseRunState,
  publishCaseRun,
  saveCaseRun,
  type QaCaseRunAdo,
} from '../services/qaCaseRunService';
import type { QaLabRunTarget } from '../../shared/types/qaLab';

interface DbState {
  suite: Record<string, unknown> | null;
  runs: Array<Record<string, unknown> | undefined>;
  inserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
}

jest.mock('../db/drizzle', () => {
  const state: DbState = { suite: null, runs: [], inserts: [], updates: [] };
  const baseRun = {
    id: 'run-1',
    status: 'draft',
    outcome: null,
    comment: '',
    stepResults: [],
    attachments: [],
    bugs: [],
    adoPlanId: 15,
    adoSuiteId: 151,
    adoRunId: null,
    adoResultId: null,
    adoRunUrl: null,
    publishedAt: null,
    updatedAt: '2026-11-05T10:00:00.000Z',
  };
  const db = {
    query: {
      qaAdoTestSuites: { findFirst: jest.fn(async () => state.suite) },
      qaCaseRuns: { findFirst: jest.fn(async () => state.runs.shift()) },
    },
    insert: jest.fn(() => ({
      values(values: Record<string, unknown>) {
        state.inserts.push(values);
        return {
          onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ ...baseRun, ...values }]) }),
        };
      },
    })),
    update: jest.fn(() => {
      let values: Record<string, unknown> = {};
      const chain = {
        set(next: Record<string, unknown>) {
          values = next;
          state.updates.push(next);
          return chain;
        },
        where: () => chain,
        returning: () => Promise.resolve([{ ...baseRun, ...values }]),
      };
      return chain;
    }),
  };
  return { db, __qaRunDbMock: state };
});

jest.mock('../services/qaCaseRegenerationService', () => ({
  QaCaseNotFoundError: class QaCaseNotFoundError extends Error {},
}));

jest.mock('../services/chatAgentService', () => ({}));
jest.mock('../services/backgroundWorkflowRouter', () => ({ routeBackgroundWorkflow: jest.fn() }));
jest.mock('../services/projectSettingsService', () => ({ resolveSkillConfig: jest.fn() }));
jest.mock('../services/appSettingsService', () => ({ getDefaultModel: jest.fn() }));
jest.mock('../services/agentRunReaperService', () => ({}));
jest.mock('../services/runGroundingService', () => ({ runGroundingService: {} }));
jest.mock('../services/adoFactory', () => ({ adoWriteForRequest: jest.fn(), adoWriteFromToken: jest.fn() }));
jest.mock('../services/azureDevOps', () => ({ AzureDevOpsService: jest.fn() }));

const { __qaRunDbMock: dbState } = jest.requireMock('../db/drizzle') as { __qaRunDbMock: DbState };

const target: QaLabRunTarget = {
  adoTestCaseId: 600,
  adoTestCaseUrl: 'https://ado.example/600',
  title: 'Clock in inside the geofence',
  planId: 15,
  planName: '15 Timesheets',
  suiteId: 151,
  suiteName: 'Geofence',
  steps: [
    { stepId: 2, order: 1, action: 'Open the timesheet', expected: 'Timesheet shows' },
    { stepId: 3, order: 2, action: 'Clock in', expected: 'Clock-in is saved' },
  ],
};

function makeAdo(): jest.Mocked<QaCaseRunAdo> {
  return {
    getTestCaseRunTarget: jest.fn().mockResolvedValue(target),
    uploadWorkItemAttachment: jest.fn(),
    publishManualTestResult: jest.fn().mockResolvedValue({ runId: 900, resultId: 100000, runUrl: 'https://ado.example/run/900' }),
    createBugWorkItem: jest.fn().mockResolvedValue({ id: 777, url: 'https://ado.example/777' }),
    linkBugToTestResult: jest.fn(),
  } as unknown as jest.Mocked<QaCaseRunAdo>;
}

function suiteRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: 'MatterWorx',
    sourceSnapshot: { root: { areaPath: 'MatterWorx\\The Bakery' } },
    testCasesJson: {
      suites: [{ pbiId: 'PBI-18452', testCases: [{ id: 'TC-1', title: 'Clock in', steps: ['Clock in'] }] }],
    },
    publishedCases: [{
      localCaseId: 'TC-1',
      adoTestCaseId: 600,
      adoTestCaseUrl: 'https://ado.example/600',
      parentWorkItemId: 18452,
      publishedAt: '2026-11-05T09:00:00.000Z',
      testPlanId: 15,
      testSuiteId: 151,
    }],
    ...overrides,
  };
}

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    status: 'draft',
    outcome: 'failed',
    comment: '',
    stepResults: [
      { stepId: 2, outcome: 'passed', comment: '' },
      { stepId: 3, outcome: 'failed', comment: 'Spinner never stops' },
    ],
    attachments: [{ id: 'att-1', fileName: 'screen.png', size: 10, url: 'https://ado.example/_apis/wit/attachments/att-1', stepId: 3 }],
    bugs: [],
    adoPlanId: 15,
    adoSuiteId: 151,
    adoRunId: null,
    adoResultId: null,
    adoRunUrl: null,
    publishedAt: null,
    updatedAt: '2026-11-05T10:00:00.000Z',
    ...overrides,
  };
}

const user = { id: 'user-1', name: 'QA Person' };

beforeEach(() => {
  dbState.suite = suiteRow();
  dbState.runs = [];
  dbState.inserts = [];
  dbState.updates = [];
});

describe('qaCaseRunService', () => {
  it('starts a draft in the suite the case was published to and saves the step results', async () => {
    const ado = makeAdo();

    const run = await saveCaseRun('suite-1', 'TC-1', {
      outcome: 'failed',
      comment: '',
      stepResults: [{ stepId: 3, outcome: 'failed', comment: 'Spinner never stops' }],
    }, user, ado);

    expect(ado.getTestCaseRunTarget).toHaveBeenCalledWith(600, { planId: 15, suiteId: 151 });
    expect(dbState.inserts[0]).toEqual(expect.objectContaining({
      project: 'MatterWorx',
      adoTestCaseId: 600,
      adoPlanId: 15,
      adoSuiteId: 151,
      parentWorkItemId: 18452,
      createdBy: 'user-1',
    }));
    expect(run.outcome).toBe('failed');
    expect(run.stepResults).toEqual([{ stepId: 3, outcome: 'failed', comment: 'Spinner never stops' }]);
  });

  it('rejects an invalid outcome without writing', async () => {
    await expect(saveCaseRun('suite-1', 'TC-1', {
      outcome: 'blocked' as never,
      comment: '',
      stepResults: [],
    }, user, makeAdo())).rejects.toBeInstanceOf(QaCaseRunInputError);
    expect(dbState.inserts).toEqual([]);
  });

  it('reports a case with no Azure DevOps Test Case as not runnable', async () => {
    dbState.suite = suiteRow({ publishedCases: [] });
    const ado = makeAdo();

    const state = await getCaseRunState('suite-1', 'TC-1', ado);

    expect(state.target).toBeNull();
    expect(state.unavailableReason).toMatch(/Publish this case/);
    expect(ado.getTestCaseRunTarget).not.toHaveBeenCalled();
  });

  it('needs a failure and a comment before filing a Bug', () => {
    expect(describeFailure({ outcome: 'passed', comment: 'fine', stepResults: [] })).toBeNull();
    expect(describeFailure({ outcome: 'failed', comment: '', stepResults: [] })).toBeNull();
    expect(describeFailure({ outcome: 'failed', comment: 'Broken', stepResults: [] })).toEqual({ failedSteps: [] });
  });

  it('files a Bug under the PBI, tested by the case, at the project top-level area', async () => {
    dbState.runs = [draft()];
    const ado = makeAdo();

    const run = await createRunBug('suite-1', 'TC-1', ado);

    const spec = ado.createBugWorkItem.mock.calls[0][0];
    expect(spec).toEqual(expect.objectContaining({
      title: 'Failed: Clock in inside the geofence',
      parentId: 18452,
      testCaseId: 600,
      areaPath: 'MatterWorx',
      attachments: [{ url: 'https://ado.example/_apis/wit/attachments/att-1', fileName: 'screen.png' }],
    }));
    expect(spec.reproStepsHtml).toContain('<b>Step 2:</b> Clock in');
    expect(spec.reproStepsHtml).toContain('<b>Actual:</b> Spinner never stops');
    expect(spec.reproStepsHtml).not.toContain('Open the timesheet');
    expect(ado.linkBugToTestResult).not.toHaveBeenCalled();
    expect(run.bugs).toEqual([{ id: 777, url: 'https://ado.example/777', title: 'Failed: Clock in inside the geofence' }]);
  });

  it('links a Bug filed after publishing to the published result', async () => {
    dbState.runs = [undefined, draft({ status: 'published', adoRunId: 900, adoResultId: 100000 })];
    const ado = makeAdo();

    await createRunBug('suite-1', 'TC-1', ado);

    expect(ado.linkBugToTestResult).toHaveBeenCalledWith(777, 900, 100000);
  });

  it('refuses a Bug when the failure has no comment', async () => {
    dbState.runs = [draft({ stepResults: [{ stepId: 3, outcome: 'failed', comment: '' }] })];
    const ado = makeAdo();

    await expect(createRunBug('suite-1', 'TC-1', ado)).rejects.toBeInstanceOf(QaCaseRunInputError);
    expect(ado.createBugWorkItem).not.toHaveBeenCalled();
  });

  it('publishes only marked steps, with attachments and Bugs, and closes the draft', async () => {
    dbState.runs = [draft({
      stepResults: [
        { stepId: 2, outcome: 'passed', comment: '' },
        { stepId: 3, outcome: 'failed', comment: 'Spinner never stops' },
        { stepId: 4, outcome: null, comment: 'not reached' },
      ],
      bugs: [{ id: 777, url: 'https://ado.example/777', title: 'Failed' }],
    })];
    const ado = makeAdo();

    const run = await publishCaseRun('suite-1', 'TC-1', ado);

    expect(ado.publishManualTestResult).toHaveBeenCalledWith({
      planId: 15,
      suiteId: 151,
      testCaseId: 600,
      title: 'Clock in inside the geofence',
      outcome: 'Failed',
      comment: '',
      steps: [
        { stepId: 2, outcome: 'Passed', comment: '' },
        { stepId: 3, outcome: 'Failed', comment: 'Spinner never stops' },
      ],
      attachments: [{ url: 'https://ado.example/_apis/wit/attachments/att-1', fileName: 'screen.png', stepId: 3 }],
      bugIds: [777],
    });
    expect(dbState.updates[0]).toEqual(expect.objectContaining({
      status: 'published',
      adoRunId: 900,
      adoResultId: 100000,
      adoRunUrl: 'https://ado.example/run/900',
    }));
    expect(run.status).toBe('published');
  });

  it('will not publish before the case is marked Passed or Failed', async () => {
    dbState.runs = [draft({ outcome: null })];
    const ado = makeAdo();

    await expect(publishCaseRun('suite-1', 'TC-1', ado)).rejects.toThrow('Mark the case Passed or Failed');
    expect(ado.publishManualTestResult).not.toHaveBeenCalled();
  });
});
