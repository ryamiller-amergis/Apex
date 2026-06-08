import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  DeploymentOutcome,
  CreateOutcomeInput,
  UpdateOutcomeInput,
  OutcomeFilters,
  OutcomeSummary,
} from '../../shared/types/deploymentOutcome';

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

export function useDeploymentOutcomes(releaseVersion?: string) {
  return useQuery<DeploymentOutcome[]>({
    queryKey: ['deployment-outcomes', releaseVersion],
    queryFn: () =>
      apiFetch<DeploymentOutcome[]>(
        `/api/deployment-outcomes/by-release/${encodeURIComponent(releaseVersion!)}`,
      ),
    enabled: !!releaseVersion,
    staleTime: 30_000,
  });
}

export function useOutcomeByDeployment(deploymentId: string | null) {
  return useQuery<DeploymentOutcome>({
    queryKey: ['deployment-outcome', deploymentId],
    queryFn: () =>
      apiFetch<DeploymentOutcome>(
        `/api/deployment-outcomes/${encodeURIComponent(deploymentId!)}`,
      ),
    enabled: !!deploymentId,
    staleTime: 30_000,
  });
}

export function useRecordOutcome() {
  const queryClient = useQueryClient();

  return useMutation<DeploymentOutcome, Error, CreateOutcomeInput>({
    mutationFn: (input) =>
      apiFetch<DeploymentOutcome>('/api/deployment-outcomes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployment-outcomes'] });
      queryClient.invalidateQueries({ queryKey: ['deployment-outcome'] });
      queryClient.invalidateQueries({ queryKey: ['deployment-outcome-report'] });
    },
  });
}

export function useUpdateOutcome() {
  const queryClient = useQueryClient();

  return useMutation<DeploymentOutcome, Error, { id: string; data: UpdateOutcomeInput }>({
    mutationFn: ({ id, data }) =>
      apiFetch<DeploymentOutcome>(`/api/deployment-outcomes/outcome/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployment-outcomes'] });
      queryClient.invalidateQueries({ queryKey: ['deployment-outcome'] });
      queryClient.invalidateQueries({ queryKey: ['deployment-outcome-report'] });
    },
  });
}

export function useDeleteOutcome() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      const res = await fetch(`/api/deployment-outcomes/outcome/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployment-outcomes'] });
      queryClient.invalidateQueries({ queryKey: ['deployment-outcome'] });
      queryClient.invalidateQueries({ queryKey: ['deployment-outcome-report'] });
    },
  });
}

export async function resolveDeploymentIdForRelease(releaseVersion: string): Promise<string> {
  try {
    const res = await fetch(
      `/api/deployments/${encodeURIComponent(releaseVersion)}/latest`,
      { credentials: 'include' },
    );
    if (res.ok) {
      const data = (await res.json()) as { production?: { id: string } };
      if (data.production?.id) return data.production.id;
    }
  } catch {
    // fall through to synthetic id
  }
  return `release:${releaseVersion}`;
}

function buildFilterQS(filters: OutcomeFilters, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  if (filters.startDate) params.set('startDate', filters.startDate);
  if (filters.endDate) params.set('endDate', filters.endDate);
  if (filters.result) params.set('result', filters.result);
  if (filters.releaseVersions?.length) {
    for (const v of filters.releaseVersions) params.append('releaseVersions', v);
  } else if (filters.releaseVersion) {
    params.append('releaseVersions', filters.releaseVersion);
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) params.set(key, value);
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function useAvailableReleaseVersions() {
  return useQuery<string[]>({
    queryKey: ['deployment-outcome-versions'],
    queryFn: () => apiFetch<string[]>('/api/deployment-outcomes/versions'),
    staleTime: 60_000,
  });
}

export function useFilteredOutcomes(filters: OutcomeFilters) {
  return useQuery<DeploymentOutcome[]>({
    queryKey: ['deployment-outcomes-filtered', filters],
    queryFn: () => {
      const qs = buildFilterQS(filters);
      return apiFetch<DeploymentOutcome[]>(`/api/deployment-outcomes/list${qs}`);
    },
    staleTime: 30_000,
  });
}

export function useOutcomeReport(filters: OutcomeFilters) {
  return useQuery<OutcomeSummary>({
    queryKey: ['deployment-outcome-report', filters],
    queryFn: () => {
      const qs = buildFilterQS(filters);
      return apiFetch<OutcomeSummary>(`/api/deployment-outcomes/report${qs}`);
    },
    staleTime: 60_000,
  });
}

export function useExportOutcomeReport() {
  return async function exportReport(
    filters: OutcomeFilters & { format: 'csv' | 'json' },
  ) {
    const qs = buildFilterQS(filters, { format: filters.format });

    const res = await fetch(`/api/deployment-outcomes/export${qs}`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);

    if (filters.format === 'csv') {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'deployment-outcomes.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return;
    }

    return res.json() as Promise<DeploymentOutcome[]>;
  };
}
