const mockGetSkillConfigById = jest.fn();
const mockUpdateRepositoryCheckoutState = jest.fn();
const mockCloneRepositoryForAdmin = jest.fn();
const mockMaterialize = jest.fn();
const mockGetReady = jest.fn();
const mockTrackEvent = jest.fn();
const mockInsertCheckoutJob = jest.fn();
const mockClaimNextCheckoutJob = jest.fn();
const mockCompleteCheckoutJob = jest.fn();
const mockRecoverExpired = jest.fn().mockResolvedValue([]);
const mockStartHeartbeat = jest.fn().mockReturnValue(() => undefined);
const mockPublish = jest.fn().mockResolvedValue(undefined);
const mockGetReadiness = jest.fn();

jest.mock('../services/projectSettingsService', () => ({
  getSkillConfigById: (...args: unknown[]) => mockGetSkillConfigById(...args),
  updateRepositoryCheckoutState: (...args: unknown[]) =>
    mockUpdateRepositoryCheckoutState(...args),
}));

jest.mock('../services/repoCacheService', () => ({
  cloneRepositoryForAdmin: (...args: unknown[]) => mockCloneRepositoryForAdmin(...args),
}));

jest.mock('../services/grounding/sharedReadCheckoutService', () => ({
  sharedReadCheckoutService: {
    materialize: (...args: unknown[]) => mockMaterialize(...args),
    getReady: (...args: unknown[]) => mockGetReady(...args),
  },
}));

jest.mock('../services/telemetry', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

jest.mock('../services/repositoryCheckoutJobService', () => ({
  insertCheckoutJob: (...args: unknown[]) => mockInsertCheckoutJob(...args),
  claimNextCheckoutJob: (...args: unknown[]) => mockClaimNextCheckoutJob(...args),
  completeCheckoutJob: (...args: unknown[]) => mockCompleteCheckoutJob(...args),
  recoverExpiredCheckoutJobs: (...args: unknown[]) => mockRecoverExpired(...args),
  startCheckoutJobHeartbeat: (...args: unknown[]) => mockStartHeartbeat(...args),
  isRepoCheckoutWorkerInProcess: () => false,
}));

jest.mock('../services/repoCheckoutWakeupPublisher', () => ({
  getRepoCheckoutWakeupPublisher: () => ({ publish: mockPublish }),
}));

jest.mock('../services/projectRepositoryReadinessService', () => ({
  getProjectRepositoryReadiness: (...args: unknown[]) => mockGetReadiness(...args),
}));

import {
  enqueueRepositoryCheckout,
  executeRepositoryCheckout,
} from '../services/projectRepositoryCheckoutService';

const config = {
  id: 'cfg-1',
  project: 'Apex',
  skillProvider: 'github',
  skillRepo: 'AI-Pilot',
  skillBranch: 'main',
  repositoryCheckoutStatus: 'not_cloned',
  repositoryCheckoutSha: null,
  repositoryCheckoutError: null,
  repositoryCheckoutStartedAt: null,
  repositoryCheckoutCompletedAt: null,
};

describe('enqueueRepositoryCheckout AC-0/AC-1 — HTTP enqueue, no git', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSkillConfigById.mockResolvedValue(config);
    mockUpdateRepositoryCheckoutState.mockResolvedValue(config);
    mockInsertCheckoutJob.mockResolvedValue({ id: 'job-1', skillSettingsId: 'cfg-1' });
  });

  it('AC-0: POST enqueue sets cloning, publishes wakeup, and does not invoke git', async () => {
    const result = await enqueueRepositoryCheckout('cfg-1', { refresh: false });

    expect(result.status).toBe('cloning');
    expect(result.progressPercent).toBe(0);
    expect(result.progressLabel).toBe('Queued');
    expect(mockUpdateRepositoryCheckoutState).toHaveBeenCalledWith(
      'cfg-1',
      expect.objectContaining({ status: 'cloning', progressPercent: 0 }),
    );
    expect(mockInsertCheckoutJob).toHaveBeenCalledWith({
      skillSettingsId: 'cfg-1',
      refresh: false,
    });
    expect(mockPublish).toHaveBeenCalledWith('job-1');
    expect(mockCloneRepositoryForAdmin).not.toHaveBeenCalled();
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it('AC-1: duplicate enqueue while cloning is idempotent (no second job)', async () => {
    mockGetSkillConfigById.mockResolvedValue({
      ...config,
      repositoryCheckoutStatus: 'cloning',
      repositoryCheckoutProgressPercent: 12,
      repositoryCheckoutProgressLabel: 'Receiving objects 45%',
    });
    mockGetReadiness.mockResolvedValue({
      skillSettingsId: 'cfg-1',
      status: 'cloning',
      sha: null,
      error: null,
      startedAt: '2026-08-12T00:00:00Z',
      completedAt: null,
      filesystemReady: false,
      progressPercent: 12,
      progressLabel: 'Receiving objects 45%',
    });

    const result = await enqueueRepositoryCheckout('cfg-1', { refresh: true });

    expect(result.status).toBe('cloning');
    expect(result.progressPercent).toBe(12);
    expect(mockInsertCheckoutJob).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockCloneRepositoryForAdmin).not.toHaveBeenCalled();
  });
});

describe('executeRepositoryCheckout — worker terminal states', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSkillConfigById.mockResolvedValue({
      ...config,
      repositoryCheckoutStatus: 'cloning',
      repositoryCheckoutStartedAt: '2026-08-12T00:00:00Z',
    });
    mockUpdateRepositoryCheckoutState.mockResolvedValue(config);
    mockCloneRepositoryForAdmin.mockResolvedValue({
      cacheDir: '/data/workspaces/repo-cache/x.git',
      baseSha: 'abc123',
      stale: false,
      remote: { url: 'https://example.test/repo.git', env: {} },
    });
    mockMaterialize.mockResolvedValue({
      workspacePath: '/data/workspaces/grounding-shared/digest',
      outcome: 'materialized',
    });
    mockGetReady.mockReturnValue({
      workspacePath: '/data/workspaces/grounding-shared/digest',
      outcome: 'hit',
    });
  });

  it('DoD: success updates readiness to ready with SHA and does not leave progress', async () => {
    const result = await executeRepositoryCheckout('cfg-1', { refresh: true });

    expect(mockCloneRepositoryForAdmin).toHaveBeenCalled();
    expect(mockMaterialize).toHaveBeenCalledWith(
      expect.objectContaining({ sha: 'abc123' }),
    );
    expect(result.status).toBe('ready');
    expect(result.sha).toBe('abc123');
    expect(result.filesystemReady).toBe(true);
    expect(mockUpdateRepositoryCheckoutState).toHaveBeenCalledWith(
      'cfg-1',
      expect.objectContaining({
        status: 'ready',
        sha: 'abc123',
        progressPercent: null,
        progressLabel: null,
      }),
    );
  });

  it('DoD: failure sanitizes error and sets failed', async () => {
    mockCloneRepositoryForAdmin.mockRejectedValue(
      new Error('git clone failed: Authorization: Basic hunter2'),
    );

    const result = await executeRepositoryCheckout('cfg-1');

    expect(result.status).toBe('failed');
    expect(result.error).toContain('[redacted]');
    expect(result.error).not.toContain('hunter2');
    expect(mockUpdateRepositoryCheckoutState).toHaveBeenCalledWith(
      'cfg-1',
      expect.objectContaining({ status: 'failed' }),
    );
  });
});
