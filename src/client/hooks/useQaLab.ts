import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../utils/apiFetch';
import type {
  QaLabGenerateRequest,
  QaLabWorkItemTestCases,
} from '../../shared/types/qaLab';

export const qaLabWorkItemKey = (project: string | null, workItemId: number | null) =>
  ['qa-lab', 'work-item-test-cases', project, workItemId] as const;

/**
 * Generated test cases for an ADO work item, resolved server-side through the
 * `adoWorkItemId` stamped on each PRD backlog.
 */
export function useWorkItemTestCases(
  project: string | null,
  workItemId: number | null,
  enabled = true,
) {
  return useQuery<QaLabWorkItemTestCases>({
    queryKey: qaLabWorkItemKey(project, workItemId),
    queryFn: () =>
      apiFetch(
        `/api/interviews/work-items/${workItemId}/test-cases?project=${encodeURIComponent(project ?? '')}`,
      ),
    enabled: enabled && !!project && !!workItemId,
    staleTime: 30_000,
  });
}

/**
 * Kicks off on-demand test-case generation for a PRD, optionally overriding the
 * model and effort chosen in the QA Lab composer.
 */
export function useGenerateTestCasesForPrd() {
  const queryClient = useQueryClient();
  return useMutation<
    { started: boolean },
    Error,
    { prdId: string } & QaLabGenerateRequest
  >({
    mutationFn: ({ prdId, model, effort }) =>
      apiFetch(`/api/interviews/prds/${prdId}/test-cases/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, effort }),
      }),
    onSuccess: (_data, { prdId }) => {
      void queryClient.invalidateQueries({ queryKey: ['prd-test-cases', prdId] });
      void queryClient.invalidateQueries({ queryKey: ['qa-lab'] });
    },
  });
}
