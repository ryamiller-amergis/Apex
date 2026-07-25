import { useQuery } from '@tanstack/react-query';
import type { LoadTestRequirementLinkSummary } from '../../shared/types/loadTest';

interface ByRequirementResponse {
  items: LoadTestRequirementLinkSummary[];
}

class RequirementLoadTestsApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RequirementLoadTestsApiError';
    this.status = status;
  }
}

async function fetchByRequirement(
  projectId: string,
  workItemId: string,
): Promise<LoadTestRequirementLinkSummary[]> {
  const params = new URLSearchParams({
    kind: 'ado_work_item',
    id: workItemId,
  });
  const url = `/api/projects/${encodeURIComponent(projectId)}/load-tests/by-requirement?${params}`;
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new RequirementLoadTestsApiError(
      body.error ?? `Request failed: ${response.status}`,
      response.status,
    );
  }
  const data = (await response.json()) as ByRequirementResponse;
  return data.items ?? [];
}

export const requirementLoadTestsQueryKey = (projectId: string, workItemId: string) =>
  ['requirement-load-tests', projectId, workItemId] as const;

/**
 * FEAT-010 — linked load tests for an ADO work item (requirement/PBI).
 */
export function useRequirementLoadTests(
  projectId: string | null,
  workItemId: string | number | null,
  options?: { enabled?: boolean },
) {
  const id = workItemId == null ? '' : String(workItemId);
  const enabled =
    Boolean(projectId && id) && (options?.enabled !== undefined ? options.enabled : true);

  return useQuery<LoadTestRequirementLinkSummary[]>({
    queryKey: requirementLoadTestsQueryKey(projectId ?? '', id),
    queryFn: () => fetchByRequirement(projectId!, id),
    enabled,
    staleTime: 15_000,
  });
}
