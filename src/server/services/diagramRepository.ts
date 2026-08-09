import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  appUsers,
  diagramShares,
  diagrams,
  userProjectAssignments,
} from '../db/schema';
import type {
  DiagramShareAccess,
  ExcalidrawScene,
} from '../../shared/types/diagram';

export type DiagramRow = typeof diagrams.$inferSelect;
export type DiagramShareRow = typeof diagramShares.$inferSelect;

export type SharedDiagramRow = {
  diagram: DiagramRow;
  access: DiagramShareAccess;
};

export type DiagramWrite = {
  title: string;
  scene: ExcalidrawScene;
  thumbnail: string;
};

export async function createDiagram(
  projectId: string,
  ownerId: string,
  input: DiagramWrite,
): Promise<DiagramRow> {
  const [created] = await db
    .insert(diagrams)
    .values({ projectId, ownerId, ...input })
    .returning();
  return created;
}

export async function findDiagram(
  projectId: string,
  diagramId: string,
): Promise<DiagramRow | null> {
  const [row] = await db
    .select()
    .from(diagrams)
    .where(and(eq(diagrams.id, diagramId), eq(diagrams.projectId, projectId)))
    .limit(1);
  return row ?? null;
}

export async function listOwnedDiagrams(
  projectId: string,
  ownerId: string,
  limit: number,
  offset: number,
): Promise<DiagramRow[]> {
  return db
    .select()
    .from(diagrams)
    .where(and(eq(diagrams.projectId, projectId), eq(diagrams.ownerId, ownerId)))
    .orderBy(desc(diagrams.updatedAt), desc(diagrams.id))
    .limit(limit)
    .offset(offset);
}

export async function listSharedDiagrams(
  projectId: string,
  granteeId: string,
  limit: number,
  offset: number,
): Promise<SharedDiagramRow[]> {
  return db
    .select({ diagram: diagrams, access: diagramShares.access })
    .from(diagramShares)
    .innerJoin(diagrams, eq(diagramShares.diagramId, diagrams.id))
    .where(and(
      eq(diagrams.projectId, projectId),
      eq(diagramShares.granteeId, granteeId),
      ne(diagrams.ownerId, granteeId),
    ))
    .orderBy(desc(diagrams.updatedAt), desc(diagrams.id))
    .limit(limit)
    .offset(offset);
}

export async function updateDiagramWithVersion(
  projectId: string,
  diagramId: string,
  expectedVersion: number,
  input: DiagramWrite,
): Promise<DiagramRow | null> {
  const [updated] = await db
    .update(diagrams)
    .set({
      ...input,
      version: sql`${diagrams.version} + 1`,
      updatedAt: sql`NOW()`,
    })
    .where(and(
      eq(diagrams.id, diagramId),
      eq(diagrams.projectId, projectId),
      eq(diagrams.version, expectedVersion),
    ))
    .returning();
  return updated ?? null;
}

export async function deleteDiagram(
  projectId: string,
  diagramId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(diagrams)
    .where(and(eq(diagrams.id, diagramId), eq(diagrams.projectId, projectId)))
    .returning({ id: diagrams.id });
  return deleted.length > 0;
}

export async function findShare(
  diagramId: string,
  granteeId: string,
): Promise<DiagramShareRow | null> {
  const [share] = await db
    .select()
    .from(diagramShares)
    .where(and(
      eq(diagramShares.diagramId, diagramId),
      eq(diagramShares.granteeId, granteeId),
    ))
    .limit(1);
  return share ?? null;
}

export async function listShares(diagramId: string): Promise<DiagramShareRow[]> {
  return db
    .select()
    .from(diagramShares)
    .where(eq(diagramShares.diagramId, diagramId))
    .orderBy(asc(diagramShares.createdAt), asc(diagramShares.id));
}

export async function upsertShare(
  diagramId: string,
  granteeId: string,
  access: DiagramShareAccess,
): Promise<DiagramShareRow> {
  const [share] = await db
    .insert(diagramShares)
    .values({ diagramId, granteeId, access })
    .onConflictDoUpdate({
      target: [diagramShares.diagramId, diagramShares.granteeId],
      set: { access },
    })
    .returning();
  return share;
}

export async function deleteShare(
  diagramId: string,
  granteeId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(diagramShares)
    .where(and(
      eq(diagramShares.diagramId, diagramId),
      eq(diagramShares.granteeId, granteeId),
    ))
    .returning({ id: diagramShares.id });
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
