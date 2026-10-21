import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PlaybookDefinitionDetail,
  PlaybookDefinitionDraftResponse,
  PlaybookDefinitionListResult,
  PlaybookDeprecateVersionResponse,
  PlaybookGraph,
  PlaybookPublishResponse,
} from '../../shared/types/playbook';

export class PlaybookApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'PlaybookApiError';
  }
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new PlaybookApiError(
      (body as { error?: string }).error ?? `Request failed: ${response.status}`,
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const playbookDefinitionKeys = {
  list: (project: string | undefined) => ['playbook-definitions', project] as const,
  detail: (project: string | undefined, definitionId: string | null) =>
    ['playbook-definition', project, definitionId] as const,
};

export function usePlaybookDefinitions(project: string | undefined) {
  return useQuery<PlaybookDefinitionListResult>({
    queryKey: playbookDefinitionKeys.list(project),
    queryFn: () =>
      apiRequest(`/api/playbooks/definitions?project=${encodeURIComponent(project!)}`),
    enabled: !!project,
    staleTime: 0,
  });
}

export function usePlaybookDefinition(
  project: string | undefined,
  definitionId: string | null,
) {
  return useQuery<PlaybookDefinitionDetail>({
    queryKey: playbookDefinitionKeys.detail(project, definitionId),
    queryFn: () =>
      apiRequest(
        `/api/playbooks/definitions/${encodeURIComponent(definitionId!)}?project=${encodeURIComponent(project!)}`,
      ),
    enabled: !!project && !!definitionId,
    staleTime: 0,
  });
}

interface DefinitionInput {
  name: string;
  description?: string;
  graph: PlaybookGraph;
}

interface SaveDraftInput extends DefinitionInput {
  expectedDraftUpdatedAt: string;
}

function useInvalidateDefinitions(project: string, definitionId?: string) {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: playbookDefinitionKeys.list(project) }),
      ...(definitionId
        ? [
            queryClient.invalidateQueries({
              queryKey: playbookDefinitionKeys.detail(project, definitionId),
            }),
          ]
        : []),
      queryClient.invalidateQueries({ queryKey: ['playbook-runnable-versions', project] }),
    ]);
  };
}

export function useCreatePlaybookDefinition(project: string) {
  const invalidate = useInvalidateDefinitions(project);
  return useMutation<PlaybookDefinitionDetail, PlaybookApiError, DefinitionInput>({
    mutationFn: (input) =>
      apiRequest('/api/playbooks/definitions', jsonRequest('POST', { project, ...input })),
    onSuccess: invalidate,
  });
}

export function useSavePlaybookDraft(project: string, definitionId: string) {
  const invalidate = useInvalidateDefinitions(project, definitionId);
  return useMutation<PlaybookDefinitionDraftResponse, PlaybookApiError, SaveDraftInput>({
    mutationFn: (input) =>
      apiRequest(
        `/api/playbooks/definitions/${encodeURIComponent(definitionId)}/draft`,
        jsonRequest('PUT', { project, ...input }),
      ),
    onSuccess: invalidate,
  });
}

export function usePublishPlaybookDraft(project: string, definitionId: string) {
  const invalidate = useInvalidateDefinitions(project, definitionId);
  return useMutation<
    PlaybookPublishResponse,
    PlaybookApiError,
    { expectedDraftUpdatedAt: string }
  >({
    mutationFn: ({ expectedDraftUpdatedAt }) =>
      apiRequest(
        `/api/playbooks/definitions/${encodeURIComponent(definitionId)}/publish`,
        jsonRequest('POST', { project, expectedDraftUpdatedAt }),
      ),
    onSuccess: invalidate,
  });
}

export function useDeprecatePlaybookVersion(project: string, definitionId: string) {
  const invalidate = useInvalidateDefinitions(project, definitionId);
  return useMutation<
    PlaybookDeprecateVersionResponse,
    PlaybookApiError,
    { versionId: string }
  >({
    mutationFn: ({ versionId }) =>
      apiRequest(
        `/api/playbooks/definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/deprecate`,
        jsonRequest('POST', { project }),
      ),
    onSuccess: invalidate,
  });
}
