import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  LoadTestRun,
  LoadTestRunSource,
  RunStatus,
} from '../../shared/types/loadTest';

interface LoadTestRunsListResponse {
  items: LoadTestRun[];
}

interface LoadTestRunResponse {
  run: LoadTestRun;
}

class LoadTestRunApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'LoadTestRunApiError';
    this.status = status;
    this.code = code;
  }
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    throw new LoadTestRunApiError(
      body.error ?? `Request failed: ${response.status}`,
      response.status,
      body.code,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function runsBase(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/load-tests`;
}

export const loadTestRunsQueryKey = (
  projectId: string,
  filters?: { definitionId?: string; status?: RunStatus },
) => ['load-test-runs', projectId, filters?.definitionId ?? null, filters?.status ?? null] as const;

export const loadTestRunQueryKey = (projectId: string, runId: string) =>
  ['load-test-run', projectId, runId] as const;

export function useLoadTestRuns(
  projectId: string | null,
  filters?: { definitionId?: string; status?: RunStatus; limit?: number },
) {
  return useQuery<LoadTestRun[]>({
    queryKey: loadTestRunsQueryKey(projectId ?? '', filters),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.definitionId) params.set('definitionId', filters.definitionId);
      if (filters?.status) params.set('status', filters.status);
      if (filters?.limit != null) params.set('limit', String(filters.limit));
      const qs = params.toString();
      const url = `${runsBase(projectId!)}/runs${qs ? `?${qs}` : ''}`;
      const data = await apiFetch<LoadTestRunsListResponse>(url);
      return data.items;
    },
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
}

export function useLoadTestRun(projectId: string | null, runId: string | null) {
  return useQuery<LoadTestRun>({
    queryKey: loadTestRunQueryKey(projectId ?? '', runId ?? ''),
    queryFn: async () => {
      const data = await apiFetch<LoadTestRunResponse>(
        `${runsBase(projectId!)}/runs/${encodeURIComponent(runId!)}`,
      );
      return data.run;
    },
    enabled: Boolean(projectId && runId),
    staleTime: 5_000,
  });
}

export function useEnqueueRun(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<
    LoadTestRun,
    LoadTestRunApiError,
    { definitionId: string; runSource?: LoadTestRunSource }
  >({
    mutationFn: async ({ definitionId, runSource }) => {
      const data = await apiFetch<LoadTestRunResponse>(
        `${runsBase(projectId!)}/${encodeURIComponent(definitionId)}/runs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runSource: runSource ?? 'app' }),
        },
      );
      return data.run;
    },
    onSuccess: (run) => {
      if (!projectId) return;
      void queryClient.invalidateQueries({ queryKey: ['load-test-runs', projectId] });
      queryClient.setQueryData(loadTestRunQueryKey(projectId, run.id), run);
    },
  });
}

export function useCancelRun(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<LoadTestRun, LoadTestRunApiError, { runId: string }>({
    mutationFn: async ({ runId }) => {
      const data = await apiFetch<LoadTestRunResponse>(
        `${runsBase(projectId!)}/runs/${encodeURIComponent(runId)}/cancel`,
        { method: 'POST' },
      );
      return data.run;
    },
    onSuccess: (run) => {
      if (!projectId) return;
      queryClient.setQueryData(loadTestRunQueryKey(projectId, run.id), run);
      void queryClient.invalidateQueries({ queryKey: ['load-test-runs', projectId] });
    },
  });
}

export { LoadTestRunApiError };
