/**
 * VT-07 / VT-08 — projectRepositoryReadinessService
 */
const mockGetSkillConfigById = jest.fn();
const mockGetReady = jest.fn();
const mockResolvePath = jest.fn();
const mockTrackEvent = jest.fn();
const mockExistsSync = jest.fn();
const mockGetRepoCacheDir = jest.fn();

jest.mock('../services/projectSettingsService', () => ({
  getSkillConfigById: (...args: unknown[]) => mockGetSkillConfigById(...args),
}));

jest.mock('../services/repoCacheService', () => ({
  getRepoCacheDir: (...args: unknown[]) => mockGetRepoCacheDir(...args),
}));

jest.mock('../services/grounding/sharedReadCheckoutService', () => ({
  SHARED_READ_MARKER: '.apex-shared-ready',
  sharedReadCheckoutService: {
    getReady: (...args: unknown[]) => mockGetReady(...args),
    resolvePath: (...args: unknown[]) => mockResolvePath(...args),
  },
}));

jest.mock('../services/telemetry', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

jest.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

import {
  assertProjectRepositoryReady,
  getProjectRepositoryReadiness,
  ProjectRepositoryNotReady,
} from '../services/projectRepositoryReadinessService';

describe('projectRepositoryReadinessService', () => {
  const baseConfig = {
    id: 'cfg-1',
    project: 'Apex',
    skillProvider: 'ado',
    skillRepo: 'AI-Pilot',
    skillBranch: 'main',
    friendlyName: 'Default',
    isDefault: true,
    repositoryCheckoutStatus: 'ready',
    repositoryCheckoutSha: 'abc123',
    repositoryCheckoutError: null,
    repositoryCheckoutStartedAt: '2026-08-01T00:00:00.000Z',
    repositoryCheckoutCompletedAt: '2026-08-01T00:01:00.000Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRepoCacheDir.mockReturnValue('/data/repo-cache/ado-apex-ai-pilot-main.git');
    mockResolvePath.mockReturnValue('/data/workspaces/grounding-shared/digest');
    mockExistsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('.git') || String(p).endsWith('HEAD')) return true;
      return false;
    });
  });

  // VT-08 — DB ready + missing marker → unavailable
  it('VT-08: reports snapshot_unavailable when DB ready but .apex-shared-ready missing', async () => {
    mockGetSkillConfigById.mockResolvedValue(baseConfig);
    mockGetReady.mockReturnValue(null);
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      if (s.endsWith('HEAD') || s.endsWith('.git')) return true;
      if (s.includes('.apex-shared-ready')) return false;
      return false;
    });

    const readiness = await getProjectRepositoryReadiness('cfg-1');
    expect(readiness).toEqual(
      expect.objectContaining({
        status: 'snapshot_unavailable',
        filesystemReady: false,
        sha: 'abc123',
      }),
    );
  });

  // VT-07 — multi-config independence
  it('VT-07: secondary config is evaluated independently of a ready default', async () => {
    mockGetSkillConfigById.mockResolvedValue({
      ...baseConfig,
      id: 'cfg-secondary',
      isDefault: false,
      repositoryCheckoutStatus: 'not_cloned',
      repositoryCheckoutSha: null,
    });
    mockExistsSync.mockReturnValue(false);
    mockGetReady.mockReturnValue(null);

    const readiness = await getProjectRepositoryReadiness('cfg-secondary', {
      project: 'Apex',
    });
    expect(readiness?.status).toBe('not_cloned');
    expect(readiness?.filesystemReady).toBe(false);
  });

  it('returns throttled progressPercent/progressLabel while cloning', async () => {
    mockGetSkillConfigById.mockResolvedValue({
      ...baseConfig,
      repositoryCheckoutStatus: 'cloning',
      repositoryCheckoutSha: null,
      repositoryCheckoutProgressPercent: 26,
      repositoryCheckoutProgressLabel: 'Receiving objects 45%',
    });
    mockExistsSync.mockReturnValue(false);
    mockGetReady.mockReturnValue(null);

    const readiness = await getProjectRepositoryReadiness('cfg-1');
    expect(readiness).toEqual(
      expect.objectContaining({
        status: 'cloning',
        progressPercent: 26,
        progressLabel: 'Receiving objects 45%',
      }),
    );
  });

  it('assertProjectRepositoryReady throws PROJECT_REPOSITORY_NOT_READY when blocked', async () => {
    mockGetSkillConfigById.mockResolvedValue({
      ...baseConfig,
      repositoryCheckoutStatus: 'not_cloned',
      repositoryCheckoutSha: null,
    });
    mockExistsSync.mockReturnValue(false);
    mockGetReady.mockReturnValue(null);

    await expect(
      assertProjectRepositoryReady({
        skillSettingsId: 'cfg-1',
        surface: 'agent-home',
      }),
    ).rejects.toBeInstanceOf(ProjectRepositoryNotReady);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      'grounding.readiness_blocked',
      expect.objectContaining({ surface: 'agent-home', skillSettingsId: 'cfg-1' }),
    );
  });

  it('assertProjectRepositoryReady passes when ready + filesystem marker present', async () => {
    mockGetSkillConfigById.mockResolvedValue(baseConfig);
    mockGetReady.mockReturnValue({
      workspacePath: '/data/workspaces/grounding-shared/digest',
      outcome: 'hit',
    });
    mockExistsSync.mockReturnValue(true);

    const readiness = await assertProjectRepositoryReady({
      skillSettingsId: 'cfg-1',
      surface: 'interview',
    });
    expect(readiness.status).toBe('ready');
    expect(readiness.filesystemReady).toBe(true);
  });
});
