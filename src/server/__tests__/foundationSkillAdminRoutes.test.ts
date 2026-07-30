/**
 * Foundation Skills Admin Route Tests
 *
 * Covers the routes under /api/platform-admin/foundation-skills/* and the
 * consumer read-only endpoints under /api/skills/foundation-*.
 */

import request from 'supertest';
import express from 'express';
import platformAdminRouter from '../routes/platformAdmin';
import skillsRouter from '../routes/skills';
import * as releaseService from '../services/foundationSkillReleaseService';
import * as compatService from '../services/foundationSkillCompatibilityService';
import * as artifactsService from '../services/azureArtifactsSkillService';
import * as updateService from '../services/foundationSkillRepoUpdateService';
import { requireSuperAdmin } from '../middleware/rbac';

jest.mock('../services/foundationSkillReleaseService', () => ({
  listReleases: jest.fn(),
  getRelease: jest.fn(),
  createRelease: jest.fn(),
  publishRelease: jest.fn(),
  deprecateRelease: jest.fn(),
  deleteDraftRelease: jest.fn(),
  getReleaseAudit: jest.fn(),
  getLatestPublishedRelease: jest.fn(),
}));

jest.mock('../services/foundationSkillCompatibilityService', () => ({
  checkCompatibility: jest.fn(),
  listRepoStatuses: jest.fn(),
  getRepoStatus: jest.fn(),
  upsertRepoStatus: jest.fn(),
}));

jest.mock('../services/azureArtifactsSkillService', () => ({
  listCandidates: jest.fn(),
  isAzureArtifactsConfigured: jest.fn(),
  computePackageIntegrity: jest.fn(),
  verifyPackageIntegrity: jest.fn(),
  promoteToReleaseView: jest.fn(),
}));

jest.mock('../services/foundationSkillRepoUpdateService', () => ({
  updateRepoWithFoundationSkills: jest.fn(),
}));

// Mock the existing platform-admin services so they don't blow up
jest.mock('../services/userProjectAssignmentService', () => ({
  bulkSetProjectAssignments: jest.fn(),
  getAllAssignments: jest.fn().mockResolvedValue([]),
  getAssignmentsForProject: jest.fn().mockResolvedValue([]),
  groupAssignmentsByProject: jest.fn().mockReturnValue([]),
  listKnownApplicationUsers: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/menuSettingsService', () => ({
  listMenuConfigs: jest.fn().mockResolvedValue([]),
  getMenuConfig: jest.fn(),
  upsertMenuConfig: jest.fn(),
}));
jest.mock('../services/projectCatalogService', () => ({
  listProjectCatalog: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/projectAccessRequestService', () => ({
  approveProjectAccessRequest: jest.fn(),
  listPlatformAdminAccessRequests: jest.fn().mockResolvedValue([]),
  rejectProjectAccessRequest: jest.fn(),
}));
jest.mock('../services/groupService', () => ({ listGroups: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/featureFlagService', () => ({
  listFlags: jest.fn().mockResolvedValue([]),
  createFlag: jest.fn(),
  updateFlag: jest.fn(),
  addRule: jest.fn(),
  removeRule: jest.fn(),
  deleteFlag: jest.fn(),
  getFlagAudit: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/pendingAssignmentService', () => ({
  addPendingAssignments: jest.fn(),
  listPendingForProject: jest.fn().mockResolvedValue([]),
  removePendingAssignment: jest.fn(),
}));
jest.mock('../middleware/rbac', () => ({
  requireSuperAdmin: jest.fn((_req: any, _res: any, next: any) => next()),
}));
jest.mock('../services/skillCatalog', () => ({
  listProjects: jest.fn().mockResolvedValue([]),
  searchSkills: jest.fn().mockReturnValue([]),
  invalidateCache: jest.fn(),
  parseFrontmatter: jest.fn().mockReturnValue({ frontmatter: { name: '', description: '' }, body: '' }),
}));
jest.mock('../services/skillCatalogFacade', () => ({
  listRepos: jest.fn().mockResolvedValue([]),
  listBranches: jest.fn().mockResolvedValue([]),
  listSkills: jest.fn().mockResolvedValue([]),
  getSkill: jest.fn(),
  getSkillFile: jest.fn(),
  invalidateCache: jest.fn(),
}));

const mockRelease    = releaseService   as jest.Mocked<typeof releaseService>;
const mockCompat     = compatService    as jest.Mocked<typeof compatService>;
const mockArtifacts  = artifactsService as jest.Mocked<typeof artifactsService>;
const mockUpdate     = updateService    as jest.Mocked<typeof updateService>;
const mockRequireSuperAdmin = requireSuperAdmin as jest.Mock;

function buildAdminApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { profile: { oid: 'admin-1', displayName: 'Admin', upn: 'admin@example.com' } };
    next();
  });
  app.use('/api/platform-admin', platformAdminRouter);
  return app;
}

function buildSkillsApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/skills', skillsRouter);
  return app;
}

import type { FoundationSkillRelease } from '../../shared/types/foundationSkills';

const sampleRelease: FoundationSkillRelease = {
  id: 'rel-1', version: '1.0.0', status: 'published',
  artifactPackage: '@apex/skills', artifactVersion: '1.0.0',
  artifactFeed: null, integritySha256: 'abc123', contractApiVersion: 1,
  selectedSkills: ['ui-lab', 'to-prd'], targetProjects: [], manifestSnapshot: null,
  releaseNotes: 'Initial release', breakingChanges: null,
  publishedBy: 'admin-1', publishedAt: '2026-07-28T00:00:00.000Z',
  deprecatedBy: null, deprecatedAt: null,
  createdBy: 'admin-1', createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
};

describe('Foundation Skills Admin Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireSuperAdmin.mockImplementation((_req: any, _res: any, next: any) => next());
  });

  describe('GET /api/platform-admin/foundation-skills/releases', () => {
    it('returns the list of releases', async () => {
      mockRelease.listReleases.mockResolvedValue([sampleRelease]);
      const res = await request(buildAdminApp())
        .get('/api/platform-admin/foundation-skills/releases');
      expect(res.status).toBe(200);
      expect(res.body.releases).toHaveLength(1);
      expect(res.body.releases[0].version).toBe('1.0.0');
    });

    it('requires super admin guard', async () => {
      mockRequireSuperAdmin.mockImplementationOnce((_req: any, res: any) =>
        res.status(403).json({ error: 'Forbidden' }));
      const res = await request(buildAdminApp())
        .get('/api/platform-admin/foundation-skills/releases');
      expect(res.status).toBe(403);
      expect(mockRelease.listReleases).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/platform-admin/foundation-skills/releases', () => {
    it('creates a draft release', async () => {
      const draft: FoundationSkillRelease = { ...sampleRelease, status: 'draft', publishedAt: null };
      mockRelease.createRelease.mockResolvedValue(draft);
      const res = await request(buildAdminApp())
        .post('/api/platform-admin/foundation-skills/releases')
        .send({ version: '1.0.0', artifactVersion: '1.0.0', selectedSkills: ['ui-lab'] });
      expect(res.status).toBe(201);
      expect(res.body.release.status).toBe('draft');
    });

    it('returns 400 when version is missing', async () => {
      const res = await request(buildAdminApp())
        .post('/api/platform-admin/foundation-skills/releases')
        .send({ artifactVersion: '1.0.0', selectedSkills: [] });
      expect(res.status).toBe(400);
      expect(mockRelease.createRelease).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/platform-admin/foundation-skills/releases/:id/publish', () => {
    it('publishes a draft and returns the updated release', async () => {
      mockRelease.publishRelease.mockResolvedValue(sampleRelease);
      const res = await request(buildAdminApp())
        .post('/api/platform-admin/foundation-skills/releases/rel-1/publish');
      expect(res.status).toBe(200);
      expect(res.body.release.status).toBe('published');
    });

    it('returns 409 when the release is not in draft state', async () => {
      mockRelease.publishRelease.mockRejectedValue(new Error("not in 'draft' state"));
      const res = await request(buildAdminApp())
        .post('/api/platform-admin/foundation-skills/releases/rel-1/publish');
      expect(res.status).toBe(409);
    });
  });

  describe('POST /api/platform-admin/foundation-skills/releases/:id/deprecate', () => {
    it('deprecates a published release', async () => {
      const deprecated: FoundationSkillRelease = { ...sampleRelease, status: 'deprecated' };
      mockRelease.deprecateRelease.mockResolvedValue(deprecated);
      const res = await request(buildAdminApp())
        .post('/api/platform-admin/foundation-skills/releases/rel-1/deprecate')
        .send({ reason: 'replaced by v2' });
      expect(res.status).toBe(200);
      expect(res.body.release.status).toBe('deprecated');
    });
  });

  describe('DELETE /api/platform-admin/foundation-skills/releases/:id', () => {
    it('deletes a draft release', async () => {
      mockRelease.deleteDraftRelease.mockResolvedValue(undefined);
      const res = await request(buildAdminApp())
        .delete('/api/platform-admin/foundation-skills/releases/rel-1');
      expect(res.status).toBe(204);
    });

    it('returns 409 when the release is not a draft', async () => {
      mockRelease.deleteDraftRelease.mockRejectedValue(new Error('Only draft releases can be deleted'));
      const res = await request(buildAdminApp())
        .delete('/api/platform-admin/foundation-skills/releases/rel-1');
      expect(res.status).toBe(409);
    });
  });

  describe('GET /api/platform-admin/foundation-skills/releases/:id/audit', () => {
    it('returns audit log entries', async () => {
      mockRelease.getReleaseAudit.mockResolvedValue([
        { id: 'a1', releaseId: 'rel-1', releaseVersion: '1.0.0', action: 'published',
          actorId: 'admin-1', actorEmail: null, details: null, createdAt: '2026-07-28T00:00:00.000Z' },
      ]);
      const res = await request(buildAdminApp())
        .get('/api/platform-admin/foundation-skills/releases/rel-1/audit');
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].action).toBe('published');
    });
  });

  describe('GET /api/platform-admin/foundation-skills/candidates', () => {
    it('returns available candidates from the feed', async () => {
      mockArtifacts.listCandidates.mockResolvedValue([
        { packageName: '@apex/skills', version: '1.0.1', publishedAt: '2026-07-28T00:00:00.000Z',
          feedUrl: 'https://feed', integrity: null, manifestUrl: null },
      ]);
      const res = await request(buildAdminApp())
        .get('/api/platform-admin/foundation-skills/candidates');
      expect(res.status).toBe(200);
      expect(res.body.candidates).toHaveLength(1);
    });

    it('returns empty array when feed is not configured', async () => {
      mockArtifacts.listCandidates.mockResolvedValue([]);
      const res = await request(buildAdminApp())
        .get('/api/platform-admin/foundation-skills/candidates');
      expect(res.status).toBe(200);
      expect(res.body.candidates).toEqual([]);
    });
  });

  describe('GET /api/platform-admin/foundation-skills/repo-statuses', () => {
    it('returns observed repo statuses', async () => {
      mockCompat.listRepoStatuses.mockResolvedValue([
        { id: 's1', provider: 'ado', project: 'MaxView', repo: 'MaxView', branch: 'main',
          installedVersion: '1.0.0', selectedSkills: [], lockHash: 'abc',
          compatibilityStatus: 'compatible', compatibilityErrors: [],
          availableVersion: '1.0.1', updateAvailable: true,
          compatibilityCheckedAt: null, lastObservedAt: '2026-07-28T00:00:00.000Z',
          observedBy: null, createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z' },
      ]);
      const res = await request(buildAdminApp())
        .get('/api/platform-admin/foundation-skills/repo-statuses');
      expect(res.status).toBe(200);
      expect(res.body.statuses).toHaveLength(1);
      expect(res.body.statuses[0].updateAvailable).toBe(true);
    });
  });

  describe('POST /api/platform-admin/foundation-skills/check-compatibility', () => {
    it('returns a compatibility report', async () => {
      mockCompat.checkCompatibility.mockResolvedValue({
        provider: 'ado', project: 'MaxView', repo: 'MaxView', branch: 'main',
        installedVersion: '1.0.0', candidateVersion: '1.0.1',
        status: 'compatible', errors: [], warnings: [], driftedFiles: [],
        checkedAt: '2026-07-28T00:00:00.000Z',
      });
      const res = await request(buildAdminApp())
        .post('/api/platform-admin/foundation-skills/check-compatibility')
        .send({ project: 'MaxView', repo: 'MaxView', provider: 'ado' });
      expect(res.status).toBe(200);
      expect(res.body.report.status).toBe('compatible');
    });

    it('returns 400 when project is missing', async () => {
      const res = await request(buildAdminApp())
        .post('/api/platform-admin/foundation-skills/check-compatibility')
        .send({ repo: 'MaxView' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/platform-admin/foundation-skills/update-repo', () => {
    it('initiates a repo update PR', async () => {
      mockUpdate.updateRepoWithFoundationSkills.mockResolvedValue({
        status: 'pr_created', prUrl: 'https://example.com/pr/1', branchName: 'chore/apex-skills-1-0-1',
        changedFiles: ['.apex/foundation/ui-lab/SKILL.md'], report: 'PR opened', releaseVersion: '1.0.1', errors: [],
      });
      const res = await request(buildAdminApp())
        .post('/api/platform-admin/foundation-skills/update-repo')
        .send({ project: 'MaxView', repo: 'MaxView' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pr_created');
      expect(res.body.prUrl).toBe('https://example.com/pr/1');
    });

    it('returns 400 when repo is missing', async () => {
      const res = await request(buildAdminApp())
        .post('/api/platform-admin/foundation-skills/update-repo')
        .send({ project: 'MaxView' });
      expect(res.status).toBe(400);
    });
  });
});

describe('Foundation Skills Consumer Endpoints (skills router)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('GET /api/skills/foundation-releases', () => {
    it('returns only published releases', async () => {
      mockRelease.listReleases.mockResolvedValue([
        { ...sampleRelease, status: 'published' },
        { ...sampleRelease, id: 'rel-2', status: 'draft' },
        { ...sampleRelease, id: 'rel-3', status: 'deprecated' },
      ]);
      const res = await request(buildSkillsApp())
        .get('/api/skills/foundation-releases');
      expect(res.status).toBe(200);
      expect(res.body.releases).toHaveLength(1);
      expect(res.body.releases[0].status).toBe('published');
    });
  });

  describe('GET /api/skills/foundation-releases/latest', () => {
    it('returns the latest published release without ?project', async () => {
      mockRelease.getLatestPublishedRelease.mockResolvedValue(sampleRelease);
      const res = await request(buildSkillsApp())
        .get('/api/skills/foundation-releases/latest');
      expect(res.status).toBe(200);
      expect(res.body.release.version).toBe('1.0.0');
      expect(mockRelease.getLatestPublishedRelease).toHaveBeenCalledWith(null);
    });

    it('passes ?project to the service for targeted filtering', async () => {
      mockRelease.getLatestPublishedRelease.mockResolvedValue(sampleRelease);
      const res = await request(buildSkillsApp())
        .get('/api/skills/foundation-releases/latest?project=MaxView');
      expect(res.status).toBe(200);
      expect(mockRelease.getLatestPublishedRelease).toHaveBeenCalledWith('MaxView');
    });

    it('returns null when no published release is visible to the project', async () => {
      mockRelease.getLatestPublishedRelease.mockResolvedValue(null);
      const res = await request(buildSkillsApp())
        .get('/api/skills/foundation-releases/latest?project=SomeOtherProject');
      expect(res.status).toBe(200);
      expect(res.body.release).toBeNull();
    });
  });

  describe('GET /api/skills/foundation-status', () => {
    it('returns repo status for project/repo query', async () => {
      mockCompat.getRepoStatus.mockResolvedValue({
        id: 's1', provider: 'ado', project: 'MaxView', repo: 'MaxView', branch: 'main',
        installedVersion: '1.0.0', selectedSkills: ['ui-lab'], lockHash: 'hash1',
        compatibilityStatus: 'compatible', compatibilityErrors: [],
        availableVersion: '1.0.1', updateAvailable: true,
        compatibilityCheckedAt: null, lastObservedAt: '2026-07-28T00:00:00.000Z',
        observedBy: null, createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
      });
      const res = await request(buildSkillsApp())
        .get('/api/skills/foundation-status?project=MaxView&repo=MaxView');
      expect(res.status).toBe(200);
      expect(res.body.status.installedVersion).toBe('1.0.0');
      expect(res.body.status.updateAvailable).toBe(true);
    });

    it('returns 400 when project or repo is missing', async () => {
      const res = await request(buildSkillsApp())
        .get('/api/skills/foundation-status?project=MaxView');
      expect(res.status).toBe(400);
    });

    it('returns null status when repo has never been observed', async () => {
      mockCompat.getRepoStatus.mockResolvedValue(null);
      const res = await request(buildSkillsApp())
        .get('/api/skills/foundation-status?project=MaxView&repo=MaxView');
      expect(res.status).toBe(200);
      expect(res.body.status).toBeNull();
    });
  });
});
