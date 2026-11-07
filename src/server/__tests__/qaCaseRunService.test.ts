import {
  QaCaseRunInputError,
  createRunBug,
  describeFailure,
  getCaseRunState,
  publishCaseRun,
  publishSuiteRuns,
  saveCaseRun,
  type QaCaseRunAdo,
} from '../services/qaCaseRunService';
import type { QaLabRunTarget } from '../../shared/types/qaLab';

interface DbState {
  suite: Record<string, unknown> | null;
  runs: Array<Record<string, unknown> | undefined>;
  drafts: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
  inserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
}

jest.mock('../db/drizzle', () => {
  const state: DbState = { suite: null, runs: [], drafts: [], files: [], inserts: [], updates: [] };
  const baseRun = {
    id: 'run-1',
    suiteId: 'suite-1',
    localCaseId: 'TC-1',
    status: 'draft',
    outcome: null,
    comment: '',
    stepResults: [],
    bugs: [],
    adoRunId: null,
    adoResultId: null,
    adoRunUrl: null,
    publishedAt: null,
    updatedAt: '2026-11-05T10:00:00.000Z',
  };
  const thenable = <T,>(value: () => T) => ({
    then: (resolve: (result: T) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve().then(value).then(resolve, reject),
  });
  const db = {
    query: {
      qaAdoTestSuites: { findFirst: jest.fn(async () => state.suite) },
      qaCaseRuns: {
        findFirst: jest.fn(async () => state.runs.shift()),
        findMany: jest.fn(async () => state.drafts),
      },
    },
    insert: jest.fn(() => ({
      values(values: Record<string, unknown>) {
        state.inserts.push(values);
        return {
          onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ ...baseRun, ...values }]) }),
          ...thenable(() => undefined),
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
        ...thenable(() => undefined),
      };
      return chain;
    }),
    select: jest.fn(() => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        ...thenable(() => state.files),
      };
      return chain;
    }),
    delete: jest.fn(() => ({ where: () => Promise.resolve() })),
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

const steps = [
  { action: 'Open the timesheet', expected: 'Timesheet shows' },
  { action: 'Clock in', expected: 'Clock-in is saved' },
];

const target: QaLabRunTarget = {
  adoTestCaseId: 600,
  adoTestCaseUrl: 'https://ado.example/600',
  title: 'Clock in inside the geofence',
  planId: 15,
  planName: '15 Timesheets',
  suiteId: 151,
  suiteName: 'Geofence',
  steps: [
    { stepId: 2, order: 1, ...steps[0] },
    { stepId: 3, order: 2, ...steps[1] },
  ],
};

function makeAdo(): jest.Mocked<QaCaseRunAdo> {
  return {
    getTestCaseRunTarget: jest.fn().mockResolvedValue(target),
    uploadWorkItemAttachment: jest.fn().mockResolvedValue({ id: 'att-1', url: 'https://ado.example/_apis/wit/attachments/att-1' }),
    publishManualTestResult: jest.fn().mockResolvedValue({ runId: 900, resultId: 100000, runUrl: 'https://ado.example/run/900' }),
    createBugWorkItem: jest.fn().mockResolvedValue({ id: 777, url: 'https://ado.example/777' }),
    linkBugToTestResult: jest.fn(),
    linkBugToTestCase: jest.fn(),
  } as unknown as jest.Mocked<QaCaseRunAdo>;
}

function suiteRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'suite-1',
    project: 'MatterWorx',
    sourceSnapshot: { root: { areaPath: 'MatterWorx\\The Bakery' } },
    testCasesJson: {
      suites: [{
        pbiId: 'PBI-18452',
        testCases: [
          { id: 'TC-1', title: 'Clock in inside the geofence', steps },
          { id: 'TC-2', title: 'Clock out', steps: ['Clock out'] },
        ],
      }],
    },
    publishedCases: [],
    ...overrides,
  };
}

const published = {
  publishedCases: [{
    localCaseId: 'TC-1',
    adoTestCaseId: 600,
    adoTestCaseUrl: 'https://ado.example/600',
    parentWorkItemId: 18452,
    publishedAt: '2026-11-05T09:00:00.000Z',
    testPlanId: 15,
    testSuiteId: 151,
  }],
};

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    suiteId: 'suite-1',
    localCaseId: 'TC-1',
    status: 'draft',
    outcome: 'failed',
    comment: '',
    stepResults: [
      { order: 1, outcome: 'passed', comment: '', ...steps[0] },
      { order: 2, outcome: 'failed', comment: 'Spinner never stops', ...steps[1] },
    ],
    bugs: [],
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
  dbState.drafts = [];
  dbState.files = [];
  dbState.inserts = [];
  dbState.updates = [];
});

describe('qaCaseRunService', () => {
  it('records results for a case that is not in Azure DevOps yet, with the step text tested', async () => {
    const run = await saveCaseRun('suite-1', 'TC-1', {
      outcome: 'failed',
      comment: '',
      stepResults: [{ order: 2, outcome: 'failed', comment: 'Spinner never stops' }],
    }, user);

    expect(dbState.inserts[0]).toEqual(expect.objectContaining({
      suiteId: 'suite-1',
      localCaseId: 'TC-1',
      project: 'MatterWorx',
      adoTestCaseId: null,
      parentWorkItemId: 18452,
      createdBy: 'user-1',
    }));
    expect(run.stepResults).toEqual([
      { order: 2, outcome: 'failed', comment: 'Spinner never stops', action: 'Clock in', expected: 'Clock-in is saved' },
    ]);
  });

  it('rejects an invalid outcome or a step the case does not have, without writing', async () => {
    await expect(saveCaseRun('suite-1', 'TC-1', {
      outcome: 'blocked' as never,
      comment: '',
      stepResults: [],
    }, user)).rejects.toBeInstanceOf(QaCaseRunInputError);
    await expect(saveCaseRun('suite-1', 'TC-1', {
      outcome: null,
      comment: '',
      stepResults: [{ order: 3, outcome: 'passed', comment: '' }],
    }, user)).rejects.toBeInstanceOf(QaCaseRunInputError);
    expect(dbState.inserts).toEqual([]);
  });

  it('leaves out results for steps that changed after they were recorded', async () => {
    dbState.runs = [draft({
      stepResults: [
        { order: 1, outcome: 'passed', comment: '', ...steps[0] },
        { order: 2, outcome: 'failed', comment: 'Old', action: 'Clock in early', expected: 'Clock-in is saved' },
      ],
    }), undefined];

    const state = await getCaseRunState('suite-1', 'TC-1');

    expect(state.adoTestCase).toBeNull();
    expect(state.steps).toEqual([{ order: 1, ...steps[0] }, { order: 2, ...steps[1] }]);
    expect(state.changedSteps).toEqual([2]);
    expect(state.draft?.stepResults.map((step) => step.order)).toEqual([1]);
  });

  it('needs a failure and a comment before filing a Bug', () => {
    expect(describeFailure({ outcome: 'passed', comment: 'fine', stepResults: [] })).toBeNull();
    expect(describeFailure({ outcome: 'failed', comment: '', stepResults: [] })).toBeNull();
    expect(describeFailure({ outcome: 'failed', comment: 'Broken', stepResults: [] })).toEqual({ failedSteps: [] });
  });

  it('files a Bug under the PBI before the case is published, uploading the files from Apex', async () => {
    dbState.runs = [draft()];
    dbState.files = [{ id: 'file-1', fileName: 'screen.png', content: Buffer.from('png'), adoUrl: null }];
    const ado = makeAdo();

    const run = await createRunBug('suite-1', 'TC-1', ado);

    expect(ado.uploadWorkItemAttachment).toHaveBeenCalledWith('screen.png', Buffer.from('png'));
    const spec = ado.createBugWorkItem.mock.calls[0][0];
    expect(spec).toEqual(expect.objectContaining({
      title: 'Failed: Clock in inside the geofence',
      parentId: 18452,
      areaPath: 'MatterWorx',
      attachments: [{ url: 'https://ado.example/_apis/wit/attachments/att-1', fileName: 'screen.png' }],
    }));
    expect(spec.testCaseId).toBeUndefined();
    expect(spec.reproStepsHtml).toContain('the QA Lab case');
    expect(spec.reproStepsHtml).toContain('<b>Step 2:</b> Clock in');
    expect(spec.reproStepsHtml).toContain('<b>Actual:</b> Spinner never stops');
    expect(spec.reproStepsHtml).not.toContain('Open the timesheet');
    expect(run.bugs).toEqual([{
      id: 777,
      url: 'https://ado.example/777',
      title: 'Failed: Clock in inside the geofence',
      linkedToTestCase: false,
    }]);
  });

  it('links a Bug to the Test Case and to the published result once the case is in Azure DevOps', async () => {
    dbState.suite = suiteRow(published);
    dbState.runs = [undefined, draft({ status: 'published', adoRunId: 900, adoResultId: 100000 })];
    dbState.files = [{ id: 'file-1', fileName: 'screen.png', content: Buffer.from('png'), adoUrl: 'https://ado.example/att-1' }];
    const ado = makeAdo();

    await createRunBug('suite-1', 'TC-1', ado);

    expect(ado.uploadWorkItemAttachment).not.toHaveBeenCalled();
    expect(ado.createBugWorkItem.mock.calls[0][0].testCaseId).toBe(600);
    expect(ado.linkBugToTestResult).toHaveBeenCalledWith(777, 900, 100000);
  });

  it('refuses a Bug when the failure has no comment', async () => {
    dbState.runs = [draft({ stepResults: [{ order: 2, outcome: 'failed', comment: '', ...steps[1] }] })];
    const ado = makeAdo();

    await expect(createRunBug('suite-1', 'TC-1', ado)).rejects.toBeInstanceOf(QaCaseRunInputError);
    expect(ado.createBugWorkItem).not.toHaveBeenCalled();
  });

  it('publishes marked steps by their Azure DevOps step id, with the files, and links earlier Bugs', async () => {
    dbState.suite = suiteRow(published);
    dbState.runs = [draft({
      stepResults: [
        { order: 1, outcome: 'passed', comment: '', ...steps[0] },
        { order: 2, outcome: 'failed', comment: 'Spinner never stops', ...steps[1] },
      ],
      bugs: [{ id: 777, url: 'https://ado.example/777', title: 'Failed', linkedToTestCase: false }],
    })];
    dbState.files = [
      { fileName: 'screen.png', content: Buffer.from('png'), stepOrder: 2 },
      { fileName: 'log.txt', content: Buffer.from('log'), stepOrder: null },
    ];
    const ado = makeAdo();

    const run = await publishCaseRun('suite-1', 'TC-1', ado);

    expect(ado.getTestCaseRunTarget).toHaveBeenCalledWith(600, { planId: 15, suiteId: 151 });
    expect(ado.linkBugToTestCase).toHaveBeenCalledWith(777, 600);
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
      attachments: [
        { fileName: 'screen.png', content: Buffer.from('png'), stepId: 3 },
        { fileName: 'log.txt', content: Buffer.from('log') },
      ],
      bugIds: [777],
    });
    expect(dbState.updates[dbState.updates.length - 1]).toEqual(expect.objectContaining({
      status: 'published',
      adoTestCaseId: 600,
      adoRunId: 900,
      adoResultId: 100000,
      bugs: [{ id: 777, url: 'https://ado.example/777', title: 'Failed', linkedToTestCase: true }],
    }));
    expect(run.status).toBe('published');
  });

  it('will not publish a case on its own before it is in Azure DevOps, or before it has an outcome', async () => {
    dbState.runs = [draft()];
    await expect(publishCaseRun('suite-1', 'TC-1', makeAdo())).rejects.toThrow('Publish the suite');

    dbState.suite = suiteRow(published);
    dbState.runs = [draft({ outcome: null })];
    const ado = makeAdo();
    await expect(publishCaseRun('suite-1', 'TC-1', ado)).rejects.toThrow('Mark the case Passed or Failed');
    expect(ado.publishManualTestResult).not.toHaveBeenCalled();
  });

  it('suite publish sends the results of cases now in Azure DevOps and reports the ones that fail', async () => {
    dbState.suite = suiteRow(published);
    dbState.drafts = [draft(), draft({ id: 'run-2', localCaseId: 'TC-2' })];
    const ado = makeAdo();

    expect(await publishSuiteRuns('suite-1', ado)).toEqual({ publishedLocalCaseIds: ['TC-1'], failures: [] });
    expect(ado.publishManualTestResult).toHaveBeenCalledTimes(1);

    ado.getTestCaseRunTarget.mockResolvedValue(null);
    expect(await publishSuiteRuns('suite-1', ado)).toEqual({
      publishedLocalCaseIds: [],
      failures: [{ localCaseId: 'TC-1', message: 'Test Case 600 is in no Test Plan suite' }],
    });
  });
});
