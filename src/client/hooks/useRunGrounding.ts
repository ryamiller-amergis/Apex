import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GroundingSurface,
  ReGroundResponse,
  RepoRole,
  RunGroundingStatus,
} from '../../shared/types/runGrounding';

async function readError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  return new Error(body.error ?? `HTTP ${response.status}`);
}

export function useRunGrounding(
  surface: GroundingSurface,
  domainRunId: string
) {
  const queryClient = useQueryClient();
  const queryKey = ['run-grounding', surface, domainRunId] as const;
  const query = useQuery<RunGroundingStatus[]>({
    queryKey,
    queryFn: async () => {
      const response = await fetch(
        `/api/run-groundings/${surface}/${encodeURIComponent(domainRunId)}`,
        { credentials: 'include' }
      );
      if (!response.ok) throw await readError(response);
      return response.json() as Promise<RunGroundingStatus[]>;
    },
    retry: false,
  });
  const mutation = useMutation<ReGroundResponse, Error, RepoRole>({
    mutationFn: async (role) => {
      const response = await fetch(
        `/api/run-groundings/${surface}/${encodeURIComponent(domainRunId)}/re-ground`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role }),
        }
      );
      if (!response.ok) throw await readError(response);
      return response.json() as Promise<ReGroundResponse>;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  return {
    statuses: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    reGround: mutation.mutateAsync,
    isReGrounding: mutation.isPending,
    reGroundError: mutation.error,
  };
}
