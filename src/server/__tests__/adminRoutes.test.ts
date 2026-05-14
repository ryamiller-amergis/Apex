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

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../services/rbacService');

// Default: all permission checks pass. Tests that verify auth behaviour
// re-configure these mocks per test.
jest.mock('../middleware/rbac', () => ({
  requirePermission: (..._keys: string[]) =>
    (_req: any, _res: any, next: any) => next(),
  requireAnyPermission: (..._keys: string[]) =>
    (_req: any, _res: any, next: any) => next(),
  attachPermissions: (_req: any, _res: any, next: any) => next(),
}));

const mockService = rbacService as jest.Mocked<typeof rbacService>;

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
