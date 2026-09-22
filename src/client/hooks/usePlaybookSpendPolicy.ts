import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PlaybookSpendPolicyView,
  UpdatePlaybookSpendPolicyRequest,
} from '../../shared/types/playbook';

async function policyFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Request failed: ${response.status}`
    );
  }
  return response.json() as Promise<T>;
}

export function usePlaybookSpendPolicy(project: string, enabled = true) {
  return useQuery<PlaybookSpendPolicyView | null>({
    queryKey: ['playbook-spend-policy', project],
    queryFn: () =>
      policyFetch(
        `/api/playbooks/spend-policy?project=${encodeURIComponent(project)}`
      ),
    enabled: enabled && Boolean(project),
  });
}

export function useUpdatePlaybookSpendPolicy(project: string) {
  const queryClient = useQueryClient();
  return useMutation<
    PlaybookSpendPolicyView,
    Error,
    Omit<UpdatePlaybookSpendPolicyRequest, 'project'>
  >({
    mutationFn: (request) =>
      policyFetch('/api/playbooks/spend-policy', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, ...request }),
      }),
    onSuccess: (policy) => {
      queryClient.setQueryData(['playbook-spend-policy', project], policy);
    },
  });
}
