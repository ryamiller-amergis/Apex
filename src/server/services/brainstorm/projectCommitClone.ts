import { isFlagEnabledForWholeProject } from '../featureFlagService';
import { isRepoCacheDir, resolveGitRemote } from '../repoCacheService';
import { cloneCachedCommit, cloneTemporaryAtSha } from './gitSourceClone';

type CloneCachedInput = Parameters<typeof cloneCachedCommit>[0];

export interface ProjectCommitCloneDeps {
  isWholeV2Project: (project: string) => Promise<boolean>;
  isRepoCacheDir: (dir: string) => boolean;
  resolveRemoteUrl: (provider: 'github' | 'ado', project: string, repository: string) => string;
  cloneCached: (input: CloneCachedInput) => Promise<void>;
  cloneTemporary: typeof cloneTemporaryAtSha;
}

// App Service stops refreshing its own mirrors for whole-V2 projects, so
// neither their cached SHA nor their objects can be trusted for a new commit.
export async function isWholeV2Project(project: string): Promise<boolean> {
  return isFlagEnabledForWholeProject('ai-runs-v2-transport', project).catch(() => false);
}

const defaultDeps: ProjectCommitCloneDeps = {
  isWholeV2Project,
  isRepoCacheDir,
  resolveRemoteUrl: (provider, project, repository) =>
    resolveGitRemote(provider, project, repository).url,
  cloneCached: cloneCachedCommit,
  cloneTemporary: cloneTemporaryAtSha,
};

/**
 * Copies a project-repository commit for a Brainstorm source. For a whole-V2
 * project a commit without a published bundle is fetched from the remote into
 * local scratch and published, instead of cloned from this host's mirror.
 * Feature-owned clones (the Brainstorm catalog) keep the cached path.
 */
export async function cloneProjectCommit(
  input: CloneCachedInput,
  deps: ProjectCommitCloneDeps = defaultDeps,
): Promise<void> {
  const identity = input.identity;
  if (
    !identity
    || !deps.isRepoCacheDir(input.cacheDir)
    || !(await deps.isWholeV2Project(identity.project))
  ) {
    return deps.cloneCached(input);
  }
  const result = await deps.cloneTemporary({
    url: deps.resolveRemoteUrl(identity.provider, identity.project, identity.repository),
    sha: input.sha,
    destination: input.destination,
    signal: input.signal,
    identity,
  });
  if (result === 'moved') {
    throw new Error('The saved clone changed. Attach the repository again.');
  }
}
