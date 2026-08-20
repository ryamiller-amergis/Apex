/**
 * Unit tests for API key expiry reminder cadences — 30 / 7 / 1 day windows.
 */
import {
  API_KEY_EXPIRY_REMINDER_DAYS,
  apiKeyExpiryDedupeKey,
  apiKeysAdminDeepLink,
  daysUntilApiKeyExpiry,
  resolveApiKeyExpiryReminderThresholds,
} from '../../shared/types/apiKeyExpiryNotifications';

describe('API key expiry reminder cadences', () => {
  it('uses industry-common 30 / 7 / 1 day thresholds (not 90)', () => {
    expect([...API_KEY_EXPIRY_REMINDER_DAYS]).toEqual([30, 7, 1]);
    expect(API_KEY_EXPIRY_REMINDER_DAYS).not.toContain(90);
  });

  describe('daysUntilApiKeyExpiry', () => {
    const now = new Date('2026-08-11T12:00:00.000Z');

    it('returns null when there is no expiration (cadence none)', () => {
      expect(daysUntilApiKeyExpiry(null, now)).toBeNull();
      expect(daysUntilApiKeyExpiry(undefined, now)).toBeNull();
      expect(daysUntilApiKeyExpiry('', now)).toBeNull();
    });

    it('returns positive whole days prior to expiry', () => {
      expect(daysUntilApiKeyExpiry('2026-09-10T12:00:00.000Z', now)).toBe(30);
      expect(daysUntilApiKeyExpiry('2026-08-18T12:00:00.000Z', now)).toBe(7);
      expect(daysUntilApiKeyExpiry('2026-08-12T12:00:00.000Z', now)).toBe(1);
    });

    it('returns 0 on the expiry day and negative after expiry', () => {
      expect(daysUntilApiKeyExpiry('2026-08-11T18:00:00.000Z', now)).toBe(1);
      expect(daysUntilApiKeyExpiry('2026-08-11T06:00:00.000Z', now)).toBe(0);
      expect(daysUntilApiKeyExpiry('2026-08-10T12:00:00.000Z', now)).toBe(-1);
    });
  });

  describe('resolveApiKeyExpiryReminderThresholds', () => {
    it('fires no reminders more than 30 days out (including 90-day prior)', () => {
      expect(resolveApiKeyExpiryReminderThresholds(90)).toEqual([]);
      expect(resolveApiKeyExpiryReminderThresholds(45)).toEqual([]);
      expect(resolveApiKeyExpiryReminderThresholds(31)).toEqual([]);
    });

    it('enters the 30-day window at 30 days remaining', () => {
      expect(resolveApiKeyExpiryReminderThresholds(30)).toEqual([30]);
      expect(resolveApiKeyExpiryReminderThresholds(15)).toEqual([30]);
      expect(resolveApiKeyExpiryReminderThresholds(8)).toEqual([30]);
    });

    it('enters the 7-day window at 7 days remaining', () => {
      expect(resolveApiKeyExpiryReminderThresholds(7)).toEqual([30, 7]);
      expect(resolveApiKeyExpiryReminderThresholds(2)).toEqual([30, 7]);
    });

    it('enters the 1-day window at 1 day remaining (and on expiry day)', () => {
      expect(resolveApiKeyExpiryReminderThresholds(1)).toEqual([30, 7, 1]);
      expect(resolveApiKeyExpiryReminderThresholds(0)).toEqual([30, 7, 1]);
    });

    it('skips expired keys and keys with no expiration', () => {
      expect(resolveApiKeyExpiryReminderThresholds(-1)).toEqual([]);
      expect(resolveApiKeyExpiryReminderThresholds(null)).toEqual([]);
    });
  });

  describe('deep link + dedupe', () => {
    it('builds a project-scoped API Keys admin deep link', () => {
      expect(apiKeysAdminDeepLink('Apex')).toBe('/admin/api-keys?project=Apex');
      expect(apiKeysAdminDeepLink('My Project')).toBe(
        '/admin/api-keys?project=My%20Project',
      );
    });

    it('scopes dedupe keys per api key, threshold, and admin user', () => {
      expect(apiKeyExpiryDedupeKey('key-1', 30, 'user-a')).toBe(
        'api-key-expiry:key-1:30d:user-a',
      );
      expect(apiKeyExpiryDedupeKey('key-1', 7, 'user-a')).not.toBe(
        apiKeyExpiryDedupeKey('key-1', 1, 'user-a'),
      );
      expect(apiKeyExpiryDedupeKey('key-1', 30, 'user-a')).not.toBe(
        apiKeyExpiryDedupeKey('key-1', 30, 'user-b'),
      );
    });
  });
});
