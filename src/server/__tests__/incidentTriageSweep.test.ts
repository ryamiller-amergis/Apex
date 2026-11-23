/**
 * The incident triage sweep pulls changed ServiceNow incidents for each enabled project,
 * stores them redacted, and queues one pending analysis per content hash.
 * The flag service, ServiceNow client, lease and store are mocked.
 */
import type { IncidentTriageSettings } from '../../shared/types/incidentTriage';
import type { ServiceNowIncidentRow } from '../services/serviceNowClient';

const mockIsFeatureOperational = jest.fn();
const mockIsFlagEnabledForWholeProject = jest.fn();
const mockIsServiceNowConfigured = jest.fn();
const mockListAllIncidents = jest.fn();
const mockWithRepoCacheLease = jest.fn();
const mockGetSettings = jest.fn();
const mockListEnabledSettings = jest.fn();
const mockRecordSweepResult = jest.fn();
const mockUpsertIncident = jest.fn();
const mockInsertPendingAnalysis = jest.fn();
const mockRetryFailedPosts = jest.fn();
const mockFailStaleRunning = jest.fn();

class MockNonblockingError extends Error {}

jest.mock('../services/featureFlagService', () => ({
  isFeatureOperational: (...args: unknown[]) => mockIsFeatureOperational(...args),
  isFlagEnabledForWholeProject: (...args: unknown[]) => mockIsFlagEnabledForWholeProject(...args),
}));
jest.mock('../services/serviceNowClient', () => ({
  ...jest.requireActual('../services/serviceNowClient'),
  isServiceNowConfigured: () => mockIsServiceNowConfigured(),
  listAllIncidentsUpdatedSince: (...args: unknown[]) => mockListAllIncidents(...args),
}));
jest.mock('../services/repoCacheLeaseService', () => ({
  NonblockingRepoCacheLeaseUnavailableError: MockNonblockingError,
  withRepoCacheLease: (...args: unknown[]) => mockWithRepoCacheLease(...args),
}));
jest.mock('../services/incidentTriageStore', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  listEnabledSettings: (...args: unknown[]) => mockListEnabledSettings(...args),
  recordSweepResult: (...args: unknown[]) => mockRecordSweepResult(...args),
  upsertIncident: (...args: unknown[]) => mockUpsertIncident(...args),
  insertPendingAnalysis: (...args: unknown[]) => mockInsertPendingAnalysis(...args),
  failStaleRunningAnalyses: (...args: unknown[]) => mockFailStaleRunning(...args),
}));
jest.mock('../services/incidentTriageTeams', () => ({
  retryFailedIncidentTriagePosts: (...args: unknown[]) => mockRetryFailedPosts(...args),
}));

import { ServiceNowRequestError } from '../services/serviceNowClient';
import {
  IncidentTriageSchedulerService,
  IncidentTriageSweepUnavailableError,
  MAX_ANALYSES_PER_SWEEP,
  setIncidentTriageAdmission,
  sweepProject,
} from '../services/incidentTriageSweep';

const PROJECT = 'Apex';
const GROUP_ID = 'a'.repeat(32);
const NOW_MS = Date.parse('2026-11-20T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const INTERVAL_MS = 15 * 60 * 1000;

function settings(overrides: Partial<IncidentTriageSettings> = {}): IncidentTriageSettings {
  return {
    project: PROJECT,
    enabled: true,
    assignmentGroupIds: [GROUP_ID],
    backfillDays: 7,
    watermark: null,
    lastSweepAt: null,
    lastSweepError: null,
    teamsWebhookMasked: null,
    ...overrides,
  };
}

function row(overrides: Partial<ServiceNowIncidentRow> = {}): ServiceNowIncidentRow {
  return {
    sysId: 'b'.repeat(32),
    number: 'INC0012345',
    shortDescription: 'Timecard page fails',
    description: 'Users see an error on save.',
    state: 'In Progress',
    priority: '2 - High',
    impact: '2 - Medium',
    urgency: '2 - Medium',
    category: 'Software',
    subcategory: 'Timecard',
    assignmentGroupSysId: GROUP_ID,
    assignmentGroupName: 'MaxView Support',
    openedAt: '2026-11-19 10:00:00',
    resolvedAt: null,
    sysUpdatedOn: '2026-11-20 11:30:00',
    closeCode: '',
    closeNotes: '',
    ...overrides,
  };
}

function pages(...rowPages: ServiceNowIncidentRow[][]) {
  return (async function* () {
    for (const page of rowPages) yield page;
  })();
}

function failingAfter(rowPages: ServiceNowIncidentRow[][], error: Error) {
  return (async function* () {
    for (const page of rowPages) yield page;
    throw error;
  })();
}

function runLease(): void {
  mockWithRepoCacheLease.mockImplementation(async (_key, operation) => operation({}));
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockIsFeatureOperational.mockResolvedValue(true);
  mockIsFlagEnabledForWholeProject.mockResolvedValue(true);
  mockIsServiceNowConfigured.mockReturnValue(true);
  mockListEnabledSettings.mockResolvedValue([settings()]);
  mockGetSettings.mockResolvedValue(settings());
  mockListAllIncidents.mockImplementation(() => pages());
  mockRecordSweepResult.mockResolvedValue(undefined);
  mockUpsertIncident.mockImplementation(async (_project, _row, contentHash) => ({
    id: 'incident-1',
    contentHash,
    changed: true,
  }));
  mockInsertPendingAnalysis.mockResolvedValue(true);
  mockRetryFailedPosts.mockResolvedValue(undefined);
  mockFailStaleRunning.mockResolvedValue(0);
  setIncidentTriageAdmission(null);
  runLease();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('IncidentTriageSchedulerService.tick', () => {
  it('does nothing when the flag is not operational', async () => {
    mockIsFeatureOperational.mockResolvedValue(false);

    await new IncidentTriageSchedulerService().tick();

    expect(mockWithRepoCacheLease).not.toHaveBeenCalled();
    expect(mockListAllIncidents).not.toHaveBeenCalled();
  });

  it('does nothing when ServiceNow is not configured', async () => {
    mockIsServiceNowConfigured.mockReturnValue(false);

    await new IncidentTriageSchedulerService().tick();

    expect(mockWithRepoCacheLease).not.toHaveBeenCalled();
    expect(mockListAllIncidents).not.toHaveBeenCalled();
  });

  it('skips when another instance holds the lease', async () => {
    mockWithRepoCacheLease.mockRejectedValue(new MockNonblockingError('held'));

    await expect(new IncidentTriageSchedulerService().tick()).resolves.toBeUndefined();

    expect(mockWithRepoCacheLease).toHaveBeenCalledWith(
      'incident-triage:sweep',
      expect.any(Function),
      { leaseMs: INTERVAL_MS - 5000, waitMs: 0, releaseOnComplete: false },
    );
    expect(mockListEnabledSettings).not.toHaveBeenCalled();
    expect(mockListAllIncidents).not.toHaveBeenCalled();
  });

  it('skips projects whose flag is not enabled for the whole project', async () => {
    mockListEnabledSettings.mockResolvedValue([
      settings({ project: 'Apex' }),
      settings({ project: 'Other' }),
    ]);
    mockIsFlagEnabledForWholeProject.mockImplementation(async (_key, project) => project === 'Apex');
    mockGetSettings.mockImplementation(async (project) => settings({ project }));

    await new IncidentTriageSchedulerService().tick();

    expect(mockIsFlagEnabledForWholeProject).toHaveBeenCalledWith('servicenow-incident-triage', 'Other');
    expect(mockListAllIncidents).toHaveBeenCalledTimes(1);
    expect(mockRecordSweepResult).toHaveBeenCalledWith('Apex', expect.anything());
    expect(mockRecordSweepResult).not.toHaveBeenCalledWith('Other', expect.anything());
  });

  it('records lastSweepError without secrets and does not throw from tick', async () => {
    process.env.SERVICENOW_CLIENT_SECRET = 'super-secret-value';
    try {
      mockListAllIncidents.mockImplementation(() =>
        failingAfter([], new ServiceNowRequestError('ServiceNow request failed (HTTP 500)', 500)),
      );

      await expect(new IncidentTriageSchedulerService().tick()).resolves.toBeUndefined();

      expect(mockRecordSweepResult).toHaveBeenCalledWith(PROJECT, {
        lastSweepAt: new Date(NOW_MS).toISOString(),
        lastSweepError: 'ServiceNow request failed (HTTP 500)',
      });
      const logged = JSON.stringify((console.error as jest.Mock).mock.calls);
      expect(logged).not.toContain('super-secret-value');
    } finally {
      delete process.env.SERVICENOW_CLIENT_SECRET;
    }
  });

  it('continues with the next project after one project fails', async () => {
    mockListEnabledSettings.mockResolvedValue([
      settings({ project: 'Apex' }),
      settings({ project: 'Other' }),
    ]);
    mockGetSettings.mockImplementation(async (project) => settings({ project }));
    mockListAllIncidents
      .mockImplementationOnce(() => failingAfter([], new ServiceNowRequestError('boom', 500)))
      .mockImplementationOnce(() => pages([row()]));

    await new IncidentTriageSchedulerService().tick();

    expect(mockListAllIncidents).toHaveBeenCalledTimes(2);
    expect(mockUpsertIncident).toHaveBeenCalledTimes(1);
    expect(mockUpsertIncident.mock.calls[0][0]).toBe('Other');
  });

  it('a ServiceNow error on one project still runs admission and retries once per tick', async () => {
    const admit = jest.fn().mockResolvedValue(undefined);
    setIncidentTriageAdmission(admit);
    mockListEnabledSettings.mockResolvedValue([
      settings({ project: 'Apex' }),
      settings({ project: 'Other' }),
    ]);
    mockGetSettings.mockImplementation(async (project) => settings({ project }));
    mockListAllIncidents
      .mockImplementationOnce(() => failingAfter([], new ServiceNowRequestError('boom', 500)))
      .mockImplementationOnce(() => failingAfter([], new ServiceNowRequestError('boom', 500)));

    await new IncidentTriageSchedulerService().tick();

    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledWith(MAX_ANALYSES_PER_SWEEP, ['Apex', 'Other']);
    expect(mockRetryFailedPosts).toHaveBeenCalledTimes(1);
    expect(mockRetryFailedPosts).toHaveBeenCalledWith(5, ['Apex', 'Other']);
  });

  it('a project whose flag is off gets no admission or posts', async () => {
    const admit = jest.fn().mockResolvedValue(undefined);
    setIncidentTriageAdmission(admit);
    mockListEnabledSettings.mockResolvedValue([
      settings({ project: 'Apex' }),
      settings({ project: 'Other' }),
    ]);
    mockIsFlagEnabledForWholeProject.mockImplementation(async (_key, project) => project === 'Apex');
    mockGetSettings.mockImplementation(async (project) => settings({ project }));

    await new IncidentTriageSchedulerService().tick();

    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledWith(MAX_ANALYSES_PER_SWEEP, ['Apex']);
    expect(mockRetryFailedPosts).toHaveBeenCalledWith(5, ['Apex']);
  });

  it('no project with the flag on means no admission and no posts', async () => {
    const admit = jest.fn().mockResolvedValue(undefined);
    setIncidentTriageAdmission(admit);
    mockIsFlagEnabledForWholeProject.mockResolvedValue(false);

    await new IncidentTriageSchedulerService().tick();

    expect(admit).not.toHaveBeenCalled();
    expect(mockRetryFailedPosts).not.toHaveBeenCalled();
  });

  it('stale running rows are failed before admission, 45 minutes after the request', async () => {
    const admit = jest.fn().mockResolvedValue(undefined);
    setIncidentTriageAdmission(admit);

    await new IncidentTriageSchedulerService().tick();

    expect(mockFailStaleRunning).toHaveBeenCalledTimes(1);
    expect(mockFailStaleRunning).toHaveBeenCalledWith(new Date(NOW_MS - 45 * 60 * 1000), 'Analysis did not finish');
    expect(mockFailStaleRunning.mock.invocationCallOrder[0]).toBeLessThan(admit.mock.invocationCallOrder[0]);
  });

  it('a failing reaper does not stop admission or the tick', async () => {
    const admit = jest.fn().mockResolvedValue(undefined);
    setIncidentTriageAdmission(admit);
    mockFailStaleRunning.mockRejectedValue(new Error('select * from t where secret = $1'));

    await expect(new IncidentTriageSchedulerService().tick()).resolves.toBeUndefined();

    expect(admit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('secret');
  });
});

describe('sweepProject', () => {
  it('first sweep starts at backfill_days ago; later sweeps start 5 minutes before the watermark', async () => {
    mockGetSettings.mockResolvedValue(settings({ backfillDays: 3, watermark: null }));
    await sweepProject(PROJECT, { requestedBy: null });
    expect(mockListAllIncidents.mock.calls[0][0]).toEqual({
      groupIds: [GROUP_ID],
      since: new Date(NOW_MS - 3 * DAY_MS),
    });

    const watermark = '2026-11-20T11:00:00.000Z';
    mockGetSettings.mockResolvedValue(settings({ watermark }));
    await sweepProject(PROJECT, { requestedBy: null });
    expect(mockListAllIncidents.mock.calls[1][0]).toEqual({
      groupIds: [GROUP_ID],
      since: new Date(Date.parse(watermark) - FIVE_MINUTES_MS),
    });
  });

  it('advances the watermark to the max sys_updated_on after a stored page; not on error', async () => {
    mockListAllIncidents.mockImplementation(() =>
      failingAfter(
        [[
          row({ sysId: '1'.repeat(32), sysUpdatedOn: '2026-11-20 10:00:00' }),
          row({ sysId: '2'.repeat(32), sysUpdatedOn: '2026-11-20 10:45:00' }),
        ]],
        new ServiceNowRequestError('ServiceNow request failed (HTTP 503)', 503),
      ),
    );

    await expect(sweepProject(PROJECT, { requestedBy: null })).rejects.toThrow('HTTP 503');

    const calls = mockRecordSweepResult.mock.calls.map(([, result]) => result);
    expect(calls[0]).toEqual({
      watermark: '2026-11-20T10:45:00.000Z',
      lastSweepAt: new Date(NOW_MS).toISOString(),
      lastSweepError: null,
    });
    expect(calls[calls.length - 1]).not.toHaveProperty('watermark');
    expect(calls[calls.length - 1].lastSweepError).toBe('ServiceNow request failed (HTTP 503)');
    expect(calls.filter((call) => 'watermark' in call)).toHaveLength(1);
  });

  it('does not move the watermark back when a page is older than it', async () => {
    mockGetSettings.mockResolvedValue(settings({ watermark: '2026-11-20T11:00:00.000Z' }));
    mockListAllIncidents.mockImplementation(() =>
      pages([row({ sysUpdatedOn: '2026-11-20 10:58:00' })]),
    );

    await sweepProject(PROJECT, { requestedBy: null });

    expect(mockRecordSweepResult.mock.calls.every(([, result]) => !('watermark' in result))).toBe(true);
  });

  it('stores redacted text only', async () => {
    mockListAllIncidents.mockImplementation(() =>
      pages([
        row({
          shortDescription: 'Failure for jane.doe@example.com',
          description: 'Call 555-123-4567 about SSN 123-45-6789',
          closeNotes: 'Fixed for worker 12345678',
        }),
      ]),
    );

    await sweepProject(PROJECT, { requestedBy: null });

    const [project, stored, contentHash] = mockUpsertIncident.mock.calls[0];
    expect(project).toBe(PROJECT);
    expect(stored.shortDescription).toBe('Failure for [email]');
    expect(stored.description).toBe('Call [phone] about SSN [ssn]');
    expect(stored.closeNotes).toBe('Fixed for worker [id]');
    expect(stored.closeCode).toBeNull();
    expect(stored.sysUpdatedOn).toBe('2026-11-20T11:30:00.000Z');
    expect(stored.openedAt).toBe('2026-11-19T10:00:00.000Z');
    expect(stored.resolvedAt).toBeNull();
    const everythingStored = JSON.stringify(mockUpsertIncident.mock.calls);
    expect(everythingStored).not.toContain('jane.doe@example.com');
    expect(everythingStored).not.toContain('555-123-4567');
    expect(everythingStored).not.toContain('123-45-6789');
    expect(everythingStored).not.toContain('12345678');
    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same content twice gives one pending analysis', async () => {
    let inserted = false;
    mockInsertPendingAnalysis.mockImplementation(async () => {
      const wasInserted = !inserted;
      inserted = true;
      return wasInserted;
    });
    mockListAllIncidents.mockImplementation(() => pages([row()]));

    const first = await sweepProject(PROJECT, { requestedBy: null });
    const second = await sweepProject(PROJECT, { requestedBy: null });

    expect(first.newAnalyses).toBe(1);
    expect(second.newAnalyses).toBe(0);
    const hashes = mockInsertPendingAnalysis.mock.calls.map((call) => call[1]);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it('changed content gives a new pending analysis', async () => {
    mockListAllIncidents
      .mockImplementationOnce(() => pages([row({ state: 'In Progress' })]))
      .mockImplementationOnce(() => pages([row({ state: 'Resolved', closeNotes: 'Patched' })]));

    await sweepProject(PROJECT, { requestedBy: null });
    await sweepProject(PROJECT, { requestedBy: null });

    const hashes = mockInsertPendingAnalysis.mock.calls.map((call) => call[1]);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it('keeps the hash steady when only fields outside the signal change', async () => {
    mockListAllIncidents
      .mockImplementationOnce(() => pages([row({ sysUpdatedOn: '2026-11-20 11:30:00' })]))
      .mockImplementationOnce(() => pages([row({ sysUpdatedOn: '2026-11-20 11:40:00' })]));

    await sweepProject(PROJECT, { requestedBy: null });
    await sweepProject(PROJECT, { requestedBy: null });

    const hashes = mockInsertPendingAnalysis.mock.calls.map((call) => call[1]);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it('queues scheduled-style analyses with no requester, even for an on-demand sweep', async () => {
    mockListAllIncidents.mockImplementation(() => pages([row()]));

    await sweepProject(PROJECT, { requestedBy: 'user-1' });

    expect(mockInsertPendingAnalysis).toHaveBeenCalledWith(
      'incident-1',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      '2026-11-20T11:30:00.000Z',
      null,
    );
  });

  it('returns fetched, upserted and newAnalyses counts', async () => {
    mockUpsertIncident
      .mockResolvedValueOnce({ id: 'i1', contentHash: 'h1', changed: true })
      .mockResolvedValueOnce({ id: 'i2', contentHash: 'h2', changed: false });
    mockInsertPendingAnalysis.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockListAllIncidents.mockImplementation(() =>
      pages([row({ sysId: '1'.repeat(32) }), row({ sysId: '2'.repeat(32) })]),
    );

    await expect(sweepProject(PROJECT, { requestedBy: null })).resolves.toEqual({
      fetched: 2,
      upserted: 1,
      newAnalyses: 1,
    });
  });

  it('throws not_enabled when settings are missing or disabled', async () => {
    mockGetSettings.mockResolvedValueOnce(null);
    await expect(sweepProject(PROJECT, { requestedBy: 'user-1' })).rejects.toMatchObject({
      name: 'IncidentTriageSweepUnavailableError',
      reason: 'not_enabled',
    });

    mockGetSettings.mockResolvedValueOnce(settings({ enabled: false }));
    await expect(sweepProject(PROJECT, { requestedBy: 'user-1' })).rejects.toBeInstanceOf(
      IncidentTriageSweepUnavailableError,
    );
    expect(mockListAllIncidents).not.toHaveBeenCalled();
  });

  it('throws not_configured when ServiceNow is not configured', async () => {
    mockIsServiceNowConfigured.mockReturnValue(false);

    await expect(sweepProject(PROJECT, { requestedBy: 'user-1' })).rejects.toMatchObject({
      reason: 'not_configured',
    });
  });

  it('asks the admission hook for up to MAX_ANALYSES_PER_SWEEP when analyses were queued', async () => {
    const admit = jest.fn().mockResolvedValue(undefined);
    setIncidentTriageAdmission(admit);
    mockListAllIncidents.mockImplementation(() => pages([row()]));

    await sweepProject(PROJECT, { requestedBy: null });

    expect(MAX_ANALYSES_PER_SWEEP).toBe(5);
    expect(admit).toHaveBeenCalledWith(MAX_ANALYSES_PER_SWEEP, [PROJECT]);
  });

  it('asks the admission hook when no analysis was queued, so a reverted row retries', async () => {
    const admit = jest.fn().mockResolvedValue(undefined);
    setIncidentTriageAdmission(admit);
    mockInsertPendingAnalysis.mockResolvedValue(false);
    mockListAllIncidents.mockImplementation(() => pages([row()]));

    await sweepProject(PROJECT, { requestedBy: null });

    expect(admit).toHaveBeenCalledWith(MAX_ANALYSES_PER_SWEEP, [PROJECT]);
  });

  it('on-demand sweep of A does not admit or post B\'s rows', async () => {
    const admit = jest.fn().mockResolvedValue(undefined);
    setIncidentTriageAdmission(admit);
    mockListEnabledSettings.mockResolvedValue([settings({ project: 'Apex' }), settings({ project: 'Other' })]);
    mockGetSettings.mockImplementation(async (project) => settings({ project }));
    mockListAllIncidents.mockImplementation(() => pages([row()]));

    await sweepProject('Apex', { requestedBy: 'user-1' });

    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledWith(MAX_ANALYSES_PER_SWEEP, ['Apex']);
    expect(mockRetryFailedPosts).toHaveBeenCalledTimes(1);
    expect(mockRetryFailedPosts).toHaveBeenCalledWith(5, ['Apex']);
    expect(mockFailStaleRunning).not.toHaveBeenCalled();
  });

  it('logs only the error name and code for an error that is not from ServiceNow', async () => {
    mockListAllIncidents.mockImplementation(() =>
      failingAfter([], Object.assign(new Error('insert into incidents values ($1) params: secret-value'), { code: '23505' })),
    );

    await expect(sweepProject(PROJECT, { requestedBy: null })).rejects.toThrow();

    const logged = JSON.stringify((console.error as jest.Mock).mock.calls);
    expect(logged).toContain('Error');
    expect(logged).toContain('23505');
    expect(logged).not.toContain('secret-value');
    expect(logged).not.toContain('insert into');
  });

  it('does not fail the sweep when the admission hook throws', async () => {
    setIncidentTriageAdmission(jest.fn().mockRejectedValue(new Error('admission down')));
    mockListAllIncidents.mockImplementation(() => pages([row()]));

    await expect(sweepProject(PROJECT, { requestedBy: null })).resolves.toMatchObject({ newAnalyses: 1 });
    expect(mockRecordSweepResult).not.toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ lastSweepError: 'admission down' }),
    );
  });

  it('retries failed Teams posts, five at most, after admission', async () => {
    const admit = jest.fn().mockResolvedValue(undefined);
    setIncidentTriageAdmission(admit);
    mockListAllIncidents.mockImplementation(() => pages([row()]));

    await sweepProject(PROJECT, { requestedBy: null });

    expect(mockRetryFailedPosts).toHaveBeenCalledWith(5, [PROJECT]);
    expect(admit.mock.invocationCallOrder[0]).toBeLessThan(mockRetryFailedPosts.mock.invocationCallOrder[0]);
  });

  it('retries failed Teams posts when no admission hook is set', async () => {
    mockListAllIncidents.mockImplementation(() => pages());

    await sweepProject(PROJECT, { requestedBy: null });

    expect(mockRetryFailedPosts).toHaveBeenCalledWith(5, [PROJECT]);
  });

  it('does not fail the sweep when the Teams retry throws', async () => {
    mockRetryFailedPosts.mockRejectedValue(new Error('teams retry down'));
    mockListAllIncidents.mockImplementation(() => pages([row()]));

    await expect(sweepProject(PROJECT, { requestedBy: null })).resolves.toMatchObject({ newAnalyses: 1 });
    expect(mockRecordSweepResult).not.toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ lastSweepError: expect.stringContaining('teams retry') }),
    );
    expect(console.error).toHaveBeenCalled();
  });
});
