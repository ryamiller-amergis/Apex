/**
 * TanStack Query hooks for current profile and org-wide profile cards.
 * FEAT-001 supplies data contracts only — FEAT-003/004 own UI surfaces.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CurrentProfileResponse,
  ProfileCardResponse,
  UpdateCurrentProfileRequest,
} from '../../shared/types/profile';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

export const currentProfileQueryKey = ['profile', 'current'] as const;

export function profileCardQueryKey(oid: string) {
  return ['profile', 'card', oid] as const;
}

/** PBI-001 AC-0: load current Azure AD identity + bio. */
export function useCurrentProfile() {
  return useQuery<CurrentProfileResponse>({
    queryKey: currentProfileQueryKey,
    queryFn: () => apiFetch<CurrentProfileResponse>('/api/profile/current'),
    staleTime: 30_000,
  });
}

/**
 * PBI-001 AC-0/AC-1: save bio; invalidate current profile only on success.
 * Prior query data is left intact on failure (TanStack default; no optimistic clear).
 */
export function useUpdateCurrentProfile() {
  const qc = useQueryClient();
  return useMutation<CurrentProfileResponse, Error, UpdateCurrentProfileRequest>({
    mutationFn: (body) =>
      apiFetch<CurrentProfileResponse>('/api/profile/current', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      qc.setQueryData(currentProfileQueryKey, data);
      void qc.invalidateQueries({ queryKey: currentProfileQueryKey });
    },
  });
}

/**
 * PBI-002: org-wide read-only card. Disabled when oid is empty.
 * Consumers render contained unavailable state from `isError` (AC-1).
 */
export function useProfileCard(oid: string | null | undefined) {
  const enabled = typeof oid === 'string' && oid.trim().length > 0;
  return useQuery<ProfileCardResponse>({
    queryKey: profileCardQueryKey(enabled ? oid!.trim() : ''),
    queryFn: () =>
      apiFetch<ProfileCardResponse>(
        `/api/profile/users/${encodeURIComponent(oid!.trim())}/card`
      ),
    enabled,
    staleTime: 60_000,
  });
}
