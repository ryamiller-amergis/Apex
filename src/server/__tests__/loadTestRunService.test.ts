/**
 * Unit tests — FEAT-007 loadTestRunService
 *
 * Traceability:
 *   TBI-007 DoD-0..4, PBI-008 AC-0..2 + cancel + BR-004, PBI-009 AC-0..2, VT-11
 */
const mockSelect = jest.fn();
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockPublish = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

jest.mock('../services/loadTestService', () => ({
  getDefinition: jest.fn(),
  enforceProfileCaps: jest.fn(),
  assertAllowlistedNonProd: jest.fn(),
}));

jest.mock('../services/loadTestTargetService', () => ({
  normalizeTargetUrl: (url: string) => {
    const u = new URL(url);
    return u.origin;
  },
}));

import {
  assertTransition,
  cancel,
  enqueue,
  evaluateThresholdOutcome,
  ingest,
  reapStaleLoadTestRuns,
  setDispatchPublisher,
  stopLoadTestRunReaper,
} from '../services/loadTestRunService';
import * as loadTestService from '../services/loadTestService';
import { LoadTestValidationError } from '../../shared/types/loadTest';

const mockGetDefinition = loadTestService.getDefinition as jest.MockedFunction<
  typeof loadTestService.getDefinition
>;
const mockEnforceCaps = loadTestService.enforceProfileCaps as jest.MockedFunction<
  typeof loadTestService.enforceProfileCaps
>;
const mockAssertAllowlist = loadTestService.assertAllowlistedNonProd as jest.MockedFunction<
  typeof loadTestService.assertAllowlistedNonProd
>;

const PROJECT = 'project-a';
const DEF_ID = 'def-1';
const NOW = '2026-07-25T12:00:00.000Z';

const definition = {
  id: DEF_ID,
  projectId: PROJECT,
  name: 'API smoke',
  description: null,
  requirementRef: null,
  targetUrl: 'https://staging.example.com',
  environment: 'staging',
  engine: 'k6' as const,
  flowType: 'single' as const,
  scriptSource: 'form_builder' as const,
  script: 'export default function () {}',
  loadProfile: { vus: 10, durationMinutes: 5 },
  clientThresholds: [{ metric: 'http_req_failed', expression: 'rate<0.01' }],
  runSource: null,
  secretRefs: { token: 'kv://vault/secret' },
  createdAt: NOW,
  updatedAt: NOW,
  createdBy: 'u1',
  updatedBy: 'u1',
};

function chainSelect(rows: unknown[]) {
  const lim = jest.fn().mockResolvedValue(rows);
  const ord = jest.fn(() => ({ limit: lim, then: undefined }));
  const wh = jest.fn(() => ({
    limit: lim,
    orderBy: jest.fn(() => ({ limit: lim })),
    then: undefined,
  }));
  // Support both .where().limit() and .where().orderBy().limit() and await .where()
  const whereResult: any = {
    limit: lim,
    orderBy: (..._a: unknown[]) => ({ limit: lim }),
  };
  // Make whereResult thenable for await db.select().from().where()
  whereResult.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);

  mockSelect.mockReturnValue({
    from: jest.fn(() => ({
      where: jest.fn(() => whereResult),
      orderBy: jest.fn(() => ({ limit: lim })),
    })),
  });
  return { lim, wh, ord };
}

function chainInsert(row: unknown) {
  mockInsert.mockReturnValue({
    values: jest.fn(() => ({
      returning: jest.fn().mockResolvedValue([row]),
    })),
  });
}

function chainUpdate(row: unknown) {
  mockUpdate.mockReturnValue({
    set: jest.fn(() => ({
      where: jest.fn(() => ({
        returning: jest.fn().mockResolvedValue([row]),
      })),
    })),
  });
}

function baseRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    projectId: PROJECT,
    loadTestId: DEF_ID,
    status: 'queued',
    runSource: 'app',
    queuedAt: NOW,
    startedAt: null,
    completedAt: null,
    heartbeatAt: NOW,
    dispatchMessageId: 'msg-1',
    cancelRequested: false,
    overallResult: null,
    thresholdResults: null,
    summaryArtifactRef: null,
    timeseriesArtifactRef: null,
    errorDetail: null,
    targetKey: 'https://staging.example.com',
    executionSnapshot: {
      targetUrl: definition.targetUrl,
      script: definition.script,
      loadProfile: definition.loadProfile,
      clientThresholds: definition.clientThresholds,
      secretRefs: { token: 'kv://vault/secret' },
      environment: 'staging',
      definitionName: 'API smoke',
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  stopLoadTestRunReaper();
  setDispatchPublisher({ publish: mockPublish });
  mockPublish.mockResolvedValue(undefined);
  mockGetDefinition.mockResolvedValue(definition as any);
  mockEnforceCaps.mockImplementation(() => undefined);
  mockAssertAllowlist.mockResolvedValue(undefined);
  process.env.LT_DISPATCH_PUBLISHER = 'noop';
});

afterEach(() => {
  stopLoadTestRunReaper();
  setDispatchPublisher(null);
});

describe('statusMachine (TBI-007 / VT-11)', () => {
  it('DoD / VT-11: rejects illegal transition passed → running', () => {
    expect(() => assertTransition('passed', 'running')).toThrow(LoadTestValidationError);
    try {
      assertTransition('passed', 'running');
    } catch (e) {
      expect((e as LoadTestValidationError).code).toBe('LOAD_TEST_ILLEGAL_TRANSITION');
    }
  });

  it('BR-007: evaluateThresholdOutcome all pass → passed; any fail → failed; empty → errored', () => {
    expect(evaluateThresholdOutcome([{ passed: true }, { passed: true }])).toBe('passed');
    expect(evaluateThresholdOutcome([{ passed: true }, { passed: false }])).toBe('failed');
    expect(evaluateThresholdOutcome([])).toBe('errored');
    expect(evaluateThresholdOutcome(null)).toBe('errored');
  });
});

describe('enqueue (TBI-007 DoD-0, PBI-008 AC-0/1/2, BR-004)', () => {
  it('AC-0 / DoD-0: creates run_source=app and publishes dispatch with dispatchMessageId', async () => {
    // active lock check → empty
    chainSelect([]);
    const queued = baseRun({ status: 'queued', dispatchMessageId: null });
    chainInsert(queued);
    const dispatched = baseRun({ status: 'dispatched', dispatchMessageId: 'msg-generated' });
    chainUpdate(dispatched);

    // After insert, update uses whatever dispatch id was generated — align mock
    mockUpdate.mockReturnValue({
      set: jest.fn((vals: any) => ({
        where: jest.fn(() => ({
          returning: jest.fn().mockResolvedValue([
            baseRun({
              status: 'dispatched',
              dispatchMessageId: vals.dispatchMessageId ?? 'msg-1',
            }),
          ]),
        })),
      })),
    });

    const run = await enqueue(PROJECT, DEF_ID);

    expect(run.status).toBe('dispatched');
    expect(run.runSource).toBe('app');
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0][0].dispatchMessageId).toBeTruthy();
    expect(mockPublish.mock.calls[0][0].runId).toBe('run-1');
    expect(mockEnforceCaps).toHaveBeenCalled();
    expect(mockAssertAllowlist).toHaveBeenCalled();
  });

  it('AC-1: rejects when target not allowlisted and does not publish', async () => {
    mockAssertAllowlist.mockRejectedValue(
      new LoadTestValidationError('not allowlisted', 'LOAD_TEST_TARGET_NOT_ALLOWLISTED'),
    );

    await expect(enqueue(PROJECT, DEF_ID)).rejects.toMatchObject({
      code: 'LOAD_TEST_TARGET_NOT_ALLOWLISTED',
    });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('BR-004 / VT-12: rejects over-cap profile before publish', async () => {
    mockEnforceCaps.mockImplementation(() => {
      throw new LoadTestValidationError('over cap', 'LOAD_TEST_PROFILE_CAP_EXCEEDED');
    });

    await expect(enqueue(PROJECT, DEF_ID)).rejects.toMatchObject({
      code: 'LOAD_TEST_PROFILE_CAP_EXCEEDED',
    });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('AC-2: when target has active run, new run remains queued and does not publish', async () => {
    // active lock check returns existing dispatched run
    chainSelect([{ id: 'active-run' }]);
    chainInsert(baseRun({ status: 'queued', dispatchMessageId: null }));

    const run = await enqueue(PROJECT, DEF_ID);

    expect(run.status).toBe('queued');
    expect(mockPublish).not.toHaveBeenCalled();
  });
});

describe('cancel (TBI-007 DoD-2, PBI-008 cancel)', () => {
  it('sets cancel_requested on non-terminal dispatched run', async () => {
    chainSelect([baseRun({ status: 'dispatched' })]);
    chainUpdate(baseRun({ status: 'dispatched', cancelRequested: true }));

    const run = await cancel(PROJECT, 'run-1');
    expect(run.cancelRequested).toBe(true);
    expect(run.status).toBe('dispatched');
  });

  it('queued without dispatch becomes cancelled immediately', async () => {
    chainSelect([baseRun({ status: 'queued', dispatchMessageId: null })]);
    // promote check after cancel
    let selectCalls = 0;
    mockSelect.mockImplementation(() => {
      selectCalls += 1;
      const rows =
        selectCalls === 1
          ? [baseRun({ status: 'queued', dispatchMessageId: null })]
          : [];
      const whereResult: any = {
        limit: jest.fn().mockResolvedValue(rows),
        orderBy: jest.fn(() => ({ limit: jest.fn().mockResolvedValue(rows) })),
      };
      whereResult.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject);
      return {
        from: jest.fn(() => ({
          where: jest.fn(() => whereResult),
        })),
      };
    });
    chainUpdate(baseRun({ status: 'cancelled', cancelRequested: true }));

    const run = await cancel(PROJECT, 'run-1');
    expect(run.status).toBe('cancelled');
    expect(run.cancelRequested).toBe(true);
  });
});

describe('ingest (TBI-007 DoD-1, PBI-009 AC-0)', () => {
  it('AC-0: final thresholds all pass → passed and stores artifact refs', async () => {
    chainSelect([baseRun({ status: 'running' })]);
    chainUpdate(
      baseRun({
        status: 'passed',
        overallResult: 'passed',
        thresholdResults: [{ metric: 'http_req_failed', expression: 'rate<0.01', passed: true }],
        summaryArtifactRef: { container: 'lt-artifacts', key: 'a/summary.json' },
        timeseriesArtifactRef: { container: 'lt-artifacts', key: 'a/ts.json' },
      }),
    );
    // promote selects after terminal
    const origUpdate = mockUpdate.getMockImplementation();
    mockSelect.mockImplementation(() => {
      const rows = [baseRun({ status: 'running' })];
      const whereResult: any = {
        limit: jest.fn().mockResolvedValue(rows),
        orderBy: jest.fn(() => ({ limit: jest.fn().mockResolvedValue([]) })),
      };
      whereResult.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
      return { from: jest.fn(() => ({ where: jest.fn(() => whereResult) })) };
    });
    // First select = getRun; subsequent = promote active + waiting
    let n = 0;
    mockSelect.mockImplementation(() => {
      n += 1;
      const rows = n === 1 ? [baseRun({ status: 'running' })] : [];
      const whereResult: any = {
        limit: jest.fn().mockResolvedValue(rows),
        orderBy: jest.fn(() => ({ limit: jest.fn().mockResolvedValue([]) })),
      };
      whereResult.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
      return { from: jest.fn(() => ({ where: jest.fn(() => whereResult) })) };
    });
    void origUpdate;

    const run = await ingest(PROJECT, 'run-1', {
      dispatchMessageId: 'msg-1',
      kind: 'final',
      thresholdResults: [{ metric: 'http_req_failed', expression: 'rate<0.01', passed: true }],
      summaryBlobRef: { container: 'lt-artifacts', key: 'a/summary.json' },
      timeseriesBlobRef: { container: 'lt-artifacts', key: 'a/ts.json' },
    });

    expect(run.status).toBe('passed');
    expect(run.overallResult).toBe('passed');
    expect(run.summaryArtifactRef).toEqual({
      container: 'lt-artifacts',
      key: 'a/summary.json',
    });
  });

  it('progress updates status to running and heartbeat', async () => {
    let n = 0;
    mockSelect.mockImplementation(() => {
      n += 1;
      const rows = [baseRun({ status: 'dispatched' })];
      const whereResult: any = {
        limit: jest.fn().mockResolvedValue(rows),
      };
      whereResult.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
      return { from: jest.fn(() => ({ where: jest.fn(() => whereResult) })) };
    });
    chainUpdate(baseRun({ status: 'running', heartbeatAt: '2026-07-25T12:01:00.000Z' }));

    const run = await ingest(PROJECT, 'run-1', {
      dispatchMessageId: 'msg-1',
      kind: 'progress',
      heartbeatAt: '2026-07-25T12:01:00.000Z',
      progress: { vu: 5 },
    });

    expect(run.status).toBe('running');
  });

  it('cancel_ack reaches cancelled (DoD-2)', async () => {
    let n = 0;
    mockSelect.mockImplementation(() => {
      n += 1;
      const rows = n === 1 ? [baseRun({ status: 'running', cancelRequested: true })] : [];
      const whereResult: any = {
        limit: jest.fn().mockResolvedValue(rows),
        orderBy: jest.fn(() => ({ limit: jest.fn().mockResolvedValue([]) })),
      };
      whereResult.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
      return { from: jest.fn(() => ({ where: jest.fn(() => whereResult) })) };
    });
    chainUpdate(baseRun({ status: 'cancelled', cancelRequested: true }));

    const run = await ingest(PROJECT, 'run-1', {
      dispatchMessageId: 'msg-1',
      kind: 'cancel_ack',
    });
    expect(run.status).toBe('cancelled');
  });
});

describe('reaper (TBI-007 DoD-3, PBI-009 AC-2)', () => {
  it('marks stale running run errored and frees lock for promotion', async () => {
    const stale = baseRun({
      status: 'running',
      heartbeatAt: '2026-07-25T11:00:00.000Z',
      queuedAt: '2026-07-25T11:00:00.000Z',
    });

    let selectPhase = 0;
    mockSelect.mockImplementation(() => {
      selectPhase += 1;
      // 1: stale scan; 2+: promote checks
      const rows = selectPhase === 1 ? [stale] : [];
      const whereResult: any = {
        limit: jest.fn().mockResolvedValue(rows),
        orderBy: jest.fn(() => ({ limit: jest.fn().mockResolvedValue([]) })),
      };
      whereResult.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
      return { from: jest.fn(() => ({ where: jest.fn(() => whereResult) })) };
    });

    chainUpdate(
      baseRun({
        status: 'errored',
        errorDetail: 'Stale heartbeat — run marked errored by reaper',
        completedAt: NOW,
      }),
    );

    const reaped = await reapStaleLoadTestRuns({
      now: () => new Date('2026-07-25T12:00:00.000Z').getTime(),
      staleMs: 60_000,
    });

    expect(reaped).toHaveLength(1);
    expect(reaped[0].status).toBe('errored');
  });
});
