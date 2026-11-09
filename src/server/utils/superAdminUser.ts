import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { appUsers } from '../db/schema';
import { isSuperAdminEmail } from './superAdmin';

/**
 * Platform admins have no project role, so a permission lookup misses them.
 * Jest skips the lookup unless a test opts in, so a missing database cannot stall the suite.
 */
export async function isSuperAdminUserId(userId: string): Promise<boolean> {
  if (process.env.JEST_WORKER_ID && process.env.BUILD_SUPER_ADMIN_DB !== '1') return false;
  try {
    const [user] = await db
      .select({ email: appUsers.email })
      .from(appUsers)
      .where(eq(appUsers.oid, userId))
      .limit(1);
    return Boolean(user?.email && isSuperAdminEmail(user.email));
  } catch {
    return false;
  }
}
