/**
 * Foundation Skill Rollback Tests
 *
 * Covers rollback target selection and the safety gates in
 * rollbackRepoWithFoundationSkills (without cloning real repos).
 */

import {
  listRollbackTargets,
  semverGreaterThan,
  isReleaseVisibleToProject,
} from '../services/foundationSkillReleaseService';
import { rollbackRepoWithFoundationSkills } from '../services/foundationSkillRepoUpdateService';
import * as releaseService from '../services/foundationSkillReleaseService';
import * as compatService from '../services/foundationSkillCompatibilityService';
import type { FoundationSkillRelease } from '../../shared/types/foundationSkills';

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock('../services/foundationSkillCompatibilityService', () => ({
  checkCompatibility: jest.fn(),
  getRepoStatus: jest.fn(),
  listRepoStatuses: jest.fn(),
  upsertRepoStatus: jest.fn(),
}));

jest.mock('../services/repoCheckoutService', () => ({
  checkoutDefaultBranch: jest.fn(),
  checkoutNewBranch: jest.fn(),
  pushBranch: jest.fn(),
  cleanupWorkspace: jest.fn(),
  getWorkspaceDir: jest.fn(),
}));

jest.mock('../services/repoCacheService', () => ({
  resolveGitRemote: jest.fn().mockReturnValue('origin'),
}));

jest.mock('../utils/asyncGit', () => ({
  git: jest.fn(),
  safeArgs: jest.fn((cwd: string, args: string[]) => args),
  LONG_TIMEOUT_MS: 1000,
}));

jest.mock('../services/skillCatalogGitHub', () => ({
  createPullRequest: jest.fn(),
}));

import { db } from '../db/drizzle';

const mockDb = db as unknown as {
  select: jest.Mock;
};

function release(overrides: Partial<FoundationSkillRelease> = {}): FoundationSkillRelease {
  return {
    id: 'rel-1',
    version: '1.0.0',
    status: 'published',
    artifactPackage: '@apex/skills',
    artifactVersion: '1.0.0',
    artifactFeed: null,
    integritySha256: null,
    contractApiVersion: 1,
    selectedSkills: ['ui-lab'],
    targetProjects: [],
    skillTargets: {},
    manifestSnapshot: null,
    releaseNotes: null,
    breakingChanges: null,
    publishedBy: 'admin',
    publishedAt: '2026-08-01T00:00:00.000Z',
    deprecatedBy: null,
    deprecatedAt: null,
    createdBy: 'admin',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('semverGreaterThan', () => {
  it('compares major/minor/patch correctly', () => {
    expect(semverGreaterThan('1.1.0', '1.0.0')).toBe(true);
    expect(semverGreaterThan('1.0.0', '1.1.0')).toBe(false);
    expect(semverGreaterThan('1.0.0', '1.0.0')).toBe(false);
    expect(semverGreaterThan('2.0.0', '1.9.9')).toBe(true);
  });
});

describe('listRollbackTargets', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns only published, visible, older releases newest-first', async () => {
    const rows = [
      release({ id: 'r2', version: '1.1.0', publishedAt: '2026-08-02T00:00:00.000Z' }),
      release({ id: 'r1', version: '1.0.0', publishedAt: '2026-08-01T00:00:00.000Z' }),
      release({ id: 'r3', version: '1.2.0', publishedAt: '2026-08-03T00:00:00.000Z' }),
    ];

    const chain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue(rows),
    };
    mockDb.select.mockReturnValue(chain);

    const targets = await listRollbackTargets('MaxView', '1.2.0');

    expect(targets.map(t => t.version)).toEqual(['1.1.0', '1.0.0']);
    expect(targets.every(t => t.status === 'published')).toBe(true);
  });

  it('excludes releases not targeted at the Apex project', async () => {
    const rows = [
      release({ id: 'r1', version: '1.0.0', targetProjects: ['OtherTeam'] }),
      release({ id: 'r2', version: '0.9.0', targetProjects: [] }),
    ];
    const chain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue(rows),
    };
    mockDb.select.mockReturnValue(chain);

    const targets = await listRollbackTargets('MaxView', '1.1.0');

    expect(targets.map(t => t.version)).toEqual(['0.9.0']);
    expect(isReleaseVisibleToProject(targets[0], 'MaxView')).toBe(true);
  });
});

describe('rollbackRepoWithFoundationSkills gates', () => {
  const getReleaseSpy = jest.spyOn(releaseService, 'getRelease');
  const getStatusSpy = jest.spyOn(compatService, 'getRepoStatus');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects when installed version is unknown', async () => {
    getReleaseSpy.mockResolvedValue(release({ id: 'r1', version: '1.0.0' }));
    getStatusSpy.mockResolvedValue(null);

    const result = await rollbackRepoWithFoundationSkills({
      project: 'MaxView',
      repo: 'MaxView',
      apexProject: 'MaxView',
      apexUrl: 'https://apex.example.com',
      releaseId: 'r1',
    });

    expect(result.status).toBe('error');
    expect(result.errors[0]).toMatch(/installed version unknown/i);
  });

  it('rejects when target is not older than installed', async () => {
    getReleaseSpy.mockResolvedValue(release({ id: 'r2', version: '1.1.0' }));

    const result = await rollbackRepoWithFoundationSkills({
      project: 'MaxView',
      repo: 'MaxView',
      apexProject: 'MaxView',
      apexUrl: 'https://apex.example.com',
      releaseId: 'r2',
      fromVersion: '1.0.0',
    });

    expect(result.status).toBe('error');
    expect(result.errors[0]).toMatch(/not older than/i);
  });

  it('rejects a deprecated target release', async () => {
    getReleaseSpy.mockResolvedValue(release({ id: 'r0', version: '0.9.0', status: 'deprecated' }));

    const result = await rollbackRepoWithFoundationSkills({
      project: 'MaxView',
      repo: 'MaxView',
      apexProject: 'MaxView',
      apexUrl: 'https://apex.example.com',
      releaseId: 'r0',
      fromVersion: '1.0.0',
    });

    expect(result.status).toBe('error');
    expect(result.errors[0]).toMatch(/not published/i);
  });

  it('rejects when release is not found', async () => {
    getReleaseSpy.mockResolvedValue(null);

    const result = await rollbackRepoWithFoundationSkills({
      project: 'MaxView',
      repo: 'MaxView',
      apexProject: 'MaxView',
      apexUrl: 'https://apex.example.com',
      releaseId: 'missing',
      fromVersion: '1.0.0',
    });

    expect(result.status).toBe('error');
    expect(result.errors[0]).toMatch(/not found/i);
  });
});
