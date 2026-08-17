import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApiKeyMetadata,
  ApiKeyRevealResponse,
  CreateApiKeyInput,
  UpdateApiKeyInput,
} from '../../shared/types/apiKey';

interface ApiKeysListResponse {
  items: ApiKeyMetadata[];
}

export class ApiKeyApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiKeyApiError';
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
    throw new ApiKeyApiError(
      body.error ?? `Request failed: ${response.status}`,
      response.status,
      body.code,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function keysUrl(projectId: string, id?: string, action?: 'regenerate'): string {
  const base = `/api/projects/${encodeURIComponent(projectId)}/api-keys`;
  if (!id) return base;
  const item = `${base}/${encodeURIComponent(id)}`;
  return action ? `${item}/${action}` : item;
}

export const apiKeysQueryKey = (projectId: string) => ['api-keys', projectId] as const;

export function useApiKeys(projectId: string | null) {
  return useQuery<ApiKeyMetadata[]>({
    queryKey: apiKeysQueryKey(projectId ?? ''),
    queryFn: async () => {
      const data = await apiFetch<ApiKeysListResponse>(keysUrl(projectId!));
      return data.items;
    },
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

export function useCreateApiKey(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<ApiKeyRevealResponse, ApiKeyApiError, CreateApiKeyInput>({
    mutationFn: (input) =>
      apiFetch<ApiKeyRevealResponse>(keysUrl(projectId!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      if (!projectId) return;
      queryClient.invalidateQueries({ queryKey: apiKeysQueryKey(projectId) });
    },
  });
}

export function useUpdateApiKey(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<
    ApiKeyMetadata,
    ApiKeyApiError,
    { id: string; input: UpdateApiKeyInput }
  >({
    mutationFn: ({ id, input }) =>
      apiFetch<ApiKeyMetadata>(keysUrl(projectId!, id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      if (!projectId) return;
      queryClient.invalidateQueries({ queryKey: apiKeysQueryKey(projectId) });
    },
  });
}

export function useRegenerateApiKey(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<ApiKeyRevealResponse, ApiKeyApiError, { id: string }>({
    mutationFn: ({ id }) =>
      apiFetch<ApiKeyRevealResponse>(keysUrl(projectId!, id, 'regenerate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      if (!projectId) return;
      queryClient.invalidateQueries({ queryKey: apiKeysQueryKey(projectId) });
    },
  });
}

export function useDeleteApiKey(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<void, ApiKeyApiError, { id: string }>({
    mutationFn: ({ id }) =>
      apiFetch<void>(keysUrl(projectId!, id), {
        method: 'DELETE',
      }),
    onSuccess: () => {
      if (!projectId) return;
      queryClient.invalidateQueries({ queryKey: apiKeysQueryKey(projectId) });
    },
  });
}
