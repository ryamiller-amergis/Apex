import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlaybookDefinitionDetail } from '../../shared/types/playbook';
import type {
  PlaybookTemplateDetail,
  PlaybookTemplateSummary,
} from '../../shared/types/playbookTemplates';
import { PlaybookApiError, playbookDefinitionKeys } from './usePlaybookDefinitions';

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new PlaybookApiError(
      (body as { error?: string }).error ?? `Request failed: ${response.status}`,
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

export function usePlaybookTemplates(project: string | undefined, enabled: boolean) {
  return useQuery<{ templates: PlaybookTemplateSummary[] }>({
    queryKey: ['playbook-templates', project],
    queryFn: () =>
      apiRequest(`/api/playbooks/templates?project=${encodeURIComponent(project!)}`),
    enabled: Boolean(project) && enabled,
  });
}

export function usePlaybookTemplate(
  project: string | undefined,
  templateKey: string | null,
  enabled: boolean,
) {
  return useQuery<PlaybookTemplateDetail>({
    queryKey: ['playbook-template', project, templateKey],
    queryFn: () =>
      apiRequest(
        `/api/playbooks/templates/${encodeURIComponent(templateKey!)}?project=${encodeURIComponent(project!)}`,
      ),
    enabled: Boolean(project && templateKey) && enabled,
  });
}

export function useInstallPlaybookTemplate(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (templateKey: string) =>
      apiRequest<PlaybookDefinitionDetail>(
        `/api/playbooks/templates/${encodeURIComponent(templateKey)}/install`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['playbook-templates', project] });
      void queryClient.invalidateQueries({ queryKey: playbookDefinitionKeys.list(project) });
    },
  });
}

export function useApplyPlaybookTemplate(project: string, definitionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      templateKey: string;
      templateVersion: number;
      expectedDraftUpdatedAt: string;
      confirmed: true;
    }) =>
      apiRequest<PlaybookDefinitionDetail>(
        `/api/playbooks/definitions/${encodeURIComponent(definitionId)}/apply-template`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project, ...input }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: playbookDefinitionKeys.detail(project, definitionId),
      });
      void queryClient.invalidateQueries({ queryKey: ['playbook-template', project] });
    },
  });
}
