/**
 * FEAT-002 — Self-scoped avatar mutations.
 *
 * Both mutations take only actorOid (from the verified Azure AD session) —
 * never a target user id — so a caller can only ever replace or delete
 * their own avatar (PBI-004 self-only signatures).
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { userProfiles } from '../db/schema';
import {
  buildAvatarResolverUrl,
  parseNormalizedAvatarCrop,
  type AvatarMutationResponse,
} from '../../shared/types/profile';
import { AvatarValidationError, processAvatarImage } from './avatarProcessingService';
import { buildAvatarObjectKey, getAvatarStore } from './avatarStore';
import { AvatarDependencyError, resolveAvatar } from './avatarResolverService';

export { AvatarValidationError, AvatarDependencyError };

/**
 * Replace the caller's own avatar: process/normalize first (fails closed on
 * bad input before touching storage), persist to the Blob/local store keyed
 * by actorOid, then upsert the pointer + a fresh cacheVersion.
 */
export async function replaceOwnAvatar(
  actorOid: string,
  fileBuffer: Buffer,
  cropInput: unknown,
  _displayName: string
): Promise<AvatarMutationResponse> {
  const cropResult = parseNormalizedAvatarCrop(cropInput);
  if (cropResult.ok === false) {
    throw new AvatarValidationError(cropResult.error, 400);
  }

  const processed = await processAvatarImage(fileBuffer, cropResult.value);

  const key = buildAvatarObjectKey(actorOid);
  const store = getAvatarStore();
  try {
    await store.put(key, processed, 'image/webp');
  } catch {
    throw new AvatarDependencyError('Failed to store avatar', 503);
  }

  const now = new Date().toISOString();
  try {
    await db
      .insert(userProfiles)
      .values({
        userOid: actorOid,
        avatarBlobKey: key,
        avatarUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userProfiles.userOid,
        set: { avatarBlobKey: key, avatarUpdatedAt: now, updatedAt: now },
      });
  } catch {
    throw new AvatarDependencyError('Failed to save avatar metadata', 502);
  }

  return {
    avatar: {
      source: 'uploaded',
      url: buildAvatarResolverUrl(actorOid, now),
      cacheVersion: now,
      initials: null,
    },
    cacheVersion: now,
  };
}

/**
 * Delete the caller's own uploaded avatar.
 * - No blob key on file → idempotent success with the current fallback (PBI-004 AC-1).
 * - Delete the blob before touching the DB; a store failure throws and
 *   leaves user_profiles untouched rather than silently orphaning state (VT-06).
 */
export async function deleteOwnAvatar(
  actorOid: string,
  displayName: string
): Promise<AvatarMutationResponse> {
  let row: { avatarBlobKey: string | null } | undefined;
  try {
    row = await db.query.userProfiles.findFirst({ where: eq(userProfiles.userOid, actorOid) });
  } catch {
    throw new AvatarDependencyError('Failed to load avatar profile', 502);
  }

  if (!row?.avatarBlobKey) {
    return buildFallbackResponse(actorOid, displayName);
  }

  const store = getAvatarStore();
  try {
    await store.delete(row.avatarBlobKey);
  } catch {
    throw new AvatarDependencyError('Failed to delete avatar', 503);
  }

  const now = new Date().toISOString();
  try {
    await db
      .update(userProfiles)
      .set({ avatarBlobKey: null, avatarUpdatedAt: null, updatedAt: now })
      .where(eq(userProfiles.userOid, actorOid));
  } catch {
    throw new AvatarDependencyError('Failed to update avatar metadata', 502);
  }

  return buildFallbackResponse(actorOid, displayName);
}

async function buildFallbackResponse(
  actorOid: string,
  displayName: string
): Promise<AvatarMutationResponse> {
  const resolved = await resolveAvatar(actorOid, displayName);
  if (resolved.kind === 'bytes') {
    return {
      avatar: {
        source: resolved.source,
        url: buildAvatarResolverUrl(actorOid, resolved.cacheVersion),
        cacheVersion: resolved.cacheVersion,
        initials: null,
      },
      cacheVersion: resolved.cacheVersion,
    };
  }
  return {
    avatar: {
      source: 'initials',
      url: null,
      cacheVersion: resolved.cacheVersion,
      initials: resolved.initials,
    },
    cacheVersion: resolved.cacheVersion,
  };
}
