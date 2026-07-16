import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Adr,
  AdrStatus,
  AdrSummary,
  CreateAdrRequest,
  CreateAdrResponse,
  GenerateAdrResponse,
  UpdateAdrRequest,
} from '../../shared/types/adr';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export function useAdrs(filters?: { status?: AdrStatus; project?: string; author?: 'me' }) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.project) params.set('project', filters.project);
  if (filters?.author) params.set('author', filters.author);
  const query = params.toString();
  return useQuery<AdrSummary[]>({
    queryKey: ['adrs', filters],
    queryFn: () => apiFetch(`/api/adr${query ? `?${query}` : ''}`),
    staleTime: 30_000,
    refetchInterval: (result) => result.state.data?.some((adr) => adr.status === 'generating') ? 5_000 : false,
  });
}

export function useAdr(id: string | null) {
  return useQuery<Adr>({
    queryKey: ['adr', id],
    queryFn: () => apiFetch(`/api/adr/${id}`),
    enabled: !!id,
    staleTime: 30_000,
    refetchInterval: (result) => result.state.data?.status === 'generating' ? 5_000 : false,
  });
}

export function useCreateAdr() {
  const queryClient = useQueryClient();
  return useMutation<CreateAdrResponse, Error, CreateAdrRequest>({
    mutationFn: (body) => apiFetch('/api/adr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['adrs'] }),
  });
}

export function useGenerateAdr() {
  const queryClient = useQueryClient();
  return useMutation<GenerateAdrResponse, Error, string>({
    mutationFn: (id) => apiFetch(`/api/adr/${id}/generate`, { method: 'POST' }),
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: ['adr', id] });
      void queryClient.invalidateQueries({ queryKey: ['adrs'] });
    },
  });
}

export function useUpdateAdr() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { id: string; changes: UpdateAdrRequest }>({
    mutationFn: ({ id, changes }) => apiFetch(`/api/adr/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    }),
    onSuccess: (_result, { id }) => {
      void queryClient.invalidateQueries({ queryKey: ['adr', id] });
      void queryClient.invalidateQueries({ queryKey: ['adrs'] });
    },
  });
}

export function useDeleteAdr() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiFetch(`/api/adr/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['adrs'] }),
  });
}
