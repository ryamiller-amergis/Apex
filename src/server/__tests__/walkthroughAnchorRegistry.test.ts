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
const WORK_BOARD_SEED_MIGRATION_PATH = path.resolve(
  __dirname,
  '../../../migrations/1786384024693_work-board-walkthrough-anchor-seed.sql',
);

/** Anchors seeded by the follow-up Work Board migration rather than the create migration. */
const WORK_BOARD_ANCHOR_KEYS = new Set([
  'work-board-view',
  'work-board-lens-toggle',
  'work-board-backlog-toggle',
]);

describe('WalkthroughAnchorRegistry contracts (Phase 1)', () => {
  it('baseline seed covers all curated REGISTRY_ENTRIES as approved/active', () => {
    const registry = listWalkthroughAnchors();
    expect(registry).toHaveLength(10);
    expect(WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS).toHaveLength(10);

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

  it('migrations seed all baseline anchor keys with constraints and indexes', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
    expect(fs.existsSync(WORK_BOARD_SEED_MIGRATION_PATH)).toBe(true);
    const createSql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    const workBoardSql = fs.readFileSync(WORK_BOARD_SEED_MIGRATION_PATH, 'utf8');

    // Schema, constraints, and indexes live in the create migration.
    expect(createSql).toMatch(/CREATE TABLE walkthrough_anchor_registry/i);
    expect(createSql).toMatch(/review_status.*pending.*approved.*rejected/is);
    expect(createSql).toMatch(/source_kind.*explicit.*data_testid.*manual/is);
    expect(createSql).toMatch(/jsonb_typeof\(allowed_placements\)\s*=\s*'array'/i);
    expect(createSql).toMatch(/jsonb_typeof\(smart_tags\)\s*=\s*'array'/i);
    expect(createSql).toMatch(/jsonb_typeof\(source_locations\)\s*=\s*'array'/i);
    expect(createSql).toMatch(/NOT is_active OR review_status = 'approved'/i);
    expect(createSql).toMatch(/USING GIN \(smart_tags\)/i);
    expect(createSql).toMatch(/idx_walkthrough_anchor_registry_active_route_status/i);

    // Every baseline seed is seeded by exactly one migration: the create
    // migration for the original curated entries, the follow-up seed migration
    // for the Work Board anchors (so already-migrated databases stay current).
    for (const seed of WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS) {
      const sql = WORK_BOARD_ANCHOR_KEYS.has(seed.anchorKey) ? workBoardSql : createSql;
      expect(sql).toContain(`'${seed.anchorKey}'`);
      expect(sql).toContain(`'${seed.testId}'`);
      expect(sql).toContain(`'${seed.sourceHash}'`);
    }

    const createInsert = createSql.split(/-- Down Migration/i)[0];
    const createdSeeds = WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS.filter((s) =>
      createInsert.includes(`'${s.anchorKey}'`),
    );
    expect(createdSeeds).toHaveLength(7);

    const workBoardInsert = workBoardSql.split(/-- Down Migration/i)[0];
    const workBoardSeeds = WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS.filter((s) =>
      workBoardInsert.includes(`'${s.anchorKey}'`),
    );
    expect(workBoardSeeds).toHaveLength(3);
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
