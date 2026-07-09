import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  MenuItemKey,
  ProjectMenuConfig,
  UpsertProjectMenuConfigRequest,
} from '../../shared/types/menuSettings';

interface MenuConfigResponse {
  enabledViews: MenuItemKey[];
}

export function useProjectMenuConfig(project: string | null) {
  const query = useQuery<MenuConfigResponse>({
    queryKey: ['menu-config', project],
    queryFn: async () => {
      const res = await fetch(
        `/api/menu-config?project=${encodeURIComponent(project!)}`,
        { credentials: 'include' },
      );
      if (!res.ok) throw new Error('Failed to fetch menu config');
      return res.json() as Promise<MenuConfigResponse>;
    },
    enabled: !!project,
    staleTime: 5 * 60 * 1000,
  });

  return {
    enabledViews: query.data?.enabledViews ?? [],
    isLoading: query.isLoading || query.isFetching,
  };
}

export function useAllProjectMenuConfigs() {
  return useQuery<ProjectMenuConfig[]>({
    queryKey: ['admin', 'project-menu-settings'],
    queryFn: async () => {
      const res = await fetch('/api/admin/project-menu-settings', {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch menu settings');
      return res.json() as Promise<ProjectMenuConfig[]>;
    },
    staleTime: 60 * 1000,
  });
}

export function useUpsertProjectMenuConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      project,
      body,
    }: {
      project: string;
      body: UpsertProjectMenuConfigRequest;
    }) => {
      const res = await fetch(
        `/api/admin/project-menu-settings/${encodeURIComponent(project)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw new Error('Failed to save menu settings');
      return res.json() as Promise<ProjectMenuConfig>;
    },
    onSuccess: (_data, { project }) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'project-menu-settings'] });
      queryClient.invalidateQueries({ queryKey: ['menu-config', project] });
    },
  });
}
