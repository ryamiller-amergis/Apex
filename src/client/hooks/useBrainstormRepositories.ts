import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BrainstormCatalogRepositoryDto,
  BrainstormRepositoryDriftResult,
} from '../../shared/types/brainstormSources';
import { apiFetch, retryUnlessClientError } from './useBrainstormSessions';

export const brainstormRepositoryKeys = {
  list: (project: string) => ['brainstorm', project, 'repositories'] as const,
};

function repositoryPath(project: string, suffix = ''): string {
  return `/api/brainstorm/repositories${suffix}?project=${encodeURIComponent(project)}`;
}

export function useBrainstormRepositories(project: string, enabled: boolean) {
  return useQuery({
    queryKey: brainstormRepositoryKeys.list(project),
    enabled: enabled && Boolean(project),
    queryFn: () => apiFetch<{ repositories: BrainstormCatalogRepositoryDto[] }>(repositoryPath(project)),
    retry: retryUnlessClientError,
    refetchInterval: (query) => (
      query.state.data?.repositories.some((row) => row.status === 'cloning') ? 3_000 : false
    ),
  });
}

export function useAddBrainstormRepository(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { displayName: string; cloneUrl: string; branch: string }) =>
      apiFetch<{ repository: BrainstormCatalogRepositoryDto }>(repositoryPath(project), {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSettled: () => client.invalidateQueries({ queryKey: brainstormRepositoryKeys.list(project) }),
  });
}

export function useCloneBrainstormRepository(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ repository: BrainstormCatalogRepositoryDto }>(
        repositoryPath(project, `/${encodeURIComponent(id)}/clone`),
        { method: 'POST', body: '{}' },
      ),
    onSettled: () => client.invalidateQueries({ queryKey: brainstormRepositoryKeys.list(project) }),
  });
}

export function useDeleteBrainstormRepository(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: true; id: string }>(
        repositoryPath(project, `/${encodeURIComponent(id)}`),
        { method: 'DELETE' },
      ),
    onSettled: () => client.invalidateQueries({ queryKey: brainstormRepositoryKeys.list(project) }),
  });
}

export function useCheckBrainstormRepositoryDrift(project: string) {
  return useMutation({
    mutationFn: async (id: string) => {
      const body = await apiFetch<{ drift: BrainstormRepositoryDriftResult }>(
        repositoryPath(project, `/${encodeURIComponent(id)}/drift`),
        { method: 'POST', body: '{}' },
      );
      return body.drift;
    },
  });
}
