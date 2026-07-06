import { useQuery } from '@tanstack/react-query';
import type { ApexBacklogGroup } from '../../shared/types/devWorkbench';

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function useApexBacklogFeatures(project: string | null) {
  return useQuery<ApexBacklogGroup[]>({
    queryKey: ['dev-workbench', 'backlog-features', project],
    queryFn: () => apiFetch(`/api/dev-workbench/backlog-features?project=${encodeURIComponent(project!)}`),
    enabled: project === 'Apex',
    staleTime: 60_000,
  });
}
