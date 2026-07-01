import { useQuery } from '@tanstack/react-query';
import type { ChangelogResponse } from '../../shared/types/changelog';

async function fetchChangelog(): Promise<ChangelogResponse> {
  const res = await fetch('/api/changelog', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to load changelog');
  return res.json() as Promise<ChangelogResponse>;
}

export function useChangelog(enabled = true) {
  return useQuery<ChangelogResponse>({
    queryKey: ['changelog'],
    queryFn: fetchChangelog,
    staleTime: 60_000,
    enabled,
  });
}
