/**
 * FEAT-002 — Avatar resolution: uploaded Blob → Graph → initials.
 *
 * Never returns a Blob key or public URL — only bytes/contentType or an
 * initials string (BR-007 / DoD-1). Operational failures in the store or
 * Graph raise AvatarDependencyError (502/503) so callers can distinguish a
 * genuine outage from "no avatar configured", which instead falls through
 * to the next source in the precedence chain.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { appUsers, userProfiles } from '../db/schema';
import { deriveInitials } from '../../shared/types/profile';
import { getAvatarStore } from './avatarStore';
import { getGraphAvatarSource } from './graphAvatarSource';

export class AvatarDependencyError extends Error {
  readonly statusCode: 502 | 503;
  constructor(message: string, statusCode: 502 | 503 = 502) {
    super(message);
    this.name = 'AvatarDependencyError';
    this.statusCode = statusCode;
  }
}

export type AvatarResolveResult =
  | {
      kind: 'bytes';
      source: 'uploaded' | 'graph';
      bytes: Buffer;
      contentType: string;
      cacheVersion: string;
      etag?: string;
    }
  | { kind: 'initials'; initials: string; cacheVersion: string };

/**
 * Resolve the presentation avatar for userOid.
 *
 * @param displayNameOverride Skip the app_users lookup and use this name for
 *   the initials fallback (used by avatarService, which already knows the
 *   caller's claim identity — avoids a redundant query and a stale-name race
 *   right after login).
 */
export async function resolveAvatar(
  userOid: string,
  displayNameOverride?: string
): Promise<AvatarResolveResult> {
  let profileRow: { avatarBlobKey: string | null; avatarUpdatedAt: string | null } | undefined;
  try {
    profileRow = await db.query.userProfiles.findFirst({
      where: eq(userProfiles.userOid, userOid),
    });
  } catch {
    throw new AvatarDependencyError('Failed to load avatar profile', 502);
  }

  const blobKey = profileRow?.avatarBlobKey ?? null;
  const cacheVersion = profileRow?.avatarUpdatedAt ?? '0';

  if (blobKey) {
    const store = getAvatarStore();
    let exists = false;
    try {
      exists = await store.exists(blobKey);
    } catch {
      throw new AvatarDependencyError('Avatar storage is unavailable', 503);
    }
    if (exists) {
      try {
        const bytes = await store.get(blobKey);
        return {
          kind: 'bytes',
          source: 'uploaded',
          bytes,
          contentType: 'image/webp',
          cacheVersion,
          etag: cacheVersion,
        };
      } catch {
        throw new AvatarDependencyError('Avatar storage is unavailable', 503);
      }
    }
    // Blob key recorded but object missing — fall through rather than 404.
  }

  const graph = getGraphAvatarSource();
  let graphPhoto: { bytes: Buffer; contentType: string } | null;
  try {
    graphPhoto = await graph.getProfilePhoto(userOid);
  } catch {
    throw new AvatarDependencyError('Graph avatar lookup failed', 502);
  }
  if (graphPhoto) {
    return {
      kind: 'bytes',
      source: 'graph',
      bytes: graphPhoto.bytes,
      contentType: graphPhoto.contentType,
      cacheVersion,
    };
  }

  let displayName = displayNameOverride;
  if (displayName === undefined) {
    let user: { displayName: string | null } | undefined;
    try {
      user = await db.query.appUsers.findFirst({ where: eq(appUsers.oid, userOid) });
    } catch {
      throw new AvatarDependencyError('Failed to load user identity', 502);
    }
    displayName = user?.displayName ?? '';
  }

  return { kind: 'initials', initials: deriveInitials(displayName), cacheVersion };
}

/**
 * Shared cache headers for byte responses (route also sets nosniff).
 * Uploaded versioned URLs are long-lived + immutable; Graph uses a short private cache.
 */
export function buildAvatarCacheHeaders(
  source: 'uploaded' | 'graph',
  cacheVersion: string
): Record<string, string> {
  return {
    'Cache-Control':
      source === 'uploaded'
        ? 'private, max-age=31536000, immutable'
        : 'private, max-age=300',
    ETag: `"${cacheVersion}"`,
  };
}
