/**
 * Unit tests for publicRateLimitService — FEAT-002 / VT-07 / PBI-003 AC-3 / TBI-003 DoD-2
 */
import {
  PUBLIC_API_KEY_RATE_LIMIT,
  PUBLIC_API_KEY_RATE_WINDOW_MS,
  consumePublicApiKeyRateLimit,
  __resetPublicRateLimitForTests,
} from '../services/publicRateLimitService';

beforeEach(() => {
  __resetPublicRateLimitForTests();
});

describe('publicRateLimitService (VT-07 / DoD-2 / AC-3)', () => {
  it('allows the first 100 requests in a window and rejects the 101st', () => {
    const key = 'key-a';
    const t0 = 1_000_000;
    for (let i = 0; i < PUBLIC_API_KEY_RATE_LIMIT; i += 1) {
      expect(consumePublicApiKeyRateLimit(key, t0).allowed).toBe(true);
    }
    expect(consumePublicApiKeyRateLimit(key, t0).allowed).toBe(false);
  });

  it('keeps independent allowances per apiKeyId', () => {
    const t0 = 2_000_000;
    for (let i = 0; i < PUBLIC_API_KEY_RATE_LIMIT; i += 1) {
      consumePublicApiKeyRateLimit('key-1', t0);
    }
    expect(consumePublicApiKeyRateLimit('key-1', t0).allowed).toBe(false);
    expect(consumePublicApiKeyRateLimit('key-2', t0).allowed).toBe(true);
  });

  it('restores allowance after the one-minute window resets', () => {
    const key = 'key-reset';
    const t0 = 3_000_000;
    for (let i = 0; i < PUBLIC_API_KEY_RATE_LIMIT; i += 1) {
      consumePublicApiKeyRateLimit(key, t0);
    }
    expect(consumePublicApiKeyRateLimit(key, t0).allowed).toBe(false);
    expect(
      consumePublicApiKeyRateLimit(key, t0 + PUBLIC_API_KEY_RATE_WINDOW_MS).allowed,
    ).toBe(true);
  });
});
