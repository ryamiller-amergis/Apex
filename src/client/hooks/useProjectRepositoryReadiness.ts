import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectRepositoryReadiness } from '../../shared/types/projectSettings';
import { useFeatureFlag } from './useFeatureFlags';

/** User-facing copy when repository-dependent AI is blocked pending admin Clone. */
export const PROJECT_REPOSITORY_NOT_READY_MESSAGE =
  'A project administrator must clone this repository before repository-dependent AI work can run.';

const FLAG_KEY = 'project-repository-checkout-readiness';

export function isProjectRepositoryReady(
  readiness: ProjectRepositoryReadiness | null | undefined,
): boolean {
  return Boolean(readiness?.filesystemReady && readiness.status === 'ready');
}

export interface ProjectRepositoryReadinessResult {
  /** True when the flag is off (legacy) or the selected config is filesystem-ready. */
  isReady: boolean;
  /** Admin-directed message when blocked; null when ready / flag off. */
  message: string | null;
  readiness: ProjectRepositoryReadiness | null;
  isLoading: boolean;
  isFetching: boolean;
  flagEnabled: boolean;
}

/**
 * Client readiness gate for a Project Skill Settings repository configuration.
 * When the feature flag is off, treats the project as ready (legacy path).
 */
export function useProjectRepositoryReadiness(
  skillSettingsId: string | null | undefined,
  project: string | null | undefined,
): ProjectRepositoryReadinessResult {
  const flagEnabled = useFeatureFlag(FLAG_KEY, project ?? undefined);

  const query = useQuery<ProjectRepositoryReadiness | null>({
    queryKey: ['repository-readiness', skillSettingsId, project],
    queryFn: async () => {
      const res = await fetch(
        `/api/skill-settings/${encodeURIComponent(skillSettingsId!)}/repository-readiness?project=${encodeURIComponent(project!)}`,
        { credentials: 'include' },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('Failed to fetch repository readiness');
      return res.json() as Promise<ProjectRepositoryReadiness>;
    },
    enabled: flagEnabled && !!skillSettingsId && !!project,
    staleTime: 15_000,
    refetchInterval: (q) => (q.state.data?.status === 'cloning' ? 2_000 : false),
  });

  const readiness = query.data ?? null;

  // @feature-flag:project-repository-checkout-readiness start winner=enabled
  if (!flagEnabled) {
    // @feature-flag:project-repository-checkout-readiness disabled-start
    return {
      isReady: true,
      message: null,
      readiness: null,
      isLoading: false,
      isFetching: false,
      flagEnabled: false,
    };
    // @feature-flag:project-repository-checkout-readiness disabled-end
  }

  // @feature-flag:project-repository-checkout-readiness enabled-start
  // No selected skill settings → nothing to gate (legacy free-form configs).
  if (!skillSettingsId || !project) {
    return {
      isReady: true,
      message: null,
      readiness: null,
      isLoading: false,
      isFetching: false,
      flagEnabled: true,
    };
  }

  const isReady = isProjectRepositoryReady(readiness);
  // Block send while loading or not ready so users cannot race the gate.
  const effectivelyReady = !query.isLoading && isReady;
  return {
    isReady: effectivelyReady,
    message: effectivelyReady ? null : PROJECT_REPOSITORY_NOT_READY_MESSAGE,
    readiness,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    flagEnabled: true,
  };
  // @feature-flag:project-repository-checkout-readiness enabled-end
  // @feature-flag:project-repository-checkout-readiness end
}

/** Admin readiness poll for a skill-settings row (Project Admin Clone/Refresh UI). */
export function useAdminProjectRepositoryReadiness(
  skillSettingsId: string | null | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery<ProjectRepositoryReadiness | null>({
    queryKey: ['admin', 'repository-readiness', skillSettingsId],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/project-settings/${encodeURIComponent(skillSettingsId!)}/repository-readiness`,
        { credentials: 'include' },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('Failed to fetch repository readiness');
      return res.json() as Promise<ProjectRepositoryReadiness>;
    },
    enabled: (options?.enabled ?? true) && !!skillSettingsId,
    staleTime: 5_000,
    refetchInterval: (q) => (q.state.data?.status === 'cloning' ? 2_000 : false),
  });
}

export function useCloneProjectRepository() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      refresh = false,
    }: {
      id: string;
      refresh?: boolean;
    }) => {
      const res = await fetch(
        `/api/admin/project-settings/${encodeURIComponent(id)}/repository-clone`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ refresh }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error || 'Failed to clone repository',
        );
      }
      return res.json() as Promise<ProjectRepositoryReadiness>;
    },
    onMutate: async ({ id }) => {
      const key = ['admin', 'repository-readiness', id] as const;
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ProjectRepositoryReadiness | null>(key);
      queryClient.setQueryData<ProjectRepositoryReadiness>(key, {
        skillSettingsId: id,
        status: 'cloning',
        sha: previous?.sha ?? null,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        filesystemReady: false,
      });
      return { previous };
    },
    onError: (_err, { id }, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(['admin', 'repository-readiness', id], context.previous);
      }
    },
    onSuccess: (data, { id }) => {
      queryClient.setQueryData(['admin', 'repository-readiness', id], data);
      queryClient.invalidateQueries({ queryKey: ['admin', 'project-settings'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'repository-readiness', id] });
      queryClient.invalidateQueries({ queryKey: ['repository-readiness', id] });
    },
  });
}

export function formatRepositoryCheckoutStatusLabel(
  readiness: ProjectRepositoryReadiness | null | undefined,
): string {
  if (!readiness) return 'Not cloned';
  switch (readiness.status) {
    case 'cloning':
      return 'Cloning';
    case 'ready': {
      const short = readiness.sha ? readiness.sha.slice(0, 7) : '—';
      return `Ready at ${short}`;
    }
    case 'failed':
      return readiness.error ? `Failed: ${readiness.error}` : 'Failed';
    case 'snapshot_unavailable':
      return 'Snapshot unavailable';
    case 'not_cloned':
    default:
      return 'Not cloned';
  }
}
