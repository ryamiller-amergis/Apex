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
  getVisibleSkillsForProject: jest.fn(),
}));

import { parseRepoFromRemote, authorizeSkillInstall } from '../services/foundationSkillAuthorizeService';
import { listSkillConfigs } from '../services/projectSettingsService';
import {
  getLatestPublishedRelease,
  getVisibleSkillsForProject,
} from '../services/foundationSkillReleaseService';

const mockListSkillConfigs = listSkillConfigs as jest.Mock;
const mockGetLatestPublishedRelease = getLatestPublishedRelease as jest.Mock;
const mockGetVisibleSkillsForProject = getVisibleSkillsForProject as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
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

describe('authorizeSkillInstall', () => {
  const release = {
    id: 'rel-1',
    version: '1.0.0',
    artifactVersion: '1.1.0',
    targetProjects: ['maxview'],
    skillTargets: {},
    selectedSkills: ['to-prd', 'grill-with-docs'],
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
    expect(result.skills).toEqual(['to-prd', 'grill-with-docs']);
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

  it('marks it unverified when the release was published without a feed', async () => {
    mockListSkillConfigs.mockResolvedValue([
      { project: 'maxview', skillRepo: 'MaxView', skillBranch: 'development' },
    ]);
    mockGetLatestPublishedRelease.mockResolvedValue({ ...release, integritySha256: null });
    mockGetVisibleSkillsForProject.mockReturnValue(['to-prd']);

    const result = await authorizeSkillInstall('https://dev.azure.com/amergis/MaxView/_git/MaxView');
    expect(result.authorized).toBe(true);
    expect(result.artifactVersionVerified).toBe(false);
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
      { project: 'maxview', skillRepo: 'amergis/MaxView', skillBranch: 'main' },
    ]);
    mockGetLatestPublishedRelease.mockResolvedValue(release);
    mockGetVisibleSkillsForProject.mockReturnValue(['to-prd']);

    const result = await authorizeSkillInstall('https://github.com/amergis/MaxView.git');
    expect(result.authorized).toBe(true);
    expect(result.apexProject).toBe('maxview');
  });

  it('denies a repo that is not registered with any project', async () => {
    mockListSkillConfigs.mockResolvedValue([
      { project: 'maxview', skillRepo: 'MaxView', skillBranch: 'development' },
    ]);

    const result = await authorizeSkillInstall('https://dev.azure.com/amergis/X/_git/MatterWorx');

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

    const result = await authorizeSkillInstall('https://dev.azure.com/amergis/X/_git/MatterWorx');

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('no-release');
    expect(result.apexProject).toBe('matterworx');
    expect(result.message).toMatch(/No published APEX release/i);
  });

  it('denies when the release ships no skills to this project', async () => {
    mockListSkillConfigs.mockResolvedValue([
      { project: 'matterworx', skillRepo: 'MatterWorx', skillBranch: 'main' },
    ]);
    mockGetLatestPublishedRelease.mockResolvedValue(release);
    mockGetVisibleSkillsForProject.mockReturnValue([]);

    const result = await authorizeSkillInstall('https://dev.azure.com/amergis/X/_git/MatterWorx');

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('no-skills');
    expect(result.version).toBe('1.0.0');
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
