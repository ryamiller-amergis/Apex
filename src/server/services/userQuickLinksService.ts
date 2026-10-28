import { and, asc, count, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { userQuickLinks } from '../db/schema';
import {
  ProjectQuickLinkError,
  USER_QUICK_LINKS_MAX_PER_PROJECT,
  type CreateUserQuickLinkInput,
  type ImportQuickLinksResult,
  type UpdateUserQuickLinkInput,
  type UserQuickLink,
} from '../../shared/types/projectQuickLinks';
import { assertImportItems, planQuickLinkImport } from './quickLinkImport';
import { normalizeCategory, normalizeLabel, normalizeUrl } from './quickLinkValidation';

type UserQuickLinkRow = typeof userQuickLinks.$inferSelect;

const LIMIT_MESSAGE = `You can keep up to ${USER_QUICK_LINKS_MAX_PER_PROJECT} personal links per project`;
const DUPLICATE_MESSAGE = 'You already have a link to this URL';

function toDto(row: UserQuickLinkRow): UserQuickLink {
  return {
    id: row.id,
    project: row.project,
    label: row.label,
    url: row.url,
    category: row.category,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireOwner(userId: string, project: string): { userId: string; project: string } {
  if (typeof userId !== 'string' || !userId.trim()) {
    throw new ProjectQuickLinkError('User is required');
  }
  const projectName = typeof project === 'string' ? project.trim() : '';
  if (!projectName) throw new ProjectQuickLinkError('Project is required');
  return { userId, project: projectName };
}

function ownedBy(owner: { userId: string; project: string }) {
  return and(eq(userQuickLinks.userId, owner.userId), eq(userQuickLinks.project, owner.project));
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

async function countOwned(owner: { userId: string; project: string }): Promise<number> {
  const [row] = await db.select({ value: count() }).from(userQuickLinks).where(ownedBy(owner));
  return Number(row?.value ?? 0);
}

export async function listUserLinks(userId: string, project: string): Promise<UserQuickLink[]> {
  const owner = requireOwner(userId, project);
  const rows = await db
    .select()
    .from(userQuickLinks)
    .where(ownedBy(owner))
    .orderBy(asc(userQuickLinks.category), asc(userQuickLinks.sortOrder), asc(userQuickLinks.label));
  return rows.map(toDto);
}

export async function createUserLink(
  userId: string,
  project: string,
  input: CreateUserQuickLinkInput,
): Promise<UserQuickLink> {
  const owner = requireOwner(userId, project);
  const values = {
    ...owner,
    label: normalizeLabel(input?.label),
    url: normalizeUrl(input?.url),
    category: normalizeCategory(input?.category),
  };
  const existing = await countOwned(owner);
  if (existing >= USER_QUICK_LINKS_MAX_PER_PROJECT) {
    throw new ProjectQuickLinkError(LIMIT_MESSAGE, 'LIMIT_REACHED');
  }
  const [row] = await db
    .insert(userQuickLinks)
    .values({ ...values, sortOrder: existing })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new ProjectQuickLinkError(DUPLICATE_MESSAGE, 'DUPLICATE');
  return toDto(row);
}

export async function updateUserLink(
  userId: string,
  project: string,
  id: string,
  input: UpdateUserQuickLinkInput,
): Promise<UserQuickLink> {
  const owner = requireOwner(userId, project);
  const patch: Partial<typeof userQuickLinks.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (input?.label !== undefined) patch.label = normalizeLabel(input.label);
  if (input?.url !== undefined) patch.url = normalizeUrl(input.url);
  if (input?.category !== undefined) patch.category = normalizeCategory(input.category);

  let row: UserQuickLinkRow | undefined;
  try {
    [row] = await db
      .update(userQuickLinks)
      .set(patch)
      .where(and(eq(userQuickLinks.id, id), ownedBy(owner)))
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) throw new ProjectQuickLinkError(DUPLICATE_MESSAGE, 'DUPLICATE');
    throw err;
  }
  if (!row) throw new ProjectQuickLinkError('Quick link not found', 'NOT_FOUND');
  return toDto(row);
}

export async function deleteUserLink(userId: string, project: string, id: string): Promise<void> {
  const owner = requireOwner(userId, project);
  const deleted = await db
    .delete(userQuickLinks)
    .where(and(eq(userQuickLinks.id, id), ownedBy(owner)))
    .returning({ id: userQuickLinks.id });
  if (deleted.length === 0) throw new ProjectQuickLinkError('Quick link not found', 'NOT_FOUND');
}

/**
 * Creates personal links from a bookmark import. Each item is validated on its own: invalid
 * items are rejected, URLs the user already has (or that repeat in the batch) are skipped,
 * and items past the per-project cap are rejected.
 */
export async function importUserLinks(
  userId: string,
  project: string,
  items: unknown,
): Promise<ImportQuickLinksResult> {
  const owner = requireOwner(userId, project);
  assertImportItems(items);
  return db.transaction(async (tx) => {
    const existingRows = await tx
      .select({ url: userQuickLinks.url })
      .from(userQuickLinks)
      .where(ownedBy(owner));
    const plan = planQuickLinkImport(
      items,
      existingRows.map((r) => r.url),
      USER_QUICK_LINKS_MAX_PER_PROJECT,
      LIMIT_MESSAGE,
    );

    let created = 0;
    if (plan.toInsert.length > 0) {
      const inserted = await tx
        .insert(userQuickLinks)
        .values(
          plan.toInsert.map((item, i) => ({
            ...owner,
            label: item.label,
            url: item.url,
            category: item.category,
            sortOrder: existingRows.length + i,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: userQuickLinks.id });
      created = inserted.length;
    }

    return {
      created,
      skippedDuplicates: plan.skippedDuplicates + plan.toInsert.length - created,
      rejected: plan.rejected,
    };
  });
}
