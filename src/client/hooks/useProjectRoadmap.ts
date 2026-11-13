import { useMemo } from 'react';
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  CreateRoadmapAdhocIdeaInput,
  MutateRoadmapAdhocIdeaResponse,
  PromoteRoadmapAdhocIdeaInput,
  PromoteRoadmapAdhocIdeaResponse,
  RoadmapProjectSettingsDto,
  RoadmapWorkspaceResponse,
  UpdateRoadmapAdhocIdeaInput,
  UpdateRoadmapSettingsInput,
  UpsertRoadmapOverlayInput,
  UpsertRoadmapOverlayResponse,
} from '../../shared/types/roadmap';
import type { WorkItem } from '../types/workitem';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Request failed: ${res.status}`,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function roadmapQueryKey(project: string | null | undefined) {
  return ['project-roadmap', project ?? ''] as const;
}

export function useProjectRoadmap(project: string | null | undefined) {
  return useQuery<RoadmapWorkspaceResponse>({
    queryKey: roadmapQueryKey(project),
    queryFn: () =>
      apiFetch<RoadmapWorkspaceResponse>(
        `/api/projects/${encodeURIComponent(project!)}/roadmap`,
      ),
    enabled: Boolean(project),
    staleTime: 15_000,
  });
}

export function useUpdateRoadmapSettings(project: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<
    RoadmapProjectSettingsDto,
    Error,
    UpdateRoadmapSettingsInput
  >({
    mutationFn: (body) =>
      apiFetch<RoadmapProjectSettingsDto>(
        `/api/projects/${encodeURIComponent(project!)}/roadmap/settings`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: roadmapQueryKey(project),
      });
    },
  });
}

export function useUpsertRoadmapOverlay(project: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<
    UpsertRoadmapOverlayResponse,
    Error,
    { workItemId: number } & UpsertRoadmapOverlayInput
  >({
    mutationFn: ({ workItemId, ...body }) =>
      apiFetch<UpsertRoadmapOverlayResponse>(
        `/api/projects/${encodeURIComponent(project!)}/roadmap/overlays/${workItemId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: roadmapQueryKey(project),
      });
    },
  });
}

export function useCreateRoadmapIdea(project: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<
    MutateRoadmapAdhocIdeaResponse,
    Error,
    CreateRoadmapAdhocIdeaInput
  >({
    mutationFn: (body) =>
      apiFetch<MutateRoadmapAdhocIdeaResponse>(
        `/api/projects/${encodeURIComponent(project!)}/roadmap/ideas`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: roadmapQueryKey(project),
      });
    },
  });
}

export function useUpdateRoadmapIdea(project: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<
    MutateRoadmapAdhocIdeaResponse,
    Error,
    { ideaId: string } & UpdateRoadmapAdhocIdeaInput
  >({
    mutationFn: ({ ideaId, ...body }) =>
      apiFetch<MutateRoadmapAdhocIdeaResponse>(
        `/api/projects/${encodeURIComponent(project!)}/roadmap/ideas/${encodeURIComponent(ideaId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: roadmapQueryKey(project),
      });
    },
  });
}

export function useDeleteRoadmapIdea(project: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (ideaId) =>
      apiFetch<void>(
        `/api/projects/${encodeURIComponent(project!)}/roadmap/ideas/${encodeURIComponent(ideaId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: roadmapQueryKey(project),
      });
    },
  });
}

export function usePromoteRoadmapIdea(project: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<
    PromoteRoadmapAdhocIdeaResponse,
    Error,
    { ideaId: string } & PromoteRoadmapAdhocIdeaInput
  >({
    mutationFn: ({ ideaId, ...body }) =>
      apiFetch<PromoteRoadmapAdhocIdeaResponse>(
        `/api/projects/${encodeURIComponent(project!)}/roadmap/ideas/${encodeURIComponent(ideaId)}/promote`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: roadmapQueryKey(project),
      });
      void queryClient.invalidateQueries({ queryKey: ['feature-requests'] });
      void queryClient.invalidateQueries({ queryKey: ['workItems'] });
    },
  });
}

export function useEpicChildrenMap(
  project: string | null | undefined,
  areaPath: string,
  epicIds: number[],
  enabled: boolean,
): { childrenByEpicId: ReadonlyMap<number, WorkItem[]>; isLoadingAny: boolean } {
  const queries = useQueries({
    queries: epicIds.map((epicId) => ({
      queryKey: ['roadmap-epic-children', project ?? '', areaPath, epicId],
      queryFn: async (): Promise<WorkItem[]> => {
        const res = await fetch(
          `/api/epics/${epicId}/children?project=${encodeURIComponent(project!)}&areaPath=${encodeURIComponent(areaPath)}`,
          { credentials: 'include' },
        );
        if (!res.ok) return [];
        const data = (await res.json()) as unknown;
        return Array.isArray(data) ? (data as WorkItem[]) : [];
      },
      enabled: enabled && Boolean(project),
      staleTime: 60_000,
    })),
  });

  const childrenByEpicId = useMemo(() => {
    const map = new Map<number, WorkItem[]>();
    epicIds.forEach((epicId, idx) => {
      const rows = queries[idx]?.data;
      if (rows) {
        map.set(epicId, rows);
      }
    });
    return map;
  }, [epicIds, queries]);

  const isLoadingAny = queries.some((q) => q.isLoading);

  return { childrenByEpicId, isLoadingAny };
}
