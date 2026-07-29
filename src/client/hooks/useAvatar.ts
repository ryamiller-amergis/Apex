/**
 * FEAT-002 — TanStack Query mutations for uploading/removing the caller's
 * own avatar. Server APIs are self-scoped (no target user id ever leaves
 * this hook); FEAT-001's `currentProfileQueryKey` cache is refreshed on
 * success only, matching useProfile's "no optimistic clear on failure" rule.
 */
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  AvatarDescriptor,
  AvatarMutationResponse,
  AvatarSubject,
  CurrentProfileResponse,
  NormalizedAvatarCrop,
} from '../../shared/types/profile';
import { buildAvatarResolverUrl, deriveInitials } from '../../shared/types/profile';
import { currentProfileQueryKey } from './useProfile';

async function avatarApiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

/** Only the avatar subject's version changes as a result of an avatar mutation. */
function applyAvatarMutationToCache(qc: QueryClient, response: AvatarMutationResponse): void {
  let subjectOid: string | undefined;
  qc.setQueryData<CurrentProfileResponse | undefined>(currentProfileQueryKey, (prev) => {
    if (!prev) return prev;
    subjectOid = prev.userOid;
    // Uploaded avatars keep a cache-busting version; fallbacks clear it so the
    // editor returns to the default initials / "Upload avatar" state.
    const version = response.avatar.source === 'uploaded' ? response.cacheVersion : null;
    return {
      ...prev,
      avatar: { userOid: prev.avatar.userOid, version },
    };
  });
  void qc.invalidateQueries({ queryKey: currentProfileQueryKey });
  void qc.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey;
      if (!Array.isArray(key) || key[0] !== 'resolved-avatar') return false;
      return subjectOid ? key[1] === subjectOid : true;
    },
  });
}

export interface UploadAvatarInput {
  file: File;
  crop: NormalizedAvatarCrop;
}

/**
 * PBI-003 AC-0/AC-1: upload or replace the caller's own avatar.
 * Posts multipart form data (`avatar` file + `crop` JSON string) to
 * POST /api/profile/avatar. Cache is refreshed only on success — a failed
 * upload leaves the previously cached profile/version untouched.
 */
export function useUploadAvatar() {
  const qc = useQueryClient();
  return useMutation<AvatarMutationResponse, Error, UploadAvatarInput>({
    mutationFn: ({ file, crop }) => {
      const formData = new FormData();
      formData.append('avatar', file);
      formData.append('crop', JSON.stringify(crop));
      return avatarApiFetch<AvatarMutationResponse>('/api/profile/avatar', {
        method: 'POST',
        body: formData,
      });
    },
    onSuccess: (data) => applyAvatarMutationToCache(qc, data),
  });
}

/**
 * PBI-004 AC-0/AC-1: delete the caller's own uploaded avatar via
 * DELETE /api/profile/avatar. Cache is refreshed only on success — a failed
 * removal leaves the previously cached profile/version untouched.
 */
export function useDeleteAvatar() {
  const qc = useQueryClient();
  return useMutation<AvatarMutationResponse, Error, void>({
    mutationFn: () =>
      avatarApiFetch<AvatarMutationResponse>('/api/profile/avatar', { method: 'DELETE' }),
    onSuccess: (data) => applyAvatarMutationToCache(qc, data),
  });
}

/**
 * Derive a display `AvatarDescriptor` from FEAT-001's `AvatarSubject` when
 * only `{ userOid, version }` is known (e.g. from `CurrentProfileResponse`
 * before any avatar mutation has resolved a precise source). A non-null
 * version means an upload has previously occurred, so route through the
 * authenticated resolver URL; a null version has never had an upload, so
 * initials render immediately without a network round trip. A successful
 * upload/delete mutation response carries the server's precise
 * `AvatarDescriptor` (uploaded/graph/initials) and should replace this
 * heuristic in caller state.
 */
export function avatarDescriptorFromSubject(
  subject: AvatarSubject,
  displayName: string
): AvatarDescriptor {
  if (subject.version !== null) {
    return {
      source: 'uploaded',
      url: buildAvatarResolverUrl(subject.userOid, subject.version),
      cacheVersion: subject.version,
      initials: null,
    };
  }
  return {
    source: 'initials',
    url: null,
    cacheVersion: '0',
    initials: deriveInitials(displayName),
  };
}
