import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  usePlatformAdminAssignments,
  usePlatformAdminMenuConfigs,
  usePlatformAdminPendingAssignments,
  usePlatformAdminUsers,
  usePlatformAdminGroups,
  useRemovePlatformAdminPendingAssignment,
  useSetPlatformAdminAssignments,
  useSetPlatformAdminMenuConfig,
} from '../usePlatformAdmin';

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

function mockFetchOk(data: unknown, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(data),
  }) as jest.Mock;
}

describe('usePlatformAdminAssignments', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches project assignment groups from the platform admin endpoint', async () => {
    mockFetchOk({
      assignments: [
        {
          project: 'MaxView',
          users: [{ userId: 'user-1', displayName: 'Ada Lovelace', email: 'ada@example.com' }],
        },
      ],
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePlatformAdminAssignments(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([
      {
        project: 'MaxView',
        users: [{ userId: 'user-1', displayName: 'Ada Lovelace', email: 'ada@example.com' }],
      },
    ]);
    expect(global.fetch).toHaveBeenCalledWith('/api/platform-admin/assignments', {
      credentials: 'include',
    });
  });
});

describe('usePlatformAdminUsers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches known platform admin users', async () => {
    mockFetchOk({
      users: [
        { userId: 'user-1', displayName: 'Ada Lovelace', email: 'ada@example.com' },
        { userId: 'user-2', displayName: 'Grace Hopper', email: 'grace@example.com' },
      ],
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePlatformAdminUsers(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([
      { userId: 'user-1', displayName: 'Ada Lovelace', email: 'ada@example.com' },
      { userId: 'user-2', displayName: 'Grace Hopper', email: 'grace@example.com' },
    ]);
    expect(global.fetch).toHaveBeenCalledWith('/api/platform-admin/users', {
      credentials: 'include',
    });
  });
});

describe('usePlatformAdminGroups', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches platform groups for feature-flag targeting pickers', async () => {
    mockFetchOk({
      groups: [
        { id: 'group-1', name: 'Developer', project: 'MaxView' },
        { id: 'group-2', name: 'QA', project: 'MaxView' },
      ],
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePlatformAdminGroups(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([
      { id: 'group-1', name: 'Developer', project: 'MaxView' },
      { id: 'group-2', name: 'QA', project: 'MaxView' },
    ]);
    expect(global.fetch).toHaveBeenCalledWith('/api/platform-admin/groups', {
      credentials: 'include',
    });
  });
});

describe('usePlatformAdminPendingAssignments', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches pending project assignments for a project', async () => {
    mockFetchOk({
      pending: [
        {
          id: 'pending-1',
          email: 'missing@example.com',
          project: 'MaxView',
          assignedBy: 'super-admin',
          assignedAt: '2026-06-14T12:00:00Z',
        },
      ],
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePlatformAdminPendingAssignments('MaxView'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([
      {
        id: 'pending-1',
        email: 'missing@example.com',
        project: 'MaxView',
        assignedBy: 'super-admin',
        assignedAt: '2026-06-14T12:00:00Z',
      },
    ]);
    expect(global.fetch).toHaveBeenCalledWith('/api/platform-admin/pending-assignments/MaxView', {
      credentials: 'include',
    });
  });
});

describe('usePlatformAdminMenuConfigs', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches menu configs from the platform admin endpoint', async () => {
    mockFetchOk({ configs: [{ project: 'MaxView', enabledViews: ['calendar', 'planning'] }] });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePlatformAdminMenuConfigs(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([{ project: 'MaxView', enabledViews: ['calendar', 'planning'] }]);
    expect(global.fetch).toHaveBeenCalledWith('/api/platform-admin/menu-settings', {
      credentials: 'include',
    });
  });
});

describe('platform admin mutations', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates project assignments with pending emails and invalidates assignment queries', async () => {
    mockFetchOk(undefined, 204);
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useSetPlatformAdminAssignments(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        project: 'MaxView',
        userIds: ['user-1', 'user-2'],
        pendingEmails: ['missing@example.com'],
      });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/platform-admin/assignments/MaxView',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'include',
        body: JSON.stringify({
          userIds: ['user-1', 'user-2'],
          pendingEmails: ['missing@example.com'],
        }),
      }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['platform-admin', 'assignments'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['platform-admin', 'pending-assignments', 'MaxView'] });
  });

  it('removes a pending assignment and invalidates pending assignments', async () => {
    mockFetchOk(undefined, 204);
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useRemovePlatformAdminPendingAssignment(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ project: 'MaxView', email: 'missing@example.com' });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/platform-admin/pending-assignments/MaxView/missing%40example.com',
      expect.objectContaining({
        method: 'DELETE',
        credentials: 'include',
      }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['platform-admin', 'pending-assignments', 'MaxView'] });
  });

  it('updates menu settings and invalidates platform and app menu config queries', async () => {
    mockFetchOk({ project: 'MaxView', enabledViews: ['calendar'] });
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useSetPlatformAdminMenuConfig(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ project: 'MaxView', enabledViews: ['calendar'] });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/platform-admin/menu-settings/MaxView',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'include',
        body: JSON.stringify({ enabledViews: ['calendar'] }),
      }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['platform-admin', 'menu-settings'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['menu-config', 'MaxView'] });
  });
});
