/**
 * Per-persona Entra test accounts for deployed dev + staging runs.
 *
 * A persona signs in as its own `apex-test-0N` account (mapping in
 * src/shared/constants/testAccounts.ts) when `E2E_PERSONA_<ID>_PASSWORD` is set,
 * e.g. `E2E_PERSONA_PRODUCT_OWNER_PASSWORD`. Personas without a password keep
 * using the default `E2E_TEST_USER` session.
 *
 * One secret per password, not one JSON blob, so GitHub masks each value in logs.
 */
import path from 'path';
import { DEV_MOCK_USERS } from '../../../src/shared/constants/devMockUsers';
import type { DevMockPersonaId } from '../../../src/shared/constants/devMockUsers';
import { testAccountEmailForPersona } from '../../../src/shared/constants/testAccounts';

export interface SsoCredentials {
  email: string;
  password: string;
}

export function personaPasswordEnvName(persona: DevMockPersonaId): string {
  return `E2E_PERSONA_${persona.toUpperCase().replace(/-/g, '_')}_PASSWORD`;
}

export function personaCredentials(persona: DevMockPersonaId): SsoCredentials | null {
  const password = process.env[personaPasswordEnvName(persona)];
  if (!password) return null;
  return { email: testAccountEmailForPersona(persona), password };
}

export function configuredPersonas(): DevMockPersonaId[] {
  return DEV_MOCK_USERS.map((u) => u.id).filter((id) => personaCredentials(id) !== null);
}

export function personaAuthFile(persona: DevMockPersonaId): string {
  return path.resolve(__dirname, '..', '.auth', `persona-${persona}.json`);
}
