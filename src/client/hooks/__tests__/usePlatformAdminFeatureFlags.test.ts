import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useAddFlagRule,
  useDeleteFeatureFlag,
  useFeatureFlagsList,
  useFlagAudit,
} from '../usePlatformAdminFeatureFlags';

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
  const body = status === 204 ? '' : JSON.stringify(data);
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(data),
  }) as jest.Mock;
}

describe('useFeatureFlagsList', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches feature flags as a bare array from the platform admin endpoint', async () => {
    mockFetchOk([
      {
        id: 'flag-1',
        key: 'example-flag',
        description: 'Demo',
        enabled: false,
        lifecycle: 'active',
        cleanupReady: false,
        createdBy: 'admin',
        createdAt: '2026-06-30T00:00:00Z',
        updatedAt: '2026-06-30T00:00:00Z',
        rules: [],
      },
    ]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useFeatureFlagsList(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([
      expect.objectContaining({ key: 'example-flag', rules: [] }),
    ]);
    expect(global.fetch).toHaveBeenCalledWith('/api/platform-admin/feature-flags', {
      credentials: 'include',
    });
  });
});

describe('useAddFlagRule', () => {
  beforeEach(() => jest.clearAllMocks());

  it('posts a targeting rule and invalidates the feature flag list', async () => {
    mockFetchOk({
      id: 'rule-1',
      flagId: 'flag-1',
      type: 'project',
      value: 'MaxView',
      createdBy: 'admin',
      createdAt: '2026-06-30T00:00:00Z',
    }, 201);
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useAddFlagRule(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        flagId: 'flag-1',
        type: 'project',
        value: 'MaxView',
      });
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/platform-admin/feature-flags/flag-1/rules', {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'project', value: 'MaxView' }),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['platform-admin', 'feature-flags'] });
  });
});

describe('useDeleteFeatureFlag', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes a feature flag and invalidates the list on 204 responses', async () => {
    mockFetchOk(undefined, 204);
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteFeatureFlag(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: 'flag-1' });
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/platform-admin/feature-flags/flag-1', {
      credentials: 'include',
      method: 'DELETE',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['platform-admin', 'feature-flags'] });
  });
});

describe('useFlagAudit', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches audit entries as a bare array when a flag id is provided', async () => {
    mockFetchOk([
      {
        id: 'audit-1',
        flagId: 'flag-1',
        flagKey: 'example-flag',
        action: 'created',
        actorId: 'admin',
        actorEmail: 'admin@example.com',
        details: null,
        createdAt: '2026-06-30T00:00:00Z',
      },
    ]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useFlagAudit('flag-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([
      expect.objectContaining({ action: 'created', flagKey: 'example-flag' }),
    ]);
    expect(global.fetch).toHaveBeenCalledWith('/api/platform-admin/feature-flags/flag-1/audit', {
      credentials: 'include',
    });
  });

  it('does not fetch audit entries when flag id is null', async () => {
    global.fetch = jest.fn() as jest.Mock;
    const { wrapper } = createWrapper();

    renderHook(() => useFlagAudit(null), { wrapper });

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
