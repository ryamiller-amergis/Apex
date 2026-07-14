import fs from 'fs';
import path from 'path';

const mockGit = jest.fn();
const mockWithLease = jest.fn(
  async (
    _key: string,
    operation: (lease: { signal: AbortSignal; assertOwned: () => Promise<void> }) => Promise<unknown>,
  ) => operation({
    signal: new AbortController().signal,
    assertOwned: jest.fn().mockResolvedValue(undefined),
  }),
);

jest.mock('fs');
jest.mock('../utils/dataDir', () => ({
  resolveDataRoot: () => '/data',
}));
jest.mock('../utils/asyncGit', () => ({
  git: (...args: unknown[]) => mockGit(...args),
  safeArgs: (dir: string, args: string[]) => ['-c', `safe.directory=${dir}`, ...args],
}));
jest.mock('../services/repoCacheLeaseService', () => ({
  withRepoCacheLease: (...args: unknown[]) => mockWithLease(...args as [
    string,
    (lease: { signal: AbortSignal; assertOwned: () => Promise<void> }) => Promise<unknown>,
  ]),
}));

import {
  COLD_CACHE_TIMEOUT_MS,
  ensureRepoCache,
  getRepoCacheDir,
  repairRepoCache,
  resolveGitRemote,
} from '../services/repoCacheService';

const mockFs = fs as jest.Mocked<typeof fs>;

describe('repoCacheService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      ADO_ORG: 'https://dev.azure.com/amergis',
      ADO_PAT: 'ado-secret',
      GITHUB_ORG: 'amergis',
      GITHUB_TOKEN: 'github-secret',
    };
    mockFs.existsSync.mockReturnValue(false);
    mockGit.mockImplementation(async (args: string[]) => {
      if (args.includes('rev-parse')) return 'abc123\n';
      return '';
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('keys caches by provider, project, repository, and base branch', () => {
    const development = getRepoCacheDir({
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'development',
    });
    const release = getRepoCacheDir({
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'release',
    });

    expect(development).toContain(path.join('repo-cache', 'ado-maxview-maxview-development-'));
    expect(development).not.toBe(release);
  });

  it('creates a credential-free remote with runtime-only authentication', () => {
    const remote = resolveGitRemote('ado', 'MaxView', 'MaxView');

    expect(remote.url).toBe('https://dev.azure.com/amergis/MaxView/_git/MaxView');
    expect(remote.url).not.toContain('ado-secret');
    expect(Object.values(remote.env).join(' ')).toContain('Basic');
    expect(Object.values(remote.env).join(' ')).not.toContain('ado-secret');
    expect(remote.secret).toBe('ado-secret');
  });

  it('encodes ADO project and repository URL path segments', () => {
    const remote = resolveGitRemote('ado', 'Max View', 'Time # Clock');

    expect(remote.url).toBe(
      'https://dev.azure.com/amergis/Max%20View/_git/Time%20%23%20Clock',
    );
  });

  it('populates a cold cache with the complete configured branch history', async () => {
    const result = await ensureRepoCache({
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'development',
    });

    const cloneCall = mockGit.mock.calls.find(([args]) => (args as string[]).includes('clone'));
    expect(cloneCall?.[0]).toEqual(expect.arrayContaining([
      'clone',
      '--bare',
      '--single-branch',
      '--branch',
      'development',
      '--progress',
    ]));
    expect(JSON.stringify(cloneCall)).not.toContain('ado-secret');
    expect(cloneCall?.[1]).toEqual(expect.objectContaining({
      timeout: COLD_CACHE_TIMEOUT_MS,
      env: expect.objectContaining({ GIT_CONFIG_COUNT: '1' }),
    }));
    expect(mockFs.renameSync).toHaveBeenCalled();
    expect(mockGit).toHaveBeenCalledWith(
      expect.arrayContaining(['fsck', '--full', '--no-dangling', '--progress', 'abc123']),
      expect.objectContaining({ timeout: COLD_CACHE_TIMEOUT_MS }),
    );
    expect(result.baseSha).toBe('abc123');
  });

  it('incrementally refreshes an existing cache before returning its base SHA', async () => {
    mockFs.existsSync.mockReturnValue(true);

    await ensureRepoCache({
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'development',
    });

    expect(mockGit).toHaveBeenCalledWith(
      expect.arrayContaining([
        'fetch',
        '--prune',
        'origin',
        '+refs/heads/development:refs/heads/development',
      ]),
      expect.objectContaining({ env: expect.objectContaining({ GIT_CONFIG_COUNT: '1' }) }),
    );
    expect(mockGit).toHaveBeenCalledWith(
      expect.arrayContaining(['cat-file', '-e', 'abc123^{commit}']),
      expect.any(Object),
    );
    expect(mockGit.mock.calls.some(([args]) => (args as string[]).includes('fsck'))).toBe(false);
    expect(mockGit.mock.calls.some(([args]) => (args as string[]).includes('clone'))).toBe(false);
  });

  it('repairs a warm cache when its fetched head commit cannot be read', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockGit.mockImplementation(async (args: string[]) => {
      if (args.includes('rev-parse')) return 'head123\n';
      if (args.includes('cat-file')) throw new Error('bad object head123');
      return '';
    });

    await expect(ensureRepoCache({
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'development',
    })).resolves.toEqual(expect.objectContaining({ baseSha: 'head123' }));

    expect(mockGit).toHaveBeenCalledWith(
      expect.arrayContaining(['fetch', '--refetch', '--prune', 'origin']),
      expect.any(Object),
    );
    expect(mockGit).toHaveBeenCalledWith(
      expect.arrayContaining(['fsck', '--full', '--no-dangling', '--progress', 'head123']),
      expect.any(Object),
    );
  });

  it('does not replace an incomplete cache that active workspaces may reference', async () => {
    mockFs.existsSync.mockImplementation((target) =>
      String(target).endsWith('.git'),
    );

    await expect(ensureRepoCache({
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'development',
    })).rejects.toThrow('incomplete');

    expect(mockFs.rmSync).not.toHaveBeenCalled();
    expect(mockGit.mock.calls.some(([args]) => (args as string[]).includes('clone'))).toBe(false);
  });

  it('uses the last verified cache when an incremental refresh is temporarily unavailable', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockGit.mockImplementation(async (args: string[]) => {
      if (args.includes('fetch')) throw new Error('network unavailable');
      if (args.includes('rev-parse')) return 'cached123\n';
      return '';
    });

    await expect(ensureRepoCache({
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'development',
    })).resolves.toEqual(expect.objectContaining({ baseSha: 'cached123', stale: true }));
    expect(mockGit).toHaveBeenCalledWith(
      expect.arrayContaining(['fsck', '--full', '--no-dangling', '--progress', 'cached123']),
      expect.any(Object),
    );
  });

  it('does not hide authentication failures behind a stale cache', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockGit.mockImplementation(async (args: string[]) => {
      if (args.includes('fetch')) throw new Error('Authentication failed');
      if (args.includes('rev-parse')) return 'cached123\n';
      return '';
    });

    await expect(ensureRepoCache({
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'development',
    })).rejects.toThrow('Authentication failed');
  });

  it('removes a partial temporary cache when cold initialization fails', async () => {
    mockGit.mockRejectedValue(new Error('clone failed'));

    await expect(ensureRepoCache({
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'development',
    })).rejects.toThrow('clone failed');

    expect(mockFs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining('.tmp-'),
      { recursive: true, force: true },
    );
  });

  it('does not publish a cold cache that fails connectivity verification', async () => {
    mockGit.mockImplementation(async (args: string[]) => {
      if (args.includes('rev-parse')) return 'broken-cold\n';
      if (args.includes('fsck')) throw new Error('missing reachable tree');
      return '';
    });

    await expect(ensureRepoCache({
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'development',
    })).rejects.toThrow('missing reachable tree');

    expect(mockFs.renameSync).not.toHaveBeenCalled();
    expect(mockFs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining('.tmp-'),
      { recursive: true, force: true },
    );
  });

  it('repairs missing reachable objects by refetching without replacing the cache', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockGit.mockImplementation(async (args: string[]) => {
      if (args.includes('rev-parse')) return 'repaired123\n';
      return '';
    });

    await expect(repairRepoCache({
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'development',
    })).resolves.toEqual(expect.objectContaining({ baseSha: 'repaired123' }));

    expect(mockGit).toHaveBeenCalledWith(
      expect.arrayContaining(['fetch', '--refetch', '--prune', 'origin']),
      expect.any(Object),
    );
    expect(mockGit).toHaveBeenCalledWith(
      expect.arrayContaining(['fsck', '--full', '--no-dangling', '--progress', 'repaired123']),
      expect.any(Object),
    );
    expect(mockFs.rmSync).not.toHaveBeenCalled();
  });

  it('coalesces a queued repair after another instance completed it', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync
      .mockReturnValueOnce('repair-before\n' as never)
      .mockReturnValueOnce('repair-after\n' as never);
    mockGit.mockImplementation(async (args: string[]) => {
      if (args.includes('rev-parse')) return 'already-fixed\n';
      return '';
    });

    await expect(repairRepoCache({
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'development',
    })).resolves.toEqual(expect.objectContaining({ baseSha: 'already-fixed' }));

    expect(mockGit.mock.calls.some(([args]) =>
      (args as string[]).includes('--refetch'),
    )).toBe(false);
  });

  it('preserves the canonical cache when a warm repair fails', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockGit.mockImplementation(async (args: string[]) => {
      if (args.includes('rev-parse')) return 'broken123\n';
      if (args.includes('cat-file')) throw new Error('missing commit object');
      if (args.includes('--refetch')) throw new Error('repair unavailable');
      return '';
    });

    await expect(ensureRepoCache({
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'development',
    })).rejects.toThrow('repair unavailable');

    expect(mockFs.rmSync).not.toHaveBeenCalled();
    expect(mockGit.mock.calls.some(([args]) => (args as string[]).includes('clone'))).toBe(false);
  });

  it('retries cold cache initialization once after cleaning the failed attempt', async () => {
    let cloneAttempts = 0;
    mockGit.mockImplementation(async (args: string[]) => {
      if (args.includes('clone')) {
        cloneAttempts += 1;
        if (cloneAttempts === 1) throw new Error('transient clone failure');
      }
      if (args.includes('rev-parse')) return 'retry123\n';
      return '';
    });

    await expect(ensureRepoCache({
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'development',
    })).resolves.toEqual(expect.objectContaining({ baseSha: 'retry123' }));

    expect(cloneAttempts).toBe(2);
    expect(mockFs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining('.tmp-'),
      { recursive: true, force: true },
    );
  });
});
