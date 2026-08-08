import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DiagramShare,
  DiagramShareAccess,
  DiagramShareTarget,
  UpsertDiagramShareInput,
} from '../../shared/types/diagram';
import {
  DiagramApiError,
  changeDiagramShareAccess,
  createDiagramShare,
  listDiagramShares,
  listShareTargets,
  revokeDiagramShare,
} from '../services/diagramApi';

export function diagramSharesQueryKey(projectId: string, diagramId: string) {
  return ['diagram-shares', projectId, diagramId] as const;
}

export function shareTargetsQueryKey(
  projectId: string,
  diagramId: string,
  query: string,
) {
  return ['diagram-share-targets', projectId, diagramId, query] as const;
}

export function useDiagramShares(
  projectId: string | null,
  diagramId: string | null,
  enabled = true,
) {
  return useQuery<DiagramShare[], DiagramApiError>({
    queryKey: diagramSharesQueryKey(projectId ?? '', diagramId ?? ''),
    queryFn: () => listDiagramShares(projectId!, diagramId!),
    enabled: Boolean(projectId && diagramId && enabled),
    retry: false,
  });
}

export function useShareTargets(
  projectId: string | null,
  diagramId: string | null,
  query: string,
  enabled = true,
) {
  return useQuery<DiagramShareTarget[], DiagramApiError>({
    queryKey: shareTargetsQueryKey(projectId ?? '', diagramId ?? '', query),
    queryFn: () => listShareTargets(projectId!, diagramId!, query),
    enabled: Boolean(projectId && diagramId && enabled),
    retry: false,
  });
}

function invalidateShares(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  diagramId: string,
) {
  void queryClient.invalidateQueries({
    queryKey: diagramSharesQueryKey(projectId, diagramId),
  });
  void queryClient.invalidateQueries({
    queryKey: ['diagram-share-targets', projectId, diagramId],
  });
}

export function useCreateShare(projectId: string | null, diagramId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<DiagramShare, DiagramApiError, UpsertDiagramShareInput>({
    mutationFn: (input) => createDiagramShare(projectId!, diagramId!, input),
    onSuccess: () => {
      if (projectId && diagramId) invalidateShares(queryClient, projectId, diagramId);
    },
  });
}

export function useChangeShareAccess(
  projectId: string | null,
  diagramId: string | null,
) {
  const queryClient = useQueryClient();
  return useMutation<
    DiagramShare,
    DiagramApiError,
    { granteeId: string; access: DiagramShareAccess }
  >({
    mutationFn: ({ granteeId, access }) =>
      changeDiagramShareAccess(projectId!, diagramId!, granteeId, access),
    onSuccess: () => {
      if (projectId && diagramId) invalidateShares(queryClient, projectId, diagramId);
    },
  });
}

export function useRevokeShare(projectId: string | null, diagramId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<void, DiagramApiError, string>({
    mutationFn: (granteeId) => revokeDiagramShare(projectId!, diagramId!, granteeId),
    onSuccess: () => {
      if (projectId && diagramId) invalidateShares(queryClient, projectId, diagramId);
    },
  });
}
