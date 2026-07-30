import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useCreateWalkthrough,
  useUpdateWalkthrough,
  useWalkthroughAnchors,
  useWalkthroughCatalog,
  useWalkthroughDetail,
} from '../usePlatformAdminWalkthroughs';

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

describe('useWalkthroughCatalog', () => {
  beforeEach(() => jest.clearAllMocks());

  it('AC-2 — fetches catalog with cursor pagination and limit', async () => {
    mockFetchOk({
      items: [{ id: 'wt-1', internalName: 'Intro', lifecycle: 'draft', priority: 1 }],
      nextCursor: 'cursor-2',
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useWalkthroughCatalog({ limit: 50 }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith('/api/platform-admin/walkthroughs?limit=50', {
      credentials: 'include',
    });
    expect(result.current.data?.pages[0].nextCursor).toBe('cursor-2');
  });
});

describe('useWalkthroughDetail', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches a walkthrough by id', async () => {
    mockFetchOk({ id: 'wt-1', internalName: 'Intro' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useWalkthroughDetail('wt-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith('/api/platform-admin/walkthroughs/wt-1', {
      credentials: 'include',
    });
  });
});

describe('useWalkthroughAnchors', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches curated anchors', async () => {
    mockFetchOk({ anchors: [{ key: 'user-menu-trigger', label: 'User menu' }] });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useWalkthroughAnchors(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith('/api/platform-admin/walkthroughs/anchors', {
      credentials: 'include',
    });
    expect(result.current.data?.[0].key).toBe('user-menu-trigger');
  });
});

describe('useCreateWalkthrough', () => {
  beforeEach(() => jest.clearAllMocks());

  it('AC-0 — posts create command and invalidates catalog', async () => {
    mockFetchOk({ id: 'wt-new', internalName: 'New walkthrough' }, 201);
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useCreateWalkthrough(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        internalName: 'New walkthrough',
        userTitle: 'Welcome',
        whyItMatters: 'Because',
        steps: [{ ordinal: 0, heading: 'Step 1', bodyMarkdown: 'Hello' }],
        targeting: { projects: ['Apex'] },
      });
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/platform-admin/walkthroughs', {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.stringContaining('"internalName":"New walkthrough"'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['platform-admin', 'walkthroughs'] });
  });
});

describe('useUpdateWalkthrough', () => {
  beforeEach(() => jest.clearAllMocks());

  it('AC-0 — patches walkthrough with expectedUpdatedAt', async () => {
    mockFetchOk({ id: 'wt-1', updatedAt: '2026-07-30T00:00:00Z' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useUpdateWalkthrough(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        id: 'wt-1',
        internalName: 'Updated',
        expectedUpdatedAt: '2026-07-29T00:00:00Z',
      });
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/platform-admin/walkthroughs/wt-1', {
      credentials: 'include',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        internalName: 'Updated',
        expectedUpdatedAt: '2026-07-29T00:00:00Z',
      }),
    });
  });
});
