import { useQuery } from '@tanstack/react-query';
import type {
  JourneyEdgePage,
  JourneyMapFilters,
  JourneyMapResponse,
} from '../../shared/types/observability';
import { ObservabilityApiError } from './useObservabilityQueries';
import { toJourneyMapView } from '../observability/journeyGraph';

async function observabilityFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    throw new ObservabilityApiError(body.error ?? `HTTP ${res.status}`, res.status, body.code);
  }
  return body as T;
}

export function journeyMapQueryKey(
  project: string | undefined,
  filters: JourneyMapFilters | null,
): readonly unknown[] {
  return ['platform-admin', 'observability', 'journeys', project, filters];
}

export function buildJourneyQueryUrl(
  project: string,
  filters: JourneyMapFilters,
  cursor: string | null,
): string {
  const params = new URLSearchParams({
    project,
    fromDay: filters.from.slice(0, 10),
    toDay: filters.to.slice(0, 10),
  });
  if (cursor) params.set('cursor', cursor);
  return `/api/platform-admin/observability/journeys?${params.toString()}`;
}

export async function fetchJourneyMap(
  project: string,
  filters: JourneyMapFilters,
  generatedAt = new Date().toISOString(),
): Promise<JourneyMapResponse> {
  const pages: JourneyEdgePage[] = [];
  let cursor: string | null = null;
  do {
    const page: JourneyEdgePage = await observabilityFetch<JourneyEdgePage>(
      buildJourneyQueryUrl(project, filters, cursor),
    );
    pages.push(page);
    cursor = page.capReached ? null : page.nextCursor;
  } while (cursor);

  return toJourneyMapView(pages, filters, generatedAt);
}

export function useJourneyMap(
  project: string | undefined,
  filters: JourneyMapFilters | null,
  enabled: boolean,
) {
  return useQuery<JourneyMapResponse, ObservabilityApiError>({
    queryKey: journeyMapQueryKey(project, filters),
    queryFn: () => fetchJourneyMap(project!, filters!),
    enabled: Boolean(project && filters && enabled),
    staleTime: 15_000,
    retry: false,
  });
}
