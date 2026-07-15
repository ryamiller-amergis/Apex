/**
 * Integration-style tests for the /api/admin routes.
 *
 * - rbacService is fully mocked so no real database is used.
 * - The RBAC middleware is mocked to pass-through by default; individual tests
 *   can override it to verify that 401/403 responses are returned correctly.
 */
import request from 'supertest';
import express from 'express';
import adminRouter from '../routes/admin';
import * as rbacService from '../services/rbacService';
import * as projectSettingsService from '../services/projectSettingsService';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../services/rbacService');
jest.mock('../services/projectSettingsService');
jest.mock('../services/groupService');

jest.mock('@cursor/sdk', () => ({
  Cursor: {
    models: {
      list: jest.fn(),
    },
  },
}));

// Default: all permission checks pass. Tests that verify auth behaviour
// re-configure these mocks per test.
jest.mock('../middleware/rbac', () => ({
  requirePermission: (..._keys: string[]) =>
    (_req: any, _res: any, next: any) => next(),
  requireAnyPermission: (..._keys: string[]) =>
    (_req: any, _res: any, next: any) => next(),
  attachPermissions: (_req: any, _res: any, next: any) => next(),
  requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
}));

const mockService = rbacService as jest.Mocked<typeof rbacService>;
const mockProjectSettings = projectSettingsService as jest.Mocked<typeof projectSettingsService>;

const { Cursor: MockCursor } = jest.requireMock('@cursor/sdk') as {
  Cursor: { models: { list: jest.Mock } };
};

// ── App factory ────────────────────────────────────────────────────────────────

function buildApp(userOid?: string) {
  const app = express();
  app.use(express.json());
  // Inject a synthetic req.user so routes can read the acting user OID
  app.use((req: any, _res: any, next: any) => {
    req.user = userOid ? { profile: { oid: userOid } } : undefined;
    next();
  });
  app.use('/api/admin', adminRouter);
  return app;
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const adminRoleWithPerms = {
  id: 'role-admin',
  name: 'admin',
  description: 'Full admin access',
  isDefault: false,
  createdAt: '2026-01-01T00:00:00Z',
  permissions: ['admin:roles', 'admin:users'],
};

const memberRoleWithPerms = {
  id: 'role-member',
  name: 'member',
  description: 'Standard member',
  isDefault: true,
  createdAt: '2026-01-01T00:00:00Z',
  permissions: ['chat:create', 'workitems:write'],
};

const adminPermission = {
  id: 'perm-1',
  key: 'admin:roles',
  description: 'Manage roles',
  category: 'admin',
};

const userWithRoles = {
  oid: 'user-1',
  displayName: 'Alice',
  email: 'alice@example.com',
  lastSeenAt: null,
  roles: ['admin'],
};

// ── GET /api/admin/roles ───────────────────────────────────────────────────────

describe('GET /api/admin/roles', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with the list of roles', async () => {
    mockService.listRoles.mockResolvedValue([adminRoleWithPerms, memberRoleWithPerms]);

    const res = await request(buildApp()).get('/api/admin/roles');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ id: 'role-admin', name: 'admin' });
  });

  it('returns 500 when listRoles throws', async () => {
    mockService.listRoles.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp()).get('/api/admin/roles');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Internal server error' });
  });
});

// ── POST /api/admin/roles ──────────────────────────────────────────────────────

describe('POST /api/admin/roles', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 201 with the created role', async () => {
    const created = { id: 'role-new', name: 'developer', description: null, isDefault: false, createdAt: '2026-05-14T00:00:00Z' };
    mockService.createRole.mockResolvedValue(created);

    const res = await request(buildApp())
      .post('/api/admin/roles')
      .send({ name: 'developer', description: null, permissionIds: [] });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'role-new', name: 'developer' });
    expect(mockService.createRole).toHaveBeenCalledWith('developer', null, []);
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(buildApp()).post('/api/admin/roles').send({ description: 'no name' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'name is required' });
    expect(mockService.createRole).not.toHaveBeenCalled();
  });

  it('defaults permissionIds to [] when not supplied', async () => {
    const created = { id: 'r1', name: 'ops', description: null, isDefault: false, createdAt: '2026-05-14T00:00:00Z' };
    mockService.createRole.mockResolvedValue(created);

    await request(buildApp()).post('/api/admin/roles').send({ name: 'ops' });

    expect(mockService.createRole).toHaveBeenCalledWith('ops', undefined, []);
  });

  it('returns 500 when createRole throws', async () => {
    mockService.createRole.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp()).post('/api/admin/roles').send({ name: 'ops' });

    expect(res.status).toBe(500);
  });
});

// ── PUT /api/admin/roles/:id ───────────────────────────────────────────────────

describe('PUT /api/admin/roles/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with the updated role', async () => {
    mockService.updateRole.mockResolvedValue(undefined);
    mockService.getRole.mockResolvedValue({ ...adminRoleWithPerms, name: 'super-admin' });

    const res = await request(buildApp())
      .put('/api/admin/roles/role-admin')
      .send({ name: 'super-admin' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'super-admin' });
    expect(mockService.updateRole).toHaveBeenCalledWith('role-admin', { name: 'super-admin' });
  });

  it('returns 404 when the role no longer exists after update', async () => {
    mockService.updateRole.mockResolvedValue(undefined);
    mockService.getRole.mockResolvedValue(null);

    const res = await request(buildApp())
      .put('/api/admin/roles/role-ghost')
      .send({ name: 'ghost' });

    expect(res.status).toBe(404);
  });

  it('returns 500 when updateRole throws', async () => {
    mockService.updateRole.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp())
      .put('/api/admin/roles/role-1')
      .send({ name: 'x' });

    expect(res.status).toBe(500);
  });
});

// ── PUT /api/admin/roles/:id/permissions ──────────────────────────────────────

describe('PUT /api/admin/roles/:id/permissions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 204 on success', async () => {
    mockService.updateRolePermissions.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .put('/api/admin/roles/role-admin/permissions')
      .send({ permissionIds: ['perm-1', 'perm-2'] });

    expect(res.status).toBe(204);
    expect(mockService.updateRolePermissions).toHaveBeenCalledWith('role-admin', ['perm-1', 'perm-2']);
  });

  it('returns 400 when permissionIds is not an array', async () => {
    const res = await request(buildApp())
      .put('/api/admin/roles/role-admin/permissions')
      .send({ permissionIds: 'not-an-array' });

    expect(res.status).toBe(400);
    expect(mockService.updateRolePermissions).not.toHaveBeenCalled();
  });

  it('returns 204 for an empty permissionIds array (clears all perms)', async () => {
    mockService.updateRolePermissions.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .put('/api/admin/roles/role-member/permissions')
      .send({ permissionIds: [] });

    expect(res.status).toBe(204);
  });

  it('returns 500 when updateRolePermissions throws', async () => {
    mockService.updateRolePermissions.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp())
      .put('/api/admin/roles/role-1/permissions')
      .send({ permissionIds: [] });

    expect(res.status).toBe(500);
  });
});

// ── DELETE /api/admin/roles/:id ────────────────────────────────────────────────

describe('DELETE /api/admin/roles/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 204 on successful delete', async () => {
    mockService.deleteRole.mockResolvedValue(undefined);

    const res = await request(buildApp()).delete('/api/admin/roles/role-viewer');

    expect(res.status).toBe(204);
    expect(mockService.deleteRole).toHaveBeenCalledWith('role-viewer');
  });

  it('returns 400 when trying to delete the default role', async () => {
    mockService.deleteRole.mockRejectedValue(new Error('Cannot delete the default role'));

    const res = await request(buildApp()).delete('/api/admin/roles/role-member');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Cannot delete the default role' });
  });

  it('returns 500 for unexpected errors', async () => {
    mockService.deleteRole.mockRejectedValue(new Error('Unexpected DB error'));

    const res = await request(buildApp()).delete('/api/admin/roles/role-1');

    expect(res.status).toBe(500);
  });
});

// ── GET /api/admin/permissions ────────────────────────────────────────────────

describe('GET /api/admin/permissions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with the list of permissions', async () => {
    mockService.listPermissions.mockResolvedValue([adminPermission]);

    const res = await request(buildApp()).get('/api/admin/permissions');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ key: 'admin:roles' });
  });

  it('returns 500 when listPermissions throws', async () => {
    mockService.listPermissions.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp()).get('/api/admin/permissions');

    expect(res.status).toBe(500);
  });
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────

describe('GET /api/admin/users', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with the list of users', async () => {
    mockService.listUsers.mockResolvedValue([userWithRoles]);

    const res = await request(buildApp()).get('/api/admin/users');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ oid: 'user-1', roles: ['admin'] });
    expect(mockService.listUsers).toHaveBeenCalledTimes(1);
    expect(mockService.listUsersForProject).not.toHaveBeenCalled();
  });

  it('returns only users assigned to the requested project', async () => {
    mockService.listUsersForProject.mockResolvedValue([userWithRoles]);

    const res = await request(buildApp()).get('/api/admin/users?project=Apex');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([userWithRoles]);
    expect(mockService.listUsersForProject).toHaveBeenCalledWith('Apex');
    expect(mockService.listUsers).not.toHaveBeenCalled();
  });

  it('returns 500 when listUsers throws', async () => {
    mockService.listUsers.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp()).get('/api/admin/users');

    expect(res.status).toBe(500);
  });
});

// ── POST /api/admin/users/:oid/roles ──────────────────────────────────────────

describe('POST /api/admin/users/:oid/roles', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 201 on successful role assignment', async () => {
    mockService.assignRole.mockResolvedValue(undefined);

    const res = await request(buildApp('admin-oid'))
      .post('/api/admin/users/user-1/roles')
      .send({ roleId: 'role-admin' });

    expect(res.status).toBe(201);
    expect(mockService.assignRole).toHaveBeenCalledWith('user-1', 'role-admin', 'admin-oid');
  });

  it('returns 400 when roleId is missing', async () => {
    const res = await request(buildApp()).post('/api/admin/users/user-1/roles').send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'roleId is required' });
    expect(mockService.assignRole).not.toHaveBeenCalled();
  });

  it('uses "unknown" as assignedBy when no user is authenticated', async () => {
    mockService.assignRole.mockResolvedValue(undefined);

    // buildApp() with no userOid → req.user is undefined
    await request(buildApp())
      .post('/api/admin/users/user-1/roles')
      .send({ roleId: 'role-member' });

    expect(mockService.assignRole).toHaveBeenCalledWith('user-1', 'role-member', 'unknown');
  });

  it('returns 500 when assignRole throws', async () => {
    mockService.assignRole.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp())
      .post('/api/admin/users/user-1/roles')
      .send({ roleId: 'role-admin' });

    expect(res.status).toBe(500);
  });
});

// ── DELETE /api/admin/users/:oid/roles/:roleId ────────────────────────────────

describe('DELETE /api/admin/users/:oid/roles/:roleId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 204 on successful role removal', async () => {
    mockService.removeRole.mockResolvedValue(undefined);

    const res = await request(buildApp()).delete('/api/admin/users/user-1/roles/role-admin');

    expect(res.status).toBe(204);
    expect(mockService.removeRole).toHaveBeenCalledWith('user-1', 'role-admin');
  });

  it('returns 500 when removeRole throws', async () => {
    mockService.removeRole.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp()).delete('/api/admin/users/user-1/roles/role-admin');

    expect(res.status).toBe(500);
  });
});

// ── GET /api/admin/project-settings ──────────────────────────────────────────

describe('GET /api/admin/project-settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProjectSettings.listApproversForAllProjects.mockResolvedValue({});
    mockProjectSettings.listApproverGroupsForAllProjects.mockResolvedValue({});
  });

  const configs = [
    { id: 'cfg-1', project: 'proj-alpha', friendlyName: 'Primary', isDefault: true, skillRepo: 'org/skills', skillBranch: 'main', updatedBy: 'alice', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
    { id: 'cfg-2', project: 'proj-beta', friendlyName: 'Primary', isDefault: true, skillRepo: 'org/skills', skillBranch: 'develop', updatedBy: null, createdAt: '2026-01-03T00:00:00Z', updatedAt: '2026-01-04T00:00:00Z' },
  ];

  it('returns 200 with the list of project skill configs', async () => {
    mockProjectSettings.listSkillConfigs.mockResolvedValue(configs);

    const res = await request(buildApp()).get('/api/admin/project-settings');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ project: 'proj-alpha', skillBranch: 'main' });
    expect(mockProjectSettings.listApproversForAllProjects).toHaveBeenCalledTimes(1);
    expect(mockProjectSettings.listApproverGroupsForAllProjects).toHaveBeenCalledTimes(1);
  });

  it('includes approver counts per project', async () => {
    mockProjectSettings.listSkillConfigs.mockResolvedValue([configs[0]]);
    mockProjectSettings.listApproversForAllProjects.mockResolvedValue({
      'cfg-1': [
        { id: 'a1', settingsId: 'cfg-1', userId: 'u1', documentType: 'design_doc', displayName: 'Alice', email: null, assignedBy: null, assignedAt: '2026-01-01T00:00:00Z' },
        { id: 'a2', settingsId: 'cfg-1', userId: 'u2', documentType: 'design_doc', displayName: 'Bob', email: null, assignedBy: null, assignedAt: '2026-01-01T00:00:00Z' },
        { id: 'a3', settingsId: 'cfg-1', userId: 'u3', documentType: 'prd', displayName: 'Carol', email: null, assignedBy: null, assignedAt: '2026-01-01T00:00:00Z' },
      ],
    });

    const res = await request(buildApp()).get('/api/admin/project-settings');

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      project: 'proj-alpha',
      designDocApproverCount: 2,
      prdApproverCount: 1,
    });
  });

  it('includes approver group counts in reviewer totals', async () => {
    mockProjectSettings.listSkillConfigs.mockResolvedValue([configs[0]]);
    mockProjectSettings.listApproversForAllProjects.mockResolvedValue({ 'cfg-1': [] });
    mockProjectSettings.listApproverGroupsForAllProjects.mockResolvedValue({
      'cfg-1': [
        { groupId: 'g1', groupName: 'QA', documentType: 'test_case' },
        { groupId: 'g2', groupName: 'BA', documentType: 'prd' },
      ],
    });

    const res = await request(buildApp()).get('/api/admin/project-settings');

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      project: 'proj-alpha',
      prdApproverCount: 1,
      testCaseApproverCount: 1,
      designDocApproverCount: 0,
    });
  });

  it('returns 500 when listSkillConfigs throws', async () => {
    mockProjectSettings.listSkillConfigs.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp()).get('/api/admin/project-settings');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Internal server error' });
  });
});

// ── PUT /api/admin/project-settings/:project ──────────────────────────────────

describe('PUT /api/admin/project-settings/:project', () => {
  beforeEach(() => jest.clearAllMocks());

  const savedConfig = {
    id: 'cfg-1',
    project: 'proj-alpha',
    friendlyName: 'Primary',
    isDefault: true,
    skillRepo: 'org/updated-skills',
    skillBranch: 'release',
    updatedBy: 'admin-oid',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-05-18T00:00:00Z',
  };

  it('returns 200 with the upserted config', async () => {
    mockProjectSettings.upsertSkillConfig.mockResolvedValue(savedConfig);

    const res = await request(buildApp())
      .put('/api/admin/project-settings/proj-alpha')
      .send({ skillRepo: 'org/updated-skills', skillBranch: 'release' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ project: 'proj-alpha', skillRepo: 'org/updated-skills' });
    expect(mockProjectSettings.upsertSkillConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'proj-alpha',
        skillRepo: 'org/updated-skills',
        skillBranch: 'release',
      }),
    );
  });

  it('returns 400 when skillRepo is missing', async () => {
    const res = await request(buildApp())
      .put('/api/admin/project-settings/proj-alpha')
      .send({ skillBranch: 'main' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'skillRepo and skillBranch are required' });
    expect(mockProjectSettings.upsertSkillConfig).not.toHaveBeenCalled();
  });

  it('returns 400 when skillBranch is missing', async () => {
    const res = await request(buildApp())
      .put('/api/admin/project-settings/proj-alpha')
      .send({ skillRepo: 'org/repo' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'skillRepo and skillBranch are required' });
    expect(mockProjectSettings.upsertSkillConfig).not.toHaveBeenCalled();
  });

  it('uses displayName as updatedBy when available', async () => {
    mockProjectSettings.upsertSkillConfig.mockResolvedValue(savedConfig);

    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.user = { profile: { oid: 'oid-1', displayName: 'Alice Admin', upn: 'alice@example.com' } };
      next();
    });
    app.use('/api/admin', adminRouter);

    await request(app)
      .put('/api/admin/project-settings/proj-alpha')
      .send({ skillRepo: 'org/repo', skillBranch: 'main' });

    expect(mockProjectSettings.upsertSkillConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'proj-alpha',
        skillRepo: 'org/repo',
        skillBranch: 'main',
        updatedBy: 'Alice Admin',
      }),
    );
  });

  it('falls back to upn when displayName is absent', async () => {
    mockProjectSettings.upsertSkillConfig.mockResolvedValue(savedConfig);

    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.user = { profile: { oid: 'oid-1', upn: 'alice@example.com' } };
      next();
    });
    app.use('/api/admin', adminRouter);

    await request(app)
      .put('/api/admin/project-settings/proj-alpha')
      .send({ skillRepo: 'org/repo', skillBranch: 'main' });

    expect(mockProjectSettings.upsertSkillConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'proj-alpha',
        skillRepo: 'org/repo',
        skillBranch: 'main',
        updatedBy: 'alice@example.com',
      }),
    );
  });

  it('forwards interviewModel, prdModel, and designDocModel to upsertSkillConfig', async () => {
    mockProjectSettings.upsertSkillConfig.mockResolvedValue(savedConfig);

    await request(buildApp())
      .put('/api/admin/project-settings/proj-alpha')
      .send({
        skillRepo: 'org/repo',
        skillBranch: 'main',
        interviewModel: 'claude-3.5-sonnet',
        prdModel: 'gpt-4o',
        designDocModel: 'claude-3-opus',
      });

    expect(mockProjectSettings.upsertSkillConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'proj-alpha',
        skillRepo: 'org/repo',
        skillBranch: 'main',
        interviewModel: 'claude-3.5-sonnet',
        prdModel: 'gpt-4o',
        designDocModel: 'claude-3-opus',
      }),
    );
  });

  it('forwards designDocValidationSkillPath and designDocValidationModel to upsertSkillConfig', async () => {
    mockProjectSettings.upsertSkillConfig.mockResolvedValue(savedConfig);

    await request(buildApp())
      .put('/api/admin/project-settings/proj-alpha')
      .send({
        skillRepo: 'org/repo',
        skillBranch: 'main',
        designDocValidationSkillPath: '.cursor/skills/validate/SKILL.md',
        designDocValidationModel: 'claude-3-opus',
      });

    expect(mockProjectSettings.upsertSkillConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'proj-alpha',
        skillRepo: 'org/repo',
        skillBranch: 'main',
        designDocValidationSkillPath: '.cursor/skills/validate/SKILL.md',
        designDocValidationModel: 'claude-3-opus',
      }),
    );
  });

  it('forwards defaultModel to upsertSkillConfig', async () => {
    mockProjectSettings.upsertSkillConfig.mockResolvedValue(savedConfig);

    await request(buildApp())
      .put('/api/admin/project-settings/proj-alpha')
      .send({ skillRepo: 'org/repo', skillBranch: 'main', defaultModel: 'composer-2' });

    expect(mockProjectSettings.upsertSkillConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'proj-alpha',
        skillRepo: 'org/repo',
        skillBranch: 'main',
        defaultModel: 'composer-2',
      }),
    );
  });

  it('passes approvalMode through to upsertSkillConfig', async () => {
    mockProjectSettings.upsertSkillConfig.mockResolvedValue(savedConfig);

    await request(buildApp())
      .put('/api/admin/project-settings/proj-alpha')
      .send({
        skillRepo: 'org/repo',
        skillBranch: 'main',
        approvalMode: 'all_required',
      });

    expect(mockProjectSettings.upsertSkillConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'proj-alpha',
        skillRepo: 'org/repo',
        skillBranch: 'main',
        approvalMode: 'all_required',
      }),
    );
  });

  it('returns 500 when upsertSkillConfig throws', async () => {
    mockProjectSettings.upsertSkillConfig.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp())
      .put('/api/admin/project-settings/proj-alpha')
      .send({ skillRepo: 'org/repo', skillBranch: 'main' });

    expect(res.status).toBe(500);
  });
});

// ── DELETE /api/admin/project-settings/:project ───────────────────────────────

describe('DELETE /api/admin/project-settings/:project', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 204 on successful delete', async () => {
    mockProjectSettings.deleteSkillConfig.mockResolvedValue(undefined);

    const res = await request(buildApp()).delete('/api/admin/project-settings/proj-alpha');

    expect(res.status).toBe(204);
    expect(mockProjectSettings.deleteSkillConfig).toHaveBeenCalledWith('proj-alpha');
  });

  it('returns 500 when deleteSkillConfig throws', async () => {
    mockProjectSettings.deleteSkillConfig.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp()).delete('/api/admin/project-settings/proj-alpha');

    expect(res.status).toBe(500);
  });
});

// ── GET/PUT /api/admin/project-settings/:project/approvers ────────────────────

describe('GET /api/admin/project-settings/:project/approvers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProjectSettings.listApproverGroupsForProject.mockResolvedValue([]);
  });

  const approvers = [
    {
      id: 'a1',
      settingsId: 'cfg-1',
      userId: 'user-1',
      documentType: 'design_doc' as const,
      displayName: 'Alice',
      email: 'alice@example.com',
      assignedBy: 'admin-oid',
      assignedAt: '2026-01-01T00:00:00Z',
    },
  ];

  it('returns 200 with approvers for the project', async () => {
    mockProjectSettings.listApprovers.mockResolvedValue(approvers);

    const res = await request(buildApp()).get('/api/admin/project-settings/proj-alpha/approvers');

    expect(res.status).toBe(200);
    expect(res.body.approvers).toEqual(approvers);
    expect(res.body.approverGroups).toEqual([]);
    expect(mockProjectSettings.listApprovers).toHaveBeenCalledWith('proj-alpha');
  });

  it('returns 500 when listApprovers throws', async () => {
    mockProjectSettings.listApprovers.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp()).get('/api/admin/project-settings/proj-alpha/approvers');

    expect(res.status).toBe(500);
  });
});

describe('PUT /api/admin/project-settings/:project/approvers', () => {
  beforeEach(() => jest.clearAllMocks());

  const designDoc = [
    {
      id: 'a1',
      settingsId: 'cfg-1',
      userId: 'user-1',
      documentType: 'design_doc' as const,
      displayName: 'Alice',
      email: null,
      assignedBy: 'oid-1',
      assignedAt: '2026-01-01T00:00:00Z',
    },
  ];
  const prd = [
    {
      id: 'a2',
      settingsId: 'cfg-1',
      userId: 'user-2',
      documentType: 'prd' as const,
      displayName: 'Bob',
      email: null,
      assignedBy: 'oid-1',
      assignedAt: '2026-01-01T00:00:00Z',
    },
  ];

  it('returns 200 with designDoc and prd approver lists', async () => {
    mockProjectSettings.setApprovers
      .mockResolvedValueOnce(designDoc)
      .mockResolvedValueOnce(prd);

    const res = await request(buildApp('oid-1'))
      .put('/api/admin/project-settings/proj-alpha/approvers')
      .send({ designDocApprovers: ['user-1'], prdApprovers: ['user-2'], designPrototypeApprovers: [] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ designDoc, prd });
    expect(mockProjectSettings.setApprovers).toHaveBeenCalledWith(
      'proj-alpha',
      'design_doc',
      ['user-1'],
      'oid-1',
    );
    expect(mockProjectSettings.setApprovers).toHaveBeenCalledWith(
      'proj-alpha',
      'prd',
      ['user-2'],
      'oid-1',
    );
  });

  it('returns 400 when designDocApprovers is not an array', async () => {
    const res = await request(buildApp())
      .put('/api/admin/project-settings/proj-alpha/approvers')
      .send({ designDocApprovers: 'user-1', prdApprovers: [] });

    expect(res.status).toBe(400);
    expect(mockProjectSettings.setApprovers).not.toHaveBeenCalled();
  });

  it('returns 400 when prdApprovers is not an array', async () => {
    const res = await request(buildApp())
      .put('/api/admin/project-settings/proj-alpha/approvers')
      .send({ designDocApprovers: [], prdApprovers: null });

    expect(res.status).toBe(400);
    expect(mockProjectSettings.setApprovers).not.toHaveBeenCalled();
  });

  it('returns 500 when setApprovers throws', async () => {
    mockProjectSettings.setApprovers.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp())
      .put('/api/admin/project-settings/proj-alpha/approvers')
      .send({ designDocApprovers: [], prdApprovers: [], designPrototypeApprovers: [] });

    expect(res.status).toBe(500);
  });
});

// ── Group routes ──────────────────────────────────────────────────────────────

import * as groupService from '../services/groupService';
const mockGroupService = groupService as jest.Mocked<typeof groupService>;

const groupFixture = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'grp-1',
  name: 'Developer',
  description: 'Software development and engineering',
  project: 'MyProject',
  isDefault: true,
  createdBy: null,
  createdAt: '2026-06-10T12:00:00Z',
  ...overrides,
});

const groupWithMembersFixture = () => ({ ...groupFixture(), members: [] });

describe('GET /api/admin/groups', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns all groups when no project query param is given', async () => {
    mockGroupService.listGroupsWithMembers.mockResolvedValue([groupWithMembersFixture()]);

    const res = await request(buildApp()).get('/api/admin/groups?withMembers=true');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockGroupService.listGroupsWithMembers).toHaveBeenCalledWith(undefined);
  });

  it('passes the project filter to the service', async () => {
    mockGroupService.listGroupsWithMembers.mockResolvedValue([groupWithMembersFixture()]);

    const res = await request(buildApp()).get('/api/admin/groups?withMembers=true&project=MyProject');

    expect(res.status).toBe(200);
    expect(mockGroupService.listGroupsWithMembers).toHaveBeenCalledWith('MyProject');
  });

  it('calls listGroups (without members) when withMembers is not set', async () => {
    mockGroupService.listGroups.mockResolvedValue([groupFixture() as any]);

    const res = await request(buildApp()).get('/api/admin/groups?project=MyProject');

    expect(res.status).toBe(200);
    expect(mockGroupService.listGroups).toHaveBeenCalledWith('MyProject');
    expect(mockGroupService.listGroupsWithMembers).not.toHaveBeenCalled();
  });

  it('returns 500 when the service throws', async () => {
    mockGroupService.listGroupsWithMembers.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp()).get('/api/admin/groups?withMembers=true');

    expect(res.status).toBe(500);
  });
});

describe('POST /api/admin/groups', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a group with name, description, and project', async () => {
    const created = groupFixture({ isDefault: false });
    mockGroupService.createGroup.mockResolvedValue(created as any);

    const res = await request(buildApp('oid-1'))
      .post('/api/admin/groups')
      .send({ name: 'Developer', description: 'desc', project: 'MyProject' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Developer' });
    expect(mockGroupService.createGroup).toHaveBeenCalledWith(
      'Developer',
      'desc',
      'oid-1',
      'MyProject',
    );
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(buildApp()).post('/api/admin/groups').send({ project: 'MyProject' });

    expect(res.status).toBe(400);
    expect(mockGroupService.createGroup).not.toHaveBeenCalled();
  });

  it('returns 500 when createGroup throws', async () => {
    mockGroupService.createGroup.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp()).post('/api/admin/groups').send({ name: 'Dev' });

    expect(res.status).toBe(500);
  });
});

describe('POST /api/admin/groups/seed/:project', () => {
  beforeEach(() => jest.clearAllMocks());

  it('seeds defaults and returns the updated group list', async () => {
    mockGroupService.seedDefaultGroupsForProject.mockResolvedValue(undefined);
    mockGroupService.listGroupsWithMembers.mockResolvedValue([groupWithMembersFixture()]);

    const res = await request(buildApp('oid-1')).post('/api/admin/groups/seed/MyProject');

    expect(res.status).toBe(200);
    expect(mockGroupService.seedDefaultGroupsForProject).toHaveBeenCalledWith('MyProject', 'oid-1');
    expect(mockGroupService.listGroupsWithMembers).toHaveBeenCalledWith('MyProject');
    expect(res.body).toHaveLength(1);
  });

  it('returns 500 when seeding throws', async () => {
    mockGroupService.seedDefaultGroupsForProject.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp()).post('/api/admin/groups/seed/MyProject');

    expect(res.status).toBe(500);
  });
});

// ── POST /api/admin/users/:oid/project-roles ──────────────────────────────────

describe('POST /api/admin/users/:oid/project-roles', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with { ok: true } on successful assignment', async () => {
    mockService.assignProjectRole.mockResolvedValue(undefined);

    const res = await request(buildApp('admin-oid'))
      .post('/api/admin/users/user-1/project-roles')
      .send({ project: 'MyProject', roleId: 'role-admin' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockService.assignProjectRole).toHaveBeenCalledWith(
      'user-1',
      'MyProject',
      'role-admin',
      'admin-oid',
    );
  });

  it('returns 400 when project is missing', async () => {
    const res = await request(buildApp('admin-oid'))
      .post('/api/admin/users/user-1/project-roles')
      .send({ roleId: 'role-admin' });

    expect(res.status).toBe(400);
    expect(mockService.assignProjectRole).not.toHaveBeenCalled();
  });

  it('returns 400 when roleId is missing', async () => {
    const res = await request(buildApp('admin-oid'))
      .post('/api/admin/users/user-1/project-roles')
      .send({ project: 'MyProject' });

    expect(res.status).toBe(400);
    expect(mockService.assignProjectRole).not.toHaveBeenCalled();
  });

  it('uses "unknown" as assignedBy when no user is authenticated', async () => {
    mockService.assignProjectRole.mockResolvedValue(undefined);

    await request(buildApp())
      .post('/api/admin/users/user-1/project-roles')
      .send({ project: 'MyProject', roleId: 'role-member' });

    expect(mockService.assignProjectRole).toHaveBeenCalledWith(
      'user-1',
      'MyProject',
      'role-member',
      'unknown',
    );
  });

  it('returns 500 when assignProjectRole throws', async () => {
    mockService.assignProjectRole.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp('admin-oid'))
      .post('/api/admin/users/user-1/project-roles')
      .send({ project: 'MyProject', roleId: 'role-admin' });

    expect(res.status).toBe(500);
  });
});

// ── DELETE /api/admin/users/:oid/project-roles/:roleId ────────────────────────

describe('DELETE /api/admin/users/:oid/project-roles/:roleId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with { ok: true } on successful removal', async () => {
    mockService.removeProjectRole.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .delete('/api/admin/users/user-1/project-roles/role-admin?project=MyProject');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockService.removeProjectRole).toHaveBeenCalledWith(
      'user-1',
      'MyProject',
      'role-admin',
    );
  });

  it('returns 400 when project query param is missing', async () => {
    const res = await request(buildApp())
      .delete('/api/admin/users/user-1/project-roles/role-admin');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'project query parameter is required' });
    expect(mockService.removeProjectRole).not.toHaveBeenCalled();
  });

  it('returns 500 when removeProjectRole throws', async () => {
    mockService.removeProjectRole.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp())
      .delete('/api/admin/users/user-1/project-roles/role-admin?project=MyProject');

    expect(res.status).toBe(500);
  });
});

// ── GET /api/admin/available-models ───────────────────────────────────────────
//
// NOTE: modelsService holds the model list in module-level cache variables that
// persist for the lifetime of the test process.  Tests are ordered so that
// the cache is cold when the first test in this describe block runs, and
// deliberately warm for the second (caching) test.

describe('GET /api/admin/available-models', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with the model list in { id, displayName } shape', async () => {
    MockCursor.models.list.mockResolvedValue([
      { id: 'claude-3.5-sonnet', displayName: 'Claude 3.5 Sonnet' },
      { id: 'gpt-4o' }, // missing displayName — should fall back to id
    ]);

    const res = await request(buildApp()).get('/api/admin/available-models');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      models: [
        { id: 'claude-3.5-sonnet', displayName: 'Claude 3.5 Sonnet' },
        { id: 'gpt-4o', displayName: 'gpt-4o' },
      ],
    });
    expect(MockCursor.models.list).toHaveBeenCalledTimes(1);
  });

  it('serves subsequent requests from cache without calling Cursor.models.list again', async () => {
    // The previous test already populated the cache and the TTL is 5 minutes.
    // clearAllMocks() reset the call count but not the module-level cache.
    const res = await request(buildApp()).get('/api/admin/available-models');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('models');
    // SDK must NOT have been called again — the cached result is served.
    expect(MockCursor.models.list).not.toHaveBeenCalled();
  });
});
