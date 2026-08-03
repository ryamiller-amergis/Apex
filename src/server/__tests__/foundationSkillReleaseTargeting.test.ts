/**
 * Unit tests for release targeting and skill tiering — isolated from the route
 * test mocks so the real service implementation runs.
 */

import type { FoundationSkillRelease } from '../../shared/types/foundationSkills';
import {
  isReleaseVisibleToProject,
  shippableSkills,
  rejectNonShippableSkills,
  type CatalogSkillEntry,
} from '../services/foundationSkillReleaseService';

jest.mock('../db/drizzle', () => ({ db: {} }));

function makeRelease(targetProjects: string[], skillTargets: Record<string, string[]> = {}): FoundationSkillRelease {
  return {
    id: 'r', version: '0.2.0', status: 'published',
    artifactPackage: '@apex/skills', artifactVersion: '0.2.0',
    artifactFeed: null, integritySha256: null, contractApiVersion: 1,
    selectedSkills: [], targetProjects, skillTargets, manifestSnapshot: null,
    releaseNotes: null, breakingChanges: null,
    publishedBy: null, publishedAt: null, deprecatedBy: null, deprecatedAt: null,
    createdBy: 'admin', createdAt: '', updatedAt: '',
  };
}

describe('isReleaseVisibleToProject', () => {
  it('returns true for empty targetProjects (all projects)', () => {
    expect(isReleaseVisibleToProject(makeRelease([]), 'MaxView')).toBe(true);
    expect(isReleaseVisibleToProject(makeRelease([]), null)).toBe(true);
  });

  it('returns true when apexProject is in the allowlist', () => {
    expect(isReleaseVisibleToProject(makeRelease(['MaxView', 'OtherProject']), 'MaxView')).toBe(true);
  });

  it('returns false when apexProject is not in the allowlist', () => {
    expect(isReleaseVisibleToProject(makeRelease(['MaxView']), 'SomeOtherProject')).toBe(false);
  });

  it('returns false when apexProject is null and allowlist is non-empty', () => {
    expect(isReleaseVisibleToProject(makeRelease(['MaxView']), null)).toBe(false);
  });
});

describe('skill tiers', () => {
  const catalog: CatalogSkillEntry[] = [
    { name: 'to-prd',                summary: 'A.', tier: 'shippable' },
    { name: 'design-doc-validation', summary: 'B.', tier: 'apex-only' },
    { name: 'ui-lab',                summary: 'C.', tier: 'shippable' },
  ];

  describe('shippableSkills', () => {
    it('drops apex-only entries', () => {
      expect(shippableSkills(catalog).map(s => s.name)).toEqual(['to-prd', 'ui-lab']);
    });

    it('returns an empty list for an empty catalog', () => {
      expect(shippableSkills([])).toEqual([]);
    });
  });

  describe('rejectNonShippableSkills', () => {
    it('returns nothing when every selected skill ships', () => {
      expect(rejectNonShippableSkills(['to-prd', 'ui-lab'], catalog)).toEqual([]);
    });

    it('flags apex-only skills in the selection', () => {
      expect(rejectNonShippableSkills(['to-prd', 'design-doc-validation'], catalog))
        .toEqual(['design-doc-validation']);
    });

    it('ignores names that are not in the catalog at all', () => {
      expect(rejectNonShippableSkills(['does-not-exist'], catalog)).toEqual([]);
    });
  });
});
