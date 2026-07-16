/**
 * Tests for GET /api/skill-config — per-skill model fields.
 *
 * Only the skill-config endpoint is exercised here. All heavy service
 * dependencies of api.ts are mocked so the module loads without a real
 * database or Azure DevOps connection.
 */
import request from 'supertest';
import express from 'express';
import apiRouter from '../routes/api';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: jest.fn().mockImplementation(() => ({
    getProjects: jest.fn().mockResolvedValue([]),
    getProjectTeams: jest.fn().mockResolvedValue([]),
    getWorkItems: jest.fn().mockResolvedValue([]),
    searchWorkItems: jest.fn().mockResolvedValue([]),
    getWorkItemById: jest.fn().mockResolvedValue(null),
  })),
}));

jest.mock('../../shared/utils/backlogId', () => ({
  generateBacklogId: jest.fn().mockReturnValue('BACK-001'),
}));

jest.mock('../utils/agentTokens', () => ({
  signAgentToken: jest.fn().mockResolvedValue('signed-token'),
}));

jest.mock('../services/featureAutoComplete', () => ({
  getFeatureAutoCompleteService: jest.fn().mockReturnValue({}),
}));

jest.mock('../services/deploymentTracking', () => ({
  DeploymentTrackingService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../services/agentEvalsPrResolutionService', () => ({
  getPrResolutionMetricsStats: jest.fn().mockResolvedValue([]),
}));

jest.mock('drizzle-orm', () => ({
  sql: jest.fn(),
  eq: jest.fn(),
  and: jest.fn(),
  or: jest.fn(),
  desc: jest.fn(),
  asc: jest.fn(),
  ne: jest.fn(),
  gte: jest.fn(),
  lte: jest.fn(),
  inArray: jest.fn(),
  isNull: jest.fn(),
  isNotNull: jest.fn(),
  relations: jest.fn().mockReturnValue({}),
  count: jest.fn(),
}));

jest.mock('../services/projectSettingsService', () => {
  const getSkillConfig = jest.fn().mockResolvedValue(null);
  return {
    getSkillConfig,
    getSkillConfigById: jest.fn().mockResolvedValue(null),
    resolveSkillConfig: jest.fn().mockImplementation((opts: { project: string; settingsId?: string }) =>
      opts.settingsId ? Promise.resolve(null) : getSkillConfig(opts.project),
    ),
    getSkillSettingsName: jest.fn().mockResolvedValue(null),
    listSkillConfigsForProject: jest.fn().mockResolvedValue([]),
    upsertSkillConfig: jest.fn(),
    deleteSkillConfig: jest.fn(),
    listSkillConfigs: jest.fn().mockResolvedValue([]),
    getAllSkillConfigs: jest.fn().mockResolvedValue([]),
  };
});

jest.mock('../middleware/rbac', () => ({
  requirePermission: (..._keys: string[]) =>
    (_req: any, _res: any, next: any) => next(),
  requireAnyPermission: (..._keys: string[]) =>
    (_req: any, _res: any, next: any) => next(),
  requireGroupMembership: (..._groups: string[]) =>
    (_req: any, _res: any, next: any) => next(),
  attachPermissions: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../services/rbacService', () => ({
  getUserPermissions: jest.fn().mockResolvedValue(new Set()),
  getUserRoleNames: jest.fn().mockResolvedValue([]),
  listRoles: jest.fn().mockResolvedValue([]),
  createRole: jest.fn(),
  updateRole: jest.fn(),
  deleteRole: jest.fn(),
  assignRole: jest.fn(),
  removeRole: jest.fn(),
  updateRolePermissions: jest.fn(),
}));

// ── App factory ────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message ?? 'Internal server error' });
  });
  return app;
}

// ── Mock references ────────────────────────────────────────────────────────────

const { getSkillConfig: mockGetSkillConfig } = jest.requireMock(
  '../services/projectSettingsService',
) as { getSkillConfig: jest.Mock };

// ── GET /api/skill-config ──────────────────────────────────────────────────────

describe('GET /api/skill-config', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when the project query parameter is missing', async () => {
    const res = await request(buildApp()).get('/api/skill-config');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('required') });
    expect(mockGetSkillConfig).not.toHaveBeenCalled();
  });

  it('returns 404 when no skill config exists for the project', async () => {
    mockGetSkillConfig.mockResolvedValue(null);

    const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'No skill config found' });
  });

  it('returns interviewModel, prdModel, designDocModel as null when config has no model fields', async () => {
    mockGetSkillConfig.mockResolvedValue({
      project: 'MaxView',
      skillRepo: 'MaxView',
      skillBranch: 'main',
      interviewSkillPath: null,
      prdSkillPath: null,
      designDocSkillPath: null,
      // model fields intentionally omitted — should map to null
    });

    const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

    expect(res.status).toBe(200);
    expect(res.body.interviewModel).toBeNull();
    expect(res.body.prdModel).toBeNull();
    expect(res.body.designDocModel).toBeNull();
  });

  it('returns the correct model values when all three model fields are set', async () => {
    mockGetSkillConfig.mockResolvedValue({
      project: 'MaxView',
      skillRepo: 'MaxView',
      skillBranch: 'main',
      interviewSkillPath: null,
      prdSkillPath: null,
      designDocSkillPath: null,
      interviewModel: 'claude-opus-4-6',
      prdModel: 'composer-2',
      designDocModel: 'claude-4-6-haiku',
    });

    const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

    expect(res.status).toBe(200);
    expect(res.body.interviewModel).toBe('claude-opus-4-6');
    expect(res.body.prdModel).toBe('composer-2');
    expect(res.body.designDocModel).toBe('claude-4-6-haiku');
  });

  it('includes core skill config fields alongside the model fields', async () => {
    mockGetSkillConfig.mockResolvedValue({
      project: 'MaxView',
      skillRepo: 'org/MaxView',
      skillBranch: 'develop',
      interviewSkillPath: '.cursor/skills/interview/SKILL.md',
      prdSkillPath: '.cursor/skills/to-prd/SKILL.md',
      designDocSkillPath: '.cursor/skills/design-doc/SKILL.md',
      interviewModel: 'claude-opus-4-6',
      prdModel: null,
      designDocModel: null,
    });

    const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      project: 'MaxView',
      skillRepo: 'org/MaxView',
      skillBranch: 'develop',
      interviewSkillPath: '.cursor/skills/interview/SKILL.md',
      prdSkillPath: '.cursor/skills/to-prd/SKILL.md',
      designDocSkillPath: '.cursor/skills/design-doc/SKILL.md',
      interviewModel: 'claude-opus-4-6',
      prdModel: null,
      designDocModel: null,
    });
  });

  it('returns technical and issue analysis skill settings', async () => {
    mockGetSkillConfig.mockResolvedValue({
      project: 'Apex',
      skillRepo: 'org/Apex',
      skillBranch: 'main',
      technicalSkillPath: '.cursor/skills/technical-analysis/SKILL.md',
      technicalModel: 'composer-2',
      issueSkillPath: '.cursor/skills/issue-analysis/SKILL.md',
      issueModel: 'claude-opus-4-6',
    });

    const res = await request(buildApp()).get('/api/skill-config?project=Apex');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      technicalSkillPath: '.cursor/skills/technical-analysis/SKILL.md',
      technicalModel: 'composer-2',
      issueSkillPath: '.cursor/skills/issue-analysis/SKILL.md',
      issueModel: 'claude-opus-4-6',
    });
  });

  it('calls getSkillConfig with the project name from the query', async () => {
    mockGetSkillConfig.mockResolvedValue(null);

    await request(buildApp()).get('/api/skill-config?project=proj-beta');

    expect(mockGetSkillConfig).toHaveBeenCalledWith('proj-beta');
  });
});
