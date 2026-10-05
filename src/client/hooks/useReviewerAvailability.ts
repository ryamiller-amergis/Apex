import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../utils/apiFetch';
import type { ReviewerAvailabilityResponse } from '../../shared/types/approvals';

/**
 * Which router owns the availability endpoint. `interviews` covers the kickoff
 * modules (prd, design_doc, design_prototype, test_case); `adr` covers adr.
 */
export type ReviewerAvailabilitySurface = 'interviews' | 'adr';

/**
 * Live "does this module have at least one selectable reviewer right now"
 * signal. Deliberately not cached across mounts (`staleTime: 0`) so each
 * kickoff recomputes against the current pool membership.
 */
export function useReviewerAvailability(
  project: string | null,
  surface: ReviewerAvailabilitySurface = 'interviews',
) {
  return useQuery<ReviewerAvailabilityResponse>({
    queryKey: ['reviewer-availability', surface, project],
    queryFn: () =>
      apiFetch<ReviewerAvailabilityResponse>(
        `/api/${surface}/reviewer-availability?project=${encodeURIComponent(project ?? '')}`,
      ),
    enabled: !!project,
    staleTime: 0,
    refetchOnMount: 'always',
  });
}
