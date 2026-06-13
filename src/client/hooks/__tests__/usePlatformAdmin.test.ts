import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  usePlatformAdminAssignments,
  usePlatformAdminMenuConfigs,
  usePlatformAdminUsers,
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

  it('updates project assignments and invalidates assignment queries', async () => {
    mockFetchOk(undefined, 204);
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useSetPlatformAdminAssignments(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ project: 'MaxView', userIds: ['user-1', 'user-2'] });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/platform-admin/assignments/MaxView',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'include',
        body: JSON.stringify({ userIds: ['user-1', 'user-2'] }),
      }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['platform-admin', 'assignments'] });
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
