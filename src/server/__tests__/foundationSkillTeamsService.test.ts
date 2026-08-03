/**
 * Foundation Skill Teams Service Tests
 *
 * Covers team discovery from the skill-config registry, the join to observed
 * install state, and resolution of the skills a release shipped to each project.
 */

import { getFoundationSkillTeams, listRegisteredSkillRepos } from '../services/foundationSkillTeamsService';
import * as projectSettings from '../services/projectSettingsService';
import * as compatService from '../services/foundationSkillCompatibilityService';
import * as releaseService from '../services/foundationSkillReleaseService';
import type { FoundationSkillRelease, FoundationSkillRepoStatus } from '../../shared/types/foundationSkills';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';

jest.mock('../services/projectSettingsService', () => ({
  listSkillConfigs: jest.fn(),
}));

jest.mock('../services/foundationSkillCompatibilityService', () => ({
  listRepoStatuses: jest.fn(),
}));

jest.mock('../services/foundationSkillReleaseService', () => ({
  getReleaseByVersion: jest.fn(),
  // Real targeting logic is covered by foundationSkillReleaseTargeting.test.ts;
  // here we only need it to behave like the real resolver.
  getVisibleSkillsForProject: jest.fn(),
}));

const mockSettings = projectSettings as jest.Mocked<typeof projectSettings>;
const mockCompat   = compatService   as jest.Mocked<typeof compatService>;
const mockRelease  = releaseService  as jest.Mocked<typeof releaseService>;

function config(overrides: Partial<ProjectSkillConfig> = {}): ProjectSkillConfig {
  return {
    id: 'cfg-1',
    project: 'MaxView',
    friendlyName: 'MaxView skills',
    isDefault: true,
    skillProvider: 'ado',
    skillRepo: 'MaxView',
    skillBranch: 'main',
    ...overrides,
  } as ProjectSkillConfig;
}

function status(overrides: Partial<FoundationSkillRepoStatus> = {}): FoundationSkillRepoStatus {
  return {
    id: 's1',
    provider: 'ado',
    project: 'MaxView',
    repo: 'MaxView',
    branch: 'main',
    apexProject: 'MaxView',
    installedVersion: '1.0.0',
    selectedSkills: ['ui-lab'],
    lockHash: 'hash',
    compatibilityStatus: 'compatible',
    compatibilityErrors: [],
    availableVersion: '1.1.0',
    updateAvailable: true,
    compatibilityCheckedAt: '2026-08-03T00:00:00.000Z',
    lastObservedAt: '2026-08-03T00:00:00.000Z',
    observedBy: null,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    ...overrides,
  };
}

function release(overrides: Partial<FoundationSkillRelease> = {}): FoundationSkillRelease {
  return {
    id: 'rel-1',
    version: '1.0.0',
    status: 'published',
    artifactPackage: '@apex/skills',
    artifactVersion: '1.0.0',
    artifactFeed: null,
    integritySha256: null,
    contractApiVersion: 1,
    selectedSkills: ['ui-lab', 'to-prd'],
    targetProjects: [],
    skillTargets: {},
    manifestSnapshot: null,
    releaseNotes: null,
    breakingChanges: null,
    publishedBy: null,
    publishedAt: '2026-08-01T00:00:00.000Z',
    deprecatedBy: null,
    deprecatedAt: null,
    createdBy: 'admin',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('getFoundationSkillTeams', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRelease.getVisibleSkillsForProject.mockImplementation((rel) => rel.selectedSkills);
  });

  it('joins a registered repo to its observed status and released skills', async () => {
    mockSettings.listSkillConfigs.mockResolvedValue([config()]);
    mockCompat.listRepoStatuses.mockResolvedValue([status()]);
    mockRelease.getReleaseByVersion.mockResolvedValue(release());

    const teams = await getFoundationSkillTeams();

    expect(teams).toHaveLength(1);
    expect(teams[0].apexProject).toBe('MaxView');
    const repo = teams[0].repos[0];
    expect(repo.observed).toBe(true);
    expect(repo.installedVersion).toBe('1.0.0');
    expect(repo.installedReleaseStatus).toBe('published');
    expect(repo.releasedSkills).toEqual(['ui-lab', 'to-prd']);
    expect(repo.installedSkills).toEqual(['ui-lab']);
    expect(repo.updateAvailable).toBe(true);
  });

  it('surfaces a deprecated installed release', async () => {
    mockSettings.listSkillConfigs.mockResolvedValue([config()]);
    mockCompat.listRepoStatuses.mockResolvedValue([status()]);
    mockRelease.getReleaseByVersion.mockResolvedValue(release({ status: 'deprecated' }));

    const teams = await getFoundationSkillTeams();

    expect(teams[0].repos[0].installedReleaseStatus).toBe('deprecated');
  });

  it('includes registered repos that have never been scanned', async () => {
    mockSettings.listSkillConfigs.mockResolvedValue([config()]);
    mockCompat.listRepoStatuses.mockResolvedValue([]);

    const teams = await getFoundationSkillTeams();

    const repo = teams[0].repos[0];
    expect(repo.observed).toBe(false);
    expect(repo.installedVersion).toBeNull();
    expect(repo.compatibilityStatus).toBe('unknown');
    expect(repo.releasedSkills).toEqual([]);
    expect(mockRelease.getReleaseByVersion).not.toHaveBeenCalled();
  });

  it('matches the status row case-insensitively', async () => {
    mockSettings.listSkillConfigs.mockResolvedValue([config({ skillRepo: 'MaxView' })]);
    mockCompat.listRepoStatuses.mockResolvedValue([status({ repo: 'maxview', project: 'maxview' })]);
    mockRelease.getReleaseByVersion.mockResolvedValue(release());

    const teams = await getFoundationSkillTeams();

    expect(teams[0].repos[0].observed).toBe(true);
  });

  it('leaves the release status unmatched when no release row exists for the version', async () => {
    mockSettings.listSkillConfigs.mockResolvedValue([config()]);
    mockCompat.listRepoStatuses.mockResolvedValue([status({ installedVersion: '9.9.9' })]);
    mockRelease.getReleaseByVersion.mockResolvedValue(null);

    const teams = await getFoundationSkillTeams();

    expect(teams[0].repos[0].installedReleaseStatus).toBeNull();
    expect(teams[0].repos[0].releasedSkills).toEqual([]);
  });

  it('groups multiple repos under one project and looks up each version once', async () => {
    mockSettings.listSkillConfigs.mockResolvedValue([
      config({ id: 'cfg-1', skillRepo: 'RepoB', friendlyName: 'B repo' }),
      config({ id: 'cfg-2', skillRepo: 'RepoA', friendlyName: 'A repo' }),
    ]);
    mockCompat.listRepoStatuses.mockResolvedValue([
      status({ id: 's1', repo: 'RepoB' }),
      status({ id: 's2', repo: 'RepoA' }),
    ]);
    mockRelease.getReleaseByVersion.mockResolvedValue(release());

    const teams = await getFoundationSkillTeams();

    expect(teams).toHaveLength(1);
    expect(teams[0].repos.map(r => r.friendlyName)).toEqual(['A repo', 'B repo']);
    // Both repos share v1.0.0 — the cache must collapse this to a single lookup
    expect(mockRelease.getReleaseByVersion).toHaveBeenCalledTimes(1);
  });

  it('sorts teams by project name', async () => {
    mockSettings.listSkillConfigs.mockResolvedValue([
      config({ id: 'cfg-1', project: 'Zulu' }),
      config({ id: 'cfg-2', project: 'Alpha' }),
    ]);
    mockCompat.listRepoStatuses.mockResolvedValue([]);

    const teams = await getFoundationSkillTeams();

    expect(teams.map(t => t.apexProject)).toEqual(['Alpha', 'Zulu']);
  });

  it('returns an empty list when no projects have a skills repo configured', async () => {
    mockSettings.listSkillConfigs.mockResolvedValue([]);
    mockCompat.listRepoStatuses.mockResolvedValue([]);

    await expect(getFoundationSkillTeams()).resolves.toEqual([]);
  });
});

describe('listRegisteredSkillRepos', () => {
  beforeEach(() => jest.clearAllMocks());

  it('dedupes repos registered by more than one config', async () => {
    mockSettings.listSkillConfigs.mockResolvedValue([
      config({ id: 'cfg-1' }),
      config({ id: 'cfg-2' }), // same project/repo/branch
    ]);

    const repos = await listRegisteredSkillRepos();

    expect(repos).toHaveLength(1);
    expect(repos[0]).toEqual({ provider: 'ado', project: 'MaxView', repo: 'MaxView', branch: 'main' });
  });

  it('defaults provider to ado and branch to main', async () => {
    mockSettings.listSkillConfigs.mockResolvedValue([
      config({ skillProvider: undefined, skillBranch: '' }),
    ]);

    const repos = await listRegisteredSkillRepos();

    expect(repos[0].provider).toBe('ado');
    expect(repos[0].branch).toBe('main');
  });

  it('skips configs with no repo set', async () => {
    mockSettings.listSkillConfigs.mockResolvedValue([config({ skillRepo: '   ' })]);

    await expect(listRegisteredSkillRepos()).resolves.toEqual([]);
  });
});
