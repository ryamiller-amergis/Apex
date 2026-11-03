import type { DevMockPersonaId } from './devMockUsers';

/**
 * Cloud-only Entra test accounts in the "Apex Test Users" administrative unit.
 * They are exempt from MFA, so deployed production must refuse them; dev and the
 * staging slot opt in with ALLOW_TEST_ACCOUNT_SIGN_IN=true.
 */
export const TEST_ACCOUNT_DOMAIN = 'amergis.com';

const TEST_ACCOUNT_PREFIX = 'apex-test-';

/** On-prem synced account used by CI before the cloud pool existed. */
const LEGACY_E2E_ACCOUNT = 'apex-e2e-test';

/** apex-test-07 through apex-test-10 are spares and have no persona. */
export const TEST_ACCOUNT_NUMBER_BY_PERSONA: Record<DevMockPersonaId, string> = {
  developer: '01',
  ba: '02',
  manager: '03',
  'product-owner': '04',
  qa: '05',
  'ui-ux': '06',
};

export function testAccountEmailForPersona(persona: DevMockPersonaId): string {
  return `${TEST_ACCOUNT_PREFIX}${TEST_ACCOUNT_NUMBER_BY_PERSONA[persona]}@${TEST_ACCOUNT_DOMAIN}`;
}

export function isTestAccountEmail(email: string | null | undefined): boolean {
  const localPart = (email ?? '').trim().toLowerCase().split('@')[0];
  if (!localPart) return false;
  return localPart.startsWith(TEST_ACCOUNT_PREFIX) || localPart === LEGACY_E2E_ACCOUNT;
}
