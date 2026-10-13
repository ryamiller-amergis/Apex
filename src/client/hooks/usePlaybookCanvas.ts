import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  PlaybookDryRunResult,
  PlaybookGraph,
  PlaybookLayoutPositions,
  PlaybookStepTypePaletteItem,
  PlaybookVersionLayout,
} from '../../shared/types/playbook';
import { PlaybookApiError } from './usePlaybookDefinitions';

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

export function usePlaybookStepPalette(project: string | undefined, enabled: boolean) {
  return useQuery<{ items: PlaybookStepTypePaletteItem[] }>({
    queryKey: ['playbook-step-palette', project],
    queryFn: () => apiRequest(`/api/playbooks/step-types?project=${encodeURIComponent(project!)}`),
    enabled: Boolean(project && enabled),
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
