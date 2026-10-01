const mockExecute = jest.fn();
const mockUpdateReturning = jest.fn();
const mockUpdateSet = jest.fn();
const mockInsertValues = jest.fn();
const mockTransaction = jest.fn();
const mockFindRequest = jest.fn();

function updateChain() {
  return {
    set: (values: unknown) => {
      mockUpdateSet(values);
      return { where: () => ({ returning: mockUpdateReturning }) };
    },
  };
}

jest.mock('../db/drizzle', () => ({
  db: {
    execute: (...args: unknown[]) => mockExecute(...args),
    update: () => updateChain(),
    insert: () => ({ values: mockInsertValues }),
    transaction: (fn: (tx: unknown) => unknown) => mockTransaction(fn),
    query: { rfpRequests: { findFirst: (...args: unknown[]) => mockFindRequest(...args) } },
  },
}));

const mockCreateNotification = jest.fn();
jest.mock('../services/notificationService', () => ({
  createNotification: (...args: unknown[]) => mockCreateNotification(...args),
}));

const mockLoadReviewState = jest.fn();
jest.mock('../services/rfpProposalFingerprint', () => ({
  loadRfpReviewState: (...args: unknown[]) => mockLoadReviewState(...args),
}));

jest.mock('../services/rfpProposalGenerationService', () => ({ generateRfpDraft: jest.fn() }));

import {
  RfpLeaseLostError,
  claimNextRfpProposalJob,
  completeRfpProposalJob,
  failOrRetryRfpProposalJob,
  recoverExpiredRfpProposalJobs,
  rfpRetryDelayMs,
  runClaimedRfpProposalJob,
  type ClaimedRfpProposalJob,
  type RfpProposalJobRunnerDeps,
} from '../services/rfpProposalGenerationWorker';
import type { RfpGeneratedDraft } from '../../shared/types/rfpIntake';

const JOB: ClaimedRfpProposalJob = {
  id: 'job-1',
  rfpRequestId: 'rfp-1',
  kind: 'proposal',
  verdict: 'build',
  inputFingerprint: 'fp-1',
  requestedBy: 'admin-1',
  attempts: 1,
  maxAttempts: 3,
};

const DRAFT = { kind: 'decision-summary', jobId: 'job-1' } as unknown as RfpGeneratedDraft;

function sqlText(call: unknown[]): string {
  const query = call[0] as { queryChunks?: Array<{ value?: string[] } | string> };
  return (query.queryChunks ?? [])
    .map((chunk) => (typeof chunk === 'string' ? '?' : (chunk.value ?? []).join('')))
    .join('');
}

function runnerDeps(overrides: Partial<RfpProposalJobRunnerDeps> = {}): RfpProposalJobRunnerDeps {
  return {
    generate: jest.fn().mockImplementation(async (_job, onPhase) => {
      await onPhase('researching-prices');
      await onPhase('writing');
      return DRAFT;
    }),
    markPhase: jest.fn().mockResolvedValue(undefined),
    renewLease: jest.fn().mockResolvedValue(true),
    complete: jest.fn().mockResolvedValue('ready'),
    failOrRetry: jest.fn().mockResolvedValue('retry'),
    recordStarted: jest.fn().mockResolvedValue(undefined),
    heartbeatMs: 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTransaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({
    update: () => updateChain(),
    insert: () => ({ values: mockInsertValues }),
  }));
});

describe('rfpProposalGenerationWorker', () => {
  it('WK-0 claims with SKIP LOCKED, only due queued jobs, and maps the row', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'job-1', rfp_request_id: 'rfp-1', kind: 'proposal', verdict: 'build',
        input_fingerprint: 'fp-1', requested_by: 'admin-1', attempts: 1, max_attempts: 3,
      }],
    });
    await expect(claimNextRfpProposalJob()).resolves.toEqual(JOB);
    const text = sqlText(mockExecute.mock.calls[0]);
    expect(text).toContain('FOR UPDATE SKIP LOCKED');
    expect(text).toContain("status = 'queued' AND available_at <= now()");
    expect(text).toContain('attempts = jobs.attempts + 1');
  });

  it('WK-1 returns null when no job is due', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });
    await expect(claimNextRfpProposalJob()).resolves.toBeNull();
  });

  it('WK-2 runs phases, then stores the draft', async () => {
    const deps = runnerDeps();
    await runClaimedRfpProposalJob(JOB, deps);
    expect(deps.recordStarted).toHaveBeenCalledWith(JOB);
    expect(deps.markPhase).toHaveBeenNthCalledWith(1, 'job-1', 'researching-prices');
    expect(deps.markPhase).toHaveBeenNthCalledWith(2, 'job-1', 'writing');
    expect(deps.complete).toHaveBeenCalledWith(JOB, DRAFT);
    expect(deps.failOrRetry).not.toHaveBeenCalled();
  });

  it('WK-3 hands generation errors to retry handling', async () => {
    const error = new Error('Bedrock throttled');
    const deps = runnerDeps({ generate: jest.fn().mockRejectedValue(error) });
    await runClaimedRfpProposalJob(JOB, deps);
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.failOrRetry).toHaveBeenCalledWith(JOB, error);
  });

  it('WK-4 stops quietly when another worker took the lease', async () => {
    const deps = runnerDeps({ markPhase: jest.fn().mockRejectedValue(new RfpLeaseLostError('job-1')) });
    await runClaimedRfpProposalJob(JOB, deps);
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.failOrRetry).not.toHaveBeenCalled();
  });

  it('WK-5 backs off exponentially between attempts', () => {
    expect(rfpRetryDelayMs(1)).toBe(30_000);
    expect(rfpRetryDelayMs(2)).toBe(60_000);
    expect(rfpRetryDelayMs(3)).toBe(120_000);
  });

  it('WK-6 requeues a retryable failure with a later available time', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ id: 'job-1' }]);
    await expect(failOrRetryRfpProposalJob(JOB, new Error('timeout'))).resolves.toBe('retry');
    const values = mockUpdateSet.mock.calls[0][0];
    expect(values.status).toBe('queued');
    expect(typeof values.availableAt).toBe('string');
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('WK-7 fails on the last attempt, logs the event, and notifies the admin', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ id: 'job-1' }]);
    mockFindRequest.mockResolvedValueOnce({ title: 'Onboarding tracker' });
    await expect(failOrRetryRfpProposalJob({ ...JOB, attempts: 3 }, new Error('bad output'))).resolves.toBe('failed');
    expect(mockUpdateSet.mock.calls[0][0]).toMatchObject({ status: 'failed', errorMessage: 'bad output' });
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      rfpRequestId: 'rfp-1',
      eventType: 'proposal-generation-failed',
    }));
    expect(mockCreateNotification).toHaveBeenCalledWith('admin-1', expect.objectContaining({
      title: 'Proposal generation failed',
      link: '/rfp-intake/rfp-1',
    }));
  });

  it('WK-8 fails immediately on errors marked not retryable', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ id: 'job-1' }]);
    mockFindRequest.mockResolvedValueOnce({ title: 'x' });
    const error = Object.assign(new Error('Architecture missing'), { retryable: false });
    await expect(failOrRetryRfpProposalJob(JOB, error)).resolves.toBe('failed');
  });

  it('WK-9 ignores a failure after ownership changed', async () => {
    mockUpdateReturning.mockResolvedValueOnce([]);
    await expect(failOrRetryRfpProposalJob(JOB, new Error('x'))).resolves.toBe('lost');
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('WK-10 stores a current draft on the request and logs completion', async () => {
    mockLoadReviewState.mockResolvedValueOnce({ row: { currentProposalJobId: 'job-1' }, fingerprint: 'fp-1' });
    mockUpdateReturning.mockResolvedValueOnce([{ id: 'job-1' }]);
    await expect(completeRfpProposalJob(JOB, DRAFT)).resolves.toBe('ready');
    expect(mockLoadReviewState).toHaveBeenCalledWith(expect.anything(), 'rfp-1', { lock: true });
    expect(mockUpdateSet.mock.calls[0][0]).toMatchObject({ status: 'ready', draft: DRAFT });
    expect(mockUpdateSet.mock.calls[1][0]).toMatchObject({ proposalDraft: DRAFT });
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'proposal-generation-completed' }));
  });

  it('WK-11 marks the job superseded when the review changed while it ran', async () => {
    mockLoadReviewState.mockResolvedValueOnce({ row: { currentProposalJobId: 'job-1' }, fingerprint: 'fp-2' });
    mockUpdateReturning.mockResolvedValueOnce([{ id: 'job-1' }]);
    await expect(completeRfpProposalJob(JOB, DRAFT)).resolves.toBe('superseded');
    expect(mockUpdateSet.mock.calls[0][0]).toMatchObject({ status: 'superseded', draft: null });
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('WK-12 logs a decision-summary event for decline drafts', async () => {
    mockLoadReviewState.mockResolvedValueOnce({ row: { currentProposalJobId: 'job-1' }, fingerprint: 'fp-1' });
    mockUpdateReturning.mockResolvedValueOnce([{ id: 'job-1' }]);
    await completeRfpProposalJob({ ...JOB, kind: 'decision-summary', verdict: 'decline' }, DRAFT);
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'decision-summary-generated' }));
  });

  it('WK-13 requeues expired leases and fails exhausted ones with a notification', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ id: 'job-9', rfp_request_id: 'rfp-9', requested_by: 'admin-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'job-2' }, { id: 'job-3' }] });
    mockFindRequest.mockResolvedValueOnce({ title: 'Stuck' });
    await expect(recoverExpiredRfpProposalJobs()).resolves.toEqual({ requeued: 2, failed: 1 });
    expect(sqlText(mockExecute.mock.calls[0])).toContain('attempts >= max_attempts');
    expect(sqlText(mockExecute.mock.calls[1])).toContain('attempts < max_attempts');
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      rfpRequestId: 'rfp-9',
      eventType: 'proposal-generation-failed',
    }));
    expect(mockCreateNotification).toHaveBeenCalledWith('admin-1', expect.anything());
  });
});
