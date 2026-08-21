/**
 * @jest-environment node
 */

import {
  hydrateRepoReadMirror,
  kickBackgroundMirrorRefresh,
  resetBackgroundMirrorRefreshesForTests,
  REPO_SYNCING_MESSAGE,
  type MirrorHydrationDependencies,
} from '../services/repoRead/mirrorHydration';
import type { RepositoryIdentity } from '../../shared/types/repoReader';

const identity: RepositoryIdentity = {
  provider: 'ado',
  project: 'MaxView',
  repo: 'MaxView',
  sha: 'a'.repeat(40),
};

const cacheDir = '/tmp/ado-maxview.git';

function deps(overrides: {
  hasCommit?: boolean | (() => Promise<boolean>);
  usable?: boolean;
  kick?: jest.Mock;
  rehydrateBare?: jest.Mock;
  ensureRepoCache?: jest.Mock;
}): MirrorHydrationDependencies {
  const hasCommit = overrides.hasCommit ?? false;
  const usable = overrides.usable ?? true;
  const kick = overrides.kick ?? jest.fn();
  const rehydrateBare =
    overrides.rehydrateBare ??
    jest.fn().mockResolvedValue({ status: 'remote-fallback' });
  const ensureRepoCache =
    overrides.ensureRepoCache ??
    jest.fn().mockResolvedValue({
      cacheDir,
      baseSha: identity.sha,
      stale: false,
      remote: { url: 'https://example', env: {}, secret: '' },
    });
  return {
    getRepoCacheDir: () => cacheDir,
    isUsableBareMirror: () => usable,
    mirrorHasCommit: async () =>
      typeof hasCommit === 'function' ? hasCommit() : hasCommit,
    resolveBranch: async () => 'development',
    rehydrateBare: (identityArg, destination) =>
      rehydrateBare(identityArg, destination),
    ensureRepoCache: (options) => ensureRepoCache(options),
    kickBackgroundRefresh: (options, sha) => kick(options, sha),
  };
}

describe('hydrateRepoReadMirror', () => {
  afterEach(() => {
    resetBackgroundMirrorRefreshesForTests();
  });

  it('returns immediately when the pin is already in the mirror', async () => {
    const kick = jest.fn();
    const rehydrateBare = jest.fn();
    const path = await hydrateRepoReadMirror(
      identity,
      deps({ hasCommit: true, kick, rehydrateBare }),
    );

    expect(path).toBe(cacheDir);
    expect(kick).not.toHaveBeenCalled();
    expect(rehydrateBare).not.toHaveBeenCalled();
  });

  it('does not wipe a warm MaxView mirror or await fetch when the pin is missing', async () => {
    const kick = jest.fn();
    const rehydrateBare = jest.fn();
    const ensure = jest.fn();

    await expect(
      hydrateRepoReadMirror(
        identity,
        deps({
          hasCommit: false,
          usable: true,
          kick,
          rehydrateBare,
          ensureRepoCache: ensure,
        }),
      ),
    ).rejects.toThrow(REPO_SYNCING_MESSAGE);

    expect(kick).toHaveBeenCalledTimes(1);
    expect(kick).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'ado',
        project: 'MaxView',
        repo: 'MaxView',
        branch: 'development',
      }),
      identity.sha,
    );
    expect(rehydrateBare).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });

  it('coalesces background refreshes so overlapping chats share one fetch', () => {
    const run = jest.fn().mockReturnValue(new Promise<void>(() => undefined));
    const options = {
      provider: 'ado' as const,
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'development',
    };

    kickBackgroundMirrorRefresh(options, identity.sha, run);
    kickBackgroundMirrorRefresh(options, identity.sha, run);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('restores from a bundle only when no local mirror exists', async () => {
    const kick = jest.fn();
    const rehydrateBare = jest.fn().mockResolvedValue({ status: 'materialized' });

    const path = await hydrateRepoReadMirror(
      identity,
      deps({
        hasCommit: false,
        usable: false,
        kick,
        rehydrateBare,
      }),
    );

    expect(path).toBe(cacheDir);
    expect(rehydrateBare).toHaveBeenCalledTimes(1);
    expect(kick).not.toHaveBeenCalled();
  });
});
