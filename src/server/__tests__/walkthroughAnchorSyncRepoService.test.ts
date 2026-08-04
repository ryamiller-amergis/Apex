/**
 * Apex skill-repo resolution for walkthrough anchor Sync (repo cache materialize).
 */

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn(),
}));

jest.mock('../services/repoCheckoutService', () => ({
  checkoutDefaultBranch: jest.fn(),
  getWorkspaceDir: jest.fn(
    (sessionId: string) => `/data/dev-workspaces/${sessionId}`
  ),
}));

import { resolveSkillConfig } from '../services/projectSettingsService';
import { checkoutDefaultBranch } from '../services/repoCheckoutService';
import {
  WALKTHROUGH_ANCHOR_SYNC_SESSION_ID,
  materializeApexWalkthroughAnchorSyncCheckout,
  normalizeSkillRepoForCheckout,
  resolveWalkthroughAnchorSyncProvider,
} from '../services/walkthroughAnchorSyncRepoService';
import { WalkthroughAnchorRegistryError } from '../../shared/types/walkthroughAnchorRegistry';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';

const mockedResolveSkillConfig = resolveSkillConfig as jest.MockedFunction<
  typeof resolveSkillConfig
>;
const mockedCheckout = checkoutDefaultBranch as jest.MockedFunction<
  typeof checkoutDefaultBranch
>;

describe('normalizeSkillRepoForCheckout', () => {
  it('strips owner for github owner/repo forms', () => {
    expect(normalizeSkillRepoForCheckout('github', 'amergis/AI-Pilot')).toBe(
      'AI-Pilot'
    );
    expect(
      normalizeSkillRepoForCheckout('github', 'amergis/AI-Pilot.git')
    ).toBe('AI-Pilot');
  });

  it('leaves bare github and ado repos unchanged', () => {
    expect(normalizeSkillRepoForCheckout('github', 'AI-Pilot')).toBe(
      'AI-Pilot'
    );
    expect(
      normalizeSkillRepoForCheckout('ado', 'Apex Project/AI-Pilot')
    ).toBe('Apex Project/AI-Pilot');
  });
});

describe('resolveWalkthroughAnchorSyncProvider', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    jest.clearAllMocks();
  });

  it('honors explicit provider', async () => {
    process.env.NODE_ENV = 'production';
    await expect(resolveWalkthroughAnchorSyncProvider('local')).resolves.toBe(
      'local'
    );
    await expect(resolveWalkthroughAnchorSyncProvider('github')).resolves.toBe(
      'github'
    );
    expect(mockedResolveSkillConfig).not.toHaveBeenCalled();
  });

  it('defaults to local outside production', async () => {
    process.env.NODE_ENV = 'development';
    await expect(resolveWalkthroughAnchorSyncProvider()).resolves.toBe('local');
    expect(mockedResolveSkillConfig).not.toHaveBeenCalled();
  });

  it('uses Apex skillProvider in production when unset', async () => {
    process.env.NODE_ENV = 'production';
    mockedResolveSkillConfig.mockResolvedValue({
      skillRepo: 'AI-Pilot',
      skillBranch: 'main',
      skillProvider: 'github',
    } as ProjectSkillConfig);

    await expect(resolveWalkthroughAnchorSyncProvider()).resolves.toBe(
      'github'
    );
    expect(mockedResolveSkillConfig).toHaveBeenCalledWith({ project: 'Apex' });
  });

  it('throws when production Apex has no skillRepo', async () => {
    process.env.NODE_ENV = 'production';
    mockedResolveSkillConfig.mockResolvedValue({
      skillRepo: '',
      skillProvider: 'github',
    } as ProjectSkillConfig);

    await expect(resolveWalkthroughAnchorSyncProvider()).rejects.toBeInstanceOf(
      WalkthroughAnchorRegistryError
    );
  });
});

describe('materializeApexWalkthroughAnchorSyncCheckout', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('checks out Apex skill repo into the Sync workspace', async () => {
    mockedResolveSkillConfig.mockResolvedValue({
      skillRepo: 'amergis/AI-Pilot',
      skillBranch: 'release',
      skillProvider: 'github',
    } as ProjectSkillConfig);
    mockedCheckout.mockResolvedValue(
      `/data/dev-workspaces/${WALKTHROUGH_ANCHOR_SYNC_SESSION_ID}`
    );

    const result = await materializeApexWalkthroughAnchorSyncCheckout('github');

    expect(mockedCheckout).toHaveBeenCalledWith({
      project: 'Apex',
      repo: 'AI-Pilot',
      branch: 'release',
      sessionId: WALKTHROUGH_ANCHOR_SYNC_SESSION_ID,
      provider: 'github',
    });
    expect(result).toEqual({
      repositoryRoot: `/data/dev-workspaces/${WALKTHROUGH_ANCHOR_SYNC_SESSION_ID}`,
      branch: 'release',
      repo: 'AI-Pilot',
      provider: 'github',
      project: 'Apex',
    });
  });
});
