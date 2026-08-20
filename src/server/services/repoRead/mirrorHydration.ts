import type { RepositoryIdentity } from '../../../shared/types/repoReader';
import { RepoReaderError } from '../repoReader';
import {
  ensureRepoCache,
  fetchPinnedCommit,
  getRepoCacheDir,
  type RepoCacheOptions,
} from '../repoCacheService';
import { isUsableBareMirror } from './mirrorStore';

export const REPO_SYNCING_MESSAGE =
  'Repository is syncing the pinned commit. Retry this question in a minute.';

export interface MirrorHydrationDependencies {
  getRepoCacheDir: typeof getRepoCacheDir;
  isUsableBareMirror: typeof isUsableBareMirror;
  mirrorHasCommit: (mirrorPath: string, sha: string) => Promise<boolean>;
  resolveBranch: (identity: RepositoryIdentity) => Promise<string>;
  rehydrateBare: (
    identity: RepositoryIdentity,
    destination: string,
  ) => Promise<{ status: string }>;
  ensureRepoCache: typeof ensureRepoCache;
  kickBackgroundRefresh: (options: RepoCacheOptions, sha: string) => void;
}

const FALLBACK_BRANCH = process.env.REPO_READ_SERVICE_BRANCH?.trim() || 'main';

const backgroundRefreshes = new Map<string, Promise<void>>();

function cacheOptionsFor(
  identity: RepositoryIdentity,
  branch: string,
): RepoCacheOptions {
  return {
    provider: identity.provider,
    project: identity.project,
    repo: identity.repo,
    branch,
  };
}

function backgroundKey(options: RepoCacheOptions, sha: string): string {
  return [options.provider, options.project, options.repo, sha.toLowerCase()].join(
    '\0',
  );
}

async function runBackgroundRefresh(
  options: RepoCacheOptions,
  sha: string,
): Promise<void> {
  const repoLabel = `${options.provider}/${options.repo}@${options.branch}`;
  const shortSha = sha.slice(0, 12);
  console.log(
    `[repo-cache] phase=background-refresh-start repo=${repoLabel} sha=${shortSha}`,
  );
  try {
    const pinned = await fetchPinnedCommit(options, sha);
    if (pinned) {
      console.log(
        `[repo-cache] phase=background-refresh-complete repo=${repoLabel} sha=${shortSha} source=pin-fetch`,
      );
      return;
    }
    await ensureRepoCache(options);
    const cacheDir = getRepoCacheDir(options);
    const fetched = await fetchPinnedCommit(options, sha);
    console.log(
      `[repo-cache] phase=background-refresh-${fetched ? 'complete' : 'miss'} repo=${repoLabel} sha=${shortSha} source=incremental cacheDir=${cacheDir}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[repo-cache] phase=background-refresh-failed repo=${repoLabel} sha=${shortSha}: ${message
        .replace(/\/\/[^/@\s]+@/g, '//***@')
        .slice(0, 300)}`,
    );
  }
}

/**
 * One fetch per pin, not per chat. Survives the HTTP request that noticed
 * the miss — otherwise MaxView chat kills `git fetch` when the turn times out.
 */
export function kickBackgroundMirrorRefresh(
  options: RepoCacheOptions,
  sha: string,
  run: (
    options: RepoCacheOptions,
    sha: string,
  ) => Promise<void> = runBackgroundRefresh,
): void {
  const key = backgroundKey(options, sha);
  if (backgroundRefreshes.has(key)) return;
  const work = run(options, sha).finally(() => {
    backgroundRefreshes.delete(key);
  });
  backgroundRefreshes.set(key, work);
}

export function resetBackgroundMirrorRefreshesForTests(): void {
  backgroundRefreshes.clear();
}

function syncingError(): RepoReaderError {
  return new RepoReaderError('LOCAL_READ_UNAVAILABLE', REPO_SYNCING_MESSAGE, true);
}

export async function hydrateRepoReadMirror(
  identity: RepositoryIdentity,
  dependencies: MirrorHydrationDependencies,
): Promise<string> {
  const cacheDir = dependencies.getRepoCacheDir(
    cacheOptionsFor(identity, FALLBACK_BRANCH),
  );

  if (await dependencies.mirrorHasCommit(cacheDir, identity.sha)) {
    return cacheDir;
  }

  const options = cacheOptionsFor(
    identity,
    await dependencies.resolveBranch(identity),
  );

  // A warm mirror that is merely missing this pin must not be deleted. Bundle
  // restore empties the destination, and a chat-bound incremental fetch is
  // aborted when the turn times out — MaxView then loops on fetch-start forever.
  if (dependencies.isUsableBareMirror(cacheDir)) {
    dependencies.kickBackgroundRefresh(options, identity.sha);
    if (await dependencies.mirrorHasCommit(cacheDir, identity.sha)) {
      return cacheDir;
    }
    throw syncingError();
  }

  const restored = await dependencies.rehydrateBare(identity, cacheDir);
  if (restored.status === 'materialized') return cacheDir;

  const cloned = await dependencies.ensureRepoCache(options);
  if (await dependencies.mirrorHasCommit(cloned.cacheDir, identity.sha)) {
    return cloned.cacheDir;
  }
  dependencies.kickBackgroundRefresh(options, identity.sha);
  throw syncingError();
}
