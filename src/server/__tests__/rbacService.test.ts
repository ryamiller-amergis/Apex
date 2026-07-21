/**
 * Unit tests for rbacService.
 * The Drizzle `db` instance is fully mocked so no real database is needed.
 */

// ── DB mock ────────────────────────────────────────────────────────────────────
// jest.mock is hoisted; the factory runs before any imports, so we build the
// entire mock shape here and expose it via jest.requireMock below.
jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
    onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
    onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
  });

  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(undefined),
  });

  const makeDeleteChain = () => ({
    where: jest.fn().mockResolvedValue(undefined),
  });

  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([]),
  });

  return {
    db: {
      query: {
        appUserRoles: { findMany: jest.fn() },
        appUserProjectRoles: { findMany: jest.fn() },
        appRoles: { findFirst: jest.fn(), findMany: jest.fn() },
        appUsers: { findMany: jest.fn() },
      },
      insert: jest.fn().mockImplementation(makeInsertChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
      delete: jest.fn().mockImplementation(makeDeleteChain),
      select: jest.fn().mockImplementation(makeSelectChain),
      transaction: jest.fn(),
    },
  };
});

import {
  getUserPermissions,
  getUserRoleNames,
  listRoles,
  getRole,
  createRole,
  updateRole,
  updateRolePermissions,
  deleteRole,
  listPermissions,
  listUsers,
  assignRole,
  removeRole,
  upsertAppUser,
  getUserProjectRoles,
  assignProjectRole,
  removeProjectRole,
} from '../services/rbacService';

// Grab a reference to the mocked db so individual tests can configure return values
const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

// ── Fixtures ───────────────────────────────────────────────────────────────────

const adminRole = {
  id: 'role-admin',
  name: 'admin',
  description: 'Full admin access',
  isDefault: false,
  createdAt: '2026-01-01T00:00:00Z',
  rolePermissions: [
    { permission: { key: 'admin:roles' } },
    { permission: { key: 'admin:users' } },
  ],
};

const memberRole = {
  id: 'role-member',
  name: 'member',
  description: 'Standard member',
  isDefault: true,
  createdAt: '2026-01-01T00:00:00Z',
  rolePermissions: [
    { permission: { key: 'chat:create' } },
    { permission: { key: 'workitems:write' } },
  ],
};

const viewerRole = {
  id: 'role-viewer',
  name: 'viewer',
  description: 'Read-only',
  isDefault: false,
  createdAt: '2026-01-01T00:00:00Z',
  rolePermissions: [{ permission: { key: 'cost:view' } }],
};

// ── getUserPermissions ─────────────────────────────────────────────────────────

describe('getUserPermissions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns permissions from the user\'s assigned roles', async () => {
    mockDb.query.appUserRoles.findMany.mockResolvedValue([
      { role: adminRole },
    ]);

    const perms = await getUserPermissions('user-1');

    expect(perms).toBeInstanceOf(Set);
    expect(perms.has('admin:roles')).toBe(true);
    expect(perms.has('admin:users')).toBe(true);
  });

  it('aggregates permissions across multiple assigned roles', async () => {
    mockDb.query.appUserRoles.findMany.mockResolvedValue([
      { role: adminRole },
      { role: viewerRole },
    ]);

    const perms = await getUserPermissions('user-1');

    expect(perms.has('admin:roles')).toBe(true);
    expect(perms.has('cost:view')).toBe(true);
  });

  it('falls back to the default role when the user has no explicit assignments', async () => {
    mockDb.query.appUserRoles.findMany.mockResolvedValue([]);
    mockDb.query.appRoles.findFirst.mockResolvedValue(memberRole);

    const perms = await getUserPermissions('user-new');

    expect(perms.has('chat:create')).toBe(true);
    expect(perms.has('workitems:write')).toBe(true);
  });

  it('returns an empty Set when no assignments and no default role', async () => {
    mockDb.query.appUserRoles.findMany.mockResolvedValue([]);
    mockDb.query.appRoles.findFirst.mockResolvedValue(null);

    const perms = await getUserPermissions('user-no-role');

    expect(perms.size).toBe(0);
  });
});

// ── getUserRoleNames ───────────────────────────────────────────────────────────

describe('getUserRoleNames', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns role names for the user\'s assigned roles', async () => {
    mockDb.query.appUserRoles.findMany.mockResolvedValue([
      { role: { name: 'admin' } },
      { role: { name: 'viewer' } },
    ]);

    const names = await getUserRoleNames('user-1');

    expect(names).toEqual(expect.arrayContaining(['admin', 'viewer']));
  });

  it('falls back to the default role name when user has no assignments', async () => {
    mockDb.query.appUserRoles.findMany.mockResolvedValue([]);
    mockDb.query.appRoles.findFirst.mockResolvedValue({ name: 'member' });

    const names = await getUserRoleNames('user-new');

    expect(names).toEqual(['member']);
  });

  it('returns an empty array when no assignments and no default role', async () => {
    mockDb.query.appUserRoles.findMany.mockResolvedValue([]);
    mockDb.query.appRoles.findFirst.mockResolvedValue(null);

    const names = await getUserRoleNames('user-orphan');

    expect(names).toEqual([]);
  });
});

// ── listRoles ──────────────────────────────────────────────────────────────────

describe('listRoles', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns roles with flattened permission key arrays', async () => {
    mockDb.query.appRoles.findMany.mockResolvedValue([adminRole, memberRole]);

    const result = await listRoles();

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: 'role-admin',
      name: 'admin',
      permissions: ['admin:roles', 'admin:users'],
    });
    expect(result[1]).toMatchObject({
      id: 'role-member',
      permissions: ['chat:create', 'workitems:write'],
    });
  });

  it('returns an empty array when no roles exist', async () => {
    mockDb.query.appRoles.findMany.mockResolvedValue([]);

    const result = await listRoles();

    expect(result).toEqual([]);
  });
});

// ── getRole ────────────────────────────────────────────────────────────────────

describe('getRole', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a RoleWithPermissions for an existing role', async () => {
    mockDb.query.appRoles.findFirst.mockResolvedValue(adminRole);

    const result = await getRole('role-admin');

    expect(result).toMatchObject({
      id: 'role-admin',
      name: 'admin',
      permissions: ['admin:roles', 'admin:users'],
    });
  });

  it('returns null when the role does not exist', async () => {
    mockDb.query.appRoles.findFirst.mockResolvedValue(null);

    const result = await getRole('role-missing');

    expect(result).toBeNull();
  });
});

// ── createRole ─────────────────────────────────────────────────────────────────

describe('createRole', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a role and returns the created row', async () => {
    const newRole = {
      id: 'role-new',
      name: 'developer',
      description: null,
      isDefault: false,
      createdAt: '2026-05-14T00:00:00Z',
    };

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnThis(),
          returning: jest.fn().mockResolvedValue([newRole]),
        }),
      };
      return fn(tx);
    });

    const result = await createRole('developer', undefined, []);

    expect(result).toEqual(newRole);
  });

  it('inserts role-permission links when permissionIds are provided', async () => {
    const newRole = { id: 'role-dev', name: 'developer', description: null, isDefault: false, createdAt: '2026-05-14T00:00:00Z' };
    const capturedInsertValues: any[] = [];

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const insertMock = jest.fn().mockImplementation(() => ({
        values: jest.fn().mockImplementation((v: any) => {
          capturedInsertValues.push(v);
          return { returning: jest.fn().mockResolvedValue([newRole]) };
        }),
      }));
      return fn({ insert: insertMock });
    });

    await createRole('developer', 'devs', ['perm-1', 'perm-2']);

    // Second insert call should be the role-permission rows
    expect(capturedInsertValues).toHaveLength(2);
    // The second insert's values should include our permissionIds
    const permInsertValues = capturedInsertValues[1];
    const ids = (Array.isArray(permInsertValues) ? permInsertValues : [permInsertValues]).map(
      (v: any) => v.permissionId,
    );
    expect(ids).toEqual(expect.arrayContaining(['perm-1', 'perm-2']));
  });
});

// ── updateRole ─────────────────────────────────────────────────────────────────

describe('updateRole', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls db.update when valid fields are provided', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateRole('role-1', { name: 'renamed', description: 'new desc' });

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'renamed', description: 'new desc' }),
    );
  });

  it('does not call db.update when no update fields are supplied', async () => {
    await updateRole('role-1', {});

    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

// ── updateRolePermissions ──────────────────────────────────────────────────────

describe('updateRolePermissions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes existing permissions then inserts the new set', async () => {
    const deletedWhere = jest.fn().mockResolvedValue(undefined);
    const txDeleteMock = jest.fn().mockReturnValue({ where: deletedWhere });
    const txInsertMock = jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue(undefined),
    });

    mockDb.transaction.mockImplementation(async (fn: any) => {
      return fn({ delete: txDeleteMock, insert: txInsertMock });
    });

    await updateRolePermissions('role-1', ['perm-a', 'perm-b']);

    expect(txDeleteMock).toHaveBeenCalledTimes(1);
    expect(txInsertMock).toHaveBeenCalledTimes(1);
  });

  it('deletes existing permissions but does not insert when permissionIds is empty', async () => {
    const deletedWhere = jest.fn().mockResolvedValue(undefined);
    const txDeleteMock = jest.fn().mockReturnValue({ where: deletedWhere });
    const txInsertMock = jest.fn();

    mockDb.transaction.mockImplementation(async (fn: any) => {
      return fn({ delete: txDeleteMock, insert: txInsertMock });
    });

    await updateRolePermissions('role-1', []);

    expect(txDeleteMock).toHaveBeenCalledTimes(1);
    expect(txInsertMock).not.toHaveBeenCalled();
  });
});

// ── deleteRole ─────────────────────────────────────────────────────────────────

describe('deleteRole', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws when trying to delete the default role', async () => {
    mockDb.query.appRoles.findFirst.mockResolvedValue({ id: 'role-member', isDefault: true });

    await expect(deleteRole('role-member')).rejects.toThrow('Cannot delete the default role');
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('deletes a non-default role', async () => {
    mockDb.query.appRoles.findFirst.mockResolvedValue({ id: 'role-viewer', isDefault: false });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where: whereMock });

    await deleteRole('role-viewer');

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it('proceeds silently when the role is not found (no row to delete)', async () => {
    mockDb.query.appRoles.findFirst.mockResolvedValue(null);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where: whereMock });

    await expect(deleteRole('role-ghost')).resolves.toBeUndefined();
  });
});

// ── listPermissions ────────────────────────────────────────────────────────────

describe('listPermissions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns all permissions ordered by category and key', async () => {
    const rows = [
      { id: 'p1', key: 'admin:roles', description: 'Manage roles', category: 'admin' },
      { id: 'p2', key: 'chat:create', description: 'Create chats', category: 'chat' },
    ];
    const orderByMock = jest.fn().mockResolvedValue(rows);
    const fromMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listPermissions();

    expect(result).toEqual(rows);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });
});

// ── listUsers ──────────────────────────────────────────────────────────────────

describe('listUsers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns users with flattened role name arrays', async () => {
    mockDb.query.appUsers.findMany.mockResolvedValue([
      {
        oid: 'user-1',
        displayName: 'Alice',
        email: 'alice@example.com',
        lastSeenAt: null,
        userRoles: [{ role: { name: 'admin' } }, { role: { name: 'member' } }],
      },
    ]);

    const result = await listUsers();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      oid: 'user-1',
      displayName: 'Alice',
      roles: ['admin', 'member'],
    });
  });

  it('returns an empty array when no users exist', async () => {
    mockDb.query.appUsers.findMany.mockResolvedValue([]);

    const result = await listUsers();

    expect(result).toEqual([]);
  });
});

// ── assignRole ─────────────────────────────────────────────────────────────────

describe('assignRole', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a user-role record and ignores conflicts', async () => {
    const onConflictMock = jest.fn().mockResolvedValue(undefined);
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoNothing: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await assignRole('user-1', 'role-admin', 'admin-user');

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', roleId: 'role-admin', assignedBy: 'admin-user' }),
    );
    expect(onConflictMock).toHaveBeenCalledTimes(1);
  });
});

// ── removeRole ─────────────────────────────────────────────────────────────────

describe('removeRole', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes the user-role record', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where: whereMock });

    await removeRole('user-1', 'role-admin');

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });
});

// ── upsertAppUser ──────────────────────────────────────────────────────────────

describe('upsertAppUser', () => {
  beforeEach(() => jest.clearAllMocks());

  it('upserts the user record with display name and email', async () => {
    const onConflictMock = jest.fn().mockResolvedValue(undefined);
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoUpdate: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await upsertAppUser('oid-1', 'Bob Smith', 'bob@example.com');

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ oid: 'oid-1', displayName: 'Bob Smith', email: 'bob@example.com' }),
    );
    expect(onConflictMock).toHaveBeenCalledTimes(1);
  });
});

// ── getUserPermissions (project-aware) ─────────────────────────────────────────

describe('getUserPermissions (project-aware)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses project roles when project is provided and project roles exist', async () => {
    mockDb.query.appUserProjectRoles.findMany.mockResolvedValue([
      { role: viewerRole },
    ]);

    const perms = await getUserPermissions('user-1', 'ProjectX');

    expect(perms).toBeInstanceOf(Set);
    expect(perms.has('cost:view')).toBe(true);
    expect(perms.has('admin:roles')).toBe(false);
    expect(mockDb.query.appUserRoles.findMany).not.toHaveBeenCalled();
  });

  it('falls back to global roles when project is provided but no project roles exist', async () => {
    mockDb.query.appUserProjectRoles.findMany.mockResolvedValue([]);
    mockDb.query.appUserRoles.findMany.mockResolvedValue([
      { role: adminRole },
    ]);

    const perms = await getUserPermissions('user-1', 'ProjectX');

    expect(perms.has('admin:roles')).toBe(true);
    expect(perms.has('admin:users')).toBe(true);
  });

  it('falls back to default role when project provided, no project roles, no global roles', async () => {
    mockDb.query.appUserProjectRoles.findMany.mockResolvedValue([]);
    mockDb.query.appUserRoles.findMany.mockResolvedValue([]);
    mockDb.query.appRoles.findFirst.mockResolvedValue(memberRole);

    const perms = await getUserPermissions('user-1', 'ProjectX');

    expect(perms.has('chat:create')).toBe(true);
    expect(perms.has('workitems:write')).toBe(true);
  });

  it('skips project role lookup when project is not provided (original behavior)', async () => {
    mockDb.query.appUserRoles.findMany.mockResolvedValue([
      { role: adminRole },
    ]);

    const perms = await getUserPermissions('user-1');

    expect(perms.has('admin:roles')).toBe(true);
    expect(mockDb.query.appUserProjectRoles.findMany).not.toHaveBeenCalled();
  });
});

// ── getUserProjectRoles ────────────────────────────────────────────────────────

describe('getUserProjectRoles', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns role names for the user on the given project', async () => {
    mockDb.query.appUserProjectRoles.findMany.mockResolvedValue([
      { role: { name: 'admin' } },
      { role: { name: 'viewer' } },
    ]);

    const names = await getUserProjectRoles('user-1', 'ProjectX');

    expect(names).toEqual(['admin', 'viewer']);
    expect(mockDb.query.appUserProjectRoles.findMany).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array when the user has no project roles', async () => {
    mockDb.query.appUserProjectRoles.findMany.mockResolvedValue([]);

    const names = await getUserProjectRoles('user-1', 'ProjectX');

    expect(names).toEqual([]);
  });
});

// ── assignProjectRole ──────────────────────────────────────────────────────────

describe('assignProjectRole', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a project-role record and ignores conflicts', async () => {
    const onConflictMock = jest.fn().mockResolvedValue(undefined);
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoNothing: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await assignProjectRole('user-1', 'ProjectX', 'role-admin', 'admin-user');

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        project: 'ProjectX',
        roleId: 'role-admin',
        assignedBy: 'admin-user',
      }),
    );
    expect(onConflictMock).toHaveBeenCalledTimes(1);
  });
});

// ── removeProjectRole ──────────────────────────────────────────────────────────

describe('removeProjectRole', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes the project-role record', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where: whereMock });

    await removeProjectRole('user-1', 'ProjectX', 'role-admin');

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });
});
