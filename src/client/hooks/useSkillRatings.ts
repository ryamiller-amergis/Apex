import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatMessageRating } from '../../shared/types/workflowMessageFeedback';
import type { SkillRatingEntry, SkillRatingSurface } from '../../shared/types/skillRating';
import {
  workflowEvaluationFetch,
  workflowEvaluationsUrl,
  type WorkflowEvaluationApiError,
} from './useWorkflowEvaluations';

export const skillRatingKeys = {
  surface: (project: string | undefined, surface: SkillRatingSurface) => ['skill-ratings', project, surface] as const,
  subjects: (project: string | undefined, surface: SkillRatingSurface, subjectIds: readonly string[]) =>
    ['skill-ratings', project, surface, [...subjectIds].sort().join(',')] as const,
};

/** The signed-in person's ratings for these items, keyed by subject id. */
export function useSkillRatings(options: {
  project: string | undefined;
  surface: SkillRatingSurface;
  subjectIds: readonly string[];
  enabled: boolean;
}) {
  const { project, surface, subjectIds, enabled } = options;
  const query = useQuery<SkillRatingEntry[], WorkflowEvaluationApiError>({
    queryKey: skillRatingKeys.subjects(project, surface, subjectIds),
    queryFn: () => {
      const params = new URLSearchParams({ surface, subjectIds: subjectIds.join(',') });
      return workflowEvaluationFetch(workflowEvaluationsUrl(project!, `/skill-ratings?${params}`));
    },
    enabled: enabled && Boolean(project) && subjectIds.length > 0,
    staleTime: 60_000,
    retry: false,
  });
  return new Map((query.data ?? []).map((entry) => [entry.subjectId, entry]));
}

export interface PutSkillRatingVariables {
  subjectType: string;
  subjectId: string;
  threadId: string | null;
  rating: ChatMessageRating | null;
  comment: string | null;
}

export function usePutSkillRating(options: { project: string | undefined; surface: SkillRatingSurface }) {
  const { project, surface } = options;
  const queryClient = useQueryClient();
  return useMutation<{ entry: SkillRatingEntry | null }, WorkflowEvaluationApiError, PutSkillRatingVariables>({
    mutationFn: (variables) =>
      workflowEvaluationFetch(workflowEvaluationsUrl(project!, '/skill-ratings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface, ...variables }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: skillRatingKeys.surface(project, surface) }),
  });
}
