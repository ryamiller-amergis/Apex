/**
 * Wave 2 Track D — tag-ranking + conservative auto-select fixture tests.
 */
import {
  WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS,
  type WalkthroughAnchorRegistryRecord,
} from '../../shared/types/walkthroughAnchorRegistry';
import {
  DEFAULT_ANCHOR_AUTO_SELECT_SCORE_THRESHOLD,
  pickAutoSelectAnchorCandidate,
  rankWalkthroughAnchorsByTags,
  tokenizeRankingText,
} from '../services/walkthroughAnchorTagRanking';

const EARLIER = '2026-07-28T12:00:00.000Z';

function seedToRecord(
  seed: (typeof WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS)[number],
  index: number,
  overrides: Partial<WalkthroughAnchorRegistryRecord> = {},
): WalkthroughAnchorRegistryRecord {
  return {
    id: `rank-fixture-${String(index + 1).padStart(2, '0')}`,
    anchorKey: seed.anchorKey,
    testId: seed.testId,
    label: seed.label,
    suggestedRoute: seed.suggestedRoute,
    approvedRoute: seed.approvedRoute,
    allowedPlacements: seed.allowedPlacements,
    smartTags: seed.smartTags,
    sourceKind: seed.sourceKind,
    sourceLocations: seed.sourceLocations,
    sourceHash: seed.sourceHash,
    reviewStatus: seed.reviewStatus,
    isActive: seed.isActive,
    lastSeenAt: EARLIER,
    missingSince: null,
    deletedAt: null,
    aiProvenance: null,
    createdBy: seed.createdBy,
    createdAt: EARLIER,
    updatedBy: seed.updatedBy,
    updatedAt: EARLIER,
    ...overrides,
  };
}

function baselineFixtures(): WalkthroughAnchorRegistryRecord[] {
  return WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS.map((seed, i) =>
    seedToRecord(seed, i),
  );
}

describe('walkthroughAnchorTagRanking (Wave 2 Track D)', () => {
  it('tokenizes ranking text conservatively', () => {
    expect(tokenizeRankingText('Profile — Theme settings')).toEqual([
      'profile',
      'theme',
      'settings',
    ]);
    expect(tokenizeRankingText('')).toEqual([]);
    expect(tokenizeRankingText(null)).toEqual([]);
  });

  it('ranks only approved+active anchors and ignores pending/inactive/deleted', () => {
    const fixtures: WalkthroughAnchorRegistryRecord[] = [
      ...baselineFixtures(),
      seedToRecord(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS[0], 90, {
        id: 'pending',
        anchorKey: 'notification-bell',
        testId: 'notification-bell',
        label: 'Notification bell',
        approvedRoute: '/home',
        smartTags: ['notifications', 'header', 'bell', 'profile', 'theme'],
        reviewStatus: 'pending',
        isActive: false,
      }),
      seedToRecord(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS[3], 91, {
        id: 'inactive',
        anchorKey: 'inactive-identity',
        testId: 'inactive-identity',
        label: 'Inactive identity',
        reviewStatus: 'approved',
        isActive: false,
        smartTags: ['profile', 'identity', 'avatar', 'settings', 'section'],
      }),
    ];

    const ranked = rankWalkthroughAnchorsByTags(fixtures, {
      route: '/profile',
      intent: 'Show the user how to edit profile theme appearance',
      heading: 'Theme settings',
      body: 'Update appearance preferences on the profile page.',
    });

    expect(ranked.every((c) => c.anchorKey !== 'notification-bell')).toBe(true);
    expect(ranked.every((c) => c.anchorKey !== 'inactive-identity')).toBe(true);
    expect(ranked.length).toBe(7);
  });

  it('orders route-compatible anchors ahead of incompatible ones', () => {
    const ranked = rankWalkthroughAnchorsByTags(baselineFixtures(), {
      route: '/profile',
      intent: 'Open the user menu avatar',
      heading: 'User menu',
      body: 'Click the avatar button in the header navigation.',
    });

    const firstIncompatible = ranked.findIndex((c) => !c.evidence.routeCompatible);
    const lastCompatible = ranked
      .map((c, i) => (c.evidence.routeCompatible ? i : -1))
      .filter((i) => i >= 0)
      .pop();

    expect(firstIncompatible).toBeGreaterThan(-1);
    expect(lastCompatible).toBeDefined();
    expect(lastCompatible!).toBeLessThan(firstIncompatible);

    // Profile-route anchors should lead even when home-route text matches menu tags.
    expect(ranked[0].evidence.routeCompatible).toBe(true);
    expect(ranked[0].approvedRoute).toBe('/profile');
  });

  it('scores intent/heading/body overlap against tags and labels with evidence', () => {
    const ranked = rankWalkthroughAnchorsByTags(baselineFixtures(), {
      route: '/profile',
      intent: 'Guide the user through profile notification preferences',
      heading: 'Notification preferences',
      body: 'Configure profile notifications on this settings section.',
    });

    const notifications = ranked.find((c) => c.anchorKey === 'profile-notifications');
    expect(notifications).toBeDefined();
    expect(notifications!.evidence.routeExactMatch).toBe(true);
    expect(notifications!.evidence.routeCompatible).toBe(true);
    expect(notifications!.evidence.matchedTags.length).toBeGreaterThan(0);
    expect(notifications!.evidence.overlapRatio).toBeGreaterThan(0);
    expect(notifications!.evidence.queryTokens).toEqual(
      expect.arrayContaining(['profile', 'notification', 'preferences']),
    );

    // Strong tag/label overlap on the matching route should outrank weaker profile peers.
    const strongerOrEqual = ranked
      .filter((c) => c.evidence.routeCompatible)
      .slice(0, 3)
      .map((c) => c.anchorKey);
    expect(strongerOrEqual).toContain('profile-notifications');
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
  });

  it('returns scores in descending order within the same route-compatibility bucket', () => {
    const ranked = rankWalkthroughAnchorsByTags(baselineFixtures(), {
      route: '/profile',
      intent: 'Edit profile bio section',
      heading: 'Bio',
      body: 'Update your bio settings.',
    });

    const compatible = ranked.filter((c) => c.evidence.routeCompatible);
    for (let i = 1; i < compatible.length; i += 1) {
      expect(compatible[i - 1].score).toBeGreaterThanOrEqual(compatible[i].score);
    }
    expect(compatible[0].anchorKey).toBe('profile-bio');
  });

  it('supports limit for top-N generation kickoff candidates', () => {
    const ranked = rankWalkthroughAnchorsByTags(
      baselineFixtures(),
      { route: '/home', intent: 'whats new changelog announcements' },
      { limit: 2 },
    );
    expect(ranked).toHaveLength(2);
    expect(ranked[0].evidence.routeCompatible).toBe(true);
  });

  describe('pickAutoSelectAnchorCandidate', () => {
    it('exposes a conservative default threshold', () => {
      expect(DEFAULT_ANCHOR_AUTO_SELECT_SCORE_THRESHOLD).toBe(0.72);
    });

    it('auto-selects only when the top score clears the threshold', () => {
      const strong = rankWalkthroughAnchorsByTags(baselineFixtures(), {
        route: '/profile',
        intent: 'profile bio section edit settings',
        heading: 'Profile — Bio',
        body: 'Edit the profile bio section settings.',
      });

      const auto = pickAutoSelectAnchorCandidate(strong, {
        route: '/profile',
      });
      expect(auto).not.toBeNull();
      expect(auto!.anchorKey).toBe('profile-bio');
      expect(auto!.score).toBeGreaterThanOrEqual(
        DEFAULT_ANCHOR_AUTO_SELECT_SCORE_THRESHOLD,
      );

      const weak = rankWalkthroughAnchorsByTags(baselineFixtures(), {
        route: '/profile',
        intent: 'xyzzy unrelated jargon',
        heading: 'Misc',
        body: 'Nothing matching.',
      });
      expect(
        pickAutoSelectAnchorCandidate(weak, { route: '/profile' }),
      ).toBeNull();
    });

    it('refuses auto-select when route is incompatible even if score is high', () => {
      const ranked = rankWalkthroughAnchorsByTags(baselineFixtures(), {
        // Force text toward home menu anchors while asking for profile route —
        // route-compatible profile rows still lead; craft a synthetic ranked list.
        route: '/profile',
        intent: 'user menu avatar header navigation open button',
      });

      const incompatibleTop: typeof ranked = [
        {
          ...ranked.find((c) => c.anchorKey === 'user-menu-trigger')!,
          score: 0.95,
          evidence: {
            ...ranked.find((c) => c.anchorKey === 'user-menu-trigger')!.evidence,
            routeCompatible: false,
            routeExactMatch: false,
          },
        },
      ];

      expect(
        pickAutoSelectAnchorCandidate(incompatibleTop, { route: '/profile' }),
      ).toBeNull();
    });

    it('allows a custom threshold for staged-review experiments', () => {
      const ranked = rankWalkthroughAnchorsByTags(baselineFixtures(), {
        route: '/home',
        intent: 'changelog whats new modal announcements',
        heading: "What's New",
        body: 'Open the whats-new modal on home.',
      });
      const top = ranked[0];
      expect(top.anchorKey).toBe('whats-new-modal');

      expect(
        pickAutoSelectAnchorCandidate(ranked, { route: '/home' }, { threshold: 0.99 }),
      ).toBeNull();
      expect(
        pickAutoSelectAnchorCandidate(
          ranked,
          { route: '/home' },
          { threshold: Math.min(top.score, 0.5) },
        )?.anchorKey,
      ).toBe('whats-new-modal');
    });
  });
});
