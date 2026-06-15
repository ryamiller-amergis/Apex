import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { pendingProjectAssignments } from '../db/schema';
import { assignUserToProject } from './userProjectAssignmentService';
import type { PendingProjectAssignment } from '../../shared/types/platformAdmin';

export async function addPendingAssignments(
  entries: { email: string; project: string }[],
  assignedBy?: string | null,
): Promise<void> {
  if (entries.length === 0) return;

  const now = new Date().toISOString();
  await db
    .insert(pendingProjectAssignments)
    .values(
      entries.map((e) => ({
        email: e.email.trim().toLowerCase(),
        project: e.project,
        assignedBy: assignedBy ?? null,
        assignedAt: now,
      })),
    )
    .onConflictDoNothing();
}

export async function resolvePendingAssignments(
  oid: string,
  email: string,
): Promise<void> {
  if (!oid || !email) return;

  await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: pendingProjectAssignments.id,
        project: pendingProjectAssignments.project,
        assignedBy: pendingProjectAssignments.assignedBy,
      })
      .from(pendingProjectAssignments)
      .where(eq(sql`LOWER(${pendingProjectAssignments.email})`, email.trim().toLowerCase()));

    if (rows.length === 0) return;

    for (const row of rows) {
      await assignUserToProject(oid, row.project, row.assignedBy);
    }

    await tx
      .delete(pendingProjectAssignments)
      .where(eq(sql`LOWER(${pendingProjectAssignments.email})`, email.trim().toLowerCase()));
  });
}

export async function listPendingForProject(
  project: string,
): Promise<PendingProjectAssignment[]> {
  const rows = await db
    .select()
    .from(pendingProjectAssignments)
    .where(eq(pendingProjectAssignments.project, project));

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    project: row.project,
    assignedBy: row.assignedBy,
    assignedAt: row.assignedAt,
  }));
}

export async function removePendingAssignment(
  email: string,
  project: string,
): Promise<void> {
  await db
    .delete(pendingProjectAssignments)
    .where(
      and(
        eq(sql`LOWER(${pendingProjectAssignments.email})`, email.trim().toLowerCase()),
        eq(pendingProjectAssignments.project, project),
      ),
    );
}
