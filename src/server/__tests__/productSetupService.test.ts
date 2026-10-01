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

import { db } from '../db/drizzle';
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

  it('stays off once PRODUCT.md is in the repository', async () => {
    mockGetRepositoryFile.mockResolvedValue('# Product\n');
    await expect(getProductSetup('Benefits Tracker', 'user-1')).resolves.toMatchObject({ active: false });
  });

  it('is active for the project admin until PRODUCT.md exists', async () => {
    await expect(getProductSetup('Benefits Tracker', 'user-1')).resolves.toEqual({
      active: true,
      skillPath: '.agents/skills/product-foundation/SKILL.md',
      model: 'gemini-3.8-flash',
      candidates: [{ userId: 'user-2', displayName: 'Ada', email: 'ada@example.com' }],
      foundationAnswers: [
        'Benefits Tracker. Help employees understand and use their benefits. Intended for internal users.',
        'Employees cannot find clear benefits information.',
        'Help employees understand and use their benefits.',
        '',
      ],
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

  it('stays active when the repository lookup fails', async () => {
    mockGetRepositoryFile.mockRejectedValue(new Error('ado down'));
    await expect(getProductSetup('Benefits Tracker', 'user-1')).resolves.toMatchObject({ active: true });
  });
});
