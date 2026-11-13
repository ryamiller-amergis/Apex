import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  projectReleasePlatforms,
  releaseEpicPlatforms,
  releaseWorkItemPlatforms,
} from '../db/schema';
import {
  isValidReleasePlatformColor,
  slugifyReleasePlatform,
  type ProjectReleasePlatformsState,
  type ReleasePlatform,
  type ReleasePlatformColor,
} from '../../shared/types/releasePlatforms';

export class ReleasePlatformValidationError extends Error {
  readonly code: 'VALIDATION_ERROR' | 'DUPLICATE_PLATFORM' | 'NOT_FOUND';

  constructor(code: 'VALIDATION_ERROR' | 'DUPLICATE_PLATFORM' | 'NOT_FOUND', message: string) {
    super(message);
    this.name = 'ReleasePlatformValidationError';
    this.code = code;
  }
}

function toReleasePlatformDto(
  row: typeof projectReleasePlatforms.$inferSelect,
): ReleasePlatform {
  return {
    id: row.id,
    project: row.project,
    slug: row.slug,
    name: row.name,
    color: isValidReleasePlatformColor(row.color) ? row.color : 'blue',
    sortOrder: row.sortOrder,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

function normalizeProject(project: string): string {
  const trimmed = typeof project === 'string' ? project.trim() : '';
  if (!trimmed) {
    throw new ReleasePlatformValidationError('VALIDATION_ERROR', 'project is required');
  }
  return trimmed;
}

export async function listProjectReleasePlatforms(
  project: string,
): Promise<ReleasePlatform[]> {
  const normalizedProject = normalizeProject(project);
  const rows = await db
    .select()
    .from(projectReleasePlatforms)
    .where(eq(projectReleasePlatforms.project, normalizedProject))
    .orderBy(asc(projectReleasePlatforms.sortOrder), asc(projectReleasePlatforms.createdAt));

  return rows.map(toReleasePlatformDto);
}

export async function getProjectReleasePlatformsState(
  project: string,
): Promise<ProjectReleasePlatformsState> {
  const normalizedProject = normalizeProject(project);

  const [platformRows, epicRows, workItemRows] = await Promise.all([
    db
      .select()
      .from(projectReleasePlatforms)
      .where(eq(projectReleasePlatforms.project, normalizedProject))
      .orderBy(asc(projectReleasePlatforms.sortOrder), asc(projectReleasePlatforms.createdAt)),
    db
      .select({
        adoEpicId: releaseEpicPlatforms.adoEpicId,
        platformId: releaseEpicPlatforms.platformId,
      })
      .from(releaseEpicPlatforms)
      .where(eq(releaseEpicPlatforms.project, normalizedProject)),
    db
      .select({
        workItemId: releaseWorkItemPlatforms.workItemId,
        platformId: releaseWorkItemPlatforms.platformId,
      })
      .from(releaseWorkItemPlatforms)
      .where(eq(releaseWorkItemPlatforms.project, normalizedProject)),
  ]);

  const platforms = platformRows.map(toReleasePlatformDto);
  const validPlatformIds = new Set(platforms.map((p) => p.id));

  const epicPlatformIds: Record<number, string[]> = {};
  for (const row of epicRows) {
    if (!validPlatformIds.has(row.platformId)) continue;
    const existing = epicPlatformIds[row.adoEpicId] ?? [];
    if (!existing.includes(row.platformId)) {
      epicPlatformIds[row.adoEpicId] = [...existing, row.platformId];
    }
  }

  const workItemPlatformIds: Record<number, string[]> = {};
  for (const row of workItemRows) {
    if (!validPlatformIds.has(row.platformId)) continue;
    const existing = workItemPlatformIds[row.workItemId] ?? [];
    if (!existing.includes(row.platformId)) {
      workItemPlatformIds[row.workItemId] = [...existing, row.platformId];
    }
  }

  return {
    project: normalizedProject,
    platforms,
    epicPlatformIds,
    workItemPlatformIds,
  };
}

export async function createProjectReleasePlatform(input: {
  project: string;
  name: string;
  color?: string;
  createdBy?: string;
}): Promise<ReleasePlatform> {
  const normalizedProject = normalizeProject(input.project);
  const trimmedName = typeof input.name === 'string' ? input.name.trim() : '';
  if (!trimmedName) {
    throw new ReleasePlatformValidationError('VALIDATION_ERROR', 'Platform name is required');
  }
  if (trimmedName.length > 60) {
    throw new ReleasePlatformValidationError(
      'VALIDATION_ERROR',
      'Platform name must be 60 characters or fewer',
    );
  }

  const slug = slugifyReleasePlatform(trimmedName);
  if (!slug) {
    throw new ReleasePlatformValidationError(
      'VALIDATION_ERROR',
      'Platform name must include letters or numbers',
    );
  }

  const color: ReleasePlatformColor =
    input.color === undefined
      ? 'blue'
      : isValidReleasePlatformColor(input.color)
        ? input.color
        : (() => {
            throw new ReleasePlatformValidationError(
              'VALIDATION_ERROR',
              `Unsupported platform color: ${input.color}`,
            );
          })();

  const existing = await db
    .select()
    .from(projectReleasePlatforms)
    .where(eq(projectReleasePlatforms.project, normalizedProject))
    .orderBy(asc(projectReleasePlatforms.sortOrder));

  if (existing.some((row) => row.slug === slug)) {
    throw new ReleasePlatformValidationError(
      'DUPLICATE_PLATFORM',
      `Platform "${trimmedName}" already exists for this project`,
    );
  }

  const nextSortOrder =
    existing.length > 0
      ? Math.max(...existing.map((row) => row.sortOrder)) + 1
      : 0;

  const [inserted] = await db
    .insert(projectReleasePlatforms)
    .values({
      project: normalizedProject,
      slug,
      name: trimmedName,
      color,
      sortOrder: nextSortOrder,
      createdBy: input.createdBy ?? null,
    })
    .returning();

  return toReleasePlatformDto(inserted);
}

export async function reorderProjectReleasePlatforms(
  project: string,
  platformIds: string[],
): Promise<ReleasePlatform[]> {
  const normalizedProject = normalizeProject(project);
  if (
    !Array.isArray(platformIds) ||
    platformIds.length === 0 ||
    !platformIds.every((id) => typeof id === 'string' && id.trim().length > 0)
  ) {
    throw new ReleasePlatformValidationError(
      'VALIDATION_ERROR',
      'platformIds must be a non-empty array of platform IDs',
    );
  }
  if (new Set(platformIds).size !== platformIds.length) {
    throw new ReleasePlatformValidationError(
      'VALIDATION_ERROR',
      'platformIds must not contain duplicates',
    );
  }

  const existing = await listProjectReleasePlatforms(normalizedProject);
  const existingMap = new Map(existing.map((p) => [p.id, p]));
  for (const id of platformIds) {
    if (!existingMap.has(id)) {
      throw new ReleasePlatformValidationError(
        'NOT_FOUND',
        `Platform ${id} does not belong to project ${normalizedProject}`,
      );
    }
  }

  // Append any remaining project platforms not explicitly passed so sortOrder stays contiguous
  const remainingIds = existing
    .map((p) => p.id)
    .filter((id) => !platformIds.includes(id));
  const finalOrder = [...platformIds, ...remainingIds];

  await db.transaction(async (tx) => {
    for (let index = 0; index < finalOrder.length; index++) {
      await tx
        .update(projectReleasePlatforms)
        .set({ sortOrder: index })
        .where(
          and(
            eq(projectReleasePlatforms.project, normalizedProject),
            eq(projectReleasePlatforms.id, finalOrder[index]),
          ),
        );
    }
  });

  return listProjectReleasePlatforms(normalizedProject);
}

export async function deleteProjectReleasePlatform(
  project: string,
  platformId: string,
): Promise<void> {
  const normalizedProject = normalizeProject(project);
  const trimmedId = typeof platformId === 'string' ? platformId.trim() : '';
  if (!trimmedId) {
    throw new ReleasePlatformValidationError('VALIDATION_ERROR', 'platformId is required');
  }

  const deleted = await db
    .delete(projectReleasePlatforms)
    .where(
      and(
        eq(projectReleasePlatforms.project, normalizedProject),
        eq(projectReleasePlatforms.id, trimmedId),
      ),
    )
    .returning({ id: projectReleasePlatforms.id });

  if (deleted.length === 0) {
    throw new ReleasePlatformValidationError('NOT_FOUND', 'Platform not found');
  }
}

async function validateProjectPlatformIds(
  project: string,
  platformIds: unknown,
): Promise<string[]> {
  if (!Array.isArray(platformIds) || !platformIds.every((id) => typeof id === 'string')) {
    throw new ReleasePlatformValidationError(
      'VALIDATION_ERROR',
      'platformIds must be an array of platform ID strings',
    );
  }

  const deduped = Array.from(new Set(platformIds.map((id) => id.trim()).filter(Boolean)));
  if (deduped.length === 0) return [];

  const validRows = await db
    .select({ id: projectReleasePlatforms.id })
    .from(projectReleasePlatforms)
    .where(
      and(
        eq(projectReleasePlatforms.project, project),
        inArray(projectReleasePlatforms.id, deduped),
      ),
    );

  const validIds = new Set(validRows.map((row) => row.id));
  const invalid = deduped.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    throw new ReleasePlatformValidationError(
      'VALIDATION_ERROR',
      `Unknown platform IDs for project ${project}: ${invalid.join(', ')}`,
    );
  }

  return deduped;
}

export async function setReleaseEpicPlatforms(input: {
  project: string;
  adoEpicId: number;
  platformIds: string[];
}): Promise<string[]> {
  const normalizedProject = normalizeProject(input.project);
  if (!Number.isInteger(input.adoEpicId) || input.adoEpicId <= 0) {
    throw new ReleasePlatformValidationError('VALIDATION_ERROR', 'Invalid release epic ID');
  }

  const validIds = await validateProjectPlatformIds(normalizedProject, input.platformIds);

  await db.transaction(async (tx) => {
    await tx
      .delete(releaseEpicPlatforms)
      .where(
        and(
          eq(releaseEpicPlatforms.project, normalizedProject),
          eq(releaseEpicPlatforms.adoEpicId, input.adoEpicId),
        ),
      );

    if (validIds.length > 0) {
      await tx
        .insert(releaseEpicPlatforms)
        .values(
          validIds.map((platformId) => ({
            project: normalizedProject,
            adoEpicId: input.adoEpicId,
            platformId,
          })),
        )
        .onConflictDoNothing();
    }
  });

  return validIds;
}

export async function setReleaseWorkItemPlatforms(input: {
  project: string;
  workItemId: number;
  platformIds: string[];
  updatedBy?: string;
}): Promise<string[]> {
  const normalizedProject = normalizeProject(input.project);
  if (!Number.isInteger(input.workItemId) || input.workItemId <= 0) {
    throw new ReleasePlatformValidationError('VALIDATION_ERROR', 'Invalid work item ID');
  }

  const validIds = await validateProjectPlatformIds(normalizedProject, input.platformIds);
  const nowIso = new Date().toISOString();

  await db.transaction(async (tx) => {
    await tx
      .delete(releaseWorkItemPlatforms)
      .where(
        and(
          eq(releaseWorkItemPlatforms.project, normalizedProject),
          eq(releaseWorkItemPlatforms.workItemId, input.workItemId),
        ),
      );

    if (validIds.length > 0) {
      await tx
        .insert(releaseWorkItemPlatforms)
        .values(
          validIds.map((platformId) => ({
            project: normalizedProject,
            workItemId: input.workItemId,
            platformId,
            updatedBy: input.updatedBy ?? null,
            updatedAt: nowIso,
          })),
        )
        .onConflictDoNothing();
    }
  });

  return validIds;
}
