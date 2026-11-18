import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PlaybookDryRunIssue,
  PlaybookDryRunResult,
  PlaybookGraph,
  PlaybookLayoutPositions,
  PlaybookSkillOption,
  PlaybookStepTypePaletteItem,
  PlaybookVersionLayout,
} from '../../shared/types/playbook';
import { PlaybookApiError } from './usePlaybookDefinitions';
import { useDebouncedValue } from './useDebouncedValue';

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const { error, nodeId } = body as { error?: string; nodeId?: unknown };
    throw new PlaybookApiError(
      error ?? `Request failed: ${response.status}`,
      response.status,
      typeof nodeId === 'string' && nodeId ? nodeId : undefined,
    );
  }
  return response.json() as Promise<T>;
}

/**
 * Every problem in the graph on screen, including edits not saved yet. The check runs on the
 * server so the canvas and publish cannot disagree about what is wrong.
 */
export function usePlaybookGraphIssues(
  project: string | undefined,
  graph: PlaybookGraph,
  enabled: boolean,
) {
  const settled = useDebouncedValue(graph, 400);
  return useQuery<{ issues: PlaybookDryRunIssue[] }>({
    queryKey: ['playbook-graph-issues', project, JSON.stringify(settled)],
    queryFn: () =>
      apiRequest('/api/playbooks/graph/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, graph: settled }),
      }),
    enabled: Boolean(project && enabled && settled.nodes.length > 0),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function usePlaybookStepPalette(project: string | undefined, enabled: boolean) {
  return useQuery<{ items: PlaybookStepTypePaletteItem[] }>({
    queryKey: ['playbook-step-palette', project],
    queryFn: () => apiRequest(`/api/playbooks/step-types?project=${encodeURIComponent(project!)}`),
    enabled: Boolean(project && enabled),
    staleTime: 60_000,
  });
}

export function usePlaybookSkills(project: string | undefined) {
  return useQuery<{ skills: PlaybookSkillOption[] }>({
    queryKey: ['playbook-skills', project],
    queryFn: () => apiRequest(`/api/playbooks/skills?project=${encodeURIComponent(project!)}`),
    enabled: Boolean(project),
    staleTime: 60_000,
  });
}

export function usePlaybookVersionLayout(
  project: string | undefined,
  definitionId: string | null,
  versionId: string | null,
  enabled: boolean,
) {
  return useQuery<PlaybookVersionLayout>({
    queryKey: ['playbook-version-layout', project, definitionId, versionId],
    queryFn: () =>
      apiRequest(
        `/api/playbooks/definitions/${encodeURIComponent(definitionId!)}/versions/${encodeURIComponent(versionId!)}/layout?project=${encodeURIComponent(project!)}`,
      ),
    enabled: Boolean(project && definitionId && versionId && enabled),
    staleTime: 0,
  });
}

export function usePlaybookVersionGraph(
  project: string | undefined,
  definitionId: string | null,
  versionId: string | null,
  enabled: boolean,
) {
  return useQuery<{ graph: PlaybookGraph }>({
    queryKey: ['playbook-version-graph', project, definitionId, versionId],
    queryFn: () =>
      apiRequest(
        `/api/playbooks/definitions/${encodeURIComponent(definitionId!)}/versions/${encodeURIComponent(versionId!)}/graph?project=${encodeURIComponent(project!)}`,
      ),
    enabled: Boolean(project && definitionId && versionId && enabled),
    staleTime: 0,
  });
}

export function useValidatePlaybookConnection(project: string) {
  return useMutation<{ ok: true }, PlaybookApiError, { graph: PlaybookGraph }>({
    mutationFn: (body) =>
      apiRequest('/api/playbooks/graph/validate-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, graph: body.graph }),
      }),
  });
}

export function useSavePlaybookLayout(
  project: string,
  definitionId: string,
  versionId: string,
) {
  const queryClient = useQueryClient();
  return useMutation<PlaybookVersionLayout, PlaybookApiError, PlaybookLayoutPositions>({
    mutationFn: (positions) =>
      apiRequest(
        `/api/playbooks/definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/layout`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project, positions }),
        },
      ),
    onSuccess: (layout) => {
      queryClient.setQueryData(
        ['playbook-version-layout', project, definitionId, versionId],
        layout,
      );
    },
  });
}

export function usePlaybookDryRun(project: string, definitionId: string) {
  return useMutation<PlaybookDryRunResult, PlaybookApiError, Record<string, unknown>>({
    mutationFn: (stubs) =>
      apiRequest(`/api/playbooks/definitions/${encodeURIComponent(definitionId)}/dry-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, stubs }),
      }),
  });
}
