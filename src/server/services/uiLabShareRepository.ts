import {
  and,
  asc,
  eq,
  ilike,
  inArray,
  ne,
  or,
} from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  appUsers,
  uiLabDesignShares,
  userProjectAssignments,
} from '../db/schema';

export type UiLabDesignShareRow = typeof uiLabDesignShares.$inferSelect;

export async function findShare(
  designId: string,
  granteeId: string,
): Promise<UiLabDesignShareRow | null> {
  const [share] = await db
    .select()
    .from(uiLabDesignShares)
    .where(and(
      eq(uiLabDesignShares.designId, designId),
      eq(uiLabDesignShares.granteeId, granteeId),
    ))
    .limit(1);
  return share ?? null;
}

export async function listShares(designId: string): Promise<UiLabDesignShareRow[]> {
  return db
    .select()
    .from(uiLabDesignShares)
    .where(eq(uiLabDesignShares.designId, designId))
    .orderBy(asc(uiLabDesignShares.createdAt), asc(uiLabDesignShares.id));
}

export async function upsertShare(
  designId: string,
  granteeId: string,
  createdBy: string,
): Promise<{ share: UiLabDesignShareRow; created: boolean }> {
  const existing = await findShare(designId, granteeId);
  if (existing) {
    return { share: existing, created: false };
  }

  const [share] = await db
    .insert(uiLabDesignShares)
    .values({ designId, granteeId, createdBy })
    .onConflictDoNothing()
    .returning();

  if (share) {
    return { share, created: true };
  }

  // Race: another insert won; return the live row.
  const raced = await findShare(designId, granteeId);
  if (!raced) {
    throw new Error('Failed to create UI Lab share');
  }
  return { share: raced, created: false };
}

export async function deleteShare(
  designId: string,
  granteeId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(uiLabDesignShares)
    .where(and(
      eq(uiLabDesignShares.designId, designId),
      eq(uiLabDesignShares.granteeId, granteeId),
    ))
    .returning({ id: uiLabDesignShares.id });
  return deleted.length > 0;
}

export async function isCurrentProjectMember(
  projectId: string,
  userId: string,
): Promise<boolean> {
  const [assignment] = await db
    .select({ id: userProjectAssignments.id })
    .from(userProjectAssignments)
    .where(and(
      eq(userProjectAssignments.project, projectId),
      eq(userProjectAssignments.userId, userId),
    ))
    .limit(1);
  return Boolean(assignment);
}

export async function getDisplayNamesByIds(
  userIds: string[],
): Promise<Map<string, string | null>> {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const rows = await db
    .select({ oid: appUsers.oid, displayName: appUsers.displayName })
    .from(appUsers)
    .where(inArray(appUsers.oid, uniqueIds));

  return new Map(rows.map((row) => [row.oid, row.displayName ?? null]));
}

export async function listShareTargets(
  projectId: string,
  query: string,
  excludeUserId: string,
): Promise<Array<{ userId: string; displayName: string | null; email: string | null }>> {
  const normalizedQuery = query.trim();
  const conditions = [
    eq(userProjectAssignments.project, projectId),
    ne(userProjectAssignments.userId, excludeUserId),
  ];
  if (normalizedQuery) {
    const pattern = `%${normalizedQuery}%`;
    const textMatch = or(
      ilike(appUsers.displayName, pattern),
      ilike(appUsers.email, pattern),
    );
    if (textMatch) conditions.push(textMatch);
  }

  return db
    .select({
      userId: userProjectAssignments.userId,
      displayName: appUsers.displayName,
      email: appUsers.email,
    })
    .from(userProjectAssignments)
    .innerJoin(appUsers, eq(userProjectAssignments.userId, appUsers.oid))
    .where(and(...conditions))
    .orderBy(asc(appUsers.displayName), asc(appUsers.email))
    .limit(50);
}
