import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  CreateSkillHealthWorkItemRequest,
  SkillHealthOverview,
  SkillHealthPeriodDays,
  SkillHealthWorkItemResult,
} from '../../shared/types/skillHealth';
import { adminFetch } from './useFoundationSkillAdmin';

export const skillHealthKeys = {
  overview: (days: SkillHealthPeriodDays) => ['skill-health', 'overview', days] as const,
};

export function useSkillHealth(days: SkillHealthPeriodDays) {
  return useQuery<SkillHealthOverview>({
    queryKey: skillHealthKeys.overview(days),
    queryFn: () => adminFetch<SkillHealthOverview>(`/api/platform-admin/skill-health?days=${days}`),
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateSkillHealthWorkItem() {
  return useMutation<SkillHealthWorkItemResult, Error, CreateSkillHealthWorkItemRequest>({
    mutationFn: (request) =>
      adminFetch<SkillHealthWorkItemResult>('/api/platform-admin/skill-health/work-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }),
  });
}
