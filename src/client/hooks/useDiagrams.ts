import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DiagramDetail,
  DiagramListScope,
  DiagramSummary,
  UpdateDiagramInput,
} from '../../shared/types/diagram';
import {
  DiagramApiError,
  deleteDiagram,
  listDiagrams,
  updateDiagram,
} from '../services/diagramApi';

export const DIAGRAM_LIST_LIMIT = 50;

export type DiagramListPage = {
  items: DiagramSummary[];
  nextOffset?: number;
  hasMore: boolean;
};

export function diagramsQueryKey(
  scope: DiagramListScope,
  projectId: string,
  offset: number,
) {
  return ['diagrams', scope, projectId, offset] as const;
}

function invalidateDiagramLists(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
) {
  void queryClient.invalidateQueries({ queryKey: ['diagrams', 'owned', projectId] });
  void queryClient.invalidateQueries({ queryKey: ['diagrams', 'shared', projectId] });
}

async function fetchDiagramListPage(
  projectId: string,
  scope: DiagramListScope,
  offset: number,
): Promise<DiagramListPage> {
  const data = await listDiagrams(projectId, {
    scope,
    limit: DIAGRAM_LIST_LIMIT,
    offset,
  });
  return {
    items: data.items,
    nextOffset: data.nextOffset,
    hasMore: data.nextOffset !== undefined,
  };
}

export function useOwnedDiagrams(projectId: string | null, offset = 0) {
  return useQuery<DiagramListPage, DiagramApiError>({
    queryKey: diagramsQueryKey('owned', projectId ?? '', offset),
    queryFn: () => fetchDiagramListPage(projectId!, 'owned', offset),
    enabled: Boolean(projectId),
    retry: false,
  });
}

export function useSharedDiagrams(projectId: string | null, offset = 0) {
  return useQuery<DiagramListPage, DiagramApiError>({
    queryKey: diagramsQueryKey('shared', projectId ?? '', offset),
    queryFn: () => fetchDiagramListPage(projectId!, 'shared', offset),
    enabled: Boolean(projectId),
    retry: false,
  });
}

export function useUpdateDiagram(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<
    DiagramDetail,
    DiagramApiError,
    { id: string; input: UpdateDiagramInput }
  >({
    mutationFn: ({ id, input }) => updateDiagram(projectId!, id, input),
    onSuccess: () => {
      if (!projectId) return;
      invalidateDiagramLists(queryClient, projectId);
    },
  });
}

export function useDeleteDiagram(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<void, DiagramApiError, string>({
    mutationFn: (id) => deleteDiagram(projectId!, id),
    onSuccess: () => {
      if (!projectId) return;
      invalidateDiagramLists(queryClient, projectId);
    },
  });
}
