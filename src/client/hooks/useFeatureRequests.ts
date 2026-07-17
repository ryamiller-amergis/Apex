import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  FeatureRequest,
  CreateFeatureRequestDTO,
  LinkedAdrSummary,
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
    refetchInterval: (query) =>
      query.state.data?.some((fr) => fr.aiStatus === 'analyzing' || fr.aiStatus === 'pending')
        ? 5_000
        : false,
  });
}

export function useAvailableFeatureRequestAdrs(project: string, enabled: boolean) {
  return useQuery<LinkedAdrSummary[]>({
    queryKey: ['feature-request-adrs', project],
    queryFn: () => apiFetch(`/api/feature-requests/available-adrs?project=${encodeURIComponent(project)}`),
    enabled: enabled && !!project,
    staleTime: 30_000,
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

export function useLinkFeatureRequestInterview() {
  const qc = useQueryClient();
  return useMutation<FeatureRequest, Error, { id: string; interviewId: string }>({
    mutationFn: ({ id, interviewId }) =>
      apiFetch(`/api/feature-requests/${id}/link-interview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interviewId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['feature-requests'] });
    },
  });
}

export function useReorderFeatureRequests() {
  const qc = useQueryClient();
  return useMutation<
    void,
    Error,
    { id: string; rank: number }[],
    { previous: FeatureRequest[] | undefined }
  >({
    onMutate: async (updates) => {
      await qc.cancelQueries({ queryKey: ['feature-requests'] });
      const previous = qc.getQueryData<FeatureRequest[]>(['feature-requests']);

      qc.setQueryData<FeatureRequest[]>(['feature-requests'], (old) => {
        if (!old) return old;
        const rankMap = new Map(updates.map((u) => [u.id, u.rank]));
        return old.map((item) => {
          const newRank = rankMap.get(item.id);
          return newRank !== undefined ? { ...item, rank: newRank } : item;
        });
      });

      return { previous };
    },
    mutationFn: async (updates) => {
      if (updates.length === 0) return;
      await Promise.all(
        updates.map(({ id, rank }) =>
          apiFetch(`/api/feature-requests/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rank }),
          }),
        ),
      );
    },
    onError: (_err, _updates, context) => {
      if (context?.previous) {
        qc.setQueryData(['feature-requests'], context.previous);
      }
    },
    onSettled: () => {
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
