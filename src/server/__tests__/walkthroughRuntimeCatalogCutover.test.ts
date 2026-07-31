/**
 * Phase 6 — runtime/authoring DB catalog cutover tests.
 */
import {
  WALKTHROUGH_ANCHOR_MARKER_ATTR,
  WalkthroughAnchorKeys,
  anchorTestIdProps,
  listWalkthroughAnchors,
  toAuthoringAnchorEntry,
  validateRegisteredAnchor,
} from '../../shared/walkthroughAnchors';
import { WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS } from '../../shared/types/walkthroughAnchorRegistry';
import {
  enrichStepAnchorFromCatalog,
  listRuntimeCatalogAnchors,
} from '../services/walkthroughAnchorCatalogResolution';
import { enrichDefinitionAnchorsFromRecords } from '../services/walkthroughService';
import type { WalkthroughDefinition } from '../../shared/types/walkthrough';
import type { WalkthroughAnchorRegistryRecord } from '../../shared/types/walkthroughAnchorRegistry';

const EARLIER = '2026-07-28T12:00:00.000Z';
const NOW = '2026-07-30T04:00:00.000Z';

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
  return WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS.map((seed, i) => seedToRecord(seed, i));
}

describe('Phase 6 runtime DB catalog cutover', () => {
  it('anchorTestIdProps emits data-testid and explicit walkthrough marker', () => {
    const props = anchorTestIdProps(WalkthroughAnchorKeys.PROFILE_BIO);
    expect(props['data-testid']).toBe('profile-bio-section');
    expect(props[WALKTHROUGH_ANCHOR_MARKER_ATTR]).toBe('profile-bio');
  });

  it('DOM markers remain available for scanners but are not the authoring allow-list API', () => {
    const markers = listWalkthroughAnchors();
    expect(markers).toHaveLength(7);
    const authoring = listRuntimeCatalogAnchors(baselineFixtures()).map(toAuthoringAnchorEntry);
    expect(authoring.map((a) => a.key).sort()).toEqual(markers.map((m) => m.key).sort());
  });

  it('validateRegisteredAnchor requires an injected catalog snapshot', () => {
    const catalog = listRuntimeCatalogAnchors(baselineFixtures()).map(toAuthoringAnchorEntry);
    const ok = validateRegisteredAnchor(
      {
        key: 'user-menu-trigger',
        targetRoute: '/home',
        placement: 'bottom',
      },
      catalog,
    );
    expect(ok.ok).toBe(true);

    const missing = validateRegisteredAnchor(
      {
        key: 'notification-bell',
        targetRoute: '/home',
        placement: 'bottom',
      },
      catalog,
    );
    expect(missing.ok).toBe(false);
  });

  it('enriches walkthrough definitions with resolved testId for playback', () => {
    const definition: WalkthroughDefinition = {
      id: 'wt-1',
      internalName: 'Profile tour',
      userTitle: 'Profile',
      whyItMatters: 'Learn profile',
      lifecycle: 'published',
      priority: 1,
      revision: 1,
      publishedAt: EARLIER,
      archivedAt: null,
      createdBy: 'admin',
      createdAt: EARLIER,
      updatedBy: 'admin',
      updatedAt: EARLIER,
      steps: [
        {
          id: 's1',
          walkthroughId: 'wt-1',
          ordinal: 0,
          heading: 'Bio',
          bodyMarkdown: 'Edit bio',
          route: '/profile',
          anchor: {
            key: 'profile-bio',
            targetRoute: '/profile',
            placement: 'bottom',
          },
        },
      ],
      targeting: { projects: ['Apex'], groupId: null },
      targetingRules: [{ type: 'project', value: 'Apex' }],
    };

    const enriched = enrichDefinitionAnchorsFromRecords(definition, baselineFixtures());
    expect(enriched.steps[0].anchor).toMatchObject({
      key: 'profile-bio',
      testId: 'profile-bio-section',
      useCenteredFallback: false,
    });
  });

  it('marks inactive/deleted/missing anchors for centered fallback enrichment', () => {
    const fixtures = [
      seedToRecord(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS[0], 0, { isActive: false }),
      seedToRecord(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS[1], 1, { deletedAt: NOW }),
    ];

    expect(
      enrichStepAnchorFromCatalog(fixtures, {
        key: 'user-menu-trigger',
        targetRoute: '/home',
        placement: 'bottom',
      }),
    ).toMatchObject({
      status: 'centered_fallback',
      reason: 'inactive',
      useCenteredFallback: true,
    });

    const definition: WalkthroughDefinition = {
      id: 'wt-2',
      internalName: 'Stale',
      userTitle: 'Stale',
      whyItMatters: '',
      lifecycle: 'published',
      priority: 0,
      revision: 1,
      publishedAt: EARLIER,
      archivedAt: null,
      createdBy: 'admin',
      createdAt: EARLIER,
      updatedBy: 'admin',
      updatedAt: EARLIER,
      steps: [
        {
          id: 's1',
          walkthroughId: 'wt-2',
          ordinal: 0,
          heading: 'Gone',
          bodyMarkdown: 'x',
          route: '/home',
          anchor: {
            key: 'whats-new-modal',
            targetRoute: '/home',
            placement: 'bottom',
          },
        },
        {
          id: 's2',
          walkthroughId: 'wt-2',
          ordinal: 1,
          heading: 'Missing',
          bodyMarkdown: 'y',
          route: '/home',
          anchor: {
            key: 'does-not-exist',
            targetRoute: '/home',
            placement: 'bottom',
          },
        },
      ],
      targeting: { projects: ['Apex'], groupId: null },
      targetingRules: [{ type: 'project', value: 'Apex' }],
    };

    const enriched = enrichDefinitionAnchorsFromRecords(definition, fixtures);
    expect(enriched.steps[0].anchor).toMatchObject({
      useCenteredFallback: true,
      catalogFallbackReason: 'deleted',
      testId: null,
    });
    expect(enriched.steps[1].anchor).toMatchObject({
      useCenteredFallback: true,
      catalogFallbackReason: 'missing',
    });
  });
});
