jest.mock('../db/drizzle', () => ({ db: {} }));

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  compactRepoCache,
  readRepoCachePackStats,
} from '../services/repoCacheService';
import { materializeWorkspaceFromCache } from '../services/repoWorkspaceService';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('materializeWorkspaceFromCache', () => {
  let rootDir: string;
  let sourceDir: string;
  let cacheDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-repo-cache-'));
    sourceDir = path.join(rootDir, 'source');
    cacheDir = path.join(rootDir, 'cache.git');
    fs.mkdirSync(sourceDir);
    runGit(sourceDir, ['init', '-b', 'development']);
    runGit(sourceDir, ['config', 'user.name', 'Apex Test']);
    runGit(sourceDir, ['config', 'user.email', 'apex-test@example.com']);
    fs.writeFileSync(path.join(sourceDir, 'history.txt'), 'first\n');
    runGit(sourceDir, ['add', 'history.txt']);
    runGit(sourceDir, ['commit', '-m', 'first']);
    fs.appendFileSync(path.join(sourceDir, 'history.txt'), 'second\n');
    runGit(sourceDir, ['commit', '-am', 'second']);
    runGit(rootDir, [
      'clone',
      '--bare',
      '--single-branch',
      '--branch',
      'development',
      sourceDir,
      cacheDir,
    ]);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('creates an independent workspace with full base-branch history', async () => {
    const workspaceDir = path.join(rootDir, 'workspace');

    await materializeWorkspaceFromCache(
      cacheDir,
      workspaceDir,
      'development',
      'https://example.invalid/repo.git',
    );

    expect(runGit(workspaceDir, ['branch', '--show-current'])).toBe('development');
    expect(runGit(workspaceDir, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(runGit(workspaceDir, ['remote', 'get-url', 'origin']))
      .toBe('https://example.invalid/repo.git');
    expect(fs.existsSync(path.join(workspaceDir, '.git', 'objects', 'info', 'alternates')))
      .toBe(false);
  });

  it('fails without leaving a partial workspace when the branch is missing', async () => {
    const workspaceDir = path.join(rootDir, 'missing-workspace');

    await expect(materializeWorkspaceFromCache(
      cacheDir,
      workspaceDir,
      'missing',
      'https://example.invalid/repo.git',
    )).rejects.toThrow();

    expect(fs.existsSync(workspaceDir)).toBe(false);
  });
});

describe('compactRepoCache', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-repo-compact-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('collapses refetch and incremental packs into one without losing history', async () => {
    const sourceDir = path.join(rootDir, 'source');
    const cacheDir = path.join(rootDir, 'cache.git');
    fs.mkdirSync(sourceDir);
    runGit(sourceDir, ['init', '-b', 'main']);
    runGit(sourceDir, ['config', 'user.name', 'Apex Test']);
    runGit(sourceDir, ['config', 'user.email', 'apex-test@example.com']);
    runGit(sourceDir, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(sourceDir, 'history.txt'), 'first\n');
    runGit(sourceDir, ['add', 'history.txt']);
    runGit(sourceDir, ['commit', '-m', 'first']);
    runGit(rootDir, ['clone', '--bare', sourceDir, cacheDir]);
    runGit(cacheDir, ['config', 'gc.auto', '0']);
    runGit(cacheDir, ['config', 'maintenance.auto', 'false']);

    const fetchAll = (...extra: string[]) => runGit(cacheDir, [
      '-c', 'fetch.unpackLimit=1', 'fetch', ...extra, sourceDir, '+refs/heads/*:refs/heads/*',
    ]);
    for (let i = 0; i < 4; i += 1) {
      fs.appendFileSync(path.join(sourceDir, 'history.txt'), `line ${i}\n`);
      runGit(sourceDir, ['commit', '-am', `change ${i}`]);
      fetchAll();
    }
    fetchAll('--refetch');
    fetchAll('--refetch');
    const before = readRepoCachePackStats(cacheDir);
    expect(before.packCount).toBeGreaterThan(2);

    const result = await compactRepoCache(cacheDir, {
      abortSignal: new AbortController().signal,
      assertOwned: async () => undefined,
      reason: 'oversized',
    });

    expect(result.compacted).toBe(true);
    expect(result.before.packCount).toBe(before.packCount);
    expect(result.after.packCount).toBe(1);
    expect(result.after.packBytes).toBeLessThan(before.packBytes);
    expect(readRepoCachePackStats(cacheDir).packCount).toBe(1);
    expect(runGit(cacheDir, ['rev-list', '--count', 'refs/heads/main'])).toBe('5');
    runGit(cacheDir, ['fsck', '--full', '--no-dangling']);
  });
});
