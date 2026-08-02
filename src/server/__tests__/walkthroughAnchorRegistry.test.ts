/**
 * Phase 1 — walkthrough_anchor_registry shared contracts + baseline seed shape.
 */
import * as fs from 'fs';
import * as path from 'path';
import { listWalkthroughAnchors } from '../../shared/walkthroughAnchors';
import {
  WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS,
  isRuntimeEligibleAnchor,
  isWalkthroughAnchorReviewStatus,
  isWalkthroughAnchorSourceKind,
  normalizeSmartTags,
  validateAnchorRegistryCandidate,
} from '../../shared/types/walkthroughAnchorRegistry';

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../../migrations/20260730030000_create-walkthrough-anchor-registry.sql',
);

describe('WalkthroughAnchorRegistry contracts (Phase 1)', () => {
  it('baseline seed covers all seven REGISTRY_ENTRIES as approved/active', () => {
    const registry = listWalkthroughAnchors();
    expect(registry).toHaveLength(7);
    expect(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS).toHaveLength(7);

    const byKey = new Map(
      WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS.map((s) => [s.anchorKey, s]),
    );

    for (const entry of registry) {
      const seed = byKey.get(entry.key);
      expect(seed).toBeDefined();
      expect(seed!.testId).toBe(entry.testId);
      expect(seed!.label).toBe(entry.label);
      expect(seed!.approvedRoute).toBe(entry.targetRoute);
      expect([...seed!.allowedPlacements]).toEqual([...entry.allowedPlacements]);
      expect(seed!.reviewStatus).toBe('approved');
      expect(seed!.isActive).toBe(true);
      expect(seed!.sourceKind).toBe('explicit');
      expect(seed!.smartTags.length).toBeGreaterThanOrEqual(3);
      expect(seed!.smartTags.every((t) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t))).toBe(
        true,
      );
      expect(validateAnchorRegistryCandidate(seed!)).toEqual([]);
      expect(
        isRuntimeEligibleAnchor({
          reviewStatus: seed!.reviewStatus,
          isActive: seed!.isActive,
          deletedAt: null,
        }),
      ).toBe(true);
    }
  });

  it('migration seeds all baseline anchor keys with constraints and indexes', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

    expect(sql).toMatch(/CREATE TABLE walkthrough_anchor_registry/i);
    expect(sql).toMatch(/review_status.*pending.*approved.*rejected/is);
    expect(sql).toMatch(/source_kind.*explicit.*data_testid.*manual/is);
    expect(sql).toMatch(/jsonb_typeof\(allowed_placements\)\s*=\s*'array'/i);
    expect(sql).toMatch(/jsonb_typeof\(smart_tags\)\s*=\s*'array'/i);
    expect(sql).toMatch(/jsonb_typeof\(source_locations\)\s*=\s*'array'/i);
    expect(sql).toMatch(/NOT is_active OR review_status = 'approved'/i);
    expect(sql).toMatch(/USING GIN \(smart_tags\)/i);
    expect(sql).toMatch(/idx_walkthrough_anchor_registry_active_route_status/i);

    for (const seed of WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS) {
      expect(sql).toContain(`'${seed.anchorKey}'`);
      expect(sql).toContain(`'${seed.testId}'`);
      expect(sql).toContain(`'${seed.sourceHash}'`);
    }

    const insertBlock = sql.split(/-- Down Migration/i)[0];
    const seededKeys = WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS.filter((s) =>
      insertBlock.includes(`'${s.anchorKey}'`),
    );
    expect(seededKeys).toHaveLength(7);
  });

  it('normalizes smart tags and enforces active=>approved invariant', () => {
    expect(normalizeSmartTags([' Profile ', 'USER_MENU', 'profile', ''])).toEqual([
      'profile',
      'user-menu',
    ]);
    expect(isWalkthroughAnchorReviewStatus('pending')).toBe(true);
    expect(isWalkthroughAnchorReviewStatus('bogus')).toBe(false);
    expect(isWalkthroughAnchorSourceKind('data_testid')).toBe(true);
    expect(isWalkthroughAnchorSourceKind('css')).toBe(false);

    expect(
      validateAnchorRegistryCandidate({
        anchorKey: 'x',
        testId: 'x',
        label: 'X',
        reviewStatus: 'pending',
        isActive: true,
        allowedPlacements: ['bottom'],
        smartTags: ['ok-tag'],
        sourceKind: 'manual',
        sourceLocations: [{ filePath: 'src/client/a.tsx' }],
      }).some((e) => e.code === 'ACTIVE_REQUIRES_APPROVED'),
    ).toBe(true);

    expect(
      isRuntimeEligibleAnchor({
        reviewStatus: 'approved',
        isActive: false,
        deletedAt: null,
      }),
    ).toBe(false);
  });
});
