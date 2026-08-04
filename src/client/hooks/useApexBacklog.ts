import { useQuery } from '@tanstack/react-query';
import type {
  ApexBacklogGroup,
  ApexFeatureContextResponse,
} from '../../shared/types/devWorkbench';
import { isAppNativeRequirementsProject } from '../../shared/types/devWorkbench';

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
    enabled: isAppNativeRequirementsProject(project),
    staleTime: 60_000,
  });
}

/**
 * Lazy-loads reference context for an app-native PRD feature when the dialog opens.
 */
export function useApexFeatureContext(
  project: string | null,
  prdId: string | null,
  featureId: string | null,
) {
  return useQuery<ApexFeatureContextResponse>({
    queryKey: ['dev-workbench', 'feature-context', project, prdId, featureId],
    queryFn: () =>
      apiFetch(
        `/api/dev-workbench/features/${encodeURIComponent(prdId!)}/${encodeURIComponent(featureId!)}/context?project=${encodeURIComponent(project!)}`,
      ),
    enabled: isAppNativeRequirementsProject(project) && !!prdId && !!featureId,
    staleTime: 60_000,
  });
}
