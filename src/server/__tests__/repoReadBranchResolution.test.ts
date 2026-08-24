import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
import type { RepositoryIdentity } from '../../shared/types/repoReader';

jest.mock('../services/projectSettingsService', () => ({
  listSkillConfigsForProject: jest.fn(),
}));

jest.mock('../services/telemetry', () => ({
  trackEvent: jest.fn(),
}));

import { resolveBranch } from '../services/repoRead/entrypoint';

const identity: RepositoryIdentity = {
  provider: 'ado',
  project: 'MaxView',
  repo: 'MaxView',
  sha: 'a'.repeat(40),
};

function config(overrides: Partial<ProjectSkillConfig>): ProjectSkillConfig {
  return {
    id: 'cfg-1',
    project: 'MaxView',
    friendlyName: 'MaxView',
    isDefault: true,
    skillRepo: 'MaxView',
    skillBranch: 'development',
    ...overrides,
  } as ProjectSkillConfig;
}

describe('resolveBranch', () => {
  it('uses the branch the project actually configured', async () => {
    // MaxView has no "main"; assuming one made the clone fallback throw.
    const branch = await resolveBranch(identity, async () => [config({})]);

    expect(branch).toBe('development');
  });

  it('picks the config matching the repository being read', async () => {
    const branch = await resolveBranch(identity, async () => [
      config({ id: 'other', skillRepo: 'Analytics', skillBranch: 'trunk' }),
      config({ id: 'mine', skillRepo: 'MaxView', skillBranch: 'development' }),
    ]);

    expect(branch).toBe('development');
  });

  it('matches when the repo is stored with an org or project prefix', async () => {
    const branch = await resolveBranch(identity, async () => [
      config({ skillRepo: 'MaxViewTeam/MaxView', skillBranch: 'release' }),
    ]);

    expect(branch).toBe('release');
  });

  it('falls back to the default config when no repo matches', async () => {
    const branch = await resolveBranch(identity, async () => [
      config({ skillRepo: 'SomethingElse', skillBranch: 'default-branch' }),
    ]);

    expect(branch).toBe('default-branch');
  });

  it('serves with a guess rather than failing when settings are unreachable', async () => {
    const branch = await resolveBranch(identity, async () => {
      throw new Error('database unreachable');
    });

    expect(branch).toBe('main');
  });

  it('ignores a blank configured branch', async () => {
    const branch = await resolveBranch(identity, async () => [
      config({ skillBranch: '   ' }),
    ]);

    expect(branch).toBe('main');
  });

  it('handles a project with no configured repository at all', async () => {
    const branch = await resolveBranch(identity, async () => []);

    expect(branch).toBe('main');
  });
});
