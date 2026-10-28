import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { projectQuickLinks } from '../db/schema';
import {
  ProjectQuickLinkError,
  QUICK_LINK_CATEGORY_MAX_LENGTH,
  QUICK_LINK_LABEL_MAX_LENGTH,
  QUICK_LINK_URL_MAX_LENGTH,
  type CreateProjectQuickLinkInput,
  type ProjectQuickLink,
  type UpdateProjectQuickLinkInput,
} from '../../shared/types/projectQuickLinks';

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

export function normalizeLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProjectQuickLinkError('Label is required');
  }
  const label = value.trim();
  if (label.length > QUICK_LINK_LABEL_MAX_LENGTH) {
    throw new ProjectQuickLinkError(
      `Label must be ${QUICK_LINK_LABEL_MAX_LENGTH} characters or fewer`,
    );
  }
  return label;
}

/** Accepts only absolute http(s) URLs so a link can never run script (`javascript:`, `data:`). */
export function normalizeUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProjectQuickLinkError('URL is required');
  }
  const raw = value.trim();
  if (raw.length > QUICK_LINK_URL_MAX_LENGTH) {
    throw new ProjectQuickLinkError(
      `URL must be ${QUICK_LINK_URL_MAX_LENGTH} characters or fewer`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ProjectQuickLinkError('URL is not valid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProjectQuickLinkError('URL must start with http:// or https://');
  }
  return parsed.toString();
}

export function normalizeCategory(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ProjectQuickLinkError('Category must be text');
  const category = value.trim();
  if (!category) return null;
  if (category.length > QUICK_LINK_CATEGORY_MAX_LENGTH) {
    throw new ProjectQuickLinkError(
      `Category must be ${QUICK_LINK_CATEGORY_MAX_LENGTH} characters or fewer`,
    );
  }
  return category;
}

export function normalizeSortOrder(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100_000) {
    throw new ProjectQuickLinkError('Sort order must be a whole number from 0 to 100000');
  }
  return n;
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
