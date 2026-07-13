/**
 * Unit tests for repoCheckoutService — workspace paths and checkout guards.
 */

import fs from 'fs';
import path from 'path';

const mockGit = jest.fn().mockResolvedValue('');
const mockRemote = {
  url: 'https://dev.azure.com/amergis/MaxView/_git/MaxView',
  env: {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: 'Authorization: Basic encoded',
  },
  secret: 'secret-pat',
};
const mockEnsureRepoCache = jest.fn().mockResolvedValue({
  cacheDir: '/data/repo-cache/maxview.git',
  baseSha: 'abc123',
  stale: false,
  remote: mockRemote,
});
const mockResolveGitRemote = jest.fn();

jest.mock('fs');
jest.mock('../utils/asyncGit', () => ({
  git: (...args: any[]) => mockGit(...args),
  safeArgs: (dir: string, args: string[]) => ['-c', `safe.directory=${dir}`, ...args],
  LONG_TIMEOUT_MS: 120_000,
}));
jest.mock('../utils/asyncMutex', () => ({
  workspaceMutex: { acquire: jest.fn().mockResolvedValue(() => {}) },
}));
jest.mock('../utils/dataDir', () => ({
  resolveDataRoot: jest.fn(() => '/data'),
}));
jest.mock('../services/repoCacheService', () => ({
  COLD_CACHE_TIMEOUT_MS: 1_800_000,
  ensureRepoCache: (...args: unknown[]) => mockEnsureRepoCache(...args),
  resolveGitRemote: (...args: unknown[]) => mockResolveGitRemote(...args),
}));

import {
  getWorkspaceDir,
  cleanupWorkspace,
  checkoutDefaultBranch,
  createFeatureBranch,
  checkoutNewBranch,
  checkoutFeatureBranch,
  excludeAiPilotFromGit,
} from '../services/repoCheckoutService';

const mockFs = fs as jest.Mocked<typeof fs>;

function workspacePath(sessionId: string): string {
  return path.join('/data', 'dev-workspaces', sessionId);
}

describe('repoCheckoutService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGit.mockResolvedValue('');
    mockEnsureRepoCache.mockResolvedValue({
      cacheDir: '/data/repo-cache/maxview.git',
      baseSha: 'abc123',
      stale: false,
      remote: mockRemote,
    });
    mockResolveGitRemote.mockImplementation((provider: string) => {
      if (provider === 'github') {
        if (!process.env.GITHUB_ORG) throw new Error('GITHUB_ORG must be set for GitHub repo checkout');
        const secret = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || process.env.GH_SKILL_TOKEN;
        if (!secret) throw new Error('GitHub token must be set for GitHub repo checkout');
        return {
          ...mockRemote,
          url: 'https://github.com/amergis/AI-Pilot.git',
          secret,
        };
      }
      if (!process.env.ADO_ORG || !process.env.ADO_PAT) {
        throw new Error('ADO_ORG and ADO_PAT must be set for repo checkout');
      }
      return { ...mockRemote, secret: process.env.ADO_PAT };
    });
  });

  describe('getWorkspaceDir', () => {
    it('returns path under dev-workspaces for the session id', () => {
      expect(getWorkspaceDir('session-123')).toBe(workspacePath('session-123'));
    });
  });

  describe('cleanupWorkspace', () => {
    it('removes the workspace directory when it exists', () => {
      mockFs.existsSync.mockReturnValue(true);

      cleanupWorkspace('session-123');

      expect(mockFs.rmSync).toHaveBeenCalledWith(workspacePath('session-123'), {
        recursive: true,
        force: true,
      });
    });

    it('does nothing when the workspace directory is missing', () => {
      mockFs.existsSync.mockReturnValue(false);

      cleanupWorkspace('session-123');

      expect(mockFs.rmSync).not.toHaveBeenCalled();
    });
  });

  describe('checkoutDefaultBranch', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('throws when ADO credentials are not configured', async () => {
      delete process.env.ADO_ORG;
      delete process.env.ADO_PAT;

      await expect(
        checkoutDefaultBranch({
          project: 'MaxView',
          repo: 'MaxView',
          branch: 'main',
          sessionId: 'session-123',
        }),
      ).rejects.toThrow('ADO_ORG and ADO_PAT must be set for repo checkout');
    });

    it('throws when GitHub credentials are not configured', async () => {
      delete process.env.GITHUB_ORG;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_PAT;
      delete process.env.GH_SKILL_TOKEN;

      await expect(
        checkoutDefaultBranch({
          project: 'Apex',
          repo: 'AI-Pilot',
          branch: 'main',
          sessionId: 'session-123',
          provider: 'github',
        }),
      ).rejects.toThrow('GITHUB_ORG must be set for GitHub repo checkout');
    });

    it('clones the repo into the workspace when credentials are set', async () => {
      process.env.ADO_ORG = 'https://dev.azure.com/amergis';
      process.env.ADO_PAT = 'secret-pat';
      mockFs.mkdirSync.mockImplementation(() => undefined);

      const workspaceDir = await checkoutDefaultBranch({
        project: 'MaxView',
        repo: 'MaxView',
        branch: 'main',
        sessionId: 'session-abc',
      });

      expect(workspaceDir).toBe(workspacePath('session-abc'));
      expect(mockEnsureRepoCache).toHaveBeenCalledWith({
        project: 'MaxView',
        repo: 'MaxView',
        branch: 'main',
        provider: 'ado',
      });
      expect(mockGit).toHaveBeenCalledWith(
        expect.arrayContaining([
          'clone',
          '--reference-if-able',
          '/data/repo-cache/maxview.git',
          '--dissociate',
          '--no-local',
          '--no-hardlinks',
          '--single-branch',
          '--branch',
          'main',
          '/data/repo-cache/maxview.git',
          workspacePath('session-abc'),
        ]),
        expect.objectContaining({ cwd: path.join('/data', 'dev-workspaces') }),
      );
      expect(mockGit).toHaveBeenCalledWith(
        expect.arrayContaining(['remote', 'set-url', 'origin', mockRemote.url]),
        expect.objectContaining({ cwd: workspacePath('session-abc') }),
      );
      expect(JSON.stringify(mockGit.mock.calls)).not.toContain('secret-pat');
    });

    it('excludes .ai-pilot from git tracking after cloning', async () => {
      process.env.ADO_ORG = 'https://dev.azure.com/amergis';
      process.env.ADO_PAT = 'secret-pat';
      mockFs.mkdirSync.mockImplementation(() => undefined);
      mockFs.existsSync.mockReturnValue(false);

      await checkoutDefaultBranch({
        project: 'MaxView',
        repo: 'MaxView',
        branch: 'main',
        sessionId: 'session-excl',
      });

      const excludePath = path.join(workspacePath('session-excl'), '.git', 'info', 'exclude');
      expect(mockFs.appendFileSync).toHaveBeenCalledWith(
        excludePath,
        expect.stringContaining('.ai-pilot/'),
        'utf-8',
      );
    });

    it('clones a GitHub repo when provider is github', async () => {
      process.env.GITHUB_ORG = 'amergis';
      process.env.GITHUB_TOKEN = 'gh-secret';
      mockFs.mkdirSync.mockImplementation(() => undefined);

      const workspaceDir = await checkoutDefaultBranch({
        project: 'Apex',
        repo: 'AI-Pilot',
        branch: 'main',
        sessionId: 'session-gh',
        provider: 'github',
      });

      expect(workspaceDir).toBe(workspacePath('session-gh'));
      expect(mockGit).toHaveBeenCalledWith(
        expect.arrayContaining(['clone']),
        expect.objectContaining({ cwd: path.join('/data', 'dev-workspaces') }),
      );
    });
  });

  describe('excludeAiPilotFromGit', () => {
    it('appends .ai-pilot/ to .git/info/exclude when not already present', () => {
      mockFs.existsSync.mockReturnValue(false);

      excludeAiPilotFromGit('/tmp/workspace');

      const excludePath = path.join('/tmp/workspace', '.git', 'info', 'exclude');
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(path.join('/tmp/workspace', '.git', 'info'), {
        recursive: true,
      });
      expect(mockFs.appendFileSync).toHaveBeenCalledWith(
        excludePath,
        expect.stringContaining('.ai-pilot/'),
        'utf-8',
      );
    });

    it('is idempotent when .ai-pilot/ is already excluded', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('# git\n.ai-pilot/\n' as never);

      excludeAiPilotFromGit('/tmp/workspace');

      expect(mockFs.appendFileSync).not.toHaveBeenCalled();
    });

    it('does not throw if writing the exclude file fails', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.appendFileSync.mockImplementation(() => {
        throw new Error('disk full');
      });

      expect(() => excludeAiPilotFromGit('/tmp/workspace')).not.toThrow();
    });
  });

  describe('createFeatureBranch', () => {
    it('creates a feature branch with workItemId and slugified title', async () => {
      const branchName = await createFeatureBranch('/tmp/workspace', 50743, 'Shift Scheduler Widget', 'development');

      expect(branchName).toBe('feature/apex-50743-shift-scheduler-widget');
      expect(mockGit).toHaveBeenCalledWith(
        ['-c', 'safe.directory=/tmp/workspace', 'checkout', '-b', 'feature/apex-50743-shift-scheduler-widget'],
        expect.objectContaining({ cwd: '/tmp/workspace' }),
      );
    });
  });

  describe('checkoutNewBranch', () => {
    it('uses safe.directory to avoid dubious ownership errors', async () => {
      await checkoutNewBranch('/tmp/workspace', 'feature/apex-feat-009-platform-integration');

      expect(mockGit).toHaveBeenCalledWith(
        ['-c', 'safe.directory=/tmp/workspace', 'checkout', '-b', 'feature/apex-feat-009-platform-integration'],
        expect.objectContaining({ cwd: '/tmp/workspace' }),
      );
    });
  });

  describe('checkoutFeatureBranch', () => {
    it('creates a fresh branch off the base when the remote branch does not exist', async () => {
      // ls-remote returns empty → no existing remote branch.
      mockGit.mockResolvedValue('');

      await checkoutFeatureBranch('/tmp/workspace', 'feature/apex-50739-blackout', 'development');

      expect(mockGit).toHaveBeenCalledWith(
        expect.arrayContaining(['ls-remote', '--heads', 'origin', 'feature/apex-50739-blackout']),
        expect.objectContaining({ cwd: '/tmp/workspace' }),
      );
      expect(mockGit).toHaveBeenCalledWith(
        ['-c', 'safe.directory=/tmp/workspace', 'checkout', '-b', 'feature/apex-50739-blackout'],
        expect.objectContaining({ cwd: '/tmp/workspace' }),
      );
      // No fetch of the feature branch and no base merge on the fresh path.
      expect(mockGit).not.toHaveBeenCalledWith(
        expect.arrayContaining(['checkout', '-b', 'feature/apex-50739-blackout', 'origin/feature/apex-50739-blackout']),
        expect.anything(),
      );
    });

    it('reuses the existing remote branch and merges the base branch in', async () => {
      mockGit.mockImplementation((args: string[]) => {
        if (args.includes('ls-remote')) {
          return Promise.resolve('abc123\trefs/heads/feature/apex-50739-blackout\n');
        }
        return Promise.resolve('');
      });

      await checkoutFeatureBranch('/tmp/workspace', 'feature/apex-50739-blackout', 'development');

      // Branches from the remote tip (preserving prior committed work).
      expect(mockGit).toHaveBeenCalledWith(
        ['-c', 'safe.directory=/tmp/workspace', 'checkout', '-b', 'feature/apex-50739-blackout', 'origin/feature/apex-50739-blackout'],
        expect.objectContaining({ cwd: '/tmp/workspace' }),
      );
      // Merges the base branch in before the agent starts.
      expect(mockGit).toHaveBeenCalledWith(
        expect.arrayContaining(['merge', '--no-ff', 'origin/development']),
        expect.objectContaining({ cwd: '/tmp/workspace' }),
      );
    });

    it('aborts and continues when the base merge conflicts', async () => {
      mockGit.mockImplementation((args: string[]) => {
        if (args.includes('ls-remote')) {
          return Promise.resolve('abc123\trefs/heads/feature/apex-50739-blackout\n');
        }
        if (args.includes('merge') && !args.includes('--abort')) {
          return Promise.reject(new Error('merge conflict'));
        }
        return Promise.resolve('');
      });

      await expect(
        checkoutFeatureBranch('/tmp/workspace', 'feature/apex-50739-blackout', 'development'),
      ).resolves.toBeUndefined();

      expect(mockGit).toHaveBeenCalledWith(
        expect.arrayContaining(['merge', '--abort']),
        expect.objectContaining({ cwd: '/tmp/workspace' }),
      );
    });
  });
});
