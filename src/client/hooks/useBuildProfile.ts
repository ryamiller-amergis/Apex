import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { BuildProfile } from '../../shared/types/build';
import type { BuildProfileResponse } from '../../shared/types/buildPreflight';

export function buildProfileQueryKey(settingsId: string | null | undefined) {
  return ['admin', 'project-settings', settingsId, 'build-profile'] as const;
}

function buildProfileUrl(settingsId: string): string {
  return `/api/admin/project-settings/${encodeURIComponent(settingsId)}/build-profile`;
}

/** A refused save. `fieldErrors` is keyed by dotted profile path, e.g. `caps.maxParallelism`. */
export class BuildProfileSaveError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly fieldErrors: Record<string, string>;

  constructor(message: string, status: number, code: string | null, fieldErrors: Record<string, string>) {
    super(message);
    this.name = 'BuildProfileSaveError';
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export function useBuildProfile(settingsId: string | null | undefined) {
  return useQuery<BuildProfileResponse>({
    queryKey: buildProfileQueryKey(settingsId),
    queryFn: async () => {
      const res = await fetch(buildProfileUrl(settingsId!), { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load the Build profile');
      return res.json() as Promise<BuildProfileResponse>;
    },
    enabled: !!settingsId,
    staleTime: 60_000,
  });
}

export function useSaveBuildProfile() {
  const queryClient = useQueryClient();
  return useMutation<BuildProfileResponse, BuildProfileSaveError, { settingsId: string; profile: BuildProfile }>({
    mutationFn: async ({ settingsId, profile }) => {
      const res = await fetch(buildProfileUrl(settingsId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(profile),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
          fieldErrors?: Record<string, string>;
        };
        throw new BuildProfileSaveError(
          data.message || 'Could not save the Build profile. Try again.',
          res.status,
          data.error ?? null,
          data.fieldErrors ?? {},
        );
      }
      return res.json() as Promise<BuildProfileResponse>;
    },
    onSuccess: (data, { settingsId }) => {
      queryClient.setQueryData(buildProfileQueryKey(settingsId), data);
      queryClient.invalidateQueries({ queryKey: buildProfileQueryKey(settingsId) });
      queryClient.invalidateQueries({ queryKey: ['admin', 'project-settings'] });
    },
  });
}
