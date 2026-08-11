/**
 * Notify project admins (api-keys:manage) when API keys approach expiry.
 * In-app + Teams via createNotification; deep-links to /admin/api-keys?project=…
 */
import { and, isNotNull, isNull, lte, gte } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { apiKeys } from '../db/schema';
import { createNotification } from './notificationService';
import { getUserPermissions, listUsersForProject } from './rbacService';
import {
  apiKeyExpiryDedupeKey,
  apiKeysAdminDeepLink,
  daysUntilApiKeyExpiry,
  resolveApiKeyExpiryReminderThresholds,
  type ApiKeyExpiryReminderDays,
} from '../../shared/types/apiKeyExpiryNotifications';

export type ApiKeyExpiryNotificationRunResult = {
  keysScanned: number;
  notificationsAttempted: number;
};

function thresholdLabel(days: ApiKeyExpiryReminderDays): string {
  return days === 1 ? '1 day' : `${days} days`;
}

async function resolveProjectAdmins(projectId: string): Promise<string[]> {
  const users = await listUsersForProject(projectId);
  const admins: string[] = [];
  for (const user of users) {
    const perms = await getUserPermissions(user.oid, projectId);
    if (perms.has('api-keys:manage')) {
      admins.push(user.oid);
    }
  }
  return admins;
}

/**
 * Scan active (non-deleted) keys that expire within 30 days and notify
 * project admins for each applicable reminder threshold (deduped).
 */
export async function runApiKeyExpiryNotifications(
  now: Date = new Date(),
): Promise<ApiKeyExpiryNotificationRunResult> {
  const windowEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      projectId: apiKeys.projectId,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(
      and(
        isNull(apiKeys.deletedAt),
        isNotNull(apiKeys.expiresAt),
        gte(apiKeys.expiresAt, now.toISOString()),
        lte(apiKeys.expiresAt, windowEnd.toISOString()),
      ),
    );

  let notificationsAttempted = 0;
  const adminCache = new Map<string, string[]>();

  for (const row of rows) {
    const daysRemaining = daysUntilApiKeyExpiry(row.expiresAt, now);
    const thresholds = resolveApiKeyExpiryReminderThresholds(daysRemaining);
    if (thresholds.length === 0) continue;

    let admins = adminCache.get(row.projectId);
    if (!admins) {
      admins = await resolveProjectAdmins(row.projectId);
      adminCache.set(row.projectId, admins);
    }
    if (admins.length === 0) continue;

    const link = apiKeysAdminDeepLink(row.projectId);

    for (const threshold of thresholds) {
      for (const userId of admins) {
        await createNotification(
          userId,
          {
            type: 'system',
            title: `API key expires in ${thresholdLabel(threshold)}`,
            body: `"${row.name}" in project ${row.projectId} expires soon. Open API Keys to regenerate or update the cadence.`,
            link,
          },
          { dedupeKey: apiKeyExpiryDedupeKey(row.id, threshold, userId) },
        );
        notificationsAttempted += 1;
      }
    }
  }

  return { keysScanned: rows.length, notificationsAttempted };
}
