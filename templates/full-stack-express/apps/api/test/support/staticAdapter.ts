import type { IdentityProviderAdapter } from '../../src/identity/adapter.ts';
import type { Principal } from '../../src/identity/principal.ts';

/**
 * Test-only adapter. It ignores the request and returns a fixed result, so a
 * test proves a handler sees what the middleware set and nothing from the
 * request. Not part of the build and not selectable through AUTH_MODE.
 */
export function createStaticAdapter(
  result: Principal | null | (() => Promise<Principal | null>),
  challenge?: string
): IdentityProviderAdapter & { calls: number } {
  const adapter = {
    calls: 0,
    challenge,
    authenticate() {
      adapter.calls += 1;
      return typeof result === 'function' ? result() : Promise.resolve(result);
    },
  };
  return adapter;
}
