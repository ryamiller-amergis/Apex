import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { appRoles } from '../db/schema';
import { assignProjectRole, getUserProjectRoles } from './rbacService';

export class ProjectMemberRoleError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ProjectMemberRoleError';
  }
}

/** Gives the user the member role on the project when they have no project role yet. */
export async function ensureProjectMemberRole(
  userId: string,
  project: string,
  assignedBy?: string | null,
): Promise<void> {
  const existing = await getUserProjectRoles(userId, project);
  if (existing.length > 0) return;

  const role = await db.query.appRoles.findFirst({ where: eq(appRoles.name, 'member') });
  if (!role) {
    throw new ProjectMemberRoleError(
      'The member role is missing, so this person cannot join the project',
      500,
      'MEMBER_ROLE_MISSING',
    );
  }

  await assignProjectRole(userId, project, role.id, assignedBy ?? 'system');
}
