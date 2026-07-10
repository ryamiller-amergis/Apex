import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AiCostSummary,
  AiCostTimeseriesPoint,
  AiCostByFeature,
  AiCostByModel,
  AiCostByProject,
  AiCostByUser,
  AiCostEventsResponse,
  AiCostReconciliation,
  AiCostForecast,
  AiCostInsightsResponse,
  AiCostDailyBrief,
  AiPricingRow,
  ProjectComparison,
} from '../../shared/types/aiCostAnalytics';

export interface AiCostFilters {
  from?: string;
  to?: string;
  project?: string;
  feature?: string;
  model?: string;
  provider?: string;
  [key: string]: string | number | undefined;
}

function buildQuery(base: string, filters: AiCostFilters & Record<string, unknown>): string {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  });
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`AI cost API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export function useAiCostSummary(filters: AiCostFilters) {
  return useQuery<AiCostSummary>({
    queryKey: ['ai-cost', 'summary', filters],
    queryFn: () => fetchJson(buildQuery('/api/ai-cost/summary', filters)),
    staleTime: 5 * 60 * 1000,
    enabled: !!filters.project || filters.project === 'all',
  });
}

export function useAiCostTimeseries(filters: AiCostFilters) {
  return useQuery<AiCostTimeseriesPoint[]>({
    queryKey: ['ai-cost', 'timeseries', filters],
    queryFn: () => fetchJson(buildQuery('/api/ai-cost/timeseries', filters)),
    staleTime: 5 * 60 * 1000,
    enabled: !!filters.project || filters.project === 'all',
  });
}

export function useAiCostByFeature(filters: AiCostFilters) {
  return useQuery<AiCostByFeature[]>({
    queryKey: ['ai-cost', 'by-feature', filters],
    queryFn: () => fetchJson(buildQuery('/api/ai-cost/by-feature', filters)),
    staleTime: 5 * 60 * 1000,
    enabled: !!filters.project || filters.project === 'all',
  });
}

export function useAiCostByModel(filters: AiCostFilters) {
  return useQuery<AiCostByModel[]>({
    queryKey: ['ai-cost', 'by-model', filters],
    queryFn: () => fetchJson(buildQuery('/api/ai-cost/by-model', filters)),
    staleTime: 5 * 60 * 1000,
    enabled: !!filters.project || filters.project === 'all',
  });
}

export function useAiCostByProject(filters: Omit<AiCostFilters, 'project'>) {
  return useQuery<AiCostByProject[]>({
    queryKey: ['ai-cost', 'by-project', filters],
    queryFn: () => fetchJson(buildQuery('/api/ai-cost/by-project', filters)),
    staleTime: 5 * 60 * 1000,
  });
}

export function useAiCostByUser(filters: AiCostFilters) {
  return useQuery<AiCostByUser[]>({
    queryKey: ['ai-cost', 'by-user', filters],
    queryFn: () => fetchJson(buildQuery('/api/ai-cost/by-user', filters)),
    staleTime: 5 * 60 * 1000,
  });
}

export function useAiCostEvents(filters: AiCostFilters, page = 1, pageSize = 25) {
  return useQuery<AiCostEventsResponse>({
    queryKey: ['ai-cost', 'events', filters, page, pageSize],
    queryFn: () => fetchJson(buildQuery('/api/ai-cost/events', { ...filters, page, pageSize })),
    staleTime: 60 * 1000,
    enabled: !!filters.project || filters.project === 'all',
  });
}

export function useAiCostReconciliation(filters: AiCostFilters) {
  return useQuery<AiCostReconciliation>({
    queryKey: ['ai-cost', 'reconciliation', filters],
    queryFn: () => fetchJson(buildQuery('/api/ai-cost/reconciliation', filters)),
    staleTime: 10 * 60 * 1000,
    enabled: !!filters.project || filters.project === 'all',
  });
}

export function useAiCostForecast(project: string) {
  return useQuery<AiCostForecast>({
    queryKey: ['ai-cost', 'forecast', project],
    queryFn: () => fetchJson(`/api/ai-cost/forecast?project=${encodeURIComponent(project)}`),
    staleTime: 30 * 60 * 1000,
    enabled: !!project,
  });
}

export function useAiCostInsights(project: string) {
  return useQuery<AiCostInsightsResponse>({
    queryKey: ['ai-cost', 'insights', project],
    queryFn: () => fetchJson(`/api/ai-cost/insights?project=${encodeURIComponent(project)}`),
    staleTime: 30 * 60 * 1000,
    enabled: !!project,
  });
}

export function useRefreshInsights(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetch('/api/ai-cost/insights/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project }),
      }).then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as any).detail || (body as any).error || 'Refresh failed');
        }
        return res.json();
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-cost', 'insights', project] });
    },
  });
}

export function useSyncAiCost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetch('/api/ai-cost/sync', {
        method: 'POST',
        credentials: 'include',
      }),
    onSuccess: () => {
      // Refetch all ai-cost queries after a short delay for the sync to complete
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['ai-cost'] });
      }, 35000);
    },
  });
}

export function useAiCostComparison(filters: Omit<AiCostFilters, 'project' | 'feature' | 'model' | 'provider'>) {
  return useQuery<ProjectComparison>({
    queryKey: ['ai-cost', 'comparison', filters],
    queryFn: () => fetchJson(buildQuery('/api/ai-cost/comparison', filters)),
    staleTime: 5 * 60 * 1000,
  });
}

export function useAiCostPricing() {
  return useQuery<AiPricingRow[]>({
    queryKey: ['ai-cost', 'pricing'],
    queryFn: () => fetchJson('/api/ai-cost/pricing'),
    staleTime: 60 * 60 * 1000,
  });
}

export function useAiCostDailyBrief(project: string) {
  return useQuery<AiCostDailyBrief | null>({
    queryKey: ['ai-cost', 'daily-brief', project],
    queryFn: () => fetchJson(`/api/ai-cost/daily-brief?project=${encodeURIComponent(project)}`),
    staleTime: 30 * 60 * 1000,
    enabled: !!project,
  });
}

export function useGenerateDailyBrief(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetch('/api/ai-cost/daily-brief/generate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project }),
      }).then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as any).detail || (body as any).error || 'Failed');
        }
        return res.json();
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-cost', 'daily-brief', project] });
    },
  });
}
