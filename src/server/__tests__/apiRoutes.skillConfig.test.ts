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
  requireProjectAccess: (_resolver: any) =>
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

jest.mock('../services/groupService', () => ({
  getUserGroupNames: jest.fn().mockResolvedValue([]),
  getUserGroupIds: jest.fn().mockResolvedValue([]),
  listGroups: jest.fn().mockResolvedValue([]),
  listGroupsWithMembers: jest.fn().mockResolvedValue([]),
}));

jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: jest.fn().mockReturnValue(false),
  isSuperAdminEmail: jest.fn().mockReturnValue(false),
  getSuperAdminEmails: jest.fn().mockReturnValue([]),
}));

// ── App factory ────────────────────────────────────────────────────────────────

/** Caller identity read by `getUserId` — Azure AD puts the stable OID on the profile. */
const CALLER_ID = 'user-alice';
const CALLER_PROFILE = { oid: CALLER_ID, upn: 'alice@example.com' };

function buildApp(profile: Record<string, unknown> | null = CALLER_PROFILE) {
  const app = express();
  app.use(express.json());
  if (profile) {
    app.use((req, _res, next) => {
      (req as any).user = { profile };
      next();
    });
  }
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

const { getUserGroupIds: mockGetUserGroupIds } = jest.requireMock(
  '../services/groupService',
) as { getUserGroupIds: jest.Mock };

const { isSuperAdminRequest: mockIsSuperAdminRequest } = jest.requireMock(
  '../utils/superAdmin',
) as { isSuperAdminRequest: jest.Mock };

const EFFORT_FIELDS = [
  'interviewEffort',
  'prdEffort',
  'adrEffort',
  'designDocEffort',
  'designDocAssistantEffort',
  'designPrototypeEffort',
  'testCaseEffort',
  'designDocValidationEffort',
  'prdAssistantEffort',
  'prdValidationEffort',
  'developmentEffort',
  'standupEffort',
  'featureRequestEffort',
  'technicalEffort',
  'issueEffort',
  'calendarAssistantEffort',
  'loadTestGenerationEffort',
  'designModuleEffort',
  'designModuleScopingEffort',
  'defaultEffort',
] as const;

// ── GET /api/skill-config ──────────────────────────────────────────────────────

describe('GET /api/skill-config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserGroupIds.mockResolvedValue([]);
    mockIsSuperAdminRequest.mockReturnValue(false);
  });

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

  it('FEAT-002 TBI-004 DoD-1 returns every effort field as null when the config has none', async () => {
    mockGetSkillConfig.mockResolvedValue({
      project: 'MaxView',
      skillRepo: 'MaxView',
      skillBranch: 'main',
      // effort fields intentionally omitted — should map to null
    });

    const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

    expect(res.status).toBe(200);
    for (const field of EFFORT_FIELDS) {
      expect(res.body).toHaveProperty(field, null);
    }
  });

  it('FEAT-002 TBI-004 DoD-1 returns the stored value for every effort field', async () => {
    const efforts = Object.fromEntries(
      EFFORT_FIELDS.map((field, index) => [
        field,
        (['low', 'medium', 'high'] as const)[index % 3],
      ]),
    );
    mockGetSkillConfig.mockResolvedValue({
      project: 'MaxView',
      skillRepo: 'MaxView',
      skillBranch: 'main',
      ...efforts,
    });

    const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(efforts);
  });

  it('FEAT-002 PBI-001 AC-2 returns null for an effort cleared to Inherit', async () => {
    mockGetSkillConfig.mockResolvedValue({
      project: 'MaxView',
      skillRepo: 'MaxView',
      skillBranch: 'main',
      interviewEffort: null,
      prdEffort: 'high',
    });

    const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

    expect(res.status).toBe(200);
    expect(res.body.interviewEffort).toBeNull();
    expect(res.body.prdEffort).toBe('high');
  });

  /**
   * FEAT-001 VT-10 originally characterized the pre-FEAT-002 behaviour, where the
   * public endpoint echoed quick-pill objects verbatim with their allow-lists.
   * FEAT-002 TBI-004 is the half of that deploy unit that strips the allow-lists,
   * so the assertions now describe the shipped end state.
   */
  it('FEAT-001 VT-10 / FEAT-002 TBI-004 DoD-1 strips allowedUserIds and allowedGroupIds from pills the caller may see', async () => {
    const skillPill = {
      label: 'Kick Off',
      skillPath: '.cursor/skills/kick-off/SKILL.md',
      allowedUserIds: [CALLER_ID, 'user-bob'],
      allowedGroupIds: ['grp-designers'],
    };
    const mcpPill = {
      label: 'Figma',
      transport: 'http',
      mcpServerName: 'figma',
      url: 'https://mcp.figma.com',
      allowedUserIds: ['user-carol'],
      allowedGroupIds: ['grp-platform-admins'],
    };
    mockGetUserGroupIds.mockResolvedValue(['grp-platform-admins']);
    mockGetSkillConfig.mockResolvedValue({
      project: 'MaxView',
      skillRepo: 'MaxView',
      skillBranch: 'main',
      quickSkillPills: [skillPill],
      quickMcpPills: [mcpPill],
    });

    const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

    expect(res.status).toBe(200);
    expect(res.body.quickSkillPills).toEqual([
      { label: 'Kick Off', skillPath: '.cursor/skills/kick-off/SKILL.md' },
    ]);
    expect(res.body.quickMcpPills).toEqual([
      {
        label: 'Figma',
        transport: 'http',
        mcpServerName: 'figma',
        url: 'https://mcp.figma.com',
      },
    ]);
    expect(res.body.quickSkillPills[0]).not.toHaveProperty('allowedUserIds');
    expect(res.body.quickSkillPills[0]).not.toHaveProperty('allowedGroupIds');
    expect(res.body.quickMcpPills[0]).not.toHaveProperty('allowedUserIds');
    expect(res.body.quickMcpPills[0]).not.toHaveProperty('allowedGroupIds');
  });

  it('FEAT-001 VT-10 leaves allow-list fields absent when a pill omits them', async () => {
    const legacySkillPill = { label: 'Kick Off', skillPath: '.cursor/skills/kick-off/SKILL.md' };
    const legacyMcpPill = {
      label: 'Figma',
      transport: 'http',
      mcpServerName: 'figma',
      url: 'https://mcp.figma.com',
    };
    mockGetSkillConfig.mockResolvedValue({
      project: 'MaxView',
      skillRepo: 'MaxView',
      skillBranch: 'main',
      quickSkillPills: [legacySkillPill],
      quickMcpPills: [legacyMcpPill],
    });

    const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

    expect(res.status).toBe(200);
    expect(res.body.quickSkillPills[0]).not.toHaveProperty('allowedUserIds');
    expect(res.body.quickSkillPills[0]).not.toHaveProperty('allowedGroupIds');
    expect(res.body.quickMcpPills[0]).not.toHaveProperty('allowedUserIds');
    expect(res.body.quickMcpPills[0]).not.toHaveProperty('allowedGroupIds');
  });

  it('calls getSkillConfig with the project name from the query', async () => {
    mockGetSkillConfig.mockResolvedValue(null);

    await request(buildApp()).get('/api/skill-config?project=proj-beta');

    expect(mockGetSkillConfig).toHaveBeenCalledWith('proj-beta');
  });

  // ── FEAT-002 TBI-004 — caller-aware Home pill filtering ──────────────────────

  describe('FEAT-002 TBI-004 Home pill filtering', () => {
    const openSkillPill = { label: 'Open Skill', skillPath: '.cursor/skills/open/SKILL.md' };
    const directSkillPill = {
      label: 'Direct Grant',
      skillPath: '.cursor/skills/direct/SKILL.md',
      allowedUserIds: [CALLER_ID],
      allowedGroupIds: [],
    };
    const groupSkillPill = {
      label: 'Group Grant',
      skillPath: '.cursor/skills/group/SKILL.md',
      allowedUserIds: [],
      allowedGroupIds: ['grp-designers'],
    };
    const deniedSkillPill = {
      label: 'Denied Skill',
      skillPath: '.cursor/skills/denied/SKILL.md',
      allowedUserIds: ['user-bob'],
      allowedGroupIds: ['grp-finance'],
    };
    const openMcpPill = {
      label: 'Open MCP',
      transport: 'http',
      mcpServerName: 'open-mcp',
      url: 'https://mcp.example.com',
    };
    const deniedMcpPill = {
      label: 'Denied MCP',
      transport: 'stdio',
      mcpServerName: 'denied-mcp',
      command: 'npx',
      args: ['-y', 'denied-mcp'],
      allowedUserIds: ['user-bob'],
      allowedGroupIds: [],
    };

    /** Every allow-list identifier used by the fixtures above. None may reach the client. */
    const ALLOW_LIST_IDENTIFIERS = [
      'allowedUserIds',
      'allowedGroupIds',
      'user-bob',
      'grp-designers',
      'grp-finance',
    ];

    function expectNoAllowListLeak(body: unknown) {
      const serialized = JSON.stringify(body);
      for (const identifier of ALLOW_LIST_IDENTIFIERS) {
        expect(serialized).not.toContain(identifier);
      }
    }

    it('FEAT-002 PBI-003 AC-0 VT-17 returns only direct-grant, group-grant, and open pills for a mixed allow-list config', async () => {
      mockGetUserGroupIds.mockResolvedValue(['grp-designers']);
      mockGetSkillConfig.mockResolvedValue({
        project: 'MaxView',
        skillRepo: 'MaxView',
        skillBranch: 'main',
        quickSkillPills: [openSkillPill, directSkillPill, groupSkillPill, deniedSkillPill],
        quickMcpPills: [openMcpPill, deniedMcpPill],
      });

      const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

      expect(res.status).toBe(200);
      expect(res.body.quickSkillPills.map((p: any) => p.label)).toEqual([
        'Open Skill',
        'Direct Grant',
        'Group Grant',
      ]);
      expect(res.body.quickMcpPills.map((p: any) => p.label)).toEqual(['Open MCP']);
      expect(res.body.homePillsConfigured).toBe(true);
      expect(mockGetUserGroupIds).toHaveBeenCalledWith(CALLER_ID);
    });

    it('FEAT-002 TBI-004 DoD-1 VT-17 never returns allow-list identifiers anywhere in the response', async () => {
      mockGetUserGroupIds.mockResolvedValue(['grp-designers']);
      mockGetSkillConfig.mockResolvedValue({
        project: 'MaxView',
        skillRepo: 'MaxView',
        skillBranch: 'main',
        quickSkillPills: [openSkillPill, directSkillPill, groupSkillPill, deniedSkillPill],
        quickMcpPills: [openMcpPill, deniedMcpPill],
      });

      const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

      expect(res.status).toBe(200);
      expectNoAllowListLeak(res.body);
    });

    it('FEAT-002 PBI-003 BR-001 returns a pill with empty allow-lists to every caller', async () => {
      mockGetUserGroupIds.mockResolvedValue([]);
      mockGetSkillConfig.mockResolvedValue({
        project: 'MaxView',
        skillRepo: 'MaxView',
        skillBranch: 'main',
        quickSkillPills: [{ ...openSkillPill, allowedUserIds: [], allowedGroupIds: [] }],
        quickMcpPills: [{ ...openMcpPill, allowedUserIds: [], allowedGroupIds: [] }],
      });

      const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

      expect(res.status).toBe(200);
      expect(res.body.quickSkillPills.map((p: any) => p.label)).toEqual(['Open Skill']);
      expect(res.body.quickMcpPills.map((p: any) => p.label)).toEqual(['Open MCP']);
    });

    it('FEAT-002 PBI-003 BR-002 grants access through a live group membership', async () => {
      mockGetUserGroupIds.mockResolvedValue(['grp-designers']);
      mockGetSkillConfig.mockResolvedValue({
        project: 'MaxView',
        skillRepo: 'MaxView',
        skillBranch: 'main',
        quickSkillPills: [groupSkillPill],
        quickMcpPills: [],
      });

      const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

      expect(res.status).toBe(200);
      expect(res.body.quickSkillPills.map((p: any) => p.label)).toEqual(['Group Grant']);
    });

    it('FEAT-002 PBI-003 AC-1 grants no access for a deleted group and still answers 200', async () => {
      // The group was deleted, so it no longer appears in the caller's live group IDs.
      mockGetUserGroupIds.mockResolvedValue([]);
      mockGetSkillConfig.mockResolvedValue({
        project: 'MaxView',
        skillRepo: 'MaxView',
        skillBranch: 'main',
        quickSkillPills: [groupSkillPill],
        quickMcpPills: [],
      });

      const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

      expect(res.status).toBe(200);
      expect(res.body.quickSkillPills).toEqual([]);
      expect(res.body.homePillsConfigured).toBe(true);
      expectNoAllowListLeak(res.body);
    });

    it('FEAT-002 PBI-003 AC-3 VT-18 returns empty pill arrays with homePillsConfigured true when the caller may see none', async () => {
      mockGetUserGroupIds.mockResolvedValue([]);
      mockGetSkillConfig.mockResolvedValue({
        project: 'MaxView',
        skillRepo: 'MaxView',
        skillBranch: 'main',
        quickSkillPills: [deniedSkillPill],
        quickMcpPills: [deniedMcpPill],
      });

      const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

      expect(res.status).toBe(200);
      expect(res.body.quickSkillPills).toEqual([]);
      expect(res.body.quickMcpPills).toEqual([]);
      expect(res.body.homePillsConfigured).toBe(true);
      expectNoAllowListLeak(res.body);
    });

    it('FEAT-002 PBI-003 AC-2 VT-19 returns empty pill arrays with homePillsConfigured false when no pills are configured', async () => {
      mockGetSkillConfig.mockResolvedValue({
        project: 'MaxView',
        skillRepo: 'MaxView',
        skillBranch: 'main',
        quickSkillPills: null,
        quickMcpPills: null,
      });

      const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

      expect(res.status).toBe(200);
      expect(res.body.quickSkillPills).toEqual([]);
      expect(res.body.quickMcpPills).toEqual([]);
      expect(res.body.homePillsConfigured).toBe(false);
    });

    it('FEAT-002 PBI-004 BR-003 AC-0 and TBI-004 DoD-2 return every configured pill to a Platform Admin with allow-lists stripped', async () => {
      mockIsSuperAdminRequest.mockReturnValue(true);
      mockGetSkillConfig.mockResolvedValue({
        project: 'MaxView',
        skillRepo: 'MaxView',
        skillBranch: 'main',
        quickSkillPills: [openSkillPill, directSkillPill, groupSkillPill, deniedSkillPill],
        quickMcpPills: [openMcpPill, deniedMcpPill],
      });

      const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

      expect(res.status).toBe(200);
      expect(res.body.quickSkillPills.map((p: any) => p.label)).toEqual([
        'Open Skill',
        'Direct Grant',
        'Group Grant',
        'Denied Skill',
      ]);
      expect(res.body.quickMcpPills.map((p: any) => p.label)).toEqual(['Open MCP', 'Denied MCP']);
      expect(res.body.homePillsConfigured).toBe(true);
      expectNoAllowListLeak(res.body);
      expect(mockGetUserGroupIds).not.toHaveBeenCalled();
    });

    it('FEAT-002 PBI-004 AC-1 treats a caller whose Platform Admin status cannot be verified as a regular caller', async () => {
      mockIsSuperAdminRequest.mockReturnValue(false);
      mockGetUserGroupIds.mockResolvedValue([]);
      mockGetSkillConfig.mockResolvedValue({
        project: 'MaxView',
        skillRepo: 'MaxView',
        skillBranch: 'main',
        quickSkillPills: [openSkillPill, deniedSkillPill],
        quickMcpPills: [openMcpPill, deniedMcpPill],
      });

      // No profile at all — identity is unverifiable, so no bypass may apply.
      const res = await request(buildApp(null)).get('/api/skill-config?project=MaxView');

      expect(res.status).toBe(200);
      expect(res.body.quickSkillPills.map((p: any) => p.label)).toEqual(['Open Skill']);
      expect(res.body.quickMcpPills.map((p: any) => p.label)).toEqual(['Open MCP']);
      expectNoAllowListLeak(res.body);
    });

    it('FEAT-002 PBI-004 AC-2 gives a Platform Admin the same pill-less response as anyone else when nothing is configured', async () => {
      mockIsSuperAdminRequest.mockReturnValue(true);
      mockGetSkillConfig.mockResolvedValue({
        project: 'MaxView',
        skillRepo: 'MaxView',
        skillBranch: 'main',
      });

      const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

      expect(res.status).toBe(200);
      expect(res.body.quickSkillPills).toEqual([]);
      expect(res.body.quickMcpPills).toEqual([]);
      expect(res.body.homePillsConfigured).toBe(false);
    });

    it('FEAT-002 PBI-004 AC-3 BR-004 filters pills for a Project Admin, who gets no bypass', async () => {
      mockIsSuperAdminRequest.mockReturnValue(false);
      mockGetUserGroupIds.mockResolvedValue(['grp-project-admins']);
      mockGetSkillConfig.mockResolvedValue({
        project: 'MaxView',
        skillRepo: 'MaxView',
        skillBranch: 'main',
        quickSkillPills: [openSkillPill, deniedSkillPill],
        quickMcpPills: [deniedMcpPill],
      });

      const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

      expect(res.status).toBe(200);
      expect(res.body.quickSkillPills.map((p: any) => p.label)).toEqual(['Open Skill']);
      expect(res.body.quickMcpPills).toEqual([]);
      expectNoAllowListLeak(res.body);
    });

    it('FEAT-002 TBI-004 DoD-0 preserves every public field of an allowed skill pill and both MCP transports', async () => {
      mockGetUserGroupIds.mockResolvedValue([]);
      mockGetSkillConfig.mockResolvedValue({
        project: 'MaxView',
        skillRepo: 'MaxView',
        skillBranch: 'main',
        quickSkillPills: [
          {
            label: 'Kick Off',
            skillPath: '.cursor/skills/kick-off/SKILL.md',
            model: 'claude-opus-4-6',
            effort: 'high',
            description: 'Start a feature kickoff',
            bypassScopePolicy: true,
            allowedUserIds: [],
            allowedGroupIds: [],
          },
        ],
        quickMcpPills: [
          {
            label: 'Figma',
            transport: 'http',
            mcpServerName: 'figma',
            url: 'https://mcp.figma.com',
            headers: { Authorization: '${FIGMA_TOKEN}' },
            description: 'Figma MCP',
            model: 'composer-2',
            effort: 'medium',
            systemPromptHint: 'Use Figma for design lookups',
            allowedUserIds: [],
            allowedGroupIds: [],
          },
          {
            label: 'SendGrid',
            transport: 'stdio',
            mcpServerName: 'sendgrid',
            command: 'npx',
            args: ['-y', 'sendgrid-mcp'],
            env: { SENDGRID_API_KEY: '${SENDGRID_API_KEY}' },
            description: 'SendGrid MCP',
            model: 'composer-2',
            effort: 'low',
            systemPromptHint: 'Send transactional email',
            allowedUserIds: [],
            allowedGroupIds: [],
          },
        ],
      });

      const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

      expect(res.status).toBe(200);
      expect(res.body.quickSkillPills).toEqual([
        {
          label: 'Kick Off',
          skillPath: '.cursor/skills/kick-off/SKILL.md',
          model: 'claude-opus-4-6',
          effort: 'high',
          description: 'Start a feature kickoff',
          bypassScopePolicy: true,
        },
      ]);
      expect(res.body.quickMcpPills).toEqual([
        {
          label: 'Figma',
          transport: 'http',
          mcpServerName: 'figma',
          url: 'https://mcp.figma.com',
          headers: { Authorization: '${FIGMA_TOKEN}' },
          description: 'Figma MCP',
          model: 'composer-2',
          effort: 'medium',
          systemPromptHint: 'Use Figma for design lookups',
        },
        {
          label: 'SendGrid',
          transport: 'stdio',
          mcpServerName: 'sendgrid',
          command: 'npx',
          args: ['-y', 'sendgrid-mcp'],
          env: { SENDGRID_API_KEY: '${SENDGRID_API_KEY}' },
          description: 'SendGrid MCP',
          model: 'composer-2',
          effort: 'low',
          systemPromptHint: 'Send transactional email',
        },
      ]);
    });

    it('FEAT-002 TBI-004 DoD-3 leaves interview, ADR, and other config fields unchanged while filtering pills', async () => {
      mockGetUserGroupIds.mockResolvedValue([]);
      mockGetSkillConfig.mockResolvedValue({
        id: 'cfg-1',
        project: 'MaxView',
        friendlyName: 'MaxView default',
        isDefault: true,
        skillRepo: 'org/MaxView',
        skillBranch: 'develop',
        interviewSkillPath: '.cursor/skills/grill-with-docs/SKILL.md',
        interviewModel: 'claude-opus-4-6',
        interviewEffort: 'high',
        adrInterviewSkillPath: '.cursor/skills/adr-interview/SKILL.md',
        adrFinalizeSkillPath: '.cursor/skills/adr-finalize/SKILL.md',
        adrModel: 'composer-2',
        adrEffort: 'medium',
        prototypeEngine: 'agent',
        prototypeStageEnabled: false,
        quickSkillPills: [deniedSkillPill],
        quickMcpPills: [deniedMcpPill],
      });

      const res = await request(buildApp()).get('/api/skill-config?project=MaxView');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: 'cfg-1',
        project: 'MaxView',
        friendlyName: 'MaxView default',
        isDefault: true,
        skillRepo: 'org/MaxView',
        skillBranch: 'develop',
        interviewSkillPath: '.cursor/skills/grill-with-docs/SKILL.md',
        interviewModel: 'claude-opus-4-6',
        interviewEffort: 'high',
        adrInterviewSkillPath: '.cursor/skills/adr-interview/SKILL.md',
        adrFinalizeSkillPath: '.cursor/skills/adr-finalize/SKILL.md',
        adrModel: 'composer-2',
        adrEffort: 'medium',
        prototypeEngine: 'agent',
        prototypeStageEnabled: false,
      });
      expect(res.body.quickSkillPills).toEqual([]);
      expect(res.body.quickMcpPills).toEqual([]);
    });
  });
});
