/**
 * Profile Service — self-scoped current profile and org-wide card projection.
 * Owns validation, identity composition, and persistence for FEAT-001.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { appUsers, userProfiles } from '../db/schema';
import {
  parseUpdateCurrentProfileRequest,
  toAvatarSubject,
  type CurrentProfileResponse,
  type ProfileCardResponse,
  type UpdateCurrentProfileRequest,
} from '../../shared/types/profile';

export class ProfileValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ProfileValidationError';
  }
}

export class ProfileNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message = 'User not found') {
    super(message);
    this.name = 'ProfileNotFoundError';
  }
}

export interface ClaimIdentity {
  displayName: string;
  email: string;
}

type ProfileRow = {
  bio: string | null;
  avatarBlobKey: string | null;
  avatarUpdatedAt: string | null;
  updatedAt: string;
};

function mapCurrentProfile(
  userOid: string,
  identity: ClaimIdentity,
  row: ProfileRow | null
): CurrentProfileResponse {
  return {
    userOid,
    displayName: identity.displayName,
    email: identity.email,
    bio: row?.bio ?? null,
    // Version is only set while an uploaded blob exists (null → initials/Graph fallback).
    avatar: toAvatarSubject(
      userOid,
      row?.avatarBlobKey ? row.avatarUpdatedAt : null
    ),
    updatedAt: row?.updatedAt ?? null,
  };
}

function mapProfileCard(
  userOid: string,
  displayName: string,
  row: ProfileRow | null
): ProfileCardResponse {
  return {
    userOid,
    displayName,
    bio: row?.bio ?? null,
    avatar: toAvatarSubject(
      userOid,
      row?.avatarBlobKey ? row.avatarUpdatedAt : null
    ),
  };
}

/**
 * GET current profile: claim-backed identity + stored bio (absent row → bio null).
 */
export async function getCurrentProfile(
  subjectOid: string,
  identity: ClaimIdentity
): Promise<CurrentProfileResponse> {
  const row = await db.query.userProfiles.findFirst({
    where: eq(userProfiles.userOid, subjectOid),
  });

  return mapCurrentProfile(subjectOid, identity, row
    ? {
        bio: row.bio,
        avatarBlobKey: row.avatarBlobKey,
        avatarUpdatedAt: row.avatarUpdatedAt,
        updatedAt: row.updatedAt,
      }
    : null);
}

/**
 * PUT current profile: upsert bio for subjectOid only. Never accepts a target OID.
 */
export async function updateCurrentProfile(
  subjectOid: string,
  identity: ClaimIdentity,
  patch: UpdateCurrentProfileRequest
): Promise<CurrentProfileResponse> {
  const parsed = parseUpdateCurrentProfileRequest(patch);
  if (parsed.ok === false) {
    throw new ProfileValidationError(parsed.error);
  }

  const now = new Date().toISOString();
  const [row] = await db
    .insert(userProfiles)
    .values({
      userOid: subjectOid,
      bio: parsed.value.bio,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userProfiles.userOid,
      set: {
        bio: parsed.value.bio,
        updatedAt: now,
      },
    })
    .returning();

  return mapCurrentProfile(subjectOid, identity, {
    bio: row.bio,
    avatarBlobKey: row.avatarBlobKey,
    avatarUpdatedAt: row.avatarUpdatedAt,
    updatedAt: row.updatedAt,
  });
}

/**
 * Org-wide read-only card. Known user without profile row → bio null.
 * Unknown OID (absent from app_users) → 404.
 * Never returns email, avatar_blob_key, or audit fields.
 */
export async function getProfileCard(targetOid: string): Promise<ProfileCardResponse> {
  if (!targetOid || typeof targetOid !== 'string' || targetOid.trim().length === 0) {
    throw new ProfileValidationError('User oid is required');
  }

  const user = await db.query.appUsers.findFirst({
    where: eq(appUsers.oid, targetOid),
  });

  if (!user) {
    throw new ProfileNotFoundError();
  }

  const row = await db.query.userProfiles.findFirst({
    where: eq(userProfiles.userOid, targetOid),
  });

  return mapProfileCard(
    targetOid,
    user.displayName ?? 'Unknown User',
    row
      ? {
          bio: row.bio,
          avatarBlobKey: row.avatarBlobKey,
          avatarUpdatedAt: row.avatarUpdatedAt,
          updatedAt: row.updatedAt,
        }
      : null
  );
}
