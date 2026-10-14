import { asc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { devEnvAllowlist } from '../db/schema';
import type {
  DevEnvAllowlistEntry,
  DevEnvAllowlistResponse,
} from '../../shared/types/devEnvAllowlist';
import { isRestrictedAccessEmail } from '../../shared/types/restrictedAccess';
import { getAppEnvironment, isSuperAdminEmail } from '../utils/superAdmin';

const CACHE_TTL_MS = 15_000;

export class DevEnvAllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevEnvAllowlistError';
  }
}

let cachedEmails: { emails: Set<string>; at: number } | null = null;

export function clearDevEnvAllowlistCache(): void {
  cachedEmails = null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function mapRow(row: {
  id: string;
  email: string;
  createdBy: string | null;
  createdAt: string;
}): DevEnvAllowlistEntry {
  return {
    id: row.id,
    email: row.email,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

function assertDevSite(): void {
  if (getAppEnvironment() !== 'dev') {
    throw new DevEnvAllowlistError('Dev access can only be changed on the dev site.');
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

export async function listDevEnvAllowlist(): Promise<DevEnvAllowlistEntry[]> {
  const rows = await db
    .select()
    .from(devEnvAllowlist)
    .orderBy(asc(devEnvAllowlist.email));
  return rows.map(mapRow);
}

export async function getDevEnvAllowlistView(): Promise<DevEnvAllowlistResponse> {
  const environment = getAppEnvironment();
  const entries = await listDevEnvAllowlist();
  return {
    environment,
    managesDevAccess: environment === 'dev',
    entries,
  };
}

async function cachedAllowedEmails(): Promise<Set<string>> {
  const now = Date.now();
  if (cachedEmails && now - cachedEmails.at < CACHE_TTL_MS) {
    return cachedEmails.emails;
  }
  const entries = await listDevEnvAllowlist();
  const emails = new Set(entries.map((entry) => entry.email));
  cachedEmails = { emails, at: now };
  return emails;
}

/**
 * Admission check for the dev site.
 * Local and production skip this check.
 * Platform admins are admitted before the list is read, so they can still sign in
 * when the list cannot be loaded. Everyone else is denied if the list cannot be read.
 */
/**
 * True when this email is on the dev access list.
 * Platform admins are not stored on the list. A missing list counts as not listed,
 * so the production popup stays up when the list cannot be read.
 */
export async function isDevAccessAllowlisted(email: string | undefined | null): Promise<boolean> {
  const normalized = normalizeEmail(email ?? '');
  if (!normalized) return false;
  try {
    const emails = await cachedAllowedEmails();
    return emails.has(normalized);
  } catch (err) {
    console.error('[dev-env-allowlist] Could not read the allowlist', err);
    return false;
  }
}

export async function isDevEnvironmentAllowed(email: string | undefined | null): Promise<boolean> {
  if (getAppEnvironment() !== 'dev') return true;
  const normalized = normalizeEmail(email ?? '');
  if (!normalized) return false;
  if (isSuperAdminEmail(normalized)) return true;
  // The deployed smoke test signs in with this account. It is configured on the
  // dev site from the CI secret and is not a platform admin.
  const automatedTestUser = normalizeEmail(process.env.E2E_TEST_USER ?? '');
  if (automatedTestUser && normalized === automatedTestUser) return true;
  try {
    const emails = await cachedAllowedEmails();
    return emails.has(normalized);
  } catch (err) {
    console.error('[dev-env-allowlist] Could not read the allowlist; denying access', err);
    return false;
  }
}

export async function addDevEnvAllowlistEntry(
  rawEmail: string,
  createdBy?: string | null,
): Promise<DevEnvAllowlistEntry> {
  assertDevSite();
  const email = normalizeEmail(rawEmail ?? '');
  if (!isRestrictedAccessEmail(email)) {
    throw new DevEnvAllowlistError('Enter a valid email address');
  }
  if (isSuperAdminEmail(email)) {
    throw new DevEnvAllowlistError('Platform admins already have access to the dev site');
  }

  try {
    const [row] = await db
      .insert(devEnvAllowlist)
      .values({ email, createdBy: createdBy ?? null })
      .returning();
    clearDevEnvAllowlistCache();
    return mapRow(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new DevEnvAllowlistError('That email is already on the dev access list');
    }
    throw err;
  }
}

const ENTRY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function removeDevEnvAllowlistEntry(id: string): Promise<void> {
  assertDevSite();
  if (!ENTRY_ID_RE.test(id)) {
    throw new DevEnvAllowlistError('Allowlist entry not found');
  }
  const [row] = await db
    .delete(devEnvAllowlist)
    .where(eq(devEnvAllowlist.id, id))
    .returning({ id: devEnvAllowlist.id });
  if (!row) {
    throw new DevEnvAllowlistError('Allowlist entry not found');
  }
  clearDevEnvAllowlistCache();
}
