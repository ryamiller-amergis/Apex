import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { appRoles, appUserProjectRoles, appUserRoles, appUsers } from '../db/schema';
import { isSuperAdminEmail } from './superAdmin';

/**
 * Returns true if the given userId has the 'admin' role assigned.
 * Used by service-layer functions to bypass author-only restrictions for admins.
 */
export async function isAdminUser(userId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(appUserRoles)
    .innerJoin(appRoles, eq(appUserRoles.roleId, appRoles.id))
    .where(and(eq(appUserRoles.userId, userId), eq(appRoles.name, 'admin')));
  return rows.length > 0;
}

/** Global admin role, or the admin role assigned on this project. */
export async function isProjectAdmin(userId: string, project: string): Promise<boolean> {
  if (await isAdminUser(userId)) return true;
  const rows = await db
    .select({ roleId: appUserProjectRoles.roleId })
    .from(appUserProjectRoles)
    .innerJoin(appRoles, eq(appUserProjectRoles.roleId, appRoles.id))
    .where(and(
      eq(appUserProjectRoles.userId, userId),
      eq(appUserProjectRoles.project, project),
      eq(appRoles.name, 'admin'),
    ));
  return rows.length > 0;
}

/** Platform admin: the user's email is on the environment super-admin list. */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const row = await db.query.appUsers.findFirst({
    where: eq(appUsers.oid, userId),
    columns: { email: true },
  });
  if (!row?.email) return false;
  return isSuperAdminEmail(row.email);
}
