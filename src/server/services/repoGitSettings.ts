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
