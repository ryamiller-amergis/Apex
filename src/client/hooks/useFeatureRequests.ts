import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  FeatureRequest,
  CreateFeatureRequestDTO,
  UpdateFeatureRequestDTO,
} from '../../shared/types/featureRequest';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export function useFeatureRequests() {
  return useQuery<FeatureRequest[]>({
    queryKey: ['feature-requests'],
    queryFn: () => apiFetch('/api/feature-requests?project=Apex'),
    staleTime: 15_000,
  });
}

export function useSubmitFeatureRequest() {
  const qc = useQueryClient();
  return useMutation<FeatureRequest, Error, CreateFeatureRequestDTO>({
    mutationFn: (body) =>
      apiFetch('/api/feature-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['feature-requests'] });
    },
  });
}

export function useUpdateFeatureRequest() {
  const qc = useQueryClient();
  return useMutation<
    FeatureRequest,
    Error,
    { id: string } & UpdateFeatureRequestDTO
  >({
    mutationFn: ({ id, ...body }) =>
      apiFetch(`/api/feature-requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['feature-requests'] });
    },
  });
}

export function useReanalyzeFeatureRequest() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) =>
      apiFetch(`/api/feature-requests/${id}/reanalyze`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['feature-requests'] });
    },
  });
}
