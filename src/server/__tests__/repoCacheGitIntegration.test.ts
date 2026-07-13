import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
      .toBe(true);
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
