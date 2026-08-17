/**
 * API key expiry reminder cadences (FEAT-001 enhancement).
 * Industry-common escalating windows: 30d (plan), 7d (act), 1d (urgent).
 * 90d prior is omitted — default key lifespan is already 90 days.
 */

export const API_KEY_EXPIRY_REMINDER_DAYS = [30, 7, 1] as const;

export type ApiKeyExpiryReminderDays = (typeof API_KEY_EXPIRY_REMINDER_DAYS)[number];

export const API_KEYS_ADMIN_PATH = '/admin/api-keys';

/** Deep-link to Project Admin → API Keys for a specific project. */
export function apiKeysAdminDeepLink(projectId: string): string {
  return `${API_KEYS_ADMIN_PATH}?project=${encodeURIComponent(projectId)}`;
}

export function apiKeyExpiryDedupeKey(
  apiKeyId: string,
  thresholdDays: ApiKeyExpiryReminderDays,
  userId: string,
): string {
  return `api-key-expiry:${apiKeyId}:${thresholdDays}d:${userId}`;
}

/**
 * Whole calendar days remaining until expiresAt (UTC day buckets via Math.ceil).
 * 0 when expiry is earlier the same UTC day; negative when expiry is at least
 * one full day in the past; null when no expiration.
 */
export function daysUntilApiKeyExpiry(
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (expiresAt == null || expiresAt === '') return null;
  const expiryMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiryMs)) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  // `+ 0` normalizes -0 from Math.ceil of a tiny negative fraction.
  return Math.ceil((expiryMs - now.getTime()) / msPerDay) + 0;
}

/**
 * Thresholds that apply for a given remaining-day count (window + dedupe model).
 * Example: 15 days left → [30]; 7 days left → [30, 7]; 1 day → [30, 7, 1].
 */
export function resolveApiKeyExpiryReminderThresholds(
  daysRemaining: number | null,
): ApiKeyExpiryReminderDays[] {
  if (daysRemaining == null || daysRemaining < 0) return [];
  return API_KEY_EXPIRY_REMINDER_DAYS.filter((threshold) => daysRemaining <= threshold);
}
