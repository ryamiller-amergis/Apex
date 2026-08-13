import {
  ensureRepoCache,
  fetchRepositoryTip,
  getRepoCacheDir,
  readCachedOriginSha,
  readRemoteBranchTip,
  type RepoCacheOptions,
} from '../repoCacheService';
import type { RunGrounding } from '../../../shared/types/runGrounding';

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
