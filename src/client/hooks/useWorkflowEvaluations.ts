import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateWorkflowEvaluationRequest,
  GetWorkflowEvaluationDefinitionsResponse,
  ListWorkflowEvaluationEventsResponse,
  WorkflowEvaluationEvent,
  WorkflowEvaluationSubjectType,
} from '../../shared/types/workflowEvaluation';

export class WorkflowEvaluationApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'WorkflowEvaluationApiError';
    this.status = status;
    this.code = code;
  }
}

/** The route pins the project from the path, so no X-Apex-Project header is sent. */
export async function workflowEvaluationFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new WorkflowEvaluationApiError(
      body.error ?? `Request failed: ${response.status}`,
      response.status,
      body.code,
    );
  }
  return response.json() as Promise<T>;
}

export function workflowEvaluationsUrl(project: string, path: string): string {
  return `/api/projects/${encodeURIComponent(project)}/workflow-evaluations${path}`;
}

export const workflowEvaluationKeys = {
  definitions: (project: string | undefined, subjectType: WorkflowEvaluationSubjectType, stageKey: string) =>
    ['workflow-evaluations', 'definitions', project, subjectType, stageKey] as const,
  subjectEvents: (project: string | undefined, subjectType: WorkflowEvaluationSubjectType, subjectId: string) =>
    ['workflow-evaluations', 'events', project, subjectType, subjectId] as const,
};

export function useWorkflowEvaluationDefinitions(options: {
  project: string | undefined;
  subjectType: WorkflowEvaluationSubjectType;
  stageKey: string;
  enabled: boolean;
}) {
  const { project, subjectType, stageKey, enabled } = options;
  return useQuery<GetWorkflowEvaluationDefinitionsResponse, WorkflowEvaluationApiError>({
    queryKey: workflowEvaluationKeys.definitions(project, subjectType, stageKey),
    queryFn: () => {
      const params = new URLSearchParams({ subjectType, stageKey });
      return workflowEvaluationFetch(workflowEvaluationsUrl(project!, `/definitions?${params}`));
    },
    enabled: enabled && Boolean(project),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useWorkflowEvaluationEvents(options: {
  project: string | undefined;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  stageKey: string;
  includeOlderVersions: boolean;
  /** Changes when the subject is edited, so the server recomputes the live hash. */
  subjectVersion?: string;
  enabled: boolean;
}) {
  const { project, subjectType, subjectId, stageKey, includeOlderVersions, subjectVersion, enabled } = options;
  return useQuery<ListWorkflowEvaluationEventsResponse, WorkflowEvaluationApiError>({
    queryKey: [
      ...workflowEvaluationKeys.subjectEvents(project, subjectType, subjectId),
      stageKey,
      includeOlderVersions,
      subjectVersion ?? null,
    ],
    queryFn: () => {
      const params = new URLSearchParams({
        subjectType,
        subjectId,
        stageKey,
        includeOlder: String(includeOlderVersions),
      });
      return workflowEvaluationFetch(workflowEvaluationsUrl(project!, `/events?${params}`));
    },
    enabled: enabled && Boolean(project) && Boolean(subjectId),
    staleTime: 30_000,
    retry: false,
  });
}

export function useSubmitWorkflowEvaluation(options: {
  project: string | undefined;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
}) {
  const { project, subjectType, subjectId } = options;
  const queryClient = useQueryClient();
  return useMutation<WorkflowEvaluationEvent, WorkflowEvaluationApiError, CreateWorkflowEvaluationRequest>({
    mutationFn: (body) =>
      workflowEvaluationFetch(workflowEvaluationsUrl(project!, '/events'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowEvaluationKeys.subjectEvents(project, subjectType, subjectId),
      });
    },
  });
}
