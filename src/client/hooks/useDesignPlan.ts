import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DesignPlan,
  DesignPlanFeature,
  DesignPlanResponse,
} from '../../shared/types/designPlan';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ── Queries ─────────────────────────────────────────────────────────────────

export function useDesignPlan(prdId: string | null) {
  return useQuery<DesignPlanResponse>({
    queryKey: ['design-plan', 'prd', prdId],
    queryFn: () => apiFetch(`/api/design-plans/prd/${prdId}`),
    enabled: !!prdId,
    staleTime: 10_000,
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.plan.status;
      return status === 'generating' ? 4_000 : false;
    },
  });
}

// ── Mutations ───────────────────────────────────────────────────────────────

export function useSaveDesignPlan() {
  const qc = useQueryClient();
  return useMutation<DesignPlan, Error, { planId: string; prdId: string; features: DesignPlanFeature[] }>({
    mutationFn: ({ planId, features }) =>
      apiFetch(`/api/design-plans/${planId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features }),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['design-plan', 'prd', variables.prdId] });
    },
  });
}

export function useRegenerateDesignPlan() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, { planId: string; prdId: string }>({
    mutationFn: ({ planId }) =>
      apiFetch(`/api/design-plans/${planId}/regenerate`, { method: 'POST' }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['design-plan', 'prd', variables.prdId] });
    },
  });
}

export function useGeneratePrototypesFromPlan() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean; prototypeIds: string[] }, Error, { planId: string; prdId: string }>({
    mutationFn: ({ planId }) =>
      apiFetch(`/api/design-plans/${planId}/generate-prototypes`, { method: 'POST' }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['design-plan', 'prd', variables.prdId] });
      qc.invalidateQueries({ queryKey: ['design-prototypes', 'prd', variables.prdId] });
      qc.invalidateQueries({ queryKey: ['design-prototypes'] });
    },
  });
}
