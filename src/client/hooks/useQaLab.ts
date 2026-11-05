import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../utils/apiFetch';
import type { WorkItem } from '../types/workitem';
import type {
  QaAdoSuiteSelection,
  QaAdoTestPlanOption,
  QaLabCaseComment,
  QaLabCaseRegeneration,
  QaLabCaseReview,
  QaLabGenerateRequest,
  QaLabGenerationCandidates,
  QaLabNewPlacementApproval,
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

/** Full fields of the selected work item, for the QA Lab details panel. */
export function useQaLabWorkItemDetail(
  project: string | null,
  workItemId: number | null,
  enabled: boolean,
) {
  return useQuery<WorkItem>({
    queryKey: ['qa-lab', 'work-item-detail', project, workItemId],
    queryFn: () =>
      apiFetch(`/api/workitems/${workItemId}?project=${encodeURIComponent(project ?? '')}`),
    enabled: enabled && !!project && !!workItemId,
    staleTime: 60_000,
  });
}

/** Test Plans and static suites the signed-in user can publish a suite into. */
export function useAdoTestPlanOptions(suiteId: string | null, enabled: boolean) {
  return useQuery<{ plans: QaAdoTestPlanOption[] }>({
    queryKey: ['qa-lab', 'test-plans', suiteId],
    queryFn: () => apiFetch(`/api/interviews/ado-test-suites/${suiteId}/test-plans`),
    enabled: enabled && !!suiteId,
    staleTime: 5 * 60_000,
  });
}

/** PBIs and Bugs beneath an ADO work item, for choosing what to generate. */
export function useAdoGenerationCandidates(
  project: string | null,
  workItemId: number | null,
  enabled: boolean,
) {
  return useQuery<QaLabGenerationCandidates>({
    queryKey: ['qa-lab', 'generation-candidates', project, workItemId],
    queryFn: () =>
      apiFetch(
        `/api/interviews/work-items/${workItemId}/test-cases/candidates?project=${encodeURIComponent(project ?? '')}`,
      ),
    enabled: enabled && !!project && !!workItemId,
    staleTime: 60_000,
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
    mutationFn: ({ project, workItemId, model, effort, targetIds }) =>
      apiFetch(`/api/interviews/work-items/${workItemId}/test-cases/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, model, effort, targetIds }),
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
    {
      suiteId: string;
      selections?: Record<string, QaAdoSuiteSelection>;
      localCaseIds?: string[];
      updateLocalCaseIds?: string[];
      newPlacements?: QaLabNewPlacementApproval[];
      newPlacementSelections?: Record<string, string>;
    }
  >({
    mutationFn: async ({
      suiteId,
      selections,
      localCaseIds,
      updateLocalCaseIds,
      newPlacements,
      newPlacementSelections,
    }) => {
      const result = await apiFetch<{
        published: QaLabPublishedCase[];
        skippedLocalCaseIds: string[];
        failures: Array<{ localCaseId: string; message: string }>;
      }>(`/api/interviews/ado-test-suites/${suiteId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(selections ? { selections } : {}),
          ...(localCaseIds ? { localCaseIds } : {}),
          ...(updateLocalCaseIds ? { updateLocalCaseIds } : {}),
          ...(newPlacements ? { newPlacements } : {}),
          ...(newPlacementSelections ? { newPlacementSelections } : {}),
        }),
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

/** Remove generated cases from an ADO-native suite before they are published. */
export function useDeleteAdoTestCases() {
  const queryClient = useQueryClient();
  return useMutation<
    { deletedLocalCaseIds: string[] },
    Error,
    { suiteId: string; localCaseIds: string[] }
  >({
    mutationFn: ({ suiteId, localCaseIds }) =>
      apiFetch(`/api/interviews/ado-test-suites/${suiteId}/delete-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localCaseIds }),
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['qa-lab'] });
    },
  });
}

const caseReviewKey = (suiteId: string | null) => ['qa-lab', 'case-review', suiteId] as const;
const CASE_REVIEW_POLL_MS = 5_000;

/**
 * Comments and the latest regeneration per case. Polls while a case is
 * regenerating and refreshes the cases once it finishes.
 */
export function useAdoCaseReview(suiteId: string | null) {
  const queryClient = useQueryClient();
  const query = useQuery<QaLabCaseReview>({
    queryKey: caseReviewKey(suiteId),
    queryFn: () => apiFetch(`/api/interviews/ado-test-suites/${suiteId}/case-review`),
    enabled: !!suiteId,
    refetchInterval: (current) =>
      current.state.data?.regenerations.some((run) => run.status === 'generating')
        ? CASE_REVIEW_POLL_MS
        : false,
  });

  const generatingIds = (query.data?.regenerations ?? [])
    .filter((run) => run.status === 'generating')
    .map((run) => run.id)
    .join(',');
  const previousGeneratingIds = useRef(generatingIds);
  useEffect(() => {
    const stillGenerating = new Set(generatingIds.split(','));
    const finishedOne = previousGeneratingIds.current
      .split(',')
      .some((id) => id.length > 0 && !stillGenerating.has(id));
    previousGeneratingIds.current = generatingIds;
    if (finishedOne) {
      void queryClient.invalidateQueries({ queryKey: ['qa-lab', 'work-item-test-cases'] });
    }
  }, [generatingIds, queryClient]);

  return query;
}

export function useAddCaseComment() {
  const queryClient = useQueryClient();
  return useMutation<QaLabCaseComment, Error, { suiteId: string; localCaseId: string; body: string }>({
    mutationFn: ({ suiteId, localCaseId, body }) =>
      apiFetch(
        `/api/interviews/ado-test-suites/${suiteId}/cases/${encodeURIComponent(localCaseId)}/comments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        },
      ),
    onSettled: (_data, _error, { suiteId }) => {
      void queryClient.invalidateQueries({ queryKey: caseReviewKey(suiteId) });
    },
  });
}

export function useRegenerateCase() {
  const queryClient = useQueryClient();
  return useMutation<QaLabCaseRegeneration, Error, { suiteId: string; localCaseId: string; model?: string }>({
    mutationFn: ({ suiteId, localCaseId, model }) =>
      apiFetch(
        `/api/interviews/ado-test-suites/${suiteId}/cases/${encodeURIComponent(localCaseId)}/regenerate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(model ? { model } : {}),
        },
      ),
    onSettled: (_data, _error, { suiteId }) => {
      void queryClient.invalidateQueries({ queryKey: caseReviewKey(suiteId) });
    },
  });
}

export function useRestoreCase() {
  const queryClient = useQueryClient();
  return useMutation<QaLabCaseRegeneration, Error, { suiteId: string; regenerationId: string }>({
    mutationFn: ({ suiteId, regenerationId }) =>
      apiFetch(`/api/interviews/ado-test-suites/${suiteId}/regenerations/${regenerationId}/restore`, {
        method: 'POST',
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['qa-lab'] });
    },
  });
}
