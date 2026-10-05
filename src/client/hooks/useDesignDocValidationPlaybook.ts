import { useMutation, useQueryClient } from '@tanstack/react-query';

export interface DesignDocValidationPlaybookStartResult {
  runId: string;
  definitionVersionId: string;
  outcome: 'started' | 'already-running';
}

export function useStartDesignDocValidationPlaybook(designDocId: string, project: string) {
  const queryClient = useQueryClient();
  return useMutation<DesignDocValidationPlaybookStartResult, Error>({
    mutationFn: async () => {
      const response = await fetch(
        `/api/interviews/design-docs/${encodeURIComponent(designDocId)}/validation-playbook`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((body as { error?: string }).error ?? 'Could not start the validation Playbook.');
      }
      return body as DesignDocValidationPlaybookStartResult;
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['design-doc', designDocId] });
      void queryClient.invalidateQueries({ queryKey: ['playbook-runs', project] });
      void queryClient.invalidateQueries({ queryKey: ['playbook-run', project, result.runId] });
    },
  });
}
