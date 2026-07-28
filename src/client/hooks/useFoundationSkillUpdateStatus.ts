import { useQuery } from '@tanstack/react-query';
import type { FoundationSkillRelease, FoundationSkillRepoStatus } from '../../shared/types/foundationSkills';

/**
 * Fetches the latest published foundation skills release.
 * Used by team-facing update notices — authenticated read, no admin guard.
 */
export function useLatestFoundationSkillRelease() {
  return useQuery<FoundationSkillRelease | null>({
    queryKey: ['foundation-skill-release', 'latest'],
    queryFn: async () => {
      const res = await fetch('/api/skills/foundation-releases/latest', { credentials: 'include' });
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
