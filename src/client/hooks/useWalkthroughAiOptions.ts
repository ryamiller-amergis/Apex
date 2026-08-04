import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SaveWalkthroughAiOptionsCommand,
  WalkthroughAiOptionsRecord,
} from '../../shared/types/walkthroughAiOptions';

const AI_OPTIONS_QUERY_KEY = ['platform-admin', 'walkthroughs', 'ai-options'] as const;

async function fetchAiOptions(): Promise<WalkthroughAiOptionsRecord> {
  const res = await fetch('/api/platform-admin/walkthroughs/ai-options', {
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      typeof body?.error === 'string' ? body.error : 'Failed to load walkthrough AI options',
    );
  }
  return res.json() as Promise<WalkthroughAiOptionsRecord>;
}

export function useWalkthroughAiOptionsQuery() {
  return useQuery({
    queryKey: AI_OPTIONS_QUERY_KEY,
    queryFn: fetchAiOptions,
    staleTime: 30_000,
  });
}

export function useSaveWalkthroughAiOptions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      command: SaveWalkthroughAiOptionsCommand,
    ): Promise<WalkthroughAiOptionsRecord> => {
      const res = await fetch('/api/platform-admin/walkthroughs/ai-options', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          typeof body?.error === 'string'
            ? body.error
            : 'Failed to save walkthrough AI options',
        );
      }
      return res.json() as Promise<WalkthroughAiOptionsRecord>;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(AI_OPTIONS_QUERY_KEY, data);
    },
  });
}
