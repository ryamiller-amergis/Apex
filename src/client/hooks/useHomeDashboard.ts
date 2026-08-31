import { useQuery } from '@tanstack/react-query';
import type { HomeDashboardPayload } from '../../shared/types/homeDashboard';

async function fetchHomeDashboard(project: string): Promise<HomeDashboardPayload> {
  const response = await fetch(
    `/api/home-dashboard?project=${encodeURIComponent(project)}`,
    { credentials: 'include' },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Home dashboard request failed: ${response.status}`);
  }
  return response.json() as Promise<HomeDashboardPayload>;
}

export function useHomeDashboard(project: string | null | undefined) {
  return useQuery<HomeDashboardPayload>({
    queryKey: ['home-dashboard', project],
    queryFn: () => fetchHomeDashboard(project!),
    enabled: Boolean(project),
    retry: 1,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}
