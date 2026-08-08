const mockGitHubGetSkillFile = jest.fn();
const mockGitHubSearchRepoCode = jest.fn();

jest.mock('../services/skillCatalogGitHub', () => ({
  listRepos: jest.fn(),
  listBranches: jest.fn(),
  listSkills: jest.fn(),
  getSkill: jest.fn(),
  getSkillFile: mockGitHubGetSkillFile,
  listRepoDir: jest.fn(),
  searchRepoCode: mockGitHubSearchRepoCode,
  invalidateCache: jest.fn(),
}));

jest.mock('../services/skillCatalog', () => ({
  listRepos: jest.fn(),
  listBranches: jest.fn(),
  listSkills: jest.fn(),
  getSkill: jest.fn(),
  getSkillFile: jest.fn(),
  listRepoDir: jest.fn(),
  searchRepoCode: jest.fn(),
  invalidateCache: jest.fn(),
}));

import {
  getSkillFile,
  searchRepoCode,
} from '../services/skillCatalogFacade';

describe('GitHub repository targeting in skillCatalogFacade', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('splits configured owner/repo values before loading a skill file', async () => {
    mockGitHubGetSkillFile.mockResolvedValue('# skill');

    await expect(
      getSkillFile(
        'Apex',
        'ryamiller-amergis/Apex',
        '/.cursor/skills/grill-with-docs/SKILL.md',
        'main',
        'github',
      ),
    ).resolves.toBe('# skill');

    expect(mockGitHubGetSkillFile).toHaveBeenCalledWith(
      'Apex',
      '/.cursor/skills/grill-with-docs/SKILL.md',
      'main',
      'ryamiller-amergis',
    );
  });

  it('uses the configured owner for GitHub repository search', async () => {
    mockGitHubSearchRepoCode.mockResolvedValue([]);

    await searchRepoCode(
      'Apex',
      'ryamiller-amergis/Apex',
      'counter',
      'main',
      10,
      'github',
    );

    expect(mockGitHubSearchRepoCode).toHaveBeenCalledWith(
      'Apex',
      'counter',
      'main',
      'ryamiller-amergis',
      10,
    );
  });
});
