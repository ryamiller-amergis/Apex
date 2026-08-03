/**
 * @jest-environment node
 */

import type { GroundingProfileId } from '../../shared/types/repoReader';
import { GroundingProfileResolver } from '../services/groundingProfileResolver';

describe('PBI-005 connection profile security contracts', () => {
  it('Security NFR / VT-07 rejects unauthorized and expired IDs without disclosing checkout paths', async () => {
    // Given one unauthorized connection profile, one expiring profile, and an unknown ID.
    let now = 1_000;
    const authorization = { authorize: jest.fn().mockResolvedValue(true) };
    const resolver = new GroundingProfileResolver({
      authorization,
      now: () => now,
      isFeatureEnabled: async () => true,
    });
    const sensitivePath = 'C:\\sensitive\\grounding\\checkout';
    const unauthorized = resolver.registerConnectionProfile(
      {
        runRef: 'chat:unauthorized',
        provider: 'github',
        project: 'Apex',
        repo: 'AI-Pilot',
        sha: 'a'.repeat(40),
        checkoutPath: sensitivePath,
      },
      {
        userId: 'developer-1',
        runRef: 'chat:unauthorized',
        project: 'Apex',
      },
      async () => false,
    );
    const expiring = resolver.registerConnectionProfile(
      {
        runRef: 'chat:expired',
        provider: 'github',
        project: 'Apex',
        repo: 'AI-Pilot',
        sha: 'b'.repeat(40),
        checkoutPath: sensitivePath,
        ttlMs: 1,
      },
      {
        userId: 'developer-2',
        runRef: 'chat:expired',
        project: 'Apex',
      },
      async () => true,
    );
    now += 2;

    // When each opaque ID is resolved by the MCP connection boundary.
    const failures = await Promise.all([
      resolver.resolveConnectionProfile(unauthorized.id).catch((error: unknown) => error),
      resolver.resolveConnectionProfile(expiring.id).catch((error: unknown) => error),
      resolver.resolveConnectionProfile(
        'unknown-profile' as GroundingProfileId,
      ).catch((error: unknown) => error),
    ]);

    // Then all failures are controlled and reveal neither checkout nor repository paths.
    expect(failures[0]).toMatchObject({
      code: 'ACCESS_DENIED',
      message: 'Grounding profile access denied',
      fallbackEligible: false,
    });
    expect(failures[1]).toMatchObject({
      code: 'PROFILE_UNAVAILABLE',
      message: 'Grounding profile is unavailable',
      fallbackEligible: false,
    });
    expect(failures[2]).toMatchObject({
      code: 'ACCESS_DENIED',
      message: 'Grounding profile access denied',
      fallbackEligible: false,
    });
    for (const failure of failures) {
      expect(String(failure)).not.toContain(sensitivePath);
      expect(String(failure)).not.toContain('AI-Pilot');
    }
  });
});
