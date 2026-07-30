/**
 * Unit tests for isReleaseVisibleToProject — isolated from the route test mocks.
 */

import type { FoundationSkillRelease } from '../../shared/types/foundationSkills';
import { isReleaseVisibleToProject } from '../services/foundationSkillReleaseService';

jest.mock('../db/drizzle', () => ({ db: {} }));

function makeRelease(targetProjects: string[]): FoundationSkillRelease {
  return {
    id: 'r', version: '0.2.0', status: 'published',
    artifactPackage: '@apex/skills', artifactVersion: '0.2.0',
    artifactFeed: null, integritySha256: null, contractApiVersion: 1,
    selectedSkills: [], targetProjects, manifestSnapshot: null,
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
