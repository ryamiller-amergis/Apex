import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { projectQuickLinks } from '../db/schema';
import {
  ProjectQuickLinkError,
  PROJECT_QUICK_LINKS_MAX_PER_PROJECT,
  type ImportQuickLinksResult,
  type CreateProjectQuickLinkInput,
  type ProjectQuickLink,
  type UpdateProjectQuickLinkInput,
} from '../../shared/types/projectQuickLinks';
import { assertImportItems, planQuickLinkImport } from './quickLinkImport';
import {
  normalizeCategory,
  normalizeLabel,
  normalizeSortOrder,
  normalizeUrl,
} from './quickLinkValidation';

export { normalizeCategory, normalizeLabel, normalizeSortOrder, normalizeUrl };

type QuickLinkRow = typeof projectQuickLinks.$inferSelect;

function toDto(row: QuickLinkRow): ProjectQuickLink {
  return {
    id: row.id,
    project: row.project,
    label: row.label,
    url: row.url,
    category: row.category,
    sortOrder: row.sortOrder,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireProject(project: string): string {
  const trimmed = typeof project === 'string' ? project.trim() : '';
  if (!trimmed) throw new ProjectQuickLinkError('Project is required');
  return trimmed;
}

export async function listLinks(project: string): Promise<ProjectQuickLink[]> {
  const rows = await db
    .select()
    .from(projectQuickLinks)
    .where(eq(projectQuickLinks.project, requireProject(project)))
    .orderBy(
      asc(projectQuickLinks.category),
      asc(projectQuickLinks.sortOrder),
      asc(projectQuickLinks.label),
    );
  return rows.map(toDto);
}

export async function createLink(
  project: string,
  input: CreateProjectQuickLinkInput,
  actor: string,
): Promise<ProjectQuickLink> {
  const values = {
    project: requireProject(project),
    label: normalizeLabel(input?.label),
    url: normalizeUrl(input?.url),
    category: normalizeCategory(input?.category),
    sortOrder: normalizeSortOrder(input?.sortOrder),
    createdBy: actor,
    updatedBy: actor,
  };
  const [row] = await db.insert(projectQuickLinks).values(values).returning();
  return toDto(row);
}

export async function updateLink(
  project: string,
  id: string,
  input: UpdateProjectQuickLinkInput,
  actor: string,
): Promise<ProjectQuickLink> {
  const projectName = requireProject(project);
  const patch: Partial<typeof projectQuickLinks.$inferInsert> = {
    updatedBy: actor,
    updatedAt: new Date().toISOString(),
  };
  if (input?.label !== undefined) patch.label = normalizeLabel(input.label);
  if (input?.url !== undefined) patch.url = normalizeUrl(input.url);
  if (input?.category !== undefined) patch.category = normalizeCategory(input.category);
  if (input?.sortOrder !== undefined) patch.sortOrder = normalizeSortOrder(input.sortOrder);

  const [row] = await db
    .update(projectQuickLinks)
    .set(patch)
    .where(and(eq(projectQuickLinks.id, id), eq(projectQuickLinks.project, projectName)))
    .returning();
  if (!row) throw new ProjectQuickLinkError('Quick link not found', 'NOT_FOUND');
  return toDto(row);
}

export async function deleteLink(project: string, id: string): Promise<void> {
  const deleted = await db
    .delete(projectQuickLinks)
    .where(and(eq(projectQuickLinks.id, id), eq(projectQuickLinks.project, requireProject(project))))
    .returning({ id: projectQuickLinks.id });
  if (deleted.length === 0) throw new ProjectQuickLinkError('Quick link not found', 'NOT_FOUND');
}

export async function reorderLinks(
  project: string,
  ids: unknown,
  actor: string,
): Promise<ProjectQuickLink[]> {
  const projectName = requireProject(project);
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)) {
    throw new ProjectQuickLinkError('ids must be a list of quick link ids');
  }
  const orderedIds = ids as string[];
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new ProjectQuickLinkError('ids must not repeat');
  }
  if (orderedIds.length > 0) {
    await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: projectQuickLinks.id })
        .from(projectQuickLinks)
        .where(and(eq(projectQuickLinks.project, projectName), inArray(projectQuickLinks.id, orderedIds)));
      if (existing.length !== orderedIds.length) {
        throw new ProjectQuickLinkError('Quick link not found', 'NOT_FOUND');
      }
      for (const [index, id] of orderedIds.entries()) {
        await tx
          .update(projectQuickLinks)
          .set({ sortOrder: index, updatedBy: actor, updatedAt: new Date().toISOString() })
          .where(and(eq(projectQuickLinks.id, id), eq(projectQuickLinks.project, projectName)));
      }
    });
  }
  return listLinks(projectName);
}

/** Creates shared project links from a bookmark import, with the same per-item rules as personal imports. */
export async function importLinks(
  project: string,
  items: unknown,
  actor: string,
): Promise<ImportQuickLinksResult> {
  const projectName = requireProject(project);
  assertImportItems(items);
  return db.transaction(async (tx) => {
    const existingRows = await tx
      .select({ url: projectQuickLinks.url })
      .from(projectQuickLinks)
      .where(eq(projectQuickLinks.project, projectName));
    const plan = planQuickLinkImport(
      items,
      existingRows.map((r) => r.url),
      PROJECT_QUICK_LINKS_MAX_PER_PROJECT,
      `A project can have up to ${PROJECT_QUICK_LINKS_MAX_PER_PROJECT} shared links`,
    );
    if (plan.toInsert.length > 0) {
      await tx.insert(projectQuickLinks).values(
        plan.toInsert.map((item, i) => ({
          project: projectName,
          label: item.label,
          url: item.url,
          category: item.category,
          sortOrder: existingRows.length + i,
          createdBy: actor,
          updatedBy: actor,
        })),
      );
    }
    return {
      created: plan.toInsert.length,
      skippedDuplicates: plan.skippedDuplicates,
      rejected: plan.rejected,
    };
  });
}
