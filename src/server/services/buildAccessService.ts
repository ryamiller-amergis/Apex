import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { buildAllowlist, buildAllowlistAudit } from '../db/schema';
import { isFeatureEnabled, isFeatureOperational } from './featureFlagService';
import { listSkillConfigsForProject } from './projectSettingsService';
import { BUILD_FROM_PROMPT_FLAG } from '../../shared/types/featureFlags';
import type { BuildAllowlistEntry } from '../../shared/types/buildAccess';

export type BuildAccessErrorKind = 'INVALID' | 'NOT_FOUND' | 'DUPLICATE';

export class BuildAccessError extends Error {
  constructor(public readonly kind: BuildAccessErrorKind, message: string) {
    super(message);
    this.name = 'BuildAccessError';
  }
}

export interface BuildAllowlistActor {
  id: string;
  label: string | null;
}

export interface AddBuildAllowlistEntryInput {
  project: string;
  repository: string;
  actor: BuildAllowlistActor;
}

const ENTRY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

function mapRow(row: typeof buildAllowlist.$inferSelect): BuildAllowlistEntry {
  return {
    id: row.id,
    project: row.project,
    repository: row.repository,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/**
 * Per-user, per-project result for routes. Honours targeting rules.
 * Cleanup plan for `build-from-prompt`: retain the enabled branch after two
 * stable sprints at full rollout.
 */
export function isBuildFromPromptEnabled(ctx: { userId: string; project: string }): Promise<boolean> {
  return isFeatureEnabled(BUILD_FROM_PROMPT_FLAG, ctx);
}

/** Kill-switch check for the dispatcher: enabled and not archived. */
export function isBuildFromPromptOperational(): Promise<boolean> {
  return isFeatureOperational(BUILD_FROM_PROMPT_FLAG);
}

/**
 * Live allow-list check. Repository match ignores case. No cache, so an add
 * or remove is visible to every instance on the next call.
 */
export async function isBuildPairAllowed(project: string, repository: string): Promise<boolean> {
  const p = project?.trim() ?? '';
  const r = repository?.trim() ?? '';
  if (!p || !r) return false;
  const rows = await db
    .select({ id: buildAllowlist.id })
    .from(buildAllowlist)
    .where(and(eq(buildAllowlist.project, p), sql`lower(${buildAllowlist.repository}) = lower(${r})`))
    .limit(1);
  return rows.length > 0;
}

export async function listBuildAllowlist(): Promise<BuildAllowlistEntry[]> {
  const rows = await db
    .select()
    .from(buildAllowlist)
    .orderBy(asc(buildAllowlist.project), asc(buildAllowlist.repository));
  return rows.map(mapRow);
}

/** Approved repositories for one project, for the New build form. */
export async function listAllowedRepositoriesForProject(project: string): Promise<string[]> {
  const rows = await db
    .select({ repository: buildAllowlist.repository })
    .from(buildAllowlist)
    .where(eq(buildAllowlist.project, project))
    .orderBy(asc(buildAllowlist.repository));
  return rows.map((row) => row.repository);
}

/** Repositories configured in Project Skill Settings that an admin may approve. */
export async function listCandidateRepositories(project: string): Promise<string[]> {
  const p = project?.trim() ?? '';
  if (!p) return [];
  const configs = await listSkillConfigsForProject(p);
  const byLower = new Map<string, string>();
  for (const cfg of configs) {
    const repo = cfg.skillRepo?.trim() ?? '';
    if (repo && !byLower.has(repo.toLowerCase())) byLower.set(repo.toLowerCase(), repo);
  }
  return [...byLower.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export async function addBuildAllowlistEntry(input: AddBuildAllowlistEntryInput): Promise<BuildAllowlistEntry> {
  const project = input.project?.trim() ?? '';
  const requested = input.repository?.trim() ?? '';
  if (!project || !requested) {
    throw new BuildAccessError('INVALID', 'Choose a project and a repository.');
  }

  const configs = await listSkillConfigsForProject(project);
  const match = configs.find((cfg) => cfg.skillRepo?.trim().toLowerCase() === requested.toLowerCase());
  if (!match) {
    throw new BuildAccessError('INVALID', 'That repository is not configured for this project.');
  }
  const repository = match.skillRepo.trim();

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(buildAllowlist)
        .values({ project, repository, createdBy: input.actor.label })
        .returning();
      await tx.insert(buildAllowlistAudit).values({
        action: 'added',
        project,
        repository,
        actorId: input.actor.id,
        actorLabel: input.actor.label,
      });
      return mapRow(row);
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new BuildAccessError('DUPLICATE', 'That repository is already approved for builds in this project.');
    }
    throw err;
  }
}

export async function removeBuildAllowlistEntry(id: string, actor: BuildAllowlistActor): Promise<void> {
  if (!ENTRY_ID_RE.test(id ?? '')) {
    throw new BuildAccessError('INVALID', 'That approved repository id is not valid.');
  }
  await db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(buildAllowlist)
      .where(eq(buildAllowlist.id, id))
      .returning({ project: buildAllowlist.project, repository: buildAllowlist.repository });
    if (!removed) {
      throw new BuildAccessError('NOT_FOUND', 'That approved repository no longer exists.');
    }
    await tx.insert(buildAllowlistAudit).values({
      action: 'removed',
      project: removed.project,
      repository: removed.repository,
      actorId: actor.id,
      actorLabel: actor.label,
    });
  });
}
