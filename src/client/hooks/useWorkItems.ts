import { useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { WorkItem } from '../types/workitem';
import { workItemService } from '../services/workItemService';
import { env } from '../config/env';

const POLL_INTERVAL = env.VITE_POLL_INTERVAL * 1000;

export function useWorkItems(
  startDate: Date,
  endDate: Date,
  project: string,
  areaPath: string,
  enabled: boolean = true
) {
  const queryClient = useQueryClient();

  const normalizedAreaPath = areaPath.replace(/\//g, '\\');
  const from = startDate.toISOString().split('T')[0];
  const to = endDate.toISOString().split('T')[0];
  // Apex has no ADO backlog; server short-circuits to [] — skip the round-trip.
  const queryEnabled = enabled && project.toLowerCase() !== 'apex';
  const queryKey = useMemo(
    () => ['workItems', project, normalizedAreaPath, from, to] as const,
    [project, normalizedAreaPath, from, to]
  );

  const { data: workItems = [], isLoading, error, isFetching } = useQuery({
    queryKey,
    queryFn: () => workItemService.getWorkItems(from, to, project, normalizedAreaPath),
    refetchInterval: POLL_INTERVAL,
    enabled: queryEnabled,
    staleTime: 10_000,
    // Transient proxy/API blips (e.g. nodemon restart) should retry quietly.
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
  });

  const mutation = useMutation({
    mutationFn: ({ id, dueDate, reason }: { id: number; dueDate: string | null; reason?: string }) =>
      workItemService.updateDueDate(id, dueDate, reason, project, areaPath),
    onMutate: async ({ id, dueDate }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<WorkItem[]>(queryKey);
      queryClient.setQueryData<WorkItem[]>(queryKey, (old = []) =>
        old.map(item =>
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
      window.setTimeout(() => {
        queryClient.invalidateQueries({ queryKey });
      }, 5000);
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
