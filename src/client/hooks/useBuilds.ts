import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isBuildInProgress } from '../../shared/types/build';
import type {
  BuildListResponse,
  BuildRepositoryOption,
  BuildRunStatus,
  StartBuildRequest,
  StartBuildResponse,
} from '../../shared/types/build';
import type { BuildDetailResponse, BuildEventsResponse } from '../../shared/types/buildView';

const BUILD_POLL_MS = 5_000;

const LIVE_BUILD_STATUSES: ReadonlySet<BuildRunStatus> = new Set<BuildRunStatus>([
  'queued',
  'intake',
  'planning',
  'building',
  'checking',
  'deploying',
  'suspended',
]);

/** A status added later reads as settled, so polling stops by default. */
export function isBuildLive(status: BuildRunStatus | undefined): boolean {
  return status !== undefined && LIVE_BUILD_STATUSES.has(status);
}

export class BuildApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly refusals: string[];

  constructor(status: number, message: string, code?: string, refusals: string[] = []) {
    super(message);
    this.name = 'BuildApiError';
    this.status = status;
    this.code = code;
    this.refusals = refusals;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = await readJson(response);
  if (!response.ok) {
    const refusals = Array.isArray(body.refusals) ? body.refusals.map((item) => String(item)) : [];
    throw new BuildApiError(
      response.status,
      typeof body.error === 'string' ? body.error : 'The request failed.',
      typeof body.code === 'string' ? body.code : undefined,
      refusals,
    );
  }
  return body as T;
}

function listKey(project: string, scope: string, state: string, limit: number, offset: number) {
  return ['builds', project, scope, state, limit, offset] as const;
}

export function useBuilds(
  project: string,
  options: { scope?: 'project' | 'mine'; state?: 'all' | 'active'; limit?: number; offset?: number } = {},
) {
  const scope = options.scope ?? 'project';
  const state = options.state ?? 'all';
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  return useQuery({
    queryKey: listKey(project, scope, state, limit, offset),
    queryFn: () => {
      const params = new URLSearchParams({
        project,
        scope,
        state,
        limit: String(limit),
        offset: String(offset),
      });
      return apiFetch<BuildListResponse>(`/api/builds?${params.toString()}`);
    },
    refetchInterval: (query) => (
      query.state.data?.builds.some((build) => isBuildInProgress(build.status)) ? 5_000 : false
    ),
  });
}

export function useActiveBuildCount(project: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['builds', project, 'active-count'],
    enabled: Boolean(project) && enabled,
    queryFn: () => {
      const params = new URLSearchParams({
        project: project ?? '',
        scope: 'mine',
        state: 'active',
        limit: '1',
      });
      return apiFetch<BuildListResponse>(`/api/builds?${params.toString()}`);
    },
    refetchInterval: (query) => ((query.state.data?.total ?? 0) > 0 ? 5_000 : 30_000),
  });
}

function retryUnlessDenied(failureCount: number, error: unknown): boolean {
  if (error instanceof BuildApiError && [401, 403, 404].includes(error.status)) return false;
  return failureCount < 2;
}

function buildDetailKey(project: string, buildId: string) {
  return ['build', project, buildId] as const;
}

function buildEventsKey(project: string, buildId: string) {
  return ['build-events', project, buildId] as const;
}

function fetchBuildDetail(project: string, buildId: string): Promise<BuildDetailResponse> {
  return apiFetch<BuildDetailResponse>(
    `/api/builds/${encodeURIComponent(buildId)}?project=${encodeURIComponent(project)}`,
  );
}

export function useBuild(project: string, buildId: string) {
  return useQuery({
    queryKey: buildDetailKey(project, buildId),
    enabled: Boolean(project) && Boolean(buildId),
    queryFn: () => fetchBuildDetail(project, buildId),
    refetchInterval: (query) => (isBuildLive(query.state.data?.build.status) ? BUILD_POLL_MS : false),
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: retryUnlessDenied,
  });
}

export function useBuildEvents(project: string, buildId: string, options: { enabled: boolean }) {
  const client = useQueryClient();
  return useQuery({
    queryKey: buildEventsKey(project, buildId),
    enabled: options.enabled && Boolean(project) && Boolean(buildId),
    queryFn: () => apiFetch<BuildEventsResponse>(
      `/api/builds/${encodeURIComponent(buildId)}/events?project=${encodeURIComponent(project)}`,
    ),
    refetchInterval: () => {
      const detail = client.getQueryData<BuildDetailResponse>(buildDetailKey(project, buildId));
      return isBuildLive(detail?.build.status) ? BUILD_POLL_MS : false;
    },
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: retryUnlessDenied,
  });
}

export interface BuildIntakeRef {
  interviewId: string | null;
}

/** Reads the intake interview id from the build detail route. Polls until the interview exists. */
export function useBuildIntake(project: string, buildId: string | undefined) {
  return useQuery({
    queryKey: buildDetailKey(project, buildId ?? ''),
    enabled: Boolean(project) && Boolean(buildId),
    queryFn: () => fetchBuildDetail(project, buildId ?? ''),
    select: (detail): BuildIntakeRef => ({ interviewId: detail.build.intakeInterviewId }),
    refetchInterval: (query) => (query.state.data?.build.intakeInterviewId ? false : BUILD_POLL_MS),
    retry: retryUnlessDenied,
  });
}

function useBuildAction<TBody extends object>(project: string, buildId: string, action: string) {
  const client = useQueryClient();
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: buildDetailKey(project, buildId) });
    void client.invalidateQueries({ queryKey: ['builds', project] });
  };
  return useMutation({
    mutationFn: (body: TBody) => apiFetch<Record<string, unknown>>(
      `/api/builds/${encodeURIComponent(buildId)}/${action}?project=${encodeURIComponent(project)}`,
      { method: 'POST', body: JSON.stringify({ ...body, project }) },
    ),
    onSuccess: invalidate,
    onError: (error) => {
      if (error instanceof BuildApiError && error.status === 403) invalidate();
    },
  });
}

/** Routes below are built in Epic 2; the request bodies follow the PRD API table. */
export function useRequestBuildRevision(project: string, buildId: string) {
  return useBuildAction<{ feedback: string }>(project, buildId, 'revisions');
}

export function useAcceptBuild(project: string, buildId: string) {
  return useBuildAction<{ revisionNumber: number }>(project, buildId, 'accept');
}

export function useCancelBuild(project: string, buildId: string) {
  return useBuildAction<{ reason?: string }>(project, buildId, 'cancel');
}

export function useResumeBuild(project: string, buildId: string) {
  return useBuildAction<Record<string, never>>(project, buildId, 'resume');
}

export function useRetryBuildDeployment(project: string, buildId: string) {
  return useBuildAction<Record<string, never>>(project, buildId, 'retry-deployment');
}

export function useBuildRepositories(project: string) {
  return useQuery({
    queryKey: ['builds', 'repositories', project],
    queryFn: () => apiFetch<{ repositories: BuildRepositoryOption[] }>(
      `/api/builds/repositories?project=${encodeURIComponent(project)}`,
    ),
  });
}

export function useStartBuild(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: Omit<StartBuildRequest, 'project'>) => apiFetch<StartBuildResponse>(
      `/api/builds?project=${encodeURIComponent(project)}`,
      { method: 'POST', body: JSON.stringify({ ...request, project }) },
    ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['builds', project] });
    },
  });
}
