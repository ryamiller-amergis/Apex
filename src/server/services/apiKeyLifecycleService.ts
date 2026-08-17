/**
 * API Key Lifecycle Service — FEAT-001 / TBI-001
 *
 * Owns token generation, SHA-256 hashing, display-prefix derivation, cadence
 * math, project-scoped uniqueness, sanitized reads, regeneration, soft delete,
 * and verifyRawKey (consumed later by FEAT-002).
 */

import { createHash, randomBytes } from 'crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { apiKeys, appUsers } from '../db/schema';
import {
  ApiKeyValidationError,
  DEFAULT_API_KEY_CADENCE,
  isApiKeyCadence,
  normalizeApiKeyScopes,
  type ApiKeyCadence,
  type ApiKeyMetadata,
  type ApiKeyScope,
  type ApiKeyStatus,
  type CreateApiKeyInput,
  type UpdateApiKeyInput,
} from '../../shared/types/apiKey';

const MAX_KEYS_PER_PROJECT = 100;
const NAME_MAX_LEN = 100;
const KEY_PREFIX_LEN = 8;
const RAW_KEY_PREFIX = 'apex_';
const RAW_KEY_BYTES = 32;

type ApiKeyRow = typeof apiKeys.$inferSelect;

export function deriveExpiry(cadence: ApiKeyCadence, from: Date): Date | null {
  if (cadence === 'none') return null;
  const days =
    cadence === '30d' ? 30
    : cadence === '60d' ? 60
    : cadence === '90d' ? 90
    : cadence === '180d' ? 180
    : 365; // 1y
  const result = new Date(from.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function hashRawKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

function generateRawKey(): string {
  return `${RAW_KEY_PREFIX}${randomBytes(RAW_KEY_BYTES).toString('base64url')}`;
}

function keyPrefixFromRaw(rawKey: string): string {
  return rawKey.slice(0, KEY_PREFIX_LEN);
}

function shortIdFromUuid(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

function deriveStatus(expiresAt: string | null, now: Date = new Date()): ApiKeyStatus {
  if (expiresAt == null) return 'active';
  return new Date(expiresAt).getTime() <= now.getTime() ? 'expired' : 'active';
}

function maskPrefix(keyPrefix: string): string {
  return `${keyPrefix}…`;
}

function isUniqueViolation(err: unknown): boolean {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';
  if (code === '23505') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /unique|duplicate/i.test(message);
}

function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ApiKeyValidationError('Name is required', 'VALIDATION');
  }
  const name = raw.trim();
  if (!name) {
    throw new ApiKeyValidationError('Name is required', 'VALIDATION');
  }
  if (name.length > NAME_MAX_LEN) {
    throw new ApiKeyValidationError(`Name must be at most ${NAME_MAX_LEN} characters`, 'VALIDATION');
  }
  return name;
}

function normalizeCadence(raw: unknown, fallback?: ApiKeyCadence): ApiKeyCadence {
  if (raw === undefined || raw === null) {
    if (fallback) return fallback;
    throw new ApiKeyValidationError('Cadence is required', 'VALIDATION');
  }
  if (!isApiKeyCadence(raw)) {
    throw new ApiKeyValidationError('Invalid cadence', 'VALIDATION');
  }
  return raw;
}

async function resolveDisplayName(userId: string): Promise<string> {
  const rows = await db
    .select({ displayName: appUsers.displayName })
    .from(appUsers)
    .where(eq(appUsers.oid, userId))
    .limit(1);
  const displayName = rows[0]?.displayName?.trim();
  return displayName || userId;
}

function toMetadata(row: ApiKeyRow, createdByDisplay: string, now: Date = new Date()): ApiKeyMetadata {
  return {
    id: row.id,
    shortId: shortIdFromUuid(row.id),
    name: row.name,
    maskedPrefix: maskPrefix(row.keyPrefix),
    cadence: row.cadence,
    scopes: Array.isArray(row.scopes) ? ([...row.scopes] as ApiKeyScope[]) : [],
    expiresAt: row.expiresAt,
    status: deriveStatus(row.expiresAt, now),
    createdAt: row.createdAt,
    createdBy: createdByDisplay,
  };
}

async function loadActiveKey(projectId: string, id: string): Promise<ApiKeyRow | null> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.projectId, projectId), isNull(apiKeys.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listKeys(
  projectId: string,
  options?: { status?: 'all' | 'active' | 'expired' },
): Promise<ApiKeyMetadata[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.projectId, projectId), isNull(apiKeys.deletedAt)))
    .orderBy(desc(apiKeys.createdAt));

  const now = new Date();
  const statusFilter = options?.status ?? 'all';
  const creatorIds = [...new Set(rows.map((r) => r.createdBy))];
  const displayById = new Map<string, string>();
  if (creatorIds.length > 0) {
    const users = await db
      .select({ oid: appUsers.oid, displayName: appUsers.displayName })
      .from(appUsers)
      .where(inArray(appUsers.oid, creatorIds));
    for (const u of users) {
      displayById.set(u.oid, u.displayName?.trim() || u.oid);
    }
  }

  const items = rows.map((row) =>
    toMetadata(row, displayById.get(row.createdBy) ?? row.createdBy, now),
  );

  if (statusFilter === 'all') return items;
  return items.filter((item) => item.status === statusFilter);
}

export async function getKey(projectId: string, id: string): Promise<ApiKeyMetadata | null> {
  const row = await loadActiveKey(projectId, id);
  if (!row) return null;
  const createdBy = await resolveDisplayName(row.createdBy);
  return toMetadata(row, createdBy);
}

export async function createKey(
  projectId: string,
  input: CreateApiKeyInput,
  userId: string,
): Promise<{ key: ApiKeyMetadata; rawKey: string }> {
  const name = normalizeName(input.name);
  const cadence = normalizeCadence(input.cadence ?? DEFAULT_API_KEY_CADENCE);
  const scopes = normalizeApiKeyScopes(input.scopes ?? []);

  const existingCountRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(apiKeys)
    .where(and(eq(apiKeys.projectId, projectId), isNull(apiKeys.deletedAt)));
  const count = Number(existingCountRows[0]?.count ?? 0);
  if (count >= MAX_KEYS_PER_PROJECT) {
    throw new ApiKeyValidationError(
      `A project may have at most ${MAX_KEYS_PER_PROJECT} API keys`,
      'LIMIT_REACHED',
    );
  }

  const now = new Date();
  const rawKey = generateRawKey();
  const keyHash = hashRawKey(rawKey);
  const keyPrefix = keyPrefixFromRaw(rawKey);
  const expires = deriveExpiry(cadence, now);

  try {
    const inserted = await db
      .insert(apiKeys)
      .values({
        projectId,
        name,
        keyHash,
        keyPrefix,
        cadence,
        scopes,
        expiresAt: expires ? expires.toISOString() : null,
        createdBy: userId,
        createdAt: now.toISOString(),
      })
      .returning();

    const row = inserted[0];
    if (!row) {
      throw new ApiKeyValidationError('Failed to create API key', 'VALIDATION');
    }
    const createdBy = await resolveDisplayName(userId);
    return { key: toMetadata(row, createdBy, now), rawKey };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiKeyValidationError('An API key with this name already exists', 'NAME_TAKEN');
    }
    throw err;
  }
}

export async function updateKey(
  projectId: string,
  id: string,
  input: UpdateApiKeyInput,
): Promise<ApiKeyMetadata> {
  const row = await loadActiveKey(projectId, id);
  if (!row) {
    throw new ApiKeyValidationError('API key not found', 'NOT_FOUND');
  }

  const patch: Partial<ApiKeyRow> = {};
  if (input.name !== undefined) {
    patch.name = normalizeName(input.name);
  }
  if (input.cadence !== undefined) {
    const cadence = normalizeCadence(input.cadence);
    patch.cadence = cadence;
    const expires = deriveExpiry(cadence, new Date());
    patch.expiresAt = expires ? expires.toISOString() : null;
  }
  if (input.scopes !== undefined) {
    patch.scopes = normalizeApiKeyScopes(input.scopes);
  }

  if (Object.keys(patch).length === 0) {
    const createdBy = await resolveDisplayName(row.createdBy);
    return toMetadata(row, createdBy);
  }

  try {
    const updated = await db
      .update(apiKeys)
      .set(patch)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.projectId, projectId), isNull(apiKeys.deletedAt)))
      .returning();
    const next = updated[0];
    if (!next) {
      throw new ApiKeyValidationError('API key not found', 'NOT_FOUND');
    }
    const createdBy = await resolveDisplayName(next.createdBy);
    return toMetadata(next, createdBy);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiKeyValidationError('An API key with this name already exists', 'NAME_TAKEN');
    }
    throw err;
  }
}

export async function regenerateKey(
  projectId: string,
  id: string,
): Promise<{ key: ApiKeyMetadata; rawKey: string }> {
  const row = await loadActiveKey(projectId, id);
  if (!row) {
    throw new ApiKeyValidationError('API key not found', 'NOT_FOUND');
  }

  const now = new Date();
  const rawKey = generateRawKey();
  const keyHash = hashRawKey(rawKey);
  const keyPrefix = keyPrefixFromRaw(rawKey);
  const expires = deriveExpiry(row.cadence, now);

  const updated = await db
    .update(apiKeys)
    .set({
      keyHash,
      keyPrefix,
      expiresAt: expires ? expires.toISOString() : null,
    })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.projectId, projectId), isNull(apiKeys.deletedAt)))
    .returning();

  const next = updated[0];
  if (!next) {
    throw new ApiKeyValidationError('API key not found', 'NOT_FOUND');
  }
  const createdBy = await resolveDisplayName(next.createdBy);
  return { key: toMetadata(next, createdBy, now), rawKey };
}

export async function deleteKey(
  projectId: string,
  id: string,
  userId: string,
): Promise<void> {
  const row = await loadActiveKey(projectId, id);
  if (!row) {
    throw new ApiKeyValidationError('API key not found', 'NOT_FOUND');
  }

  const now = new Date().toISOString();
  await db
    .update(apiKeys)
    .set({ deletedAt: now, deletedBy: userId })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.projectId, projectId), isNull(apiKeys.deletedAt)));
}

/**
 * Narrow verification seam for FEAT-002 public authentication.
 * Returns null for unknown, deleted, or expired keys.
 */
export async function verifyRawKey(
  rawKey: string,
): Promise<{ apiKeyId: string; projectId: string; scopes: ApiKeyScope[] } | null> {
  if (typeof rawKey !== 'string' || !rawKey.startsWith(RAW_KEY_PREFIX)) {
    return null;
  }
  const keyHash = hashRawKey(rawKey);
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (deriveStatus(row.expiresAt) === 'expired') return null;
  const scopes = Array.isArray(row.scopes)
    ? normalizeApiKeyScopes(row.scopes)
    : [];
  return { apiKeyId: row.id, projectId: row.projectId, scopes };
}
