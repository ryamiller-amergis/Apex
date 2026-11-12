import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EffortLevel } from '../../shared/types/effort';
import type {
  CaptureHealthResponse,
  GenerateObservabilityPoDigestRequest,
  ObservabilityPoDigestResponse,
  ObservabilityTrendWindow,
  TraceEventPage,
} from '../../shared/types/observability';
import type { AppliedWorkspaceFilters } from '../observability/workspaceFilters';

export class ObservabilityApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ObservabilityApiError';
    this.status = status;
    this.code = code;
  }
}

async function observabilityFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    throw new ObservabilityApiError(body.error ?? `HTTP ${res.status}`, res.status, body.code);
  }
  return body as T;
}

export function buildTrailQueryUrl(
  project: string,
  filters: AppliedWorkspaceFilters,
  cursor: string | null,
): string {
  const params = new URLSearchParams({
    project,
    actorId: filters.actorId,
    from: filters.from,
    to: filters.to,
  });
  if (filters.traceId) params.set('traceId', filters.traceId);
  if (filters.eventType) params.set('eventType', filters.eventType);
  if (filters.routeTemplate) params.set('routeTemplate', filters.routeTemplate);
  if (cursor) params.set('cursor', cursor);
  return `/api/platform-admin/observability/trail?${params.toString()}`;
}

export function buildHealthQueryUrl(project: string): string {
  const params = new URLSearchParams({ project });
  return `/api/platform-admin/observability/health?${params.toString()}`;
}

export function buildPoDigestQueryUrl(
  project: string,
  window: ObservabilityTrendWindow,
  model?: string,
  effort?: EffortLevel,
): string {
  const params = new URLSearchParams({ project, window });
  if (model) params.set('model', model);
  if (effort) params.set('effort', effort);
  return `/api/platform-admin/observability/po-digest?${params.toString()}`;
}

export function useObservabilityTrail(
  project: string | undefined,
  filters: AppliedWorkspaceFilters | null,
  cursor: string | null,
) {
  return useQuery<TraceEventPage, ObservabilityApiError>({
    queryKey: ['observability-trail', project, filters, cursor],
    queryFn: () => observabilityFetch<TraceEventPage>(buildTrailQueryUrl(project!, filters!, cursor)),
    enabled: Boolean(project && filters),
    staleTime: 15_000,
  });
}

export function useObservabilityHealth(project: string | undefined, enabled: boolean) {
  return useQuery<CaptureHealthResponse, ObservabilityApiError>({
    queryKey: ['observability-health', project],
    queryFn: () => observabilityFetch<CaptureHealthResponse>(buildHealthQueryUrl(project!)),
    enabled: Boolean(project && enabled),
    staleTime: 15_000,
  });
}

export function useObservabilityPoDigest(
  project: string | undefined,
  window: ObservabilityTrendWindow,
  model: string,
  effort: EffortLevel,
) {
  return useQuery<ObservabilityPoDigestResponse, ObservabilityApiError>({
    queryKey: ['observability-po-digest', project, window, model, effort],
    queryFn: () =>
      observabilityFetch<ObservabilityPoDigestResponse>(
        buildPoDigestQueryUrl(project!, window, model, effort),
      ),
    enabled: Boolean(project),
    staleTime: 15_000,
  });
}

export function useGenerateObservabilityPoDigest(project: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation<
    ObservabilityPoDigestResponse,
    ObservabilityApiError,
    GenerateObservabilityPoDigestRequest
  >({
    mutationFn: (payload) => {
      const targetProject = payload.project ?? project ?? 'Apex';
      const params = new URLSearchParams({ project: targetProject });
      return observabilityFetch<ObservabilityPoDigestResponse>(
        `/api/platform-admin/observability/po-digest/generate?${params.toString()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, project: targetProject }),
        },
      );
    },
    onSuccess: (data, variables) => {
      const targetProject = variables.project ?? project ?? 'Apex';
      queryClient.setQueryData(
        [
          'observability-po-digest',
          targetProject,
          data.digest.window,
          data.digest.model,
          data.digest.effort,
        ],
        data,
      );
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === 'observability-po-digest' &&
          query.queryKey[1] === targetProject &&
          query.queryKey[2] !== data.digest.window,
      });
    },
  });
}
