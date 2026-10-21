import { useQuery } from '@tanstack/react-query';
import type { FoundationSkillRelease, FoundationSkillRepoStatus } from '../../shared/types/foundationSkills';

export interface FoundationSkillReleaseRepoQuery {
  provider?: 'ado' | 'github' | string | null;
  project?: string | null;
  repo?: string | null;
  branch?: string | null;
}

/**
 * Fetches the latest published foundation skills release visible to the given
 * Apex project. Pass a repository to limit that result to releases offered to
 * that Project Settings repository. Pass `null`/`undefined` project to get the
 * global latest (admin use).
 */
export function useLatestFoundationSkillRelease(
  apexProject?: string | null,
  repo?: FoundationSkillReleaseRepoQuery | null,
) {
  const repoName = repo?.repo?.trim() || '';
  const repoProject = repo?.project?.trim() || apexProject || '';
  const provider = repo?.provider === 'github' ? 'github' : 'ado';
  const branch = repo?.branch?.trim() || 'main';
  return useQuery<FoundationSkillRelease | null>({
    queryKey: ['foundation-skill-release', 'latest', apexProject ?? null, provider, repoProject, repoName, branch],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (apexProject) params.set('project', apexProject);
      if (repoName) {
        params.set('repo', repoName);
        params.set('repoProject', repoProject);
        params.set('provider', provider);
        params.set('branch', branch);
      }
      const query = params.toString();
      const res = await fetch(
        `/api/skills/foundation-releases/latest${query ? `?${query}` : ''}`,
        { credentials: 'include' },
      );
      if (!res.ok) return null;
      const data = await res.json() as { release: FoundationSkillRelease | null };
      return data.release ?? null;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * Fetches the last-observed install status for a specific consumer repo.
 * Returns null when the repo has not yet been observed.
 */
export function useFoundationSkillRepoStatus(
  provider: 'ado' | 'github' | undefined,
  project: string | null | undefined,
  repo: string | null | undefined,
  branch = 'main',
) {
  return useQuery<FoundationSkillRepoStatus | null>({
    queryKey: ['foundation-skill-status', provider, project, repo, branch],
    queryFn: async () => {
      if (!project || !repo) return null;
      const params = new URLSearchParams({ project, repo, branch });
      if (provider) params.set('provider', provider);
      const res = await fetch(`/api/skills/foundation-status?${params.toString()}`, { credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.json() as { status: FoundationSkillRepoStatus | null };
      return data.status;
    },
    enabled: !!(project && repo),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
