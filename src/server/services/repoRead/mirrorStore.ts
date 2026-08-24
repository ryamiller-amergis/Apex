import fs from 'node:fs';
import path from 'node:path';
import {
  ensureRepoCache,
  fetchRepositoryTip,
  getRepoCacheDir,
  readCachedOriginSha,
  readRemoteBranchTip,
  type RepoCacheOptions,
} from '../repoCacheService';
import type { RunGrounding } from '../../../shared/types/runGrounding';

/**
 * True when `mirrorPath` is a git object database we can `cat-file` against.
 * A registered path string is not enough — the cache may not have been fetched
 * yet, and Stage 6 must fall back to the working-tree reader in that case.
 */
export function isUsableBareMirror(
  mirrorPath: string | undefined,
): mirrorPath is string {
  if (!mirrorPath) return false;
  try {
    return fs.existsSync(path.join(mirrorPath, 'HEAD'));
  } catch {
    return false;
  }
}

export function cacheOptionsFromGrounding(
  grounding: Pick<RunGrounding, 'provider' | 'project' | 'repository' | 'branch'>,
): RepoCacheOptions {
  return {
    provider: grounding.provider === 'azure_devops' ? 'ado' : 'github',
    project: grounding.project,
    repo: grounding.repository,
    branch: grounding.branch,
  };
}

export const mirrorStore = {
  ensureMirror: ensureRepoCache,
  fetch: fetchRepositoryTip,
  resolvePath: getRepoCacheDir,
  resolveTip: readCachedOriginSha,
  probeRemoteTip: readRemoteBranchTip,
  cacheOptionsFromGrounding,
};
