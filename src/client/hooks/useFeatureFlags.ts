import { useQuery } from '@tanstack/react-query';
import type { EvaluateFlagsResponse } from '../../shared/types/featureFlags';

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Fetches all evaluated feature flags for the current user + project.
 * Returns a Record<string, boolean> keyed by flag key.
 */
export function useFeatureFlags(project: string | undefined) {
  const query = useQuery<EvaluateFlagsResponse>({
    queryKey: ['feature-flags', 'evaluate', project],
    queryFn: () =>
      apiFetch<EvaluateFlagsResponse>(
        `/api/feature-flags/evaluate?project=${encodeURIComponent(project!)}`,
      ),
    enabled: !!project,
    staleTime: 60_000,
  });

  return {
    ...query,
    flags: query.data?.flags ?? {},
  };
}

/**
 * Convenience hook: returns whether a single flag is enabled for the current user + project.
 */
export function useFeatureFlag(key: string, project: string | undefined): boolean {
  const { flags } = useFeatureFlags(project);
  return flags[key] ?? false;
}
