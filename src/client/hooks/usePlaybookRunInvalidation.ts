import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * SSE invalidation hint for the canvas live run view. Authoritative state still comes from
 * `usePlaybookRun` polling.
 */
export function usePlaybookRunInvalidation(
  project: string | undefined,
  runId: string | null,
  enabled: boolean,
): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || !project || !runId) return undefined;

    const url = `/api/playbooks/runs/${encodeURIComponent(runId)}/events?project=${encodeURIComponent(project)}`;
    const source = new EventSource(url, { withCredentials: true });

    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: ['playbook-run', project, runId] });
    };

    source.addEventListener('invalidated', invalidate);
    source.onerror = () => {
      // Polling remains the backstop when the stream drops.
    };

    return () => {
      source.close();
    };
  }, [enabled, project, runId, queryClient]);
}
