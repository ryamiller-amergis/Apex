/**
 * Tests for the CLI install-authorization service.
 *
 * The remote parser decides which Apex project a repo maps to, so it is the
 * component that must not silently mis-authorize. It is covered against every
 * remote form teams actually have configured.
 */

jest.mock('../services/projectSettingsService', () => ({
  listSkillConfigs: jest.fn(),
}));

jest.mock('../services/foundationSkillReleaseService', () => ({
  getLatestPublishedRelease: jest.fn(),
  getPublishedReleaseByArtifactVersion: jest.fn(),
  getVisibleSkillsForProject: jest.fn(),
}));

import {
  parseRepoFromRemote,
  parseRepositoryIdentity,
  validateConfiguredRepository,
  authorizeSkillInstall,
} from '../services/foundationSkillAuthorizeService';
import { listSkillConfigs } from '../services/projectSettingsService';
import {
  getLatestPublishedRelease,
  getPublishedReleaseByArtifactVersion,
  getVisibleSkillsForProject,
} from '../services/foundationSkillReleaseService';

const mockListSkillConfigs = listSkillConfigs as jest.Mock;
const mockGetLatestPublishedRelease = getLatestPublishedRelease as jest.Mock;
const mockGetPublishedReleaseByArtifactVersion =
  getPublishedReleaseByArtifactVersion as jest.Mock;
const mockGetVisibleSkillsForProject = getVisibleSkillsForProject as jest.Mock;
const originalAdoOrg = process.env.ADO_ORG;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ADO_ORG = 'https://dev.azure.com/amergis';
});

afterAll(() => {
  if (originalAdoOrg === undefined) delete process.env.ADO_ORG;
  else process.env.ADO_ORG = originalAdoOrg;
});

describe('parseRepoFromRemote', () => {
  it('parses Azure DevOps https remotes via the /_git/ marker', () => {
    expect(parseRepoFromRemote('https://dev.azure.com/amergis/MaxView/_git/MaxView')).toBe('MaxView');
    expect(parseRepoFromRemote('https://amergis@dev.azure.com/amergis/TimeClock/_git/MatterWorx')).toBe('MatterWorx');
  });

  it('parses legacy visualstudio.com remotes', () => {
    expect(parseRepoFromRemote('https://amergis.visualstudio.com/MaxView/_git/MaxView')).toBe('MaxView');
  });

  it('parses Azure DevOps ssh remotes', () => {
    expect(parseRepoFromRemote('git@ssh.dev.azure.com:v3/amergis/MaxView/MaxView')).toBe('MaxView');
  });

  it('parses GitHub https and ssh remotes and strips the .git suffix', () => {
    expect(parseRepoFromRemote('https://github.com/amergis/MaxView.git')).toBe('MaxView');
    expect(parseRepoFromRemote('git@github.com:amergis/MaxView.git')).toBe('MaxView');
  });

  it('tolerates trailing slashes and url-encoded names', () => {
    expect(parseRepoFromRemote('https://github.com/amergis/MaxView/')).toBe('MaxView');
    expect(parseRepoFromRemote('https://dev.azure.com/amergis/P/_git/My%20Repo')).toBe('My Repo');
  });

  it('returns null when no repo can be extracted', () => {
    expect(parseRepoFromRemote('')).toBeNull();
    expect(parseRepoFromRemote('   ')).toBeNull();
    expect(parseRepoFromRemote('https://dev.azure.com')).toBeNull();
  });
});

describe('parseRepositoryIdentity', () => {
  it('keeps provider, organization, project, and repo for Azure DevOps', () => {
    expect(
      parseRepositoryIdentity(
        'https://dev.azure.com/amergis/MaxView/_git/Workforce',
      ),
    ).toEqual({
      provider: 'ado',
      organization: 'amergis',
      project: 'MaxView',
      repo: 'Workforce',
    });
  });

  it('parses Azure DevOps ssh URI remotes', () => {
    expect(
      parseRepositoryIdentity(
        'ssh://git@ssh.dev.azure.com/v3/amergis/MaxView/My%20Repo',
      ),
    ).toEqual({
      provider: 'ado',
      organization: 'amergis',
      project: 'MaxView',
      repo: 'My Repo',
    });
  });

  it('keeps provider, organization, and repo for GitHub', () => {
    expect(
      parseRepositoryIdentity('git@github.com:amergis/Workforce.git'),
    ).toEqual({
      provider: 'github',
      organization: 'amergis',
      project: null,
      repo: 'Workforce',
    });
  });
});

describe('validateConfiguredRepository', () => {
  it('requires organization/repo for GitHub configs', () => {
    expect(validateConfiguredRepository('github', 'Workforce')).toMatch(
      /organization\/repo/i,
    );
    expect(validateConfiguredRepository('github', 'amergis/Workforce')).toBeNull();
  });

  it('rejects unsupported providers at the API boundary', () => {
    expect(
      validateConfiguredRepository(
        'gitlab' as unknown as 'ado',
        'amergis/Workforce',
      ),
    ).toMatch(/unsupported/i);
  });
});

describe('authorizeSkillInstall', () => {
  const release = {
    id: 'rel-1',
    version: '1.0.0',
    artifactVersion: '1.1.0',
    targetProjects: ['maxview'],
    skillTargets: {},
    selectedSkills: ['to-prd', 'grill-with-docs'],
    integritySha256: 'abc123',
    manifestSnapshot: {
      skills: [{ name: 'post-skill-bootstrap', alwaysInstall: true }],
    },
  };

  it('authorizes a registered repo whose project has a published release', async () => {
    mockListSkillConfigs.mockResolvedValue([
      { project: 'maxview', skillRepo: 'MaxView', skillBranch: 'development' },
    ]);
    mockGetLatestPublishedRelease.mockResolvedValue(release);
    mockGetVisibleSkillsForProject.mockReturnValue(['to-prd', 'grill-with-docs']);

    const result = await authorizeSkillInstall('https://dev.azure.com/amergis/MaxView/_git/MaxView');

    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('authorized');
    expect(result.apexProject).toBe('maxview');
    expect(result.version).toBe('1.0.0');
    expect(result.skills).toEqual(['to-prd', 'grill-with-docs', 'post-skill-bootstrap']);
  });

  it('returns artifactVersion so the CLI can refuse a mismatched package', async () => {
    mockListSkillConfigs.mockResolvedValue([
      { project: 'maxview', skillRepo: 'MaxView', skillBranch: 'development' },
    ]);
    mockGetLatestPublishedRelease.mockResolvedValue(release);
    mockGetVisibleSkillsForProject.mockReturnValue(['to-prd']);

    const result = await authorizeSkillInstall('https://dev.azure.com/amergis/MaxView/_git/MaxView');
    expect(result.artifactVersion).toBe('1.1.0');
  });

  it('marks the artifact version verified when an integrity hash proves it', async () => {
    // The hash is only ever computed against a real feed, so its presence is the
    // one trustworthy signal that the version was not simply typed in by hand.
    mockListSkillConfigs.mockResolvedValue([
      { project: 'maxview', skillRepo: 'MaxView', skillBranch: 'development' },
    ]);
    mockGetLatestPublishedRelease.mockResolvedValue({ ...release, integritySha256: 'abc123' });
    mockGetVisibleSkillsForProject.mockReturnValue(['to-prd']);

    const result = await authorizeSkillInstall('https://dev.azure.com/amergis/MaxView/_git/MaxView');
    expect(result.artifactVersionVerified).toBe(true);
  });

  it('denies a published row without verified artifact evidence', async () => {
    mockListSkillConfigs.mockResolvedValue([
      { project: 'maxview', skillRepo: 'MaxView', skillBranch: 'development' },
    ]);
    mockGetLatestPublishedRelease.mockResolvedValue({ ...release, integritySha256: null });
    mockGetVisibleSkillsForProject.mockReturnValue(['to-prd']);

    const result = await authorizeSkillInstall('https://dev.azure.com/amergis/MaxView/_git/MaxView');
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('release-unverified');
  });

  it('reports a null artifactVersion for releases that predate the field', async () => {
    mockListSkillConfigs.mockResolvedValue([
      { project: 'maxview', skillRepo: 'MaxView', skillBranch: 'development' },
    ]);
    mockGetLatestPublishedRelease.mockResolvedValue({ ...release, artifactVersion: undefined });
    mockGetVisibleSkillsForProject.mockReturnValue(['to-prd']);

    const result = await authorizeSkillInstall('https://dev.azure.com/amergis/MaxView/_git/MaxView');
    expect(result.authorized).toBe(true);
    expect(result.artifactVersion).toBeNull();
  });

  it('matches the registered repo case-insensitively', async () => {
    mockListSkillConfigs.mockResolvedValue([
      { project: 'maxview', skillRepo: 'maxview', skillBranch: 'development' },
    ]);
    mockGetLatestPublishedRelease.mockResolvedValue(release);
    mockGetVisibleSkillsForProject.mockReturnValue(['to-prd']);

    const result = await authorizeSkillInstall('https://dev.azure.com/amergis/MaxView/_git/MaxView');
    expect(result.authorized).toBe(true);
  });

  it('matches a GitHub config stored as org/name', async () => {
    mockListSkillConfigs.mockResolvedValue([
      {
        project: 'maxview',
        skillProvider: 'github',
        skillRepo: 'amergis/MaxView',
        skillBranch: 'main',
      },
    ]);
    mockGetLatestPublishedRelease.mockResolvedValue(release);
    mockGetVisibleSkillsForProject.mockReturnValue(['to-prd']);

    const result = await authorizeSkillInstall('https://github.com/amergis/MaxView.git');
    expect(result.authorized).toBe(true);
    expect(result.apexProject).toBe('maxview');
  });

  it('does not authorize a same-named repo from a different ADO project', async () => {
    mockListSkillConfigs.mockResolvedValue([
      {
        project: 'maxview',
        skillProvider: 'ado',
        skillRepo: 'Workforce',
        skillBranch: 'main',
      },
    ]);

    const result = await authorizeSkillInstall(
      'https://dev.azure.com/amergis/MatterWorx/_git/Workforce',
    );

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('repo-not-registered');
    expect(mockGetLatestPublishedRelease).not.toHaveBeenCalled();
  });

  it('does not authorize the same project and repo from another ADO organization', async () => {
    mockListSkillConfigs.mockResolvedValue([
      {
        project: 'maxview',
        skillProvider: 'ado',
        skillRepo: 'MaxView',
        skillBranch: 'main',
      },
    ]);

    const result = await authorizeSkillInstall(
      'https://dev.azure.com/another-org/MaxView/_git/MaxView',
    );

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('repo-not-registered');
  });

  it('authorizes a prior published artifact release explicitly', async () => {
    const historical = {
      ...release,
      id: 'rel-old',
      version: '1.0.0',
      artifactVersion: '1.0.0',
      selectedSkills: ['to-prd'],
      manifestSnapshot: { skills: [] },
    };
    mockListSkillConfigs.mockResolvedValue([
      {
        project: 'maxview',
        skillProvider: 'ado',
        skillRepo: 'MaxView',
        skillBranch: 'development',
      },
    ]);
    mockGetPublishedReleaseByArtifactVersion.mockResolvedValue(historical);
    mockGetVisibleSkillsForProject.mockReturnValue(['to-prd']);

    const result = await authorizeSkillInstall(
      'https://dev.azure.com/amergis/MaxView/_git/MaxView',
      '1.0.0',
    );

    expect(result.authorized).toBe(true);
    expect(result.artifactVersion).toBe('1.0.0');
    expect(result.skills).toEqual(['to-prd']);
    expect(mockGetPublishedReleaseByArtifactVersion).toHaveBeenCalledWith(
      '1.0.0',
      'maxview',
    );
    expect(mockGetLatestPublishedRelease).not.toHaveBeenCalled();
  });

  it('denies an artifact version never released to the project', async () => {
    mockListSkillConfigs.mockResolvedValue([
      {
        project: 'maxview',
        skillProvider: 'ado',
        skillRepo: 'MaxView',
        skillBranch: 'development',
      },
    ]);
    mockGetPublishedReleaseByArtifactVersion.mockResolvedValue(null);

    const result = await authorizeSkillInstall(
      'https://dev.azure.com/amergis/MaxView/_git/MaxView',
      '9.9.9',
    );

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('release-not-entitled');
  });

  it('denies a repo that is not registered with any project', async () => {
    mockListSkillConfigs.mockResolvedValue([
      { project: 'maxview', skillRepo: 'MaxView', skillBranch: 'development' },
    ]);

    const result = await authorizeSkillInstall(
      'https://dev.azure.com/amergis/MatterWorx/_git/MatterWorx',
    );

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('repo-not-registered');
    expect(result.repo).toBe('MatterWorx');
    expect(result.apexProject).toBeNull();
    expect(result.message).toMatch(/not registered/i);
    expect(mockGetLatestPublishedRelease).not.toHaveBeenCalled();
  });

  it('denies a registered repo whose project has no published release', async () => {
    mockListSkillConfigs.mockResolvedValue([
      { project: 'matterworx', skillRepo: 'MatterWorx', skillBranch: 'main' },
    ]);
    mockGetLatestPublishedRelease.mockResolvedValue(null);

    const result = await authorizeSkillInstall(
      'https://dev.azure.com/amergis/MatterWorx/_git/MatterWorx',
    );

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('no-release');
    expect(result.apexProject).toBe('matterworx');
    expect(result.message).toMatch(/No published APEX release/i);
  });

  it('denies when the release ships no skills to this project', async () => {
    mockListSkillConfigs.mockResolvedValue([
      { project: 'matterworx', skillRepo: 'MatterWorx', skillBranch: 'main' },
    ]);
    mockGetLatestPublishedRelease.mockResolvedValue({
      ...release,
      manifestSnapshot: { skills: [] },
    });
    mockGetVisibleSkillsForProject.mockReturnValue([]);

    const result = await authorizeSkillInstall(
      'https://dev.azure.com/amergis/MatterWorx/_git/MatterWorx',
    );

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('no-skills');
    expect(result.version).toBe('1.0.0');
  });

  it('authorizes artifact-specific always-install skills even when selected skills are not visible', async () => {
    mockListSkillConfigs.mockResolvedValue([
      { project: 'maxview', skillRepo: 'MaxView', skillBranch: 'main' },
    ]);
    mockGetLatestPublishedRelease.mockResolvedValue(release);
    mockGetVisibleSkillsForProject.mockReturnValue([]);

    const result = await authorizeSkillInstall(
      'https://dev.azure.com/amergis/MaxView/_git/MaxView',
    );

    expect(result.authorized).toBe(true);
    expect(result.skills).toEqual(['post-skill-bootstrap']);
  });

  it('denies an unparsable remote without touching project config', async () => {
    const result = await authorizeSkillInstall('not-a-remote');

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('remote-unparsable');
    expect(mockListSkillConfigs).not.toHaveBeenCalled();
  });

  it('ignores config rows with a blank skillRepo', async () => {
    mockListSkillConfigs.mockResolvedValue([
      { project: 'empty', skillRepo: '   ', skillBranch: 'main' },
      { project: 'maxview', skillRepo: 'MaxView', skillBranch: 'development' },
    ]);
    mockGetLatestPublishedRelease.mockResolvedValue(release);
    mockGetVisibleSkillsForProject.mockReturnValue(['to-prd']);

    const result = await authorizeSkillInstall('https://dev.azure.com/amergis/MaxView/_git/MaxView');
    expect(result.apexProject).toBe('maxview');
  });
});
