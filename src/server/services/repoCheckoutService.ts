import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { resolveDataRoot } from '../utils/dataDir';

const CHECKOUT_BASE = path.join(resolveDataRoot(), 'dev-workspaces');

export function getWorkspaceDir(sessionId: string): string {
  return path.join(CHECKOUT_BASE, sessionId);
}

export async function checkoutDefaultBranch(opts: {
  project: string;
  repo: string;
  branch: string;
  sessionId: string;
}): Promise<string> {
  const { project, repo, branch, sessionId } = opts;
  const workspaceDir = getWorkspaceDir(sessionId);

  const orgUrl = process.env.ADO_ORG;
  const pat = process.env.ADO_PAT;

  if (!orgUrl || !pat) {
    throw new Error('ADO_ORG and ADO_PAT must be set for repo checkout');
  }

  const urlObj = new URL(`${orgUrl}/${project}/_git/${repo}`);
  urlObj.username = 'pat';
  urlObj.password = pat;

  fs.mkdirSync(workspaceDir, { recursive: true });

  execSync(
    `git clone -c core.longpaths=true --single-branch --branch "${branch}" --depth 1 "${urlObj.toString()}" .`,
    { cwd: workspaceDir, stdio: 'pipe', timeout: 120000 },
  );

  return workspaceDir;
}

export function createFeatureBranch(workspaceDir: string, workItemId: number): string {
  const branchName = `feature/wi-${workItemId}`;
  execSync(`git checkout -b "${branchName}"`, { cwd: workspaceDir, stdio: 'pipe' });
  return branchName;
}

export function computeDiff(workspaceDir: string): { diffText: string; changedFiles: string[] } {
  execSync('git add -A', { cwd: workspaceDir, stdio: 'pipe' });

  const diffText = execSync('git diff --cached', {
    cwd: workspaceDir,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });

  const filesOutput = execSync('git diff --cached --name-only', {
    cwd: workspaceDir,
    encoding: 'utf-8',
  });
  const changedFiles = filesOutput.split('\n').filter(Boolean);

  return { diffText, changedFiles };
}

export function pushBranch(workspaceDir: string, branchName: string): void {
  execSync('git add -A', { cwd: workspaceDir, stdio: 'pipe' });

  const status = execSync('git status --porcelain', {
    cwd: workspaceDir,
    encoding: 'utf-8',
  }).trim();

  if (status) {
    execSync('git commit -m "Dev workbench: agent changes"', {
      cwd: workspaceDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'AI Pilot',
        GIT_AUTHOR_EMAIL: 'ai-pilot@noreply',
        GIT_COMMITTER_NAME: 'AI Pilot',
        GIT_COMMITTER_EMAIL: 'ai-pilot@noreply',
      },
    });
  }

  execSync(`git push -u origin "${branchName}"`, {
    cwd: workspaceDir,
    stdio: 'pipe',
    timeout: 120000,
  });
}

export function cleanupWorkspace(sessionId: string): void {
  const workspaceDir = getWorkspaceDir(sessionId);
  if (fs.existsSync(workspaceDir)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}
