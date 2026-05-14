import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useMyPermissions,
  useRoles,
  usePermissions,
  useUsers,
  useCreateRole,
  useUpdateRole,
  useDeleteRole,
  useUpdateRolePermissions,
  useAssignRole,
  useRemoveRole,
} from '../useRbac';

// ── QueryClient wrapper ────────────────────────────────────────────────────────

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

function mockFetchOk(data: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
  }) as jest.Mock;
}

function mockFetchError(status: number, body: unknown = { error: `HTTP ${status}` }) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  }) as jest.Mock;
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const myPermsResponse = {
  permissions: ['admin:roles', 'chat:create'],
  roles: ['admin'],
};

const roles = [
  { id: 'role-admin', name: 'admin', description: null, isDefault: false, createdAt: '2026-01-01', permissions: ['admin:roles'] },
  { id: 'role-member', name: 'member', description: null, isDefault: true, createdAt: '2026-01-01', permissions: ['chat:create'] },
];

const permissions = [
  { id: 'p1', key: 'admin:roles', description: 'Manage roles', category: 'admin' },
  { id: 'p2', key: 'chat:create', description: 'Create chats', category: 'chat' },
];

const users = [
  { oid: 'user-1', displayName: 'Alice', email: 'alice@test.com', lastSeenAt: null, roles: ['admin'] },
];

// ── useMyPermissions ───────────────────────────────────────────────────────────

describe('useMyPermissions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/me/permissions and exposes permissions + roles', async () => {
    mockFetchOk(myPermsResponse);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useMyPermissions(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.permissions).toEqual(['admin:roles', 'chat:create']);
    expect(result.current.roles).toEqual(['admin']);
  });

  it('isAdmin is true when roles includes "admin"', async () => {
    mockFetchOk(myPermsResponse);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useMyPermissions(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.isAdmin).toBe(true);
  });

  it('isAdmin is false when the user is not an admin', async () => {
    mockFetchOk({ permissions: ['chat:create'], roles: ['member'] });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useMyPermissions(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.isAdmin).toBe(false);
  });

  it('can() returns true for a held permission', async () => {
    mockFetchOk(myPermsResponse);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useMyPermissions(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.can('admin:roles')).toBe(true);
    expect(result.current.can('deployments:create')).toBe(false);
  });

  it('defaults permissions and roles to empty arrays before data loads', async () => {
    // Delayed fetch so we can inspect the loading state
    global.fetch = jest.fn().mockResolvedValue(new Promise(() => {})) as jest.Mock;
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useMyPermissions(), { wrapper });

    expect(result.current.permissions).toEqual([]);
    expect(result.current.roles).toEqual([]);
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.can('admin:roles')).toBe(false);
  });

  it('calls the correct URL with credentials', async () => {
    mockFetchOk(myPermsResponse);
    const { wrapper } = createWrapper();

    renderHook(() => useMyPermissions(), { wrapper });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/me/permissions',
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});

// ── useRoles ───────────────────────────────────────────────────────────────────

describe('useRoles', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/admin/roles', async () => {
    mockFetchOk(roles);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useRoles(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(2);
    expect(result.current.data![0]).toMatchObject({ id: 'role-admin', name: 'admin' });
  });

  it('surfaces an error when the request fails', async () => {
    mockFetchError(403, { error: 'Forbidden' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useRoles(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeTruthy();
  });
});

// ── usePermissions ─────────────────────────────────────────────────────────────

describe('usePermissions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/admin/permissions', async () => {
    mockFetchOk(permissions);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePermissions(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(permissions);
  });
});

// ── useUsers ───────────────────────────────────────────────────────────────────

describe('useUsers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/admin/users', async () => {
    mockFetchOk(users);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useUsers(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0]).toMatchObject({ oid: 'user-1', roles: ['admin'] });
  });
});

// ── useCreateRole ──────────────────────────────────────────────────────────────

describe('useCreateRole', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/admin/roles and returns the created role', async () => {
    const created = { id: 'role-new', name: 'developer', description: null, isDefault: false, createdAt: '2026-05-14', permissions: [] };
    mockFetchOk(created);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCreateRole(), { wrapper });

    let data: any;
    await act(async () => {
      data = await result.current.mutateAsync({ name: 'developer' });
    });

    expect(data).toMatchObject({ id: 'role-new', name: 'developer' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/admin/roles',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws when the server returns an error', async () => {
    mockFetchError(400, { error: 'name is required' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCreateRole(), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync({ name: '' })).rejects.toThrow('name is required');
    });
  });
});

// ── useUpdateRole ──────────────────────────────────────────────────────────────

describe('useUpdateRole', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PUTs to /api/admin/roles/:id', async () => {
    const updated = { ...roles[0], name: 'super-admin' };
    mockFetchOk(updated);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useUpdateRole(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: 'role-admin', name: 'super-admin' });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/admin/roles/role-admin',
      expect.objectContaining({ method: 'PUT' }),
    );
  });
});

// ── useDeleteRole ──────────────────────────────────────────────────────────────

describe('useDeleteRole', () => {
  beforeEach(() => jest.clearAllMocks());

  it('DELETEs /api/admin/roles/:id', async () => {
    // 204 No Content — response body is empty, so we mock ok:true with no JSON
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(null),
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDeleteRole(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('role-viewer');
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/admin/roles/role-viewer',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

// ── useUpdateRolePermissions ───────────────────────────────────────────────────

describe('useUpdateRolePermissions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PUTs to /api/admin/roles/:id/permissions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(null),
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useUpdateRolePermissions(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: 'role-admin', permissionIds: ['p1', 'p2'] });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/admin/roles/role-admin/permissions',
      expect.objectContaining({ method: 'PUT' }),
    );
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toEqual({ permissionIds: ['p1', 'p2'] });
  });
});

// ── useAssignRole ──────────────────────────────────────────────────────────────

describe('useAssignRole', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/admin/users/:oid/roles', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(null),
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAssignRole(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ oid: 'user-1', roleId: 'role-admin' });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/admin/users/user-1/roles',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toEqual({ roleId: 'role-admin' });
  });
});

// ── useRemoveRole ──────────────────────────────────────────────────────────────

describe('useRemoveRole', () => {
  beforeEach(() => jest.clearAllMocks());

  it('DELETEs /api/admin/users/:oid/roles/:roleId', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(null),
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRemoveRole(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ oid: 'user-1', roleId: 'role-admin' });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/admin/users/user-1/roles/role-admin',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
