import type { IdentityProviderAdapter } from '../../src/identity/adapter.ts';
import type { Principal } from '../../src/identity/principal.ts';

export const TEST_SUBJECT_HEADER = 'x-test-subject';

const SUBJECT = /^test-[a-z0-9-]+$/;

/**
 * Picks the principal from x-test-subject. Lives under test/ so src/ cannot
 * import it. A missing or non-test subject is unauthenticated.
 */
export function createTestIdentityAdapter(): IdentityProviderAdapter & {
  calls: number;
} {
  const adapter = {
    calls: 0,
    async authenticate(request: {
      headers: Record<string, string | string[] | undefined>;
    }): Promise<Principal | null> {
      adapter.calls += 1;
      const raw = request.headers[TEST_SUBJECT_HEADER];
      const subject = Array.isArray(raw) ? raw[0] : raw;
      if (typeof subject !== 'string' || !SUBJECT.test(subject)) {
        return null;
      }
      return {
        subject,
        displayName: `test-name-${subject}`,
        email: `${subject}@example.test`,
      };
    },
  };
  return adapter;
}
