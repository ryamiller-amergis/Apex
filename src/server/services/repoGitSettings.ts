import { git } from '../utils/asyncGit';

export const COLD_CACHE_TIMEOUT_MS = 30 * 60 * 1000;
export const COLD_CACHE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const CACHE_FETCH_TIMEOUT_MS = 5 * 60 * 1000;
export const CACHE_FETCH_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Timeout for local working-tree git operations (diff, status, add, commit,
 * merge) run against a cloned workspace. The default 30s in asyncGit is too
 * short for a large repo (e.g. MaxView) on Azure Files, where a full-tree
 * `git diff`/`commit` can take minutes — a 30s cap surfaced as
 * `git -c timed out after 30000ms` and blocked the diff panel and push.
 */
export const WORKTREE_GIT_TIMEOUT_MS = 5 * 60 * 1000;

let safeDirectoryConfigured = false;

/**
 * Trusts all repo directories at the global/system git config level so that the
 * dubious-ownership guard is cleared for git subprocesses that do NOT inherit
 * command-line `-c safe.directory` overrides.
 *
 * A per-command `-c safe.directory=<dir>` (see `safeArgs`) is enough for git
 * operations that run in-place inside a repo (e.g. cache `fetch`), which is why
 * the bare mirror updates fine on Azure Files. But `git clone --no-local` spins
 * up a separate `upload-pack` transport process to read the source mirror, and
 * that child process performs its own ownership check without the outer
 * command-line override — surfacing as `fatal: detected dubious ownership` /
 * `Could not read from remote repository` and aborting workspace
 * materialization. Writing `safe.directory=*` into the on-disk global/system
 * config is honored by every git subprocess, including that transport helper.
 *
 * Only needed on Azure App Service (persistent `/home` share owned by a
 * different uid than the app process); a no-op locally.
 */
export async function ensureGitSafeDirectory(): Promise<void> {
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
