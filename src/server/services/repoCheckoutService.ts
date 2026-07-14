import fs from 'fs';
import path from 'path';
import type { SkillProvider } from '../../shared/types/projectSettings';
import { resolveDataRoot } from '../utils/dataDir';
import { git, safeArgs, LONG_TIMEOUT_MS, type GitOptions } from '../utils/asyncGit';
import { workspaceMutex } from '../utils/asyncMutex';
import {
  ensureRepoCache,
  repairRepoCache,
  resolveGitRemote,
  type GitRemote,
} from './repoCacheService';
import {
  COLD_CACHE_IDLE_TIMEOUT_MS,
  COLD_CACHE_TIMEOUT_MS,
} from './repoGitSettings';
import { materializeWorkspaceFromCache } from './repoWorkspaceService';

export { materializeWorkspaceFromCache } from './repoWorkspaceService';

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

function withRemoteEnv(remote: GitRemote | undefined, env?: Record<string, string>): Record<string, string> | undefined {
  if (!remote && !env) return undefined;
  return { ...(remote?.env ?? {}), ...(env ?? {}) };
}

async function runRemoteGit(
  workspaceDir: string,
  args: string[],
  remote?: GitRemote,
  options: Omit<GitOptions, 'cwd' | 'env'> & { env?: Record<string, string> } = {},
): Promise<string> {
  try {
    return await git(safeArgs(workspaceDir, args), {
      ...options,
      cwd: workspaceDir,
      env: withRemoteEnv(remote, options.env),
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(redactSecrets(raw, remote?.secret));
  }
}

function isCacheObjectError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return [
    'missing blob',
    'missing tree',
    'bad object',
    'invalid object',
    'unable to read object',
    'unable to read sha1 file',
    'could not read',
    'failed to traverse parents',
    'did not send all necessary objects',
    'reference is not a tree',
    'object file is empty',
    'object missing',
    'object corrupt',
    'error in object',
    'pack has bad object',
    'inflate returned',
  ].some((fragment) => message.includes(fragment));
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

  await ensureGitSafeDirectory();
  const remote = resolveGitRemote(provider, project, repo);
  fs.mkdirSync(CHECKOUT_BASE, { recursive: true });
  fs.rmSync(workspaceDir, { recursive: true, force: true });

  try {
    if (process.env.DEV_WORKBENCH_GIT_CACHE_ENABLED === 'false') {
      await git([
        '-c',
        'core.longpaths=true',
        'clone',
        '--single-branch',
        '--branch',
        branch,
        '--progress',
        remote.url,
        workspaceDir,
      ], {
        cwd: CHECKOUT_BASE,
        timeout: COLD_CACHE_TIMEOUT_MS,
        idleTimeout: COLD_CACHE_IDLE_TIMEOUT_MS,
        env: remote.env,
      });
    } else {
      const cache = await ensureRepoCache({ project, repo, branch, provider });
      try {
        await materializeWorkspaceFromCache(
          cache.cacheDir,
          workspaceDir,
          branch,
          cache.remote.url,
        );
      } catch (materializeError) {
        if (!isCacheObjectError(materializeError)) throw materializeError;
        console.warn(
          `[repoCheckoutService] workspace materialization detected missing cache objects; ` +
          `repairing ${provider}/${repo}@${branch}`,
        );
        const repaired = await repairRepoCache({ project, repo, branch, provider });
        await materializeWorkspaceFromCache(
          repaired.cacheDir,
          workspaceDir,
          branch,
          repaired.remote.url,
        );
      }
    }
  } catch (err) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(`git clone failed: ${redactSecrets(raw, remote.secret)}`);
  }

  // The cloned repo's .gitignore does not cover `.ai-pilot`, so the design-context
  // files APEX injects into the workspace would otherwise be picked up by every
  // `git add -A` (diff panel, auto-push, base-merge commit) and end up in the PR.
  // Adding the path to the local `.git/info/exclude` suppresses git tracking of it
  // everywhere at once while leaving the files on disk for the agent to read.
  excludeAiPilotFromGit(workspaceDir);

  return workspaceDir;
}

/**
 * Adds `.ai-pilot/` to the workspace's local `.git/info/exclude` so the injected
 * design-context files are never staged, diffed, committed, or pushed — without
 * touching the committed `.gitignore`. Idempotent and non-fatal: the files stay
 * on disk (readable by the agent); only their git tracking is suppressed.
 */
export function excludeAiPilotFromGit(workspaceDir: string): void {
  const entry = '.ai-pilot/';
  const excludePath = path.join(workspaceDir, '.git', 'info', 'exclude');
  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });

    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf-8') : '';
    const alreadyExcluded = existing
      .split(/\r?\n/)
      .some((line) => line.trim() === entry);
    if (alreadyExcluded) return;

    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(
      excludePath,
      `${prefix}# APEX-injected design context — excluded from diffs and commits\n${entry}\n`,
      'utf-8',
    );
  } catch (err) {
    console.warn(
      '[repoCheckoutService] failed to write .ai-pilot exclude (non-fatal):',
      (err as Error).message,
    );
  }
}

/**
 * Creates a feature branch named feature/apex-<workItemId>-<slug>.
 */
export async function createFeatureBranch(
  workspaceDir: string,
  workItemId: number,
  workItemTitle: string,
  baseBranch: string,
  remote?: GitRemote,
): Promise<string> {
  const slug = slugify(workItemTitle);
  const branchName = `feature/apex-${workItemId}-${slug}`;
  await checkoutFeatureBranch(workspaceDir, branchName, baseBranch, remote);
  return branchName;
}

/**
 * Creates and checks out a feature branch with the given pre-computed name.
 */
export async function checkoutNewBranch(workspaceDir: string, branchName: string): Promise<void> {
  await git(safeArgs(workspaceDir, ['checkout', '-b', branchName]), { cwd: workspaceDir });
}

/**
 * Establishes the feature branch in the workspace, reconciling with an existing
 * remote branch of the same name so that reruns for the same work item CONTINUE
 * the same branch (and its pull request) instead of colliding on push with a
 * non-fast-forward rejection.
 *
 * - If `origin/<branchName>` already exists: create the local branch FROM the
 *   remote tip (preserving all prior committed work), then merge the base branch
 *   in so the agent starts from an up-to-date branch — done here, before any
 *   agent work begins.
 * - Otherwise: create a fresh local branch off the just-cloned base branch
 *   (original behaviour for first-time runs).
 *
 * A base-branch merge conflict during reuse is non-fatal: the merge is aborted
 * and the branch is left at the remote tip. The push-time `syncWithBase` step
 * re-attempts the base merge and surfaces any conflicts to the in-app resolver.
 */
export async function checkoutFeatureBranch(
  workspaceDir: string,
  branchName: string,
  baseBranch: string,
  remote?: GitRemote,
): Promise<void> {
  const release = await workspaceMutex.acquire(workspaceDir);
  try {
    const remoteRefs = (
      await runRemoteGit(workspaceDir, ['ls-remote', '--heads', 'origin', branchName], remote, {
        timeout: LONG_TIMEOUT_MS,
      })
    ).trim();

    if (!remoteRefs) {
      // First run for this work item — fresh branch off the cloned base branch.
      await git(safeArgs(workspaceDir, ['checkout', '-b', branchName]), { cwd: workspaceDir });
      return;
    }

    // Rerun — the branch already exists on the remote. Continue it by branching
    // from the remote tip so the push is a fast-forward and the prior work
    // (design docs, earlier commits) is preserved.
    await runRemoteGit(workspaceDir, [
      'fetch',
      'origin',
      `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
    ], remote, {
      timeout: LONG_TIMEOUT_MS,
    });
    await git(safeArgs(workspaceDir, ['checkout', '-b', branchName, `origin/${branchName}`]), {
      cwd: workspaceDir,
    });

    // Bring the base branch up to date before the agent starts working.
    try {
      await runRemoteGit(workspaceDir, [
        'fetch',
        'origin',
        `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
      ], remote, {
        timeout: LONG_TIMEOUT_MS,
      });
      await git(
        safeArgs(workspaceDir, [
          'merge',
          '--no-ff',
          `origin/${baseBranch}`,
          '-m',
          `Merge latest ${baseBranch} into feature branch`,
        ]),
        {
          cwd: workspaceDir,
          env: {
            GIT_AUTHOR_NAME: 'AI Pilot',
            GIT_AUTHOR_EMAIL: 'ai-pilot@noreply',
            GIT_COMMITTER_NAME: 'AI Pilot',
            GIT_COMMITTER_EMAIL: 'ai-pilot@noreply',
          },
        },
      );
    } catch (mergeErr) {
      try {
        await git(safeArgs(workspaceDir, ['merge', '--abort']), { cwd: workspaceDir });
      } catch {
        // Nothing to abort.
      }
      console.warn(
        '[repoCheckoutService] base merge during feature-branch reuse hit conflicts; deferring to push-time resolver:',
        (mergeErr as Error).message,
      );
    }
  } finally {
    release();
  }
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
export async function pushBranch(
  workspaceDir: string,
  branchName: string,
  remote?: GitRemote,
): Promise<void> {
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

    await runRemoteGit(workspaceDir, ['push', '-u', 'origin', branchName], remote, {
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
export async function syncWithBase(
  workspaceDir: string,
  baseBranch: string,
  remote?: GitRemote,
): Promise<SyncResult> {
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

    await runRemoteGit(workspaceDir, [
      'fetch',
      'origin',
      `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
    ], remote, {
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
export async function pushMergedBranch(
  workspaceDir: string,
  branchName: string,
  remote?: GitRemote,
): Promise<void> {
  await runRemoteGit(workspaceDir, ['push', '-u', 'origin', branchName], remote, {
    timeout: LONG_TIMEOUT_MS,
  });
}

export function cleanupWorkspace(sessionId: string): void {
  const workspaceDir = getWorkspaceDir(sessionId);
  if (fs.existsSync(workspaceDir)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}
