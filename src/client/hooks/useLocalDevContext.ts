import { useMutation } from '@tanstack/react-query';
import type {
  LocalDevContextRequest,
  LocalDevContextResponse,
} from '../../shared/types/devWorkbench';

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function buildLocalDevContextUrl(params: LocalDevContextRequest): string {
  const qs = new URLSearchParams();
  qs.set('project', params.project);
  if (params.workItemId != null) {
    qs.set('workItemId', String(params.workItemId));
  }
  if (params.prdId) {
    qs.set('prdId', params.prdId);
  }
  if (params.featureId) {
    qs.set('featureId', params.featureId);
  }
  return `/api/dev-workbench/local-dev-context?${qs.toString()}`;
}

/**
 * Lazy fetch of a local-dev context pack. Call mutateAsync with the row
 * identifiers when the Start Local Development modal opens.
 */
export function useLocalDevContext() {
  return useMutation<LocalDevContextResponse, Error, LocalDevContextRequest>({
    mutationFn: (params) => apiFetch(buildLocalDevContextUrl(params)),
  });
}
