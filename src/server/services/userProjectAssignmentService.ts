import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { appUsers, userProjectAssignments } from '../db/schema';
import type { PlatformAdminUser, ProjectAssignmentGroup, UserProjectAssignment } from '../../shared/types/platformAdmin';

type AssignmentRow = {
  id: string;
  userId: string;
  displayName: string | null;
  email: string | null;
  project: string;
  assignedBy: string | null;
  assignedAt: string;
};

function normalizeUserIds(userIds: string[]): string[] {
  return [...new Set(userIds.map((id) => id.trim()).filter(Boolean))];
}

function toAssignment(row: AssignmentRow): UserProjectAssignment {
  return {
    id: row.id,
    userId: row.userId,
    displayName: row.displayName ?? row.userId,
    email: row.email ?? '',
    project: row.project,
    assignedBy: row.assignedBy,
    assignedAt: row.assignedAt,
  };
}

function assignmentSelect() {
  return {
    id: userProjectAssignments.id,
    userId: userProjectAssignments.userId,
    displayName: appUsers.displayName,
    email: appUsers.email,
    project: userProjectAssignments.project,
    assignedBy: userProjectAssignments.assignedBy,
    assignedAt: userProjectAssignments.assignedAt,
  };
}

export async function listKnownApplicationUsers(): Promise<PlatformAdminUser[]> {
  const rows = await db
    .select({
      userId: appUsers.oid,
      displayName: appUsers.displayName,
      email: appUsers.email,
    })
    .from(appUsers)
    .orderBy(asc(appUsers.displayName), asc(appUsers.email), asc(appUsers.oid));

  return rows.map((row) => ({
    userId: row.userId,
    displayName: row.displayName ?? '',
    email: row.email ?? '',
  }));
}

export function groupAssignmentsByProject(assignments: UserProjectAssignment[]): ProjectAssignmentGroup[] {
  const grouped = new Map<string, ProjectAssignmentGroup>();

  for (const assignment of assignments) {
    const group = grouped.get(assignment.project) ?? { project: assignment.project, users: [] };
    group.users.push({
      userId: assignment.userId,
      displayName: assignment.displayName,
      email: assignment.email,
    });
    grouped.set(assignment.project, group);
  }

  return [...grouped.values()];
}

export async function getAssignmentsForUser(userId: string): Promise<string[]> {
  const rows = await db
    .select({ project: userProjectAssignments.project })
    .from(userProjectAssignments)
    .where(eq(userProjectAssignments.userId, userId))
    .orderBy(asc(userProjectAssignments.project));

  return rows.map((row) => row.project);
}

export async function getAssignmentsForProject(project: string): Promise<UserProjectAssignment[]> {
  const rows = await db
    .select(assignmentSelect())
    .from(userProjectAssignments)
    .innerJoin(appUsers, eq(userProjectAssignments.userId, appUsers.oid))
    .where(eq(userProjectAssignments.project, project))
    .orderBy(asc(appUsers.displayName), asc(appUsers.email));

  return rows.map(toAssignment);
}

export async function getAllAssignments(): Promise<UserProjectAssignment[]> {
  const rows = await db
    .select(assignmentSelect())
    .from(userProjectAssignments)
    .innerJoin(appUsers, eq(userProjectAssignments.userId, appUsers.oid))
    .orderBy(asc(userProjectAssignments.project), asc(appUsers.displayName), asc(appUsers.email));

  return rows.map(toAssignment);
}

export async function assignUserToProject(
  userId: string,
  project: string,
  assignedBy?: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(userProjectAssignments)
    .values({
      userId,
      project,
      assignedBy: assignedBy ?? null,
      assignedAt: now,
    })
    .onConflictDoUpdate({
      target: [userProjectAssignments.userId, userProjectAssignments.project],
      set: {
        assignedBy: assignedBy ?? null,
        assignedAt: now,
      },
    });
}

export async function bulkAssignUsersToProject(
  userIds: string[],
  project: string,
  assignedBy?: string | null,
): Promise<void> {
  const uniqueUserIds = normalizeUserIds(userIds);
  if (uniqueUserIds.length === 0) return;

  const now = new Date().toISOString();
  await db
    .insert(userProjectAssignments)
    .values(
      uniqueUserIds.map((userId) => ({
        userId,
        project,
        assignedBy: assignedBy ?? null,
        assignedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [userProjectAssignments.userId, userProjectAssignments.project],
      set: {
        assignedBy: assignedBy ?? null,
        assignedAt: now,
      },
    });
}

export async function removeUserFromProject(userId: string, project: string): Promise<void> {
  await db
    .delete(userProjectAssignments)
    .where(and(eq(userProjectAssignments.userId, userId), eq(userProjectAssignments.project, project)));
}

export async function bulkSetProjectAssignments(
  project: string,
  userIds: string[],
  assignedBy?: string | null,
): Promise<void> {
  const uniqueUserIds = normalizeUserIds(userIds);
  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    await tx.delete(userProjectAssignments).where(eq(userProjectAssignments.project, project));

    if (uniqueUserIds.length === 0) return;

    await tx.insert(userProjectAssignments).values(
      uniqueUserIds.map((userId) => ({
        userId,
        project,
        assignedBy: assignedBy ?? null,
        assignedAt: now,
      })),
    );
  });
}
