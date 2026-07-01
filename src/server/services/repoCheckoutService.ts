import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { resolveDataRoot } from '../utils/dataDir';

const CHECKOUT_BASE = path.join(resolveDataRoot(), 'dev-workspaces');

export function getWorkspaceDir(sessionId: string): string {
  return path.join(CHECKOUT_BASE, sessionId);
}

/**
 * Produces a URL-safe kebab-case slug from a title, max 40 chars.
 * Non-alphanumeric characters become hyphens; leading/trailing/consecutive
 * hyphens are collapsed.
 */
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

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
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

  // Blobless partial clone: fetches all commits/trees (so pre-push
  // base-branch merges still work) but defers historical file blobs,
  // fetching them on demand. Dramatically smaller/faster than a full
  // clone on large monorepos, which matters on constrained hosts.
  try {
    execSync(
      `git clone -c core.longpaths=true --filter=blob:none --branch "${branch}" "${urlObj.toString()}" .`,
      { cwd: workspaceDir, stdio: 'pipe', timeout: 600000 },
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(`git clone failed: ${redactSecrets(raw, pat)}`);
  }

  return workspaceDir;
}

/**
 * Creates a feature branch named feature/apex-<workItemId>-<slug>.
 * The slug is derived from the work item title (max 40 chars, kebab-case).
 */
export function createFeatureBranch(
  workspaceDir: string,
  workItemId: number,
  workItemTitle: string,
): string {
  const slug = slugify(workItemTitle);
  const branchName = `feature/apex-${workItemId}-${slug}`;
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

/**
 * Commits all staged+unstaged changes, pushes the feature branch to origin,
 * and returns the branch name. Only commits if there are changes.
 */
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
 * branch (non-fast-forward merge commit). Returns 'clean' if the merge
 * succeeded (or was already up to date), 'conflict' + the conflicted
 * files if there were unresolvable conflicts. When conflicts occur the
 * working tree is LEFT in the conflicted state — do NOT call git merge
 * --abort — so the caller can present a resolver UI.
 */
export function syncWithBase(workspaceDir: string, baseBranch: string): SyncResult {
  // Commit any outstanding agent edits before merging.
  execSync('git add -A', { cwd: workspaceDir, stdio: 'pipe' });
  const pendingStatus = execSync('git status --porcelain', {
    cwd: workspaceDir,
    encoding: 'utf-8',
  }).trim();
  if (pendingStatus) {
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

  // Fetch the latest base branch tip.
  execSync(`git fetch origin "${baseBranch}"`, {
    cwd: workspaceDir,
    stdio: 'pipe',
    timeout: 60000,
  });

  // Attempt merge.
  try {
    execSync(`git merge --no-ff "origin/${baseBranch}" -m "Merge latest ${baseBranch} into feature branch"`, {
      cwd: workspaceDir,
      stdio: 'pipe',
    });
    return { status: 'clean', conflictedFiles: [] };
  } catch {
    // Merge failed — collect conflicted files and leave the tree conflicted.
    const conflictedFiles = listConflicts(workspaceDir);
    return { status: 'conflict', conflictedFiles };
  }
}

/**
 * Returns all files currently in a conflicted (unmerged) state, with their
 * raw content (including conflict markers).
 */
export function listConflicts(workspaceDir: string): ConflictedFile[] {
  const output = execSync('git diff --name-only --diff-filter=U', {
    cwd: workspaceDir,
    encoding: 'utf-8',
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
export function writeResolvedFile(workspaceDir: string, filePath: string, content: string): void {
  const fullPath = path.join(workspaceDir, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  execSync(`git add "${filePath}"`, { cwd: workspaceDir, stdio: 'pipe' });
}

/**
 * Finalises the merge commit after all conflicts have been resolved and
 * staged. Throws if any files are still unmerged.
 */
export function completeMerge(workspaceDir: string): void {
  const remaining = execSync('git diff --name-only --diff-filter=U', {
    cwd: workspaceDir,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter(Boolean);

  if (remaining.length > 0) {
    throw new Error(
      `Cannot complete merge: ${remaining.length} file(s) still have conflicts: ${remaining.join(', ')}`,
    );
  }

  execSync('git commit --no-edit', {
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

/**
 * Aborts a conflicted merge and restores the working tree to pre-merge state.
 */
export function abortMerge(workspaceDir: string): void {
  execSync('git merge --abort', { cwd: workspaceDir, stdio: 'pipe' });
}

/**
 * Pushes an already-committed (and merged) feature branch to origin.
 * Unlike pushBranch this does NOT commit first — call after completeMerge.
 */
export function pushMergedBranch(workspaceDir: string, branchName: string): void {
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
