import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ListWorkflowMessageFeedbackResponse,
  PutWorkflowMessageFeedbackResponse,
  WorkflowMessageFeedbackSurface,
  WorkflowMessageRating,
} from '../../shared/types/workflowMessageFeedback';
import {
  workflowEvaluationFetch,
  workflowEvaluationsUrl,
  type WorkflowEvaluationApiError,
} from './useWorkflowEvaluations';

export const workflowMessageFeedbackKeys = {
  subject: (project: string | undefined, surface: WorkflowMessageFeedbackSurface, subjectId: string) =>
    ['workflow-message-feedback', project, surface, subjectId] as const,
};

export function useWorkflowMessageFeedback(options: {
  project: string | undefined;
  surface: WorkflowMessageFeedbackSurface;
  subjectId: string;
  enabled: boolean;
}) {
  const { project, surface, subjectId, enabled } = options;
  return useQuery<ListWorkflowMessageFeedbackResponse, WorkflowEvaluationApiError>({
    queryKey: workflowMessageFeedbackKeys.subject(project, surface, subjectId),
    queryFn: () => {
      const params = new URLSearchParams({ surface, subjectId });
      return workflowEvaluationFetch(workflowEvaluationsUrl(project!, `/message-feedback?${params}`));
    },
    enabled: enabled && Boolean(project) && Boolean(subjectId),
    staleTime: 60_000,
    retry: false,
  });
}

export function usePutWorkflowMessageFeedback(options: {
  project: string | undefined;
  surface: WorkflowMessageFeedbackSurface;
  subjectId: string;
}) {
  const { project, surface, subjectId } = options;
  const queryClient = useQueryClient();
  const key = workflowMessageFeedbackKeys.subject(project, surface, subjectId);
  return useMutation<
    PutWorkflowMessageFeedbackResponse,
    WorkflowEvaluationApiError,
    { messageId: string; rating: WorkflowMessageRating | null; comment?: string | null }
  >({
    mutationFn: ({ messageId, rating, comment }) =>
      workflowEvaluationFetch(
        workflowEvaluationsUrl(project!, `/message-feedback/${encodeURIComponent(messageId)}`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ surface, subjectId, rating, comment: comment ?? null }),
        },
      ),
    onSuccess: (result, { messageId }) => {
      queryClient.setQueryData<ListWorkflowMessageFeedbackResponse>(key, (current) => {
        const entries = (current?.entries ?? []).filter((entry) => entry.messageId !== messageId);
        return {
          surface,
          subjectId,
          entries: result.entry ? [...entries, result.entry] : entries,
        };
      });
    },
  });
}
