import { useCallback } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkflowEvaluationJobEvaluator } from '../../shared/types/workflowEvaluation';
import type {
  AdminEvaluationEventDetail,
  AdminEvaluationEventDetailResponse,
  AdminEvaluationExportFormat,
  AdminEvaluationFilters,
  AdminEvaluationJudgeAppendixResponse,
  AdminEvaluationListResponse,
  AdminEvaluationModelSettings,
  UpdateAdminEvaluationModelSettingsRequest,
} from '../../shared/types/workflowEvaluationAdmin';
import { filtersToQuery } from '../utils/workflowEvaluationFilters';
import {
  WorkflowEvaluationApiError,
  workflowEvaluationFetch,
  workflowEvaluationsUrl,
} from './useWorkflowEvaluations';

const POLL_MS = 10_000;

export const workflowEvaluationsAdminKeys = {
  all: (project: string) => ['workflow-evaluations-admin', project] as const,
  events: (project: string, filters: AdminEvaluationFilters) =>
    ['workflow-evaluations-admin', project, 'events', filters] as const,
  event: (project: string, eventId: string) =>
    ['workflow-evaluations-admin', project, 'event', eventId] as const,
  appendix: (project: string, eventId: string) =>
    ['workflow-evaluations-admin', project, 'appendix', eventId] as const,
  settings: (project: string) => ['workflow-evaluations-admin', project, 'settings'] as const,
};

export function useEvaluationModelSettings(project: string | null) {
  return useQuery<AdminEvaluationModelSettings, WorkflowEvaluationApiError>({
    queryKey: workflowEvaluationsAdminKeys.settings(project ?? ''),
    queryFn: () => workflowEvaluationFetch(workflowEvaluationsUrl(project!, '/admin/settings')),
    enabled: Boolean(project),
    retry: false,
  });
}

export function useUpdateEvaluationModelSettings(project: string) {
  const queryClient = useQueryClient();
  return useMutation<AdminEvaluationModelSettings, WorkflowEvaluationApiError, UpdateAdminEvaluationModelSettingsRequest>({
    mutationFn: (settings) =>
      workflowEvaluationFetch(workflowEvaluationsUrl(project, '/admin/settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      }),
    onSuccess: (settings) => {
      queryClient.setQueryData(workflowEvaluationsAdminKeys.settings(project), settings);
    },
  });
}

export function useAdminWorkflowEvaluationEvents(
  project: string | null,
  filters: AdminEvaluationFilters,
  enabled: boolean,
) {
  return useInfiniteQuery<AdminEvaluationListResponse, WorkflowEvaluationApiError>({
    queryKey: workflowEvaluationsAdminKeys.events(project ?? '', filters),
    queryFn: ({ pageParam }) => {
      const params = filtersToQuery(filters);
      if (typeof pageParam === 'string') params.set('cursor', pageParam);
      return workflowEvaluationFetch(workflowEvaluationsUrl(project!, `/admin/events?${params}`));
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && Boolean(project),
    staleTime: 10_000,
    retry: false,
  });
}

function hasUnfinishedJob(event: AdminEvaluationEventDetail | undefined): boolean {
  return (event?.jobs ?? []).some((job) => job.status === 'pending' || job.status === 'running');
}

export function useAdminWorkflowEvaluationEvent(project: string, eventId: string) {
  return useQuery<AdminEvaluationEventDetail, WorkflowEvaluationApiError>({
    queryKey: workflowEvaluationsAdminKeys.event(project, eventId),
    queryFn: async () => {
      const body = await workflowEvaluationFetch<AdminEvaluationEventDetailResponse>(
        workflowEvaluationsUrl(project, `/admin/events/${encodeURIComponent(eventId)}`),
      );
      return body.event;
    },
    refetchInterval: (query) => (hasUnfinishedJob(query.state.data) ? POLL_MS : false),
    retry: false,
  });
}

export function useAdminJudgeAppendix(project: string, eventId: string, enabled: boolean) {
  return useQuery<string, WorkflowEvaluationApiError>({
    queryKey: workflowEvaluationsAdminKeys.appendix(project, eventId),
    queryFn: async () => {
      const body = await workflowEvaluationFetch<AdminEvaluationJudgeAppendixResponse>(
        workflowEvaluationsUrl(project, `/admin/events/${encodeURIComponent(eventId)}/judge-appendix`),
      );
      return body.markdown;
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useRetryWorkflowEvaluationJob(project: string, eventId: string) {
  const queryClient = useQueryClient();
  return useMutation<unknown, WorkflowEvaluationApiError, WorkflowEvaluationJobEvaluator>({
    mutationFn: (evaluatorKey) =>
      workflowEvaluationFetch(
        workflowEvaluationsUrl(
          project,
          `/events/${encodeURIComponent(eventId)}/jobs/${encodeURIComponent(evaluatorKey)}/retry`,
        ),
        { method: 'POST' },
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: workflowEvaluationsAdminKeys.event(project, eventId) });
      void queryClient.invalidateQueries({ queryKey: [...workflowEvaluationsAdminKeys.all(project), 'events'] });
    },
  });
}

function filenameFrom(header: string | null, fallback: string): string {
  const match = header ? /filename="([^"]+)"/.exec(header) : null;
  return match?.[1] ?? fallback;
}

/** Downloads the export and resolves to the row count. Throws on a failed response, so no file is created. */
export function useExportWorkflowEvaluations(project: string | null) {
  return useCallback(async (filters: AdminEvaluationFilters, format: AdminEvaluationExportFormat): Promise<number | null> => {
    if (!project) throw new Error('Select a project first.');
    const params = filtersToQuery(filters);
    params.set('format', format);
    const response = await fetch(workflowEvaluationsUrl(project, `/admin/export?${params}`), {
      credentials: 'include',
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
      throw new WorkflowEvaluationApiError(body.error ?? `Export failed: ${response.status}`, response.status, body.code);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filenameFrom(response.headers.get('Content-Disposition'), `workflow-evaluations.${format}`);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    const header = response.headers.get('X-Export-Row-Count');
    const rowCount = header === null ? NaN : Number(header);
    return Number.isFinite(rowCount) ? rowCount : null;
  }, [project]);
}
