import type { Request } from 'express';
import { getUserEmail } from './requestUser';

export type AppEnvironment = 'local' | 'dev' | 'prod';

/**
 * Resolve the current application environment used to scope platform-admin
 * (super-admin) access.
 *
 * Reads `APP_ENV` and normalizes it. If `APP_ENV` is unset but the process is
 * running as a deployed instance (`NODE_ENV === 'production'`), we default to
 * `prod` — the most restrictive list — so a misconfigured deployment never
 * silently exposes the local list.
 */
export function getAppEnvironment(): AppEnvironment {
  const raw = (process.env.APP_ENV ?? '').trim().toLowerCase();
  if (raw === 'prod' || raw === 'production') return 'prod';
  if (raw === 'dev' || raw === 'development' || raw === 'staging') return 'dev';
  if (raw === 'local') return 'local';
  if (process.env.NODE_ENV === 'production') return 'prod';
  return 'local';
}

/**
 * Environment-scoped super-admin email lists. Edit the list for a given
 * environment to grant or revoke platform-admin access there. An email must be
 * present in an environment's list to gain access in that environment.
 */
const SUPER_ADMIN_EMAILS_BY_ENV: Record<AppEnvironment, string[]> = {
  local: [
    'ryamiller@amergis.com',
    'anedunur@amergis.com',
    'laleduy@amergis.com',
  ],
  dev: [
    'ryamiller@amergis.com',
    'anedunur@amergis.com',
  ],
  prod: [
    'ryamiller@amergis.com',
    'anedunur@amergis.com',
  ],
};

export function getSuperAdminEmails(env: AppEnvironment = getAppEnvironment()): string[] {
  return SUPER_ADMIN_EMAILS_BY_ENV[env];
}

export function isSuperAdminEmail(email: string, env: AppEnvironment = getAppEnvironment()): boolean {
  const lower = email.toLowerCase();
  return getSuperAdminEmails(env).some((e) => e.toLowerCase() === lower);
}

export function isSuperAdminRequest(req: Request): boolean {
  const email = getUserEmail(req);
  if (!email) return false;
  return isSuperAdminEmail(email);
}
