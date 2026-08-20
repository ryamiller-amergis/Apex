import { useInfiniteQuery, keepPreviousData } from '@tanstack/react-query';
import type { SessionTimelineResponse } from '../../shared/types/observability';
import { ObservabilityApiError } from './useObservabilityQueries';

async function observabilityFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    throw new ObservabilityApiError(body.error ?? `HTTP ${res.status}`, res.status, body.code);
  }
  return body as T;
}

export function buildSessionTimelineUrl(
  project: string,
  sessionId: string,
  cursor: string | null,
): string {
  const params = new URLSearchParams({ project });
  if (cursor) params.set('cursor', cursor);
  return `/api/platform-admin/observability/sessions/${encodeURIComponent(sessionId)}/timeline?${params.toString()}`;
}

export function useSessionTimeline(
  project: string | undefined,
  sessionId: string | null,
) {
  return useInfiniteQuery<SessionTimelineResponse, ObservabilityApiError>({
    queryKey: ['observability-session-timeline', project, sessionId],
    queryFn: ({ pageParam }) =>
      observabilityFetch<SessionTimelineResponse>(
        buildSessionTimelineUrl(project!, sessionId!, (pageParam as string | null) ?? null),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor,
    enabled: Boolean(project && sessionId),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}
