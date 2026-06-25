import { useQuery } from '@tanstack/react-query';
import type { ProjectRepoConfigSummary } from '../../shared/types/projectSettings';

export function useProjectRepoConfigs(project: string | null | undefined) {
  return useQuery<ProjectRepoConfigSummary[]>({
    queryKey: ['skill-configs', project],
    queryFn: async () => {
      if (!project) return [];
      const res = await fetch(`/api/skill-configs?project=${encodeURIComponent(project)}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch repo configs');
      return res.json() as Promise<ProjectRepoConfigSummary[]>;
    },
    enabled: !!project,
    staleTime: 5 * 60 * 1000,
  });
}
