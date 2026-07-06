import type { Request } from 'express';
import { getUserEmail } from './requestUser';

export type AppEnvironment = 'local' | 'dev' | 'prod';

/**
 * Resolve the current application environment used to scope platform-admin
 * (super-admin) access.
 *
 * Resolution order:
 * 1. APP_ENV if explicitly set (local | dev | prod).
 * 2. WEBSITE_SITE_NAME — Azure App Service sets this automatically to the app
 *    name (e.g. "app-scrum-dev", "app-scrum-prod"). We look for "dev" or "prod"
 *    anywhere in the name, so no manual app-settings entry is needed.
 * 3. Fall back to "local" when neither is present (developer machines).
 */
export function getAppEnvironment(): AppEnvironment {
  const explicit = (process.env.APP_ENV ?? '').trim().toLowerCase();
  if (explicit === 'prod' || explicit === 'production') return 'prod';
  if (explicit === 'dev' || explicit === 'development' || explicit === 'staging') return 'dev';
  if (explicit === 'local') return 'local';

  const siteName = (process.env.WEBSITE_SITE_NAME ?? '').toLowerCase();
  if (siteName.includes('prod')) return 'prod';
  if (siteName.includes('dev')) return 'dev';

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
