import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateLoadTestTargetInput,
  LoadTestTarget,
  UpdateLoadTestTargetInput,
} from '../../shared/types/loadTest';

interface LoadTestTargetsResponse {
  items: LoadTestTarget[];
}

interface LoadTestTargetResponse {
  item: LoadTestTarget;
}

class LoadTestTargetApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'LoadTestTargetApiError';
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
    throw new LoadTestTargetApiError(
      body.error ?? `Request failed: ${response.status}`,
      response.status,
      body.code,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function targetsUrl(projectId: string, query?: string): string {
  const base = `/api/projects/${encodeURIComponent(projectId)}/load-test-targets`;
  const params = new URLSearchParams();
  params.set('project', projectId);
  if (query) {
    const extra = new URLSearchParams(query);
    extra.forEach((v, k) => params.set(k, v));
  }
  return `${base}?${params.toString()}`;
}

const targetsKey = (projectId: string, includeInactive?: boolean) =>
  ['load-test-targets', projectId, includeInactive ? 'all' : 'active'] as const;

export function useLoadTestTargets(
  projectId: string | null,
  options?: { includeInactive?: boolean },
) {
  const includeInactive = options?.includeInactive ?? false;
  return useQuery<LoadTestTarget[]>({
    queryKey: targetsKey(projectId ?? '', includeInactive),
    queryFn: async () => {
      const data = await apiFetch<LoadTestTargetsResponse>(
        targetsUrl(projectId!, includeInactive ? 'includeInactive=true' : undefined),
      );
      return data.items;
    },
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });
}

export function useCreateLoadTestTarget(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<LoadTestTarget, LoadTestTargetApiError, CreateLoadTestTargetInput>({
    mutationFn: async (input) => {
      const data = await apiFetch<LoadTestTargetResponse>(targetsUrl(projectId!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      return data.item;
    },
    onSuccess: () => {
      if (!projectId) return;
      queryClient.invalidateQueries({ queryKey: ['load-test-targets', projectId] });
    },
  });
}

export function useUpdateLoadTestTarget(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<
    LoadTestTarget,
    LoadTestTargetApiError,
    { targetId: string; input: UpdateLoadTestTargetInput }
  >({
    mutationFn: async ({ targetId, input }) => {
      const data = await apiFetch<LoadTestTargetResponse>(
        `${targetsUrl(projectId!).split('?')[0]}/${encodeURIComponent(targetId)}?project=${encodeURIComponent(projectId!)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      return data.item;
    },
    onSuccess: () => {
      if (!projectId) return;
      queryClient.invalidateQueries({ queryKey: ['load-test-targets', projectId] });
    },
  });
}

export function useDeleteLoadTestTarget(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<void, LoadTestTargetApiError, string>({
    mutationFn: async (targetId) => {
      await apiFetch<void>(
        `${targetsUrl(projectId!).split('?')[0]}/${encodeURIComponent(targetId)}?project=${encodeURIComponent(projectId!)}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => {
      if (!projectId) return;
      queryClient.invalidateQueries({ queryKey: ['load-test-targets', projectId] });
    },
  });
}

export { LoadTestTargetApiError };
