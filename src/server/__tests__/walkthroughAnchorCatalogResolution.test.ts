/**
 * Wave 2 Track D — runtime catalog-resolution fixture tests.
 */
import {
  WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS,
  type WalkthroughAnchorRegistryRecord,
} from '../../shared/types/walkthroughAnchorRegistry';
import {
  buildRuntimeCatalogIndex,
  enrichStepAnchorFromCatalog,
  listRuntimeCatalogAnchors,
  resolveRuntimeCatalogAnchor,
} from '../services/walkthroughAnchorCatalogResolution';

const NOW = '2026-07-30T04:00:00.000Z';
const EARLIER = '2026-07-28T12:00:00.000Z';

function seedToRecord(
  seed: (typeof WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS)[number],
  index: number,
  overrides: Partial<WalkthroughAnchorRegistryRecord> = {},
): WalkthroughAnchorRegistryRecord {
  return {
    id: `fixture-${String(index + 1).padStart(2, '0')}`,
    anchorKey: seed.anchorKey,
    testId: seed.testId,
    label: seed.label,
    suggestedRoute: seed.suggestedRoute,
    approvedRoute: seed.approvedRoute,
    allowedPlacements: seed.allowedPlacements,
    smartTags: seed.smartTags,
    openerAnchorKeys: seed.openerAnchorKeys ?? [],
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

describe('walkthroughAnchorCatalogResolution (Wave 2 Track D)', () => {
  describe('buildRuntimeCatalogIndex / listRuntimeCatalogAnchors', () => {
    it('indexes only approved+active non-deleted rows as runtime anchors', () => {
      const fixtures: WalkthroughAnchorRegistryRecord[] = [
        ...baselineFixtures(),
        seedToRecord(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS[0], 90, {
          id: 'pending-bell',
          anchorKey: 'notification-bell',
          testId: 'notification-bell',
          label: 'Notification bell',
          reviewStatus: 'pending',
          isActive: false,
          sourceHash: 'scan:notification-bell',
        }),
        seedToRecord(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS[0], 91, {
          id: 'rejected-x',
          anchorKey: 'legacy-rejected',
          testId: 'legacy-rejected',
          label: 'Rejected',
          reviewStatus: 'rejected',
          isActive: false,
          sourceHash: 'scan:legacy-rejected',
        }),
        seedToRecord(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS[3], 92, {
          id: 'inactive-profile',
          anchorKey: 'profile-identity-inactive-copy',
          testId: 'profile-identity-inactive-copy',
          label: 'Inactive profile',
          reviewStatus: 'approved',
          isActive: false,
          sourceHash: 'manual:inactive',
        }),
        seedToRecord(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS[4], 93, {
          id: 'deleted-bio',
          anchorKey: 'profile-bio-deleted',
          testId: 'profile-bio-deleted',
          label: 'Deleted bio',
          reviewStatus: 'approved',
          isActive: true,
          deletedAt: NOW,
          sourceHash: 'manual:deleted',
        }),
      ];

      const index = buildRuntimeCatalogIndex(fixtures);
      expect(index.runtimeByKey.size).toBe(7);
      expect(index.runtimeByTestId.size).toBe(7);
      expect(index.runtimeByKey.has('notification-bell')).toBe(false);
      expect(index.runtimeByKey.has('legacy-rejected')).toBe(false);
      expect(index.runtimeByKey.has('profile-identity-inactive-copy')).toBe(false);
      expect(index.runtimeByKey.has('profile-bio-deleted')).toBe(false);
      expect(index.runtimeByKey.get('profile-identity')?.testId).toBe(
        'profile-identity-section',
      );

      const listed = listRuntimeCatalogAnchors(fixtures);
      expect(listed).toHaveLength(7);
      expect(listed.map((a) => a.anchorKey)).toEqual([
        'profile-bio',
        'profile-identity',
        'profile-notifications',
        'profile-theme',
        'user-menu-profile',
        'user-menu-trigger',
        'whats-new-modal',
      ]);
      expect(listed.find((a) => a.anchorKey === 'profile-bio')?.testId).toBe(
        'profile-bio-section',
      );
    });
  });

  describe('resolveRuntimeCatalogAnchor', () => {
    it('resolves approved+active keys to testId + metadata', () => {
      const fixtures = baselineFixtures();
      const result = resolveRuntimeCatalogAnchor(fixtures, 'profile-theme');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.useCenteredFallback).toBe(false);
      expect(result.anchor).toMatchObject({
        anchorKey: 'profile-theme',
        testId: 'profile-theme-section',
        label: 'Profile — Theme',
        targetRoute: '/profile',
      });
      expect(result.anchor.allowedPlacements).toEqual(
        expect.arrayContaining(['bottom', 'top']),
      );
      expect(result.anchor.smartTags).toEqual(
        expect.arrayContaining(['profile', 'theme']),
      );
    });

    it('signals centered fallback for missing keys', () => {
      const result = resolveRuntimeCatalogAnchor(baselineFixtures(), 'does-not-exist');
      expect(result).toEqual({
        ok: false,
        useCenteredFallback: true,
        reason: 'missing',
        record: null,
      });
    });

    it('signals centered fallback for inactive approved rows', () => {
      const fixtures = [
        seedToRecord(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS[0], 0, {
          isActive: false,
        }),
      ];
      const result = resolveRuntimeCatalogAnchor(fixtures, 'user-menu-trigger');
      expect(result).toMatchObject({
        ok: false,
        useCenteredFallback: true,
        reason: 'inactive',
      });
      if (result.ok) return;
      expect(result.record?.anchorKey).toBe('user-menu-trigger');
    });

    it('signals centered fallback for soft-deleted rows', () => {
      const fixtures = [
        seedToRecord(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS[1], 1, {
          deletedAt: NOW,
        }),
      ];
      const result = resolveRuntimeCatalogAnchor(fixtures, 'whats-new-modal');
      expect(result).toMatchObject({
        ok: false,
        useCenteredFallback: true,
        reason: 'deleted',
      });
    });

    it('signals centered fallback for pending and rejected rows', () => {
      const fixtures: WalkthroughAnchorRegistryRecord[] = [
        seedToRecord(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS[0], 0, {
          id: 'p1',
          anchorKey: 'pending-anchor',
          testId: 'pending-anchor',
          label: 'Pending',
          reviewStatus: 'pending',
          isActive: false,
        }),
        seedToRecord(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS[0], 1, {
          id: 'r1',
          anchorKey: 'rejected-anchor',
          testId: 'rejected-anchor',
          label: 'Rejected',
          reviewStatus: 'rejected',
          isActive: false,
        }),
      ];

      expect(resolveRuntimeCatalogAnchor(fixtures, 'pending-anchor')).toMatchObject({
        ok: false,
        reason: 'not_approved',
        useCenteredFallback: true,
      });
      expect(resolveRuntimeCatalogAnchor(fixtures, 'rejected-anchor')).toMatchObject({
        ok: false,
        reason: 'not_approved',
        useCenteredFallback: true,
      });
    });

    it('prefers a live runtime row over a soft-deleted duplicate key in fixtures', () => {
      const live = seedToRecord(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS[2], 0);
      const deleted = seedToRecord(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS[2], 1, {
        id: 'deleted-dup',
        deletedAt: NOW,
        testId: 'stale-user-menu-profile',
      });
      const result = resolveRuntimeCatalogAnchor([deleted, live], 'user-menu-profile');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.anchor.testId).toBe('user-menu-profile');
    });
  });

  describe('enrichStepAnchorFromCatalog', () => {
    it('attaches catalog testId for playback enrichment', () => {
      const enriched = enrichStepAnchorFromCatalog(baselineFixtures(), {
        key: 'profile-notifications',
        targetRoute: '/profile',
        placement: 'top',
      });
      expect(enriched.status).toBe('resolved');
      if (enriched.status !== 'resolved') return;
      expect(enriched.useCenteredFallback).toBe(false);
      expect(enriched.enriched).toMatchObject({
        key: 'profile-notifications',
        testId: 'profile-notification-section',
        targetRoute: '/profile',
        placement: 'top',
        label: 'Profile — Notifications',
      });
    });

    it('returns centered_fallback for inactive / deleted / missing step anchors', () => {
      const fixtures = [
        seedToRecord(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS[0], 0, {
          isActive: false,
        }),
        seedToRecord(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS[1], 1, {
          deletedAt: NOW,
        }),
      ];

      expect(
        enrichStepAnchorFromCatalog(fixtures, {
          key: 'user-menu-trigger',
          targetRoute: '/home',
          placement: 'bottom',
        }),
      ).toMatchObject({
        status: 'centered_fallback',
        useCenteredFallback: true,
        reason: 'inactive',
        key: 'user-menu-trigger',
      });

      expect(
        enrichStepAnchorFromCatalog(fixtures, {
          key: 'whats-new-modal',
          targetRoute: '/home',
          placement: 'bottom',
        }),
      ).toMatchObject({
        status: 'centered_fallback',
        reason: 'deleted',
      });

      expect(
        enrichStepAnchorFromCatalog(fixtures, {
          key: 'unknown-key',
          targetRoute: '/home',
          placement: 'bottom',
        }),
      ).toMatchObject({
        status: 'centered_fallback',
        reason: 'missing',
      });

      expect(enrichStepAnchorFromCatalog(fixtures, null)).toMatchObject({
        status: 'centered_fallback',
        reason: 'missing',
        key: null,
      });
    });

    it('TBI-003 DoD-0/1: attaches resolved openers and skips unresolved keys', () => {
      const fixtures = baselineFixtures().map((row) =>
        row.anchorKey === 'whats-new-modal'
          ? {
              ...row,
              openerAnchorKeys: ['user-menu-trigger', 'not-in-catalog'],
            }
          : row,
      );

      const result = enrichStepAnchorFromCatalog(fixtures, {
        key: 'whats-new-modal',
        targetRoute: '/home',
        placement: 'bottom',
      });

      expect(result.status).toBe('resolved');
      if (result.status !== 'resolved') return;
      expect(result.enriched.openers).toEqual([
        { key: 'user-menu-trigger', testId: 'user-menu-trigger' },
      ]);
    });
  });
});
