import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../utils/apiFetch';
import type {
  QaLabGenerateRequest,
  QaLabPublishedCase,
  QaLabWorkItemList,
  QaLabWorkItemTestCases,
} from '../../shared/types/qaLab';

export const qaLabWorkItemListKey = (project: string | null) =>
  ['qa-lab', 'work-items', project] as const;

/**
 * Every Epic, Feature, PBI, TBI, and Bug in the selected Azure DevOps project.
 */
export function useQaLabWorkItems(project: string | null) {
  const isAdoProject = !!project && project.toLowerCase() !== 'apex';
  return useQuery<QaLabWorkItemList>({
    queryKey: qaLabWorkItemListKey(project),
    queryFn: () =>
      apiFetch(
        `/api/interviews/work-items?project=${encodeURIComponent(project ?? '')}`,
      ),
    enabled: isAdoProject,
    staleTime: 60_000,
  });
}

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
    refetchInterval: (query) =>
      query.state.data?.generation?.testCaseStatus === 'generating'
      || query.state.data?.externalSuite?.status === 'generating'
        ? 5_000
        : false,
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
    mutationFn: ({ prdId, model, effort, pbiIds, matchLevel, matchedTitle }) =>
      apiFetch(`/api/interviews/prds/${prdId}/test-cases/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, effort, pbiIds, matchLevel, matchedTitle }),
      }),
    onSuccess: (_data, { prdId }) => {
      void queryClient.invalidateQueries({ queryKey: ['prd-test-cases', prdId] });
      void queryClient.invalidateQueries({ queryKey: ['qa-lab'] });
    },
  });
}

/** Generate cases from ADO itself when the selected item has no Apex PRD. */
export function useGenerateTestCasesForAdoWorkItem() {
  const queryClient = useQueryClient();
  return useMutation<
    { started: boolean; suiteId: string },
    Error,
    { project: string; workItemId: number } & QaLabGenerateRequest
  >({
    mutationFn: ({ project, workItemId, model, effort }) =>
      apiFetch(`/api/interviews/work-items/${workItemId}/test-cases/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, model, effort }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['qa-lab'] });
    },
  });
}

/** Publish an ADO-native generated suite as linked ADO Test Case work items. */
export function usePublishAdoTestSuite() {
  const queryClient = useQueryClient();
  return useMutation<
    {
      published: QaLabPublishedCase[];
      skippedLocalCaseIds: string[];
      failures: Array<{ localCaseId: string; message: string }>;
    },
    Error,
    { suiteId: string }
  >({
    mutationFn: async ({ suiteId }) => {
      const result = await apiFetch<{
        published: QaLabPublishedCase[];
        skippedLocalCaseIds: string[];
        failures: Array<{ localCaseId: string; message: string }>;
      }>(`/api/interviews/ado-test-suites/${suiteId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (result.failures.length > 0) {
        throw new Error(
          `${result.failures.length} test case${result.failures.length === 1 ? '' : 's'} could not be published: ${result.failures[0].message}`,
        );
      }
      return result;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['qa-lab'] });
    },
  });
}
