jest.mock('../db/drizzle', () => ({
  db: { query: { rfpRequests: { findFirst: jest.fn() } } },
}));

jest.mock('../services/rbacService', () => ({
  getUserProjectRoles: jest.fn(),
}));

jest.mock('../services/projectSettingsService', () => ({
  listSkillConfigsForProject: jest.fn(),
}));

jest.mock('../services/projectTeammateService', () => ({
  listProjectTeammateCandidates: jest.fn(),
}));

const mockGetRepositoryFile = jest.fn();
jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: jest.fn().mockImplementation(() => ({
    getRepositoryFile: mockGetRepositoryFile,
  })),
}));

jest.mock('../services/productBuildService', () => ({
  getProductBuildSetup: jest.fn(),
}));

import { db } from '../db/drizzle';
import { getProductBuildSetup } from '../services/productBuildService';
import { getProductSetup, requireOpenProductSetup } from '../services/productSetupService';
import { listSkillConfigsForProject } from '../services/projectSettingsService';
import { listProjectTeammateCandidates } from '../services/projectTeammateService';
import { getUserProjectRoles } from '../services/rbacService';

const findRequest = db.query.rfpRequests.findFirst as jest.Mock;

describe('getProductSetup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getUserProjectRoles as jest.Mock).mockResolvedValue(['admin']);
    findRequest.mockResolvedValue({
      apexProject: 'Benefits Tracker',
      approvedAt: '2026-09-30T00:00:00.000Z',
      approvedRepoName: 'benefits-tracker',
      status: 'approved',
      title: 'Benefits Tracker',
      request: 'Help employees understand and use their benefits.',
      problem: 'Employees cannot find clear benefits information.',
      audience: 'internal',
      proposal: null,
    });
    mockGetRepositoryFile.mockResolvedValue(null);
    (listSkillConfigsForProject as jest.Mock).mockResolvedValue([{
      defaultModel: 'auto',
      quickSkillPills: [{
        label: 'Product foundation',
        skillPath: '.agents/skills/product-foundation/SKILL.md',
        model: 'auto',
      }],
    }]);
    (listProjectTeammateCandidates as jest.Mock).mockResolvedValue([
      { userId: 'user-2', displayName: 'Ada', email: 'ada@example.com' },
    ]);
  });

  it('stays off for someone who is not the project admin', async () => {
    (getUserProjectRoles as jest.Mock).mockResolvedValue(['member']);
    await expect(getProductSetup('Benefits Tracker', 'user-1')).resolves.toMatchObject({ active: false });
    expect(mockGetRepositoryFile).not.toHaveBeenCalled();
  });

  it('is active for the project admin until PRODUCT.md exists', async () => {
    await expect(getProductSetup('Benefits Tracker', 'user-1')).resolves.toEqual({
      active: true,
      phase: 'foundation',
      skillPath: '.agents/skills/product-foundation/SKILL.md',
      model: 'gemini-3.8-flash',
      candidates: [{ userId: 'user-2', displayName: 'Ada', email: 'ada@example.com' }],
      canInviteTeammates: true,
      foundationAnswers: [
        'Benefits Tracker. Help employees understand and use their benefits. Intended for internal users.',
        'Employees cannot find clear benefits information.',
        'Help employees understand and use their benefits.',
        '',
      ],
      build: null,
      chatThreadId: null,
      thread: null,
      design: null,
    });
    expect(getProductBuildSetup).not.toHaveBeenCalled();
  });

  it('starts the product build once PRODUCT.md exists', async () => {
    mockGetRepositoryFile.mockResolvedValue('# Product\n');
    const buildStatus = {
      active: true as const,
      phase: 'build' as const,
      skillPath: '.agents/skills/product-discovery/SKILL.md',
      model: 'gemini-3.8-flash',
      candidates: [],
      foundationAnswers: [],
      project: 'Benefits Tracker',
      build: { id: 'build-1', status: 'discovery' },
      chatThreadId: 'thread-1',
      thread: { id: 'thread-1' },
      design: null,
    };
    (getProductBuildSetup as jest.Mock).mockResolvedValue(buildStatus);

    await expect(getProductSetup('Benefits Tracker', 'user-1')).resolves.toEqual(buildStatus);
    expect(getProductBuildSetup).toHaveBeenCalledWith('Benefits Tracker', 'user-1');
  });

  it('lets the approved requester start discovery without a project admin role', async () => {
    (getUserProjectRoles as jest.Mock).mockResolvedValue(['member']);
    findRequest.mockResolvedValue({
      apexProject: 'Benefits Tracker',
      ownerId: 'user-1',
      approvedAt: '2026-09-30T00:00:00.000Z',
      approvedRepoName: 'benefits-tracker',
      status: 'approved',
      title: 'Benefits Tracker',
      request: 'Help employees understand and use their benefits.',
      problem: 'Employees cannot find clear benefits information.',
      audience: 'internal',
      proposal: null,
    });
    mockGetRepositoryFile.mockResolvedValue('# Product\n');
    (getProductBuildSetup as jest.Mock).mockResolvedValue({ active: true, phase: 'build' });

    await expect(getProductSetup('Benefits Tracker', 'user-1')).resolves.toMatchObject({ phase: 'build' });
    expect(getProductBuildSetup).toHaveBeenCalledWith('Benefits Tracker', 'user-1');
  });

  it('shows the approved requester the foundation step without the teammate step', async () => {
    (getUserProjectRoles as jest.Mock).mockResolvedValue(['member']);
    findRequest.mockResolvedValue({
      apexProject: 'Benefits Tracker',
      ownerId: 'user-1',
      approvedAt: '2026-09-30T00:00:00.000Z',
      approvedRepoName: 'benefits-tracker',
      status: 'approved',
      title: 'Benefits Tracker',
      request: 'Help employees understand and use their benefits.',
      problem: 'Employees cannot find clear benefits information.',
      audience: 'internal',
      proposal: null,
    });

    await expect(getProductSetup('Benefits Tracker', 'user-1')).resolves.toMatchObject({
      active: true,
      phase: 'foundation',
      candidates: [],
      canInviteTeammates: false,
    });
    expect(listProjectTeammateCandidates).not.toHaveBeenCalled();
    await expect(requireOpenProductSetup('Benefits Tracker', 'user-1')).resolves.toEqual({
      repoName: 'benefits-tracker',
    });
  });

  it('refuses foundation writes from someone who is neither requester nor admin', async () => {
    (getUserProjectRoles as jest.Mock).mockResolvedValue(['member']);
    await expect(requireOpenProductSetup('Benefits Tracker', 'user-1')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
  });

  it('returns the repo while setup is open', async () => {
    await expect(requireOpenProductSetup('Benefits Tracker', 'user-1')).resolves.toEqual({
      repoName: 'benefits-tracker',
    });
  });

  it('refuses to open setup once PRODUCT.md exists', async () => {
    mockGetRepositoryFile.mockResolvedValue('# Product\n');
    await expect(requireOpenProductSetup('Benefits Tracker', 'user-1')).rejects.toMatchObject({
      status: 409,
      code: 'SETUP_CLOSED',
    });
  });

  it('stays on the foundation when the repository lookup fails', async () => {
    mockGetRepositoryFile.mockRejectedValue(new Error('ado down'));
    await expect(getProductSetup('Benefits Tracker', 'user-1')).resolves.toMatchObject({
      active: true,
      phase: 'foundation',
    });
    expect(getProductBuildSetup).not.toHaveBeenCalled();
  });
});
