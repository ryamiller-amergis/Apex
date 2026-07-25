import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateLoadTestDefinitionInput,
  LoadTestDefinition,
  LoadTestDefinitionListItem,
  UpdateLoadTestDefinitionInput,
} from '../../shared/types/loadTest';

interface LoadTestsListResponse {
  items: LoadTestDefinitionListItem[];
}

/** @deprecated Prefer LoadTestDefinitionListItem from shared types. */
export type { LoadTestDefinitionListItem };

class LoadTestApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'LoadTestApiError';
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
    throw new LoadTestApiError(
      body.error ?? `Request failed: ${response.status}`,
      response.status,
      body.code,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function definitionsUrl(projectId: string, id?: string): string {
  const base = `/api/projects/${encodeURIComponent(projectId)}/load-tests`;
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

export const loadTestsQueryKey = (projectId: string) => ['load-tests', projectId] as const;
export const loadTestQueryKey = (projectId: string, id: string) =>
  ['load-test', projectId, id] as const;

export function useLoadTests(projectId: string | null) {
  return useQuery<LoadTestDefinitionListItem[]>({
    queryKey: loadTestsQueryKey(projectId ?? ''),
    queryFn: async () => {
      const data = await apiFetch<LoadTestsListResponse>(definitionsUrl(projectId!));
      return data.items;
    },
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

export function useLoadTest(projectId: string | null, id: string | null) {
  return useQuery<LoadTestDefinition>({
    queryKey: loadTestQueryKey(projectId ?? '', id ?? ''),
    queryFn: () => apiFetch<LoadTestDefinition>(definitionsUrl(projectId!, id!)),
    enabled: Boolean(projectId && id),
    staleTime: 15_000,
  });
}

export function useCreateLoadTest(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<LoadTestDefinition, LoadTestApiError, CreateLoadTestDefinitionInput>({
    mutationFn: (input) =>
      apiFetch<LoadTestDefinition>(definitionsUrl(projectId!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      if (!projectId) return;
      queryClient.invalidateQueries({ queryKey: loadTestsQueryKey(projectId) });
    },
  });
}

export function useUpdateLoadTest(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<
    LoadTestDefinition,
    LoadTestApiError,
    { id: string; input: UpdateLoadTestDefinitionInput }
  >({
    mutationFn: ({ id, input }) =>
      apiFetch<LoadTestDefinition>(definitionsUrl(projectId!, id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: (_data, vars) => {
      if (!projectId) return;
      queryClient.invalidateQueries({ queryKey: loadTestsQueryKey(projectId) });
      queryClient.invalidateQueries({ queryKey: loadTestQueryKey(projectId, vars.id) });
    },
  });
}

export function useDeleteLoadTest(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<void, LoadTestApiError, string>({
    mutationFn: (id) =>
      apiFetch<void>(definitionsUrl(projectId!, id), {
        method: 'DELETE',
      }),
    onSuccess: (_data, id) => {
      if (!projectId) return;
      queryClient.invalidateQueries({ queryKey: loadTestsQueryKey(projectId) });
      queryClient.invalidateQueries({ queryKey: loadTestQueryKey(projectId, id) });
    },
  });
}

export { LoadTestApiError };
