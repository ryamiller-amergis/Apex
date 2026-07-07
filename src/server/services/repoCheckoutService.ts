import fs from 'fs';
import path from 'path';
import type { SkillProvider } from '../../shared/types/projectSettings';
import { resolveDataRoot } from '../utils/dataDir';
import { git, safeArgs, LONG_TIMEOUT_MS } from '../utils/asyncGit';
import { workspaceMutex } from '../utils/asyncMutex';

const CHECKOUT_BASE = path.join(resolveDataRoot(), 'dev-workspaces');

export function getWorkspaceDir(sessionId: string): string {
  return path.join(CHECKOUT_BASE, sessionId);
}

/**
 * Removes credentials from text so a Personal Access Token embedded in a
 * clone URL can never surface in an error message or log line. Strips both
 * the exact PAT value and any `user:secret@host` userinfo in a URL.
 */
export function redactSecrets(text: string, pat?: string): string {
  let out = text;
  if (pat) {
    out = out.split(pat).join('***');
  }
  return out.replace(/\/\/[^/@\s:]*:[^/@\s]*@/g, '//***:***@');
}

let safeDirectoryConfigured = false;

/**
 * Trusts all repo directories at the global/system git config level so that
 * git commands run OUTSIDE this service — notably the Cursor agent, which
 * operates in the cloned workspace — also clear the dubious-ownership guard.
 * Only needed on Azure App Service; a no-op locally.
 */
async function ensureGitSafeDirectory(): Promise<void> {
  if (safeDirectoryConfigured) return;
  safeDirectoryConfigured = true;

  const onAzureAppService = Boolean(
    process.env.WEBSITE_SITE_NAME || process.env.WEBSITE_INSTANCE_ID,
  );
  if (!onAzureAppService) return;

  for (const scope of ['--system', '--global']) {
    try {
      await git(['config', scope, '--add', 'safe.directory', '*']);
      return;
    } catch {
      // Try the next scope; --system needs root, --global needs a writable HOME.
    }
  }
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

function getGitHubOrg(): string {
  const org = process.env.GITHUB_ORG || '';
  if (!org) {
    throw new Error('GITHUB_ORG must be set for GitHub repo checkout');
  }
  return org;
}

function getGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || process.env.GH_SKILL_TOKEN || '';
  if (!token) {
    throw new Error('GITHUB_TOKEN, GITHUB_PAT, or GH_SKILL_TOKEN must be set for GitHub repo checkout');
  }
  return token;
}

function buildCloneUrl(provider: SkillProvider, project: string, repo: string): { url: string; secret?: string } {
  if (provider === 'github') {
    const org = getGitHubOrg();
    const token = getGitHubToken();
    const urlObj = new URL(`https://github.com/${org}/${repo}.git`);
    urlObj.username = 'x-access-token';
    urlObj.password = token;
    return { url: urlObj.toString(), secret: token };
  }

  const orgUrl = process.env.ADO_ORG;
  const pat = process.env.ADO_PAT;
  if (!orgUrl || !pat) {
    throw new Error('ADO_ORG and ADO_PAT must be set for repo checkout');
  }

  const urlObj = new URL(`${orgUrl}/${project}/_git/${repo}`);
  urlObj.username = 'pat';
  urlObj.password = pat;
  return { url: urlObj.toString(), secret: pat };
}

export async function checkoutDefaultBranch(opts: {
  project: string;
  repo: string;
  branch: string;
  sessionId: string;
  provider?: SkillProvider;
}): Promise<string> {
  const { project, repo, branch, sessionId, provider = 'ado' } = opts;
  const workspaceDir = getWorkspaceDir(sessionId);

  if (provider === 'ado') await ensureGitSafeDirectory();

  const { url: cloneUrl, secret } = buildCloneUrl(provider, project, repo);

  fs.mkdirSync(workspaceDir, { recursive: true });

  try {
    await git(
      ['-c', 'core.longpaths=true', 'clone', '--filter=blob:none', '--branch', branch, cloneUrl, '.'],
      { cwd: workspaceDir, timeout: LONG_TIMEOUT_MS },
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(`git clone failed: ${redactSecrets(raw, secret)}`);
  }

  return workspaceDir;
}

/**
 * Creates a feature branch named feature/apex-<workItemId>-<slug>.
 */
export async function createFeatureBranch(
  workspaceDir: string,
  workItemId: number,
  workItemTitle: string,
): Promise<string> {
  const slug = slugify(workItemTitle);
  const branchName = `feature/apex-${workItemId}-${slug}`;
  await git(safeArgs(workspaceDir, ['checkout', '-b', branchName]), { cwd: workspaceDir });
  return branchName;
}

/**
 * Creates and checks out a feature branch with the given pre-computed name.
 */
export async function checkoutNewBranch(workspaceDir: string, branchName: string): Promise<void> {
  await git(safeArgs(workspaceDir, ['checkout', '-b', branchName]), { cwd: workspaceDir });
}

export async function computeDiff(workspaceDir: string): Promise<{ diffText: string; changedFiles: string[] }> {
  const release = await workspaceMutex.acquire(workspaceDir);
  try {
    await git(safeArgs(workspaceDir, ['add', '-A']), { cwd: workspaceDir });

    const diffText = await git(safeArgs(workspaceDir, ['diff', '--cached']), {
      cwd: workspaceDir,
      maxBuffer: 10 * 1024 * 1024,
    });

    const filesOutput = await git(safeArgs(workspaceDir, ['diff', '--cached', '--name-only']), {
      cwd: workspaceDir,
    });
    const changedFiles = filesOutput.split('\n').filter(Boolean);

    return { diffText, changedFiles };
  } finally {
    release();
  }
}

/**
 * Commits all staged+unstaged changes, pushes the feature branch to origin,
 * and returns the branch name. Only commits if there are changes.
 */
export async function pushBranch(workspaceDir: string, branchName: string): Promise<void> {
  const release = await workspaceMutex.acquire(workspaceDir);
  try {
    await git(safeArgs(workspaceDir, ['add', '-A']), { cwd: workspaceDir });

    const status = (await git(safeArgs(workspaceDir, ['status', '--porcelain']), {
      cwd: workspaceDir,
    })).trim();

    if (status) {
      await git(safeArgs(workspaceDir, ['commit', '-m', 'Dev workbench: agent changes']), {
        cwd: workspaceDir,
        env: {
          GIT_AUTHOR_NAME: 'AI Pilot',
          GIT_AUTHOR_EMAIL: 'ai-pilot@noreply',
          GIT_COMMITTER_NAME: 'AI Pilot',
          GIT_COMMITTER_EMAIL: 'ai-pilot@noreply',
        },
      });
    }

    await git(safeArgs(workspaceDir, ['push', '-u', 'origin', branchName]), {
      cwd: workspaceDir,
      timeout: LONG_TIMEOUT_MS,
    });
  } finally {
    release();
  }
}

export interface ConflictedFile {
  path: string;
  content: string;
}

export interface SyncResult {
  status: 'clean' | 'conflict';
  conflictedFiles: ConflictedFile[];
}

/**
 * Fetches the latest base branch and merges it into the current feature
 * branch. Returns 'clean' if the merge succeeded, 'conflict' + the
 * conflicted files if there were unresolvable conflicts.
 */
export async function syncWithBase(workspaceDir: string, baseBranch: string): Promise<SyncResult> {
  const release = await workspaceMutex.acquire(workspaceDir);
  try {
    await git(safeArgs(workspaceDir, ['add', '-A']), { cwd: workspaceDir });
    const pendingStatus = (await git(safeArgs(workspaceDir, ['status', '--porcelain']), {
      cwd: workspaceDir,
    })).trim();

    if (pendingStatus) {
      await git(safeArgs(workspaceDir, ['commit', '-m', 'Dev workbench: agent changes']), {
        cwd: workspaceDir,
        env: {
          GIT_AUTHOR_NAME: 'AI Pilot',
          GIT_AUTHOR_EMAIL: 'ai-pilot@noreply',
          GIT_COMMITTER_NAME: 'AI Pilot',
          GIT_COMMITTER_EMAIL: 'ai-pilot@noreply',
        },
      });
    }

    await git(safeArgs(workspaceDir, ['fetch', 'origin', baseBranch]), {
      cwd: workspaceDir,
      timeout: LONG_TIMEOUT_MS,
    });

    try {
      await git(safeArgs(workspaceDir, ['merge', '--no-ff', `origin/${baseBranch}`, '-m', `Merge latest ${baseBranch} into feature branch`]), {
        cwd: workspaceDir,
      });
      return { status: 'clean', conflictedFiles: [] };
    } catch {
      const conflictedFiles = await listConflicts(workspaceDir);
      return { status: 'conflict', conflictedFiles };
    }
  } finally {
    release();
  }
}

/**
 * Returns all files currently in a conflicted (unmerged) state, with their
 * raw content (including conflict markers).
 */
export async function listConflicts(workspaceDir: string): Promise<ConflictedFile[]> {
  const output = await git(safeArgs(workspaceDir, ['diff', '--name-only', '--diff-filter=U']), {
    cwd: workspaceDir,
  });
  const paths = output.split('\n').filter(Boolean);
  return paths.map((filePath) => {
    const fullPath = path.join(workspaceDir, filePath);
    const content = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : '';
    return { path: filePath, content };
  });
}

/**
 * Writes the developer's resolved content for a single file and stages it.
 */
export async function writeResolvedFile(workspaceDir: string, filePath: string, content: string): Promise<void> {
  const fullPath = path.join(workspaceDir, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  await git(safeArgs(workspaceDir, ['add', filePath]), { cwd: workspaceDir });
}

/**
 * Finalises the merge commit after all conflicts have been resolved and
 * staged. Throws if any files are still unmerged.
 */
export async function completeMerge(workspaceDir: string): Promise<void> {
  const output = await git(safeArgs(workspaceDir, ['diff', '--name-only', '--diff-filter=U']), {
    cwd: workspaceDir,
  });
  const remaining = output.split('\n').filter(Boolean);

  if (remaining.length > 0) {
    throw new Error(
      `Cannot complete merge: ${remaining.length} file(s) still have conflicts: ${remaining.join(', ')}`,
    );
  }

  await git(safeArgs(workspaceDir, ['commit', '--no-edit']), {
    cwd: workspaceDir,
    env: {
      GIT_AUTHOR_NAME: 'AI Pilot',
      GIT_AUTHOR_EMAIL: 'ai-pilot@noreply',
      GIT_COMMITTER_NAME: 'AI Pilot',
      GIT_COMMITTER_EMAIL: 'ai-pilot@noreply',
    },
  });
}

/**
 * Aborts a conflicted merge and restores the working tree to pre-merge state.
 */
export async function abortMerge(workspaceDir: string): Promise<void> {
  await git(safeArgs(workspaceDir, ['merge', '--abort']), { cwd: workspaceDir });
}

/**
 * Pushes an already-committed (and merged) feature branch to origin.
 * Unlike pushBranch this does NOT commit first — call after completeMerge.
 */
export async function pushMergedBranch(workspaceDir: string, branchName: string): Promise<void> {
  await git(safeArgs(workspaceDir, ['push', '-u', 'origin', branchName]), {
    cwd: workspaceDir,
    timeout: LONG_TIMEOUT_MS,
  });
}

export function cleanupWorkspace(sessionId: string): void {
  const workspaceDir = getWorkspaceDir(sessionId);
  if (fs.existsSync(workspaceDir)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}
