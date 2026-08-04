/**
 * FEAT-005 / PBI-005 — Fetch at most one next-eligible Walkthrough for the selected project.
 */
import { useQuery } from '@tanstack/react-query';
import type { WalkthroughDefinition } from '../../shared/types/walkthrough';
import { trackEvent } from '../services/telemetry';

export const walkthroughEligibilityQueryKey = (
  projectId: string | null | undefined,
  userId: string | null | undefined,
) => ['walkthrough-eligibility', projectId ?? null, userId ?? null] as const;

export interface WalkthroughEligibilityEnvelope {
  walkthrough: WalkthroughDefinition | null;
}

async function fetchNextEligible(projectId: string): Promise<WalkthroughDefinition | null> {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/walkthroughs/next`,
    { credentials: 'include' },
  );
  const durationMs = Math.round(
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started,
  );

  if (!res.ok) {
    trackEvent('walkthrough.eligibility_evaluated', {
      outcome: 'error',
      status: String(res.status),
      duration_ms: String(durationMs),
    });
    throw new Error(`Eligibility request failed (${res.status})`);
  }

  const body = (await res.json()) as WalkthroughEligibilityEnvelope;
  if (!body || typeof body !== 'object' || !('walkthrough' in body)) {
    trackEvent('walkthrough.eligibility_evaluated', {
      outcome: 'error',
      status: 'malformed',
      duration_ms: String(durationMs),
    });
    throw new Error('Malformed eligibility response');
  }

  const walkthrough = body.walkthrough ?? null;
  trackEvent('walkthrough.eligibility_evaluated', {
    outcome: walkthrough ? 'eligible' : 'none',
    duration_ms: String(durationMs),
    ...(walkthrough ? { walkthroughId: walkthrough.id } : {}),
  });
  return walkthrough;
}

export interface UseWalkthroughEligibilityOptions {
  projectId: string | null | undefined;
  userId: string | null | undefined;
  enabled?: boolean;
}

export interface UseWalkthroughEligibilityResult {
  candidate: WalkthroughDefinition | null;
  isLoading: boolean;
  isError: boolean;
  isFetched: boolean;
  isSettled: boolean;
  error: Error | null;
}

/**
 * Background eligibility fetch. Failures yield no candidate (fail-closed for Walkthroughs).
 */
export function useWalkthroughEligibility({
  projectId,
  userId,
  enabled = true,
}: UseWalkthroughEligibilityOptions): UseWalkthroughEligibilityResult {
  const canFetch = Boolean(enabled && projectId && userId);

  const query = useQuery({
    queryKey: walkthroughEligibilityQueryKey(projectId, userId),
    queryFn: () => fetchNextEligible(projectId!),
    enabled: canFetch,
    retry: false,
    staleTime: 60_000,
    // Project entry is an eligibility boundary. A cached "none" may predate a
    // re-show publish in another session, so always verify it on host remount.
    refetchOnMount: 'always',
  });

  // Cached data is available while the mount refetch runs. Do not let overlay
  // arbitration consume that stale value before the entry check completes.
  const isSettled =
    !canFetch || (!query.isFetching && (query.isFetchedAfterMount || query.isError));

  return {
    candidate: query.isError ? null : (query.data ?? null),
    isLoading: canFetch && query.isLoading,
    isError: query.isError,
    isFetched: query.isFetched,
    isSettled,
    error: query.error instanceof Error ? query.error : query.error ? new Error(String(query.error)) : null,
  };
}
