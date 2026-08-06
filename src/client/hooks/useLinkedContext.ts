import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  AddAdrLinkRequest,
  AddDesignModuleLinkRequest,
  LinkCandidateType,
  LinkMutationResult,
  LinkedContextReadModel,
  PaginatedCandidates,
} from '../../shared/types/interviewLinks';

const CANDIDATE_STALE_TIME_MS = 30_000;
const MAX_CANDIDATE_PAGE_SIZE = 50;

export type LinkCandidateFilters = {
  type: LinkCandidateType;
  search?: string;
  offset?: number;
  limit?: number;
};

type NormalizedLinkCandidateFilters = {
  type: LinkCandidateType;
  search?: string;
  offset: number;
  limit: number;
};

export type StagedLinkSelection = {
  type: LinkCandidateType;
  id: string;
};

export type StagedLinkFailure = {
  selection: StagedLinkSelection;
  error: string;
};

export type PersistStagedLinksInput = {
  interviewId: string;
  selections: StagedLinkSelection[];
};

export type PersistStagedLinksResult = {
  linkedContext?: LinkedContextReadModel;
  failures: StagedLinkFailure[];
};

export const interviewLinkKeys = {
  links: (interviewId: string) =>
    ['interview-links', interviewId] as const,
  candidateRoot: (project: string, interviewId: string | null) =>
    ['interview-link-candidates', project, interviewId] as const,
  candidates: (
    project: string,
    interviewId: string | null,
    filters: NormalizedLinkCandidateFilters,
  ) =>
    [
      'interview-link-candidates',
      project,
      interviewId,
      filters,
    ] as const,
};

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'include',
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Request failed: ${response.status}`,
    );
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function normalizeCandidateFilters(
  filters: LinkCandidateFilters,
): NormalizedLinkCandidateFilters {
  const search = filters.search?.trim();
  return {
    type: filters.type,
    ...(search ? { search } : {}),
    offset: Math.max(0, filters.offset ?? 0),
    limit: Math.min(
      MAX_CANDIDATE_PAGE_SIZE,
      Math.max(1, filters.limit ?? MAX_CANDIDATE_PAGE_SIZE),
    ),
  };
}

function candidatesUrl(
  project: string,
  interviewId: string | null,
  filters: NormalizedLinkCandidateFilters,
): string {
  const params = new URLSearchParams();
  if (!interviewId) params.set('project', project);
  params.set('type', filters.type);
  if (filters.search) params.set('search', filters.search);
  params.set('offset', String(filters.offset));
  params.set('limit', String(filters.limit));

  const root = interviewId
    ? `/api/interviews/${encodeURIComponent(interviewId)}/link-candidates`
    : '/api/interviews/link-candidates';
  return `${root}?${params.toString()}`;
}

function reconcileLinkedContext(
  queryClient: QueryClient,
  interviewId: string,
  result: LinkMutationResult,
): void {
  queryClient.setQueryData(
    interviewLinkKeys.links(interviewId),
    result.linkedContext,
  );
}

function invalidateLinkedContext(
  queryClient: QueryClient,
  interviewId: string,
  project: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: interviewLinkKeys.links(interviewId),
  });
  void queryClient.invalidateQueries({
    queryKey: interviewLinkKeys.candidateRoot(project, interviewId),
  });
}

export function useLinkedContext(interviewId: string | null) {
  return useQuery<LinkedContextReadModel, Error>({
    queryKey: ['interview-links', interviewId],
    queryFn: () =>
      apiFetch(
        `/api/interviews/${encodeURIComponent(interviewId!)}/links`,
      ),
    enabled: Boolean(interviewId),
  });
}

export function useLinkCandidates(
  project: string,
  interviewId: string | null,
  filters: LinkCandidateFilters,
) {
  const normalizedFilters = normalizeCandidateFilters(filters);
  return useQuery<PaginatedCandidates, Error>({
    queryKey: interviewLinkKeys.candidates(
      project,
      interviewId,
      normalizedFilters,
    ),
    queryFn: () =>
      apiFetch(candidatesUrl(project, interviewId, normalizedFilters)),
    enabled: Boolean(project),
    staleTime: CANDIDATE_STALE_TIME_MS,
  });
}

export function useAddAdrLink(interviewId: string, project: string) {
  const queryClient = useQueryClient();
  return useMutation<LinkMutationResult, Error, AddAdrLinkRequest>({
    mutationFn: (body) =>
      apiFetch(`/api/interviews/${encodeURIComponent(interviewId)}/links/adr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (result) =>
      reconcileLinkedContext(queryClient, interviewId, result),
    onSettled: () =>
      invalidateLinkedContext(queryClient, interviewId, project),
  });
}

export function useAddDesignModuleLink(
  interviewId: string,
  project: string,
) {
  const queryClient = useQueryClient();
  return useMutation<LinkMutationResult, Error, AddDesignModuleLinkRequest>({
    mutationFn: (body) =>
      apiFetch(
        `/api/interviews/${encodeURIComponent(interviewId)}/links/design-module`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ),
    onSuccess: (result) =>
      reconcileLinkedContext(queryClient, interviewId, result),
    onSettled: () =>
      invalidateLinkedContext(queryClient, interviewId, project),
  });
}

type RemoveMutationContext = {
  previous?: LinkedContextReadModel;
};

export function useRemoveAdrLink(interviewId: string, project: string) {
  const queryClient = useQueryClient();
  return useMutation<LinkMutationResult, Error, string, RemoveMutationContext>({
    mutationFn: (adrId) =>
      apiFetch(
        `/api/interviews/${encodeURIComponent(interviewId)}/links/adr/${encodeURIComponent(adrId)}`,
        { method: 'DELETE' },
      ),
    onMutate: async (adrId) => {
      await queryClient.cancelQueries({
        queryKey: interviewLinkKeys.links(interviewId),
      });
      const previous = queryClient.getQueryData<LinkedContextReadModel>(
        interviewLinkKeys.links(interviewId),
      );
      queryClient.setQueryData<LinkedContextReadModel>(
        interviewLinkKeys.links(interviewId),
        (current) => {
          if (!current) return current;
          const adrLinks = current.adrLinks.filter(
            (link) => link.adrId !== adrId,
          );
          return {
            ...current,
            adrLinks,
            count: adrLinks.length + current.designModuleLinks.length,
          };
        },
      );
      return { previous };
    },
    onError: (_error, _adrId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          interviewLinkKeys.links(interviewId),
          context.previous,
        );
      }
    },
    onSuccess: (result) =>
      reconcileLinkedContext(queryClient, interviewId, result),
    onSettled: () =>
      invalidateLinkedContext(queryClient, interviewId, project),
  });
}

export function useRemoveDesignModuleLink(
  interviewId: string,
  project: string,
) {
  const queryClient = useQueryClient();
  return useMutation<LinkMutationResult, Error, string, RemoveMutationContext>({
    mutationFn: (designModuleId) =>
      apiFetch(
        `/api/interviews/${encodeURIComponent(interviewId)}/links/design-module/${encodeURIComponent(designModuleId)}`,
        { method: 'DELETE' },
      ),
    onMutate: async (designModuleId) => {
      await queryClient.cancelQueries({
        queryKey: interviewLinkKeys.links(interviewId),
      });
      const previous = queryClient.getQueryData<LinkedContextReadModel>(
        interviewLinkKeys.links(interviewId),
      );
      queryClient.setQueryData<LinkedContextReadModel>(
        interviewLinkKeys.links(interviewId),
        (current) => {
          if (!current) return current;
          const designModuleLinks = current.designModuleLinks.filter(
            (link) => link.designModuleId !== designModuleId,
          );
          return {
            ...current,
            designModuleLinks,
            count: current.adrLinks.length + designModuleLinks.length,
          };
        },
      );
      return { previous };
    },
    onError: (_error, _designModuleId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          interviewLinkKeys.links(interviewId),
          context.previous,
        );
      }
    },
    onSuccess: (result) =>
      reconcileLinkedContext(queryClient, interviewId, result),
    onSettled: () =>
      invalidateLinkedContext(queryClient, interviewId, project),
  });
}

/**
 * Persists kickoff selections after Interview creation without rolling back the
 * Interview. Each artifact failure remains associated with its staged row.
 */
export function usePersistStagedLinks(project: string) {
  const queryClient = useQueryClient();
  return useMutation<
    PersistStagedLinksResult,
    Error,
    PersistStagedLinksInput
  >({
    mutationFn: async ({ interviewId, selections }) => {
      let linkedContext: LinkedContextReadModel | undefined;
      const failures: StagedLinkFailure[] = [];

      for (const selection of selections) {
        try {
          const path = selection.type === 'adr' ? 'adr' : 'design-module';
          const body = selection.type === 'adr'
            ? { adrId: selection.id }
            : { designModuleId: selection.id };
          const result = await apiFetch<LinkMutationResult>(
            `/api/interviews/${encodeURIComponent(interviewId)}/links/${path}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            },
          );
          linkedContext = result.linkedContext;
        } catch (error) {
          failures.push({
            selection,
            error: error instanceof Error ? error.message : 'Unable to link artifact',
          });
        }
      }

      return { linkedContext, failures };
    },
    onSuccess: (result, { interviewId }) => {
      if (result.linkedContext) {
        queryClient.setQueryData(
          interviewLinkKeys.links(interviewId),
          result.linkedContext,
        );
      }
    },
    onSettled: (_result, _error, { interviewId }) =>
      invalidateLinkedContext(queryClient, interviewId, project),
  });
}
