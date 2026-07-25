/**
 * loadTestTargetService — FEAT-005 Per-Project Target Allowlist
 *
 * Owns allowlist CRUD and shared validation helpers reused at definition save,
 * enqueue, and runner start (BR-001, BR-002).
 */

import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { loadTestTargets } from '../db/schema';
import type {
  CreateLoadTestTargetInput,
  LoadTestTarget,
  UpdateLoadTestTargetInput,
} from '../../shared/types/loadTest';
import { LoadTestValidationError } from '../../shared/types/loadTest';

type LoadTestTargetRow = typeof loadTestTargets.$inferSelect;

// ── Mapping ───────────────────────────────────────────────────────────────────

function mapTargetRow(row: LoadTestTargetRow): LoadTestTarget {
  return {
    id: row.id,
    projectId: row.projectId,
    baseUrl: row.baseUrl,
    environmentLabel: row.environmentLabel,
    isReachable: row.isReachable,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}

function assertProjectId(projectId: unknown): asserts projectId is string {
  if (!projectId || typeof projectId !== 'string') {
    throw new LoadTestValidationError('projectId is required', 'LOAD_TEST_VALIDATION');
  }
}

// ── URL normalization ─────────────────────────────────────────────────────────

/**
 * Persist/compare as canonical origin: scheme + host + optional port (no path/query/fragment).
 */
export function normalizeTargetUrl(raw: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new LoadTestValidationError('baseUrl is required', 'LOAD_TEST_VALIDATION');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new LoadTestValidationError(
      'baseUrl must be a valid http or https URL',
      'LOAD_TEST_VALIDATION',
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new LoadTestValidationError(
      'baseUrl must use http or https',
      'LOAD_TEST_VALIDATION',
    );
  }

  const origin = parsed.origin;
  // URL.origin lowercases host; strip default trailing slash semantics already handled
  return origin.replace(/\/+$/, '');
}

// ── Prod hard-refuse (BR-001) — deterministic, delimiter-safe ─────────────────

const PROD_ENV_EXACT = new Set(['prod', 'production', 'prd']);
/** Matches prod / production / prd as a whole label or with a delimiter suffix. */
const PROD_ENV_PREFIX = /^(prod|production|prd)([-_.]|$)/i;

export function isProdEnvironmentLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return false;
  if (PROD_ENV_EXACT.has(normalized)) return true;
  return PROD_ENV_PREFIX.test(normalized);
}

/**
 * Hostname segment rules (case-insensitive):
 * prod. | .prod. | -prod. | production. | .production. (and segment boundaries)
 * Delimiter-safe so product-api-staging is allowed.
 */
export function isProdHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;

  // Segment-bounded prod / production (not substrings like "product")
  if (/(?:^|[.-])prod(?:[.-]|$)/.test(host)) return true;
  if (/(?:^|[.-])production(?:[.-]|$)/.test(host)) return true;
  return false;
}

export interface NonProdAllowlistInput {
  baseUrl: string;
  environmentLabel: string;
  /** Optional explicit tier from payload (assumptions). */
  environmentTier?: string | null;
  isProd?: boolean | null;
}

export function assertNonProdAllowlistEntry(input: NonProdAllowlistInput): string {
  const normalized = normalizeTargetUrl(input.baseUrl);
  const label = input.environmentLabel?.trim() ?? '';
  if (!label) {
    throw new LoadTestValidationError('environmentLabel is required', 'LOAD_TEST_VALIDATION');
  }

  if (input.isProd === true || input.environmentTier?.toLowerCase() === 'prod') {
    throw new LoadTestValidationError(
      'Production targets are not allowed on the load-test allowlist.',
      'LOAD_TEST_TARGET_PROD_REFUSED',
    );
  }

  if (isProdEnvironmentLabel(label)) {
    throw new LoadTestValidationError(
      `Environment label "${label}" appears to be production and is refused.`,
      'LOAD_TEST_TARGET_PROD_REFUSED',
    );
  }

  const hostname = new URL(normalized).hostname;
  if (isProdHostname(hostname)) {
    throw new LoadTestValidationError(
      `Hostname "${hostname}" appears to be a production host and is refused.`,
      'LOAD_TEST_TARGET_PROD_REFUSED',
    );
  }

  return normalized;
}

/**
 * Ensures normalized URL matches an **active** allowlist row for the project
 * and passes non-prod checks. Used by definition save, enqueue, and runner.
 */
export async function assertTargetAllowlisted(
  projectId: string,
  baseUrl: string,
): Promise<void> {
  assertProjectId(projectId);
  const normalized = normalizeTargetUrl(baseUrl);

  const hostname = new URL(normalized).hostname;
  if (isProdHostname(hostname)) {
    throw new LoadTestValidationError(
      `Hostname "${hostname}" appears to be a production host and is refused.`,
      'LOAD_TEST_TARGET_PROD_REFUSED',
    );
  }

  const rows = await db
    .select()
    .from(loadTestTargets)
    .where(eq(loadTestTargets.projectId, projectId))
    .orderBy(desc(loadTestTargets.createdAt));

  const match = rows.find((row) => normalizeTargetUrl(row.baseUrl) === normalized);
  if (!match || !match.isActive) {
    throw new LoadTestValidationError(
      `Target "${normalized}" is not on the project allowlist. Add it via the allowlist admin before saving.`,
      'LOAD_TEST_TARGET_NOT_ALLOWLISTED',
    );
  }

  if (isProdEnvironmentLabel(match.environmentLabel)) {
    throw new LoadTestValidationError(
      `Allowlisted target "${normalized}" is tagged as production and is refused.`,
      'LOAD_TEST_TARGET_PROD_REFUSED',
    );
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function createTarget(
  projectId: string,
  input: CreateLoadTestTargetInput,
  userId: string,
): Promise<LoadTestTarget> {
  assertProjectId(projectId);

  const baseUrl = assertNonProdAllowlistEntry({
    baseUrl: input.baseUrl,
    environmentLabel: input.environmentLabel,
  });

  const rows = await db.transaction(async (tx) => {
    return tx
      .insert(loadTestTargets)
      .values({
        projectId,
        baseUrl,
        environmentLabel: input.environmentLabel.trim(),
        isReachable: input.isReachable ?? true,
        isActive: input.isActive ?? true,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
  });

  return mapTargetRow(rows[0]);
}

export async function updateTarget(
  projectId: string,
  id: string,
  input: UpdateLoadTestTargetInput,
  userId: string,
): Promise<LoadTestTarget | null> {
  assertProjectId(projectId);

  // Fail closed on prod patterns before touching storage when fields are provided
  if (input.baseUrl !== undefined) {
    const normalized = normalizeTargetUrl(input.baseUrl);
    if (isProdHostname(new URL(normalized).hostname)) {
      throw new LoadTestValidationError(
        `Hostname appears to be a production host and is refused.`,
        'LOAD_TEST_TARGET_PROD_REFUSED',
      );
    }
  }
  if (input.environmentLabel !== undefined && isProdEnvironmentLabel(input.environmentLabel)) {
    throw new LoadTestValidationError(
      `Environment label "${input.environmentLabel}" appears to be production and is refused.`,
      'LOAD_TEST_TARGET_PROD_REFUSED',
    );
  }
  if (input.baseUrl !== undefined && input.environmentLabel !== undefined) {
    assertNonProdAllowlistEntry({
      baseUrl: input.baseUrl,
      environmentLabel: input.environmentLabel,
    });
  }

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(loadTestTargets)
      .where(and(eq(loadTestTargets.id, id), eq(loadTestTargets.projectId, projectId)))
      .limit(1);

    if (existing.length === 0) return null;

    const nextBaseUrl = input.baseUrl ?? existing[0].baseUrl;
    const nextLabel = input.environmentLabel ?? existing[0].environmentLabel;

    const normalized = assertNonProdAllowlistEntry({
      baseUrl: nextBaseUrl,
      environmentLabel: nextLabel,
    });

    const updated = await tx
      .update(loadTestTargets)
      .set({
        baseUrl: normalized,
        environmentLabel: nextLabel.trim(),
        isReachable: input.isReachable ?? existing[0].isReachable,
        isActive: input.isActive ?? existing[0].isActive,
        updatedBy: userId,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(loadTestTargets.id, id), eq(loadTestTargets.projectId, projectId)))
      .returning();

    return updated.length > 0 ? mapTargetRow(updated[0]) : null;
  });
}

export async function listTargets(
  projectId: string,
  options?: { includeInactive?: boolean },
): Promise<LoadTestTarget[]> {
  assertProjectId(projectId);

  const rows = await db
    .select()
    .from(loadTestTargets)
    .where(eq(loadTestTargets.projectId, projectId))
    .orderBy(desc(loadTestTargets.createdAt));

  const mapped = rows.map(mapTargetRow);
  if (options?.includeInactive) return mapped;
  return mapped.filter((t) => t.isActive);
}

export async function deleteTarget(projectId: string, id: string): Promise<boolean> {
  assertProjectId(projectId);

  const rows = await db
    .delete(loadTestTargets)
    .where(and(eq(loadTestTargets.id, id), eq(loadTestTargets.projectId, projectId)))
    .returning({ id: loadTestTargets.id });

  return rows.length > 0;
}

/**
 * Soft-disable preferred for reversible removal from picker/validation.
 */
export async function deactivateTarget(
  projectId: string,
  id: string,
  userId: string,
): Promise<LoadTestTarget | null> {
  return updateTarget(projectId, id, { isActive: false }, userId);
}
