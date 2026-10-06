import { eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { appUsers } from '../db/schema';
import { addPendingAssignments, listPendingForProject, removePendingAssignment } from './pendingAssignmentService';
import { ensureProjectMemberRole } from './projectMemberRole';
import {
  ensureUserProjectAssignment,
  getAssignmentsForProject,
  listKnownApplicationUsers,
} from './userProjectAssignmentService';

export const PROJECT_TEAM_LIMIT = 50;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class ProjectTeammateError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ProjectTeammateError';
  }
}

export interface AddProjectTeammateResult {
  status: 'assigned' | 'pending';
  email: string;
}

export function normalizeTeammateEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function addProjectTeammate(
  project: string,
  rawEmail: string,
  actorId: string,
): Promise<AddProjectTeammateResult> {
  const email = normalizeTeammateEmail(rawEmail);
  if (!email) {
    throw new ProjectTeammateError('Enter a work email address', 400, 'VALIDATION');
  }

  const [assigned, pending, existing] = await Promise.all([
    getAssignmentsForProject(project),
    listPendingForProject(project),
    findUserByEmail(email),
  ]);

  if (existing && assigned.some((row) => row.userId === existing.oid)) {
    await ensureProjectMemberRole(existing.oid, project, actorId);
    await removePendingAssignment(email, project);
    return { status: 'assigned', email };
  }

  if (!existing && !EMAIL_PATTERN.test(email)) {
    throw new ProjectTeammateError('Enter a work email address', 400, 'VALIDATION');
  }

  if (assigned.length + pending.length >= PROJECT_TEAM_LIMIT) {
    throw new ProjectTeammateError(
      `This project already has ${PROJECT_TEAM_LIMIT} people`,
      409,
      'TEAM_FULL',
    );
  }

  if (existing) {
    await ensureUserProjectAssignment(existing.oid, project, actorId);
    await ensureProjectMemberRole(existing.oid, project, actorId);
    await removePendingAssignment(email, project);
    return { status: 'assigned', email };
  }

  await addPendingAssignments([{ email, project }], actorId);
  return { status: 'pending', email };
}

export async function listProjectTeammateCandidates(project: string) {
  const [known, assigned] = await Promise.all([
    listKnownApplicationUsers(),
    getAssignmentsForProject(project),
  ]);
  const assignedIds = new Set(assigned.map((row) => row.userId));
  return known.filter((user) => !assignedIds.has(user.userId));
}

async function findUserByEmail(email: string): Promise<{ oid: string } | null> {
  const rows = await db
    .select({ oid: appUsers.oid })
    .from(appUsers)
    .where(eq(sql`lower(${appUsers.email})`, email))
    .limit(1);
  return rows[0] ?? null;
}
