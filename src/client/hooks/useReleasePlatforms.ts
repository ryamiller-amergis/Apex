import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProjectReleasePlatformsState,
  ReleasePlatform,
  ReleasePlatformColor,
} from '../../shared/types/releasePlatforms';

const EMPTY_PLATFORM_STATE = (project: string): ProjectReleasePlatformsState => ({
  project,
  platforms: [],
  epicPlatformIds: {},
  workItemPlatformIds: {},
});

export const releasePlatformsQueryKey = (project: string) =>
  ['releasePlatforms', project] as const;

export function useReleasePlatforms(project: string) {
  const queryClient = useQueryClient();
  const normalizedProject = project.trim();

  const query = useQuery<ProjectReleasePlatformsState>({
    queryKey: releasePlatformsQueryKey(normalizedProject),
    enabled: Boolean(normalizedProject) && normalizedProject.toLowerCase() !== 'apex',
    queryFn: async () => {
      const response = await fetch(
        `/api/releases/platforms?project=${encodeURIComponent(normalizedProject)}`,
      );
      if (!response.ok) {
        return EMPTY_PLATFORM_STATE(normalizedProject);
      }
      const data = await response.json();
      if (
        !data ||
        typeof data !== 'object' ||
        !Array.isArray((data as ProjectReleasePlatformsState).platforms)
      ) {
        return EMPTY_PLATFORM_STATE(normalizedProject);
      }
      return {
        project: normalizedProject,
        platforms: (data as ProjectReleasePlatformsState).platforms ?? [],
        epicPlatformIds: (data as ProjectReleasePlatformsState).epicPlatformIds ?? {},
        workItemPlatformIds:
          (data as ProjectReleasePlatformsState).workItemPlatformIds ?? {},
      };
    },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: releasePlatformsQueryKey(normalizedProject),
    });

  const createPlatform = useMutation<
    ReleasePlatform,
    Error,
    { name: string; color?: ReleasePlatformColor }
  >({
    mutationFn: async ({ name, color }) => {
      const response = await fetch('/api/releases/platforms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: normalizedProject, name, color }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error ?? 'Failed to create platform');
      }
      return body as ReleasePlatform;
    },
    onSuccess: (created) => {
      queryClient.setQueryData<ProjectReleasePlatformsState>(
        releasePlatformsQueryKey(normalizedProject),
        (prev) => {
          const base = prev ?? EMPTY_PLATFORM_STATE(normalizedProject);
          if (base.platforms.some((p) => p.id === created.id)) return base;
          return {
            ...base,
            platforms: [...base.platforms, created],
          };
        },
      );
      void invalidate();
    },
  });

  const reorderPlatforms = useMutation<ReleasePlatform[], Error, string[]>({
    mutationFn: async (platformIds) => {
      const response = await fetch('/api/releases/platforms/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: normalizedProject, platformIds }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error ?? 'Failed to reorder platforms');
      }
      return (body?.platforms ?? []) as ReleasePlatform[];
    },
    onSuccess: (platforms) => {
      queryClient.setQueryData<ProjectReleasePlatformsState>(
        releasePlatformsQueryKey(normalizedProject),
        (prev) => ({
          ...(prev ?? EMPTY_PLATFORM_STATE(normalizedProject)),
          platforms,
        }),
      );
      void invalidate();
    },
  });

  const deletePlatform = useMutation<string, Error, string>({
    mutationFn: async (platformId) => {
      const response = await fetch(
        `/api/releases/platforms/${encodeURIComponent(platformId)}?project=${encodeURIComponent(normalizedProject)}`,
        { method: 'DELETE' },
      );
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error ?? 'Failed to delete platform');
      }
      return platformId;
    },
    onSuccess: (deletedId) => {
      queryClient.setQueryData<ProjectReleasePlatformsState>(
        releasePlatformsQueryKey(normalizedProject),
        (prev) => {
          if (!prev) return EMPTY_PLATFORM_STATE(normalizedProject);
          const nextEpicIds: Record<number, string[]> = {};
          for (const [k, ids] of Object.entries(prev.epicPlatformIds)) {
            nextEpicIds[Number(k)] = ids.filter((id) => id !== deletedId);
          }
          const nextItemIds: Record<number, string[]> = {};
          for (const [k, ids] of Object.entries(prev.workItemPlatformIds)) {
            nextItemIds[Number(k)] = ids.filter((id) => id !== deletedId);
          }
          return {
            ...prev,
            platforms: prev.platforms.filter((p) => p.id !== deletedId),
            epicPlatformIds: nextEpicIds,
            workItemPlatformIds: nextItemIds,
          };
        },
      );
      void invalidate();
    },
  });

  const updateEpicPlatforms = useMutation<
    { epicId: number; platformIds: string[] },
    Error,
    { epicId: number; platformIds: string[] }
  >({
    mutationFn: async ({ epicId, platformIds }) => {
      const response = await fetch(`/api/releases/${epicId}/platforms`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: normalizedProject, platformIds }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error ?? 'Failed to update release platforms');
      }
      return { epicId, platformIds: body?.platformIds ?? platformIds };
    },
    onSuccess: ({ epicId, platformIds }) => {
      queryClient.setQueryData<ProjectReleasePlatformsState>(
        releasePlatformsQueryKey(normalizedProject),
        (prev) => {
          const base = prev ?? EMPTY_PLATFORM_STATE(normalizedProject);
          return {
            ...base,
            epicPlatformIds: {
              ...base.epicPlatformIds,
              [epicId]: platformIds,
            },
          };
        },
      );
      void invalidate();
    },
  });

  const updateWorkItemPlatforms = useMutation<
    { workItemId: number; platformIds: string[] },
    Error,
    { workItemId: number; platformIds: string[] }
  >({
    mutationFn: async ({ workItemId, platformIds }) => {
      const response = await fetch(`/api/releases/work-items/${workItemId}/platforms`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: normalizedProject, platformIds }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error ?? 'Failed to update work item platforms');
      }
      return { workItemId, platformIds: body?.platformIds ?? platformIds };
    },
    onSuccess: ({ workItemId, platformIds }) => {
      queryClient.setQueryData<ProjectReleasePlatformsState>(
        releasePlatformsQueryKey(normalizedProject),
        (prev) => {
          const base = prev ?? EMPTY_PLATFORM_STATE(normalizedProject);
          return {
            ...base,
            workItemPlatformIds: {
              ...base.workItemPlatformIds,
              [workItemId]: platformIds,
            },
          };
        },
      );
      void invalidate();
    },
  });

  const data = query.data ?? EMPTY_PLATFORM_STATE(normalizedProject);

  return {
    platforms: data.platforms,
    epicPlatformIds: data.epicPlatformIds,
    workItemPlatformIds: data.workItemPlatformIds,
    isLoadingPlatforms: query.isLoading,
    createPlatform,
    reorderPlatforms,
    deletePlatform,
    updateEpicPlatforms,
    updateWorkItemPlatforms,
  };
}
