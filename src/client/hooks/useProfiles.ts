/**
 * FEAT-004 — Shared Avatar / profile-card client retrieval.
 * Route constants live here so they stay aligned with FEAT-001/002 without
 * changing presentation components. Reuses useProfileCard from useProfile.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { buildAvatarResolverUrl } from '../../shared/types/profile';
import { apexProjectHeaders } from '../utils/apiFetch';
import { profileCardQueryKey, useProfileCard } from './useProfile';

export { useProfileCard, profileCardQueryKey };

/** Versioned avatar bytes are immutable for a given (oid, version) pair. */
export const RESOLVED_AVATAR_STALE_TIME = Number.POSITIVE_INFINITY;

export function resolvedAvatarQueryKey(
  oid: string,
  version: string | null | undefined
) {
  return ['resolved-avatar', oid, version ?? '0'] as const;
}

export type ResolvedAvatarBytes =
  | { kind: 'image'; buffer: ArrayBuffer; contentType: string }
  | { kind: 'initials' };

/**
 * Authenticated resolved-avatar loader. Fetches opaque resolver bytes (never a
 * Blob storage URL). 204 / non-image responses map to initials; 401/403 throw
 * so callers can show a contained fallback without private fields.
 */
export async function fetchResolvedAvatar(
  oid: string,
  version: string | null | undefined,
  init?: { signal?: AbortSignal }
): Promise<ResolvedAvatarBytes> {
  const url = buildAvatarResolverUrl(oid.trim(), version ?? '0');
  const res = await fetch(url, {
    credentials: 'include',
    headers: apexProjectHeaders(),
    signal: init?.signal,
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error('Not authenticated');
  }

  if (res.status === 204 || !res.ok) {
    return { kind: 'initials' };
  }

  const contentType = res.headers.get('Content-Type') ?? 'image/png';
  if (!contentType.startsWith('image/')) {
    return { kind: 'initials' };
  }

  const buffer = await res.arrayBuffer();
  return { kind: 'image', buffer, contentType };
}

/**
 * TBI-007 / PBI-007: TanStack Query wrapper around authenticated avatar bytes.
 * Object URLs are created in the consuming component lifecycle (SharedAvatar)
 * so they revoke cleanly on version change and unmount.
 */
export function useResolvedAvatar(
  oid: string | null | undefined,
  version: string | null | undefined = null,
  enabled = true
) {
  const ready = typeof oid === 'string' && oid.trim().length > 0 && enabled;
  const trimmedOid = ready ? oid!.trim() : '';

  return useQuery<ResolvedAvatarBytes, Error>({
    queryKey: resolvedAvatarQueryKey(trimmedOid, version),
    queryFn: ({ signal }) => fetchResolvedAvatar(trimmedOid, version, { signal }),
    enabled: ready,
    staleTime: RESOLVED_AVATAR_STALE_TIME,
    retry: false,
    gcTime: 1000 * 60 * 30,
  });
}

/**
 * Creates a browser object URL from cached avatar bytes and revokes it on
 * replacement or unmount (VT-08 / TBI-007 NFR).
 */
export function useAvatarObjectUrl(
  data: ResolvedAvatarBytes | undefined
): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!data || data.kind !== 'image') {
      return;
    }

    const blob = new Blob([new Uint8Array(data.buffer)], { type: data.contentType });
    const url = URL.createObjectURL(blob);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync object URL after createObjectURL
    setObjectUrl(url);
    return () => {
      if (typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(url);
      }
    };
  }, [data]);

  if (!data || data.kind !== 'image') {
    return null;
  }
  return objectUrl;
}
