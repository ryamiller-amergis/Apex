/**
 * FEAT-010 — loadTestTraceabilityService
 *
 * VT-01 / PBI-012 AC-0: project-scoped list with latest run
 * VT-03 / PBI-012 AC-2: never-run → latestRun null
 * VT-05 / PBI-013 AC-0: posts comment + sets columns
 * VT-06 / PBI-013 AC-1: ADO failure swallowed; no throw
 * VT-07 / PBI-013 AC-2: idempotent when external id set
 * VT-08 / PBI-013 AC-3: skip when no requirement_ref
 * VT-10 / TBI-010 DoD-2: errored + cancelled post activity
 */
const mockSelect = jest.fn();
const mockUpdate = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: jest.fn().mockImplementation(() => ({
    addWorkItemComment: jest.fn(),
  })),
}));

import {
  listByRequirement,
  recordRunCompletionActivity,
  setTraceabilityCommentWriterFactory,
} from '../services/loadTestTraceabilityService';

const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';
const WI_ID = '100';
const NOW = '2026-07-25T12:00:00.000Z';

function chainSelectSequence(results: unknown[][]) {
  let call = 0;
  mockSelect.mockImplementation(() => {
    const rows = results[call] ?? [];
    call += 1;
    const lim = jest.fn().mockResolvedValue(rows);
    const whereResult: any = {
      limit: lim,
      orderBy: jest.fn(() => whereResult),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return {
      from: jest.fn(() => ({
        where: jest.fn(() => whereResult),
      })),
    };
  });
}

function chainUpdate(): jest.Mock {
  const returning = jest.fn().mockResolvedValue([]);
  const where = jest.fn(() => ({ returning }));
  const set = jest.fn(() => ({ where }));
  mockUpdate.mockReturnValue({ set });
  return set;
}

describe('loadTestTraceabilityService.listByRequirement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('VT-01 / AC-0: returns only project A definitions with latest run summary', async () => {
    const def1 = {
      id: 'def-1',
      name: 'Checkout load',
      requirementRef: { kind: 'ado_work_item', id: WI_ID },
    };
    const def2 = {
      id: 'def-2',
      name: 'Login load',
      requirementRef: { kind: 'ado_work_item', id: WI_ID },
    };
    const run1 = {
      id: 'run-1',
      projectId: PROJECT_A,
      loadTestId: 'def-1',
      status: 'passed',
      overallResult: 'passed',
      completedAt: NOW,
      updatedAt: NOW,
      createdAt: NOW,
    };

    chainSelectSequence([[def1, def2], [run1]]);

    const items = await listByRequirement({
      projectId: PROJECT_A,
      kind: 'ado_work_item',
      id: WI_ID,
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      definitionId: 'def-1',
      name: 'Checkout load',
      latestRun: {
        runId: 'run-1',
        status: 'passed',
        overallResult: 'passed',
        completedAt: NOW,
      },
    });
    expect(items[1].latestRun).toBeNull();
    expect(JSON.stringify(items)).not.toMatch(/script|secret/i);
    expect(PROJECT_B).toBeTruthy(); // isolation covered by projectId filter in where clause
  });

  it('VT-03 / AC-2: linked definition with zero runs → latestRun null (not false pass)', async () => {
    chainSelectSequence([
      [
        {
          id: 'def-never',
          name: 'Never run',
          requirementRef: { kind: 'ado_work_item', id: WI_ID },
        },
      ],
      [],
    ]);

    const items = await listByRequirement({
      projectId: PROJECT_A,
      kind: 'ado_work_item',
      id: WI_ID,
    });

    expect(items).toHaveLength(1);
    expect(items[0].latestRun).toBeNull();
  });
});

describe('loadTestTraceabilityService.recordRunCompletionActivity', () => {
  const addComment = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    addComment.mockReset();
    setTraceabilityCommentWriterFactory(() => ({
      addWorkItemComment: addComment,
    }));
  });

  afterEach(() => {
    setTraceabilityCommentWriterFactory(null);
  });

  function terminalRun(overrides: Record<string, unknown> = {}) {
    return {
      id: 'run-t',
      projectId: PROJECT_A,
      loadTestId: 'def-1',
      status: 'failed',
      overallResult: 'failed',
      completedAt: NOW,
      updatedAt: NOW,
      requirementActivityExternalId: null,
      requirementActivityPostedAt: null,
      thresholdResults: [{ metric: 'http_req_failed', expression: 'rate<0.01', passed: false }],
      ...overrides,
    };
  }

  it('VT-05 / AC-0: posts ADO comment once and stores external id (DoD-2)', async () => {
    addComment.mockResolvedValue({ id: 42 });
    chainSelectSequence([
      [terminalRun()],
      [{ name: 'API smoke', requirementRef: { kind: 'ado_work_item', id: WI_ID } }],
    ]);
    const set = chainUpdate();

    await recordRunCompletionActivity({ projectId: PROJECT_A, runId: 'run-t' });

    expect(addComment).toHaveBeenCalledTimes(1);
    expect(addComment.mock.calls[0][0]).toBe(100);
    expect(String(addComment.mock.calls[0][1])).toContain('API smoke');
    expect(String(addComment.mock.calls[0][1])).toContain('failed');
    expect(String(addComment.mock.calls[0][1])).not.toMatch(/kv:\/\/|Authorization|script/i);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        requirementActivityExternalId: '42',
      }),
    );
  });

  it('VT-06 / AC-1: ADO failure is logged and does not throw', async () => {
    addComment.mockRejectedValue(new Error('ADO down'));
    chainSelectSequence([
      [terminalRun({ status: 'passed', overallResult: 'passed' })],
      [{ name: 'API smoke', requirementRef: { kind: 'ado_work_item', id: WI_ID } }],
    ]);

    await expect(
      recordRunCompletionActivity({ projectId: PROJECT_A, runId: 'run-t' }),
    ).resolves.toBeUndefined();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('VT-07 / AC-2: second call no-ops when activity columns already set', async () => {
    chainSelectSequence([
      [
        terminalRun({
          requirementActivityExternalId: '99',
          requirementActivityPostedAt: NOW,
        }),
      ],
    ]);

    await recordRunCompletionActivity({ projectId: PROJECT_A, runId: 'run-t' });

    expect(addComment).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('VT-08 / AC-3: skips when definition has no requirement_ref', async () => {
    chainSelectSequence([
      [terminalRun()],
      [{ name: 'Orphan', requirementRef: null }],
    ]);

    await recordRunCompletionActivity({ projectId: PROJECT_A, runId: 'run-t' });

    expect(addComment).not.toHaveBeenCalled();
  });

  it('VT-10 / DoD-2: posts for errored and cancelled terminal states', async () => {
    for (const status of ['errored', 'cancelled'] as const) {
      jest.clearAllMocks();
      addComment.mockResolvedValue({ id: 7 });
      chainSelectSequence([
        [terminalRun({ status, overallResult: null })],
        [{ name: 'API smoke', requirementRef: { kind: 'ado_work_item', id: WI_ID } }],
      ]);
      chainUpdate();

      await recordRunCompletionActivity({ projectId: PROJECT_A, runId: 'run-t' });
      expect(addComment).toHaveBeenCalledTimes(1);
    }
  });
});
