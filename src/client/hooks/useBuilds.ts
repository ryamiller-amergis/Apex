import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isBuildInProgress } from '../../shared/types/build';
import type {
  BuildListResponse,
  BuildRepositoryOption,
  StartBuildRequest,
  StartBuildResponse,
} from '../../shared/types/build';

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

export interface BuildIntakeRef {
  interviewId: string | null;
  threadId: string | null;
}

/** Reads `intake` from the build detail route (`GET /api/builds/:id`). */
export function useBuildIntake(buildId: string | undefined) {
  return useQuery({
    queryKey: ['builds', 'detail', buildId, 'intake'],
    enabled: Boolean(buildId),
    queryFn: async () => {
      const body = await apiFetch<{ intake?: BuildIntakeRef | null }>(
        `/api/builds/${encodeURIComponent(buildId ?? '')}`,
      );
      return body.intake ?? null;
    },
    refetchInterval: (query) => (query.state.data?.interviewId ? false : 5_000),
  });
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
