import { useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApexRelease, ApexWorkItem } from '../../shared/types/apexWorkItem';
import { WorkItem } from '../types/workitem';
import { workItemService } from '../services/workItemService';
import { toLegacyWorkItem } from '../utils/boardWorkItemAdapter';
import { env } from '../config/env';

const POLL_INTERVAL = env.VITE_POLL_INTERVAL * 1000;

async function fetchBoardWorkItems(project: string): Promise<WorkItem[]> {
  const enc = encodeURIComponent(project);
  const [itemsRes, releasesRes] = await Promise.all([
    fetch(`/api/apex-work-items?project=${enc}`, { credentials: 'include' }),
    fetch(`/api/apex-work-items/releases?project=${enc}`, { credentials: 'include' }),
  ]);
  if (!itemsRes.ok) {
    throw new Error(`Failed to fetch board work items: ${itemsRes.status}`);
  }
  const items = (await itemsRes.json()) as ApexWorkItem[];
  const releases: ApexRelease[] = releasesRes.ok
    ? ((await releasesRes.json()) as ApexRelease[])
    : [];
  const releaseMap = new Map(releases.map((r) => [r.id, r]));

  return items.map((item) => {
    const release =
      item.release ?? (item.releaseId ? releaseMap.get(item.releaseId) ?? null : null);
    return toLegacyWorkItem({ ...item, release });
  });
}

export function useWorkItems(
  startDate: Date,
  endDate: Date,
  project: string,
  areaPath: string,
  enabled: boolean = true,
  useBoardSource: boolean = false
) {
  const queryClient = useQueryClient();

  const normalizedAreaPath = areaPath.replace(/\//g, '\\');
  const from = startDate.toISOString().split('T')[0];
  const to = endDate.toISOString().split('T')[0];
  // Apex has no ADO backlog; server short-circuits to [] — skip the round-trip when on ADO path.
  const queryEnabled =
    enabled && (useBoardSource || project.toLowerCase() !== 'apex');
  const queryKey = useMemo(
    () =>
      useBoardSource
        ? (['workItems', 'board', project] as const)
        : (['workItems', 'ado', project, normalizedAreaPath, from, to] as const),
    [useBoardSource, project, normalizedAreaPath, from, to]
  );

  const { data: workItems = [], isLoading, error, isFetching } = useQuery({
    queryKey,
    queryFn: () =>
      useBoardSource
        ? fetchBoardWorkItems(project)
        : workItemService.getWorkItems(from, to, project, normalizedAreaPath),
    refetchInterval: POLL_INTERVAL,
    enabled: queryEnabled,
    staleTime: 10_000,
    // Transient proxy/API blips (e.g. nodemon restart) should retry quietly.
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
  });

  const mutation = useMutation({
    mutationFn: async ({
      id,
      dueDate,
      reason,
    }: {
      id: number;
      dueDate: string | null;
      reason?: string;
    }) => {
      if (useBoardSource) {
        const cached = queryClient.getQueryData<WorkItem[]>(queryKey) ?? [];
        const match = cached.find((item) => item.id === id);
        const apexId = match?.apexWorkItemId;
        if (!apexId) {
          throw new Error(`Board work item not found for item number ${id}`);
        }
        const res = await fetch(
          `/api/apex-work-items/${encodeURIComponent(apexId)}?project=${encodeURIComponent(project)}`,
          {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dueDate }),
          }
        );
        if (!res.ok) {
          throw new Error(`Failed to update board due date: ${res.status}`);
        }
        return;
      }
      return workItemService.updateDueDate(id, dueDate, reason, project, areaPath);
    },
    onMutate: async ({ id, dueDate }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<WorkItem[]>(queryKey);
      queryClient.setQueryData<WorkItem[]>(queryKey, (old = []) =>
        old.map((item) =>
          item.id === id ? { ...item, dueDate: dueDate || undefined } : item
        )
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSettled: () => {
      // Delay invalidation to let ADO process the change before refetching
      const delay = useBoardSource ? 500 : 5000;
      window.setTimeout(() => {
        queryClient.invalidateQueries({ queryKey });
      }, delay);
    },
  });

  const updateDueDate = useCallback(
    (id: number, dueDate: string | null, reason?: string) => {
      return mutation.mutateAsync({ id, dueDate, reason });
    },
    [mutation]
  );

  const refetch = useCallback(() => {
    return queryClient.refetchQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    workItems,
    loading: isLoading,
    /** True while a background refetch is in flight (does not flip initial loading). */
    isFetching,
    error: error ? (error as Error).message : null,
    updateDueDate,
    refetch,
  };
}
