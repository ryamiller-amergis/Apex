import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../useWorkItems', () => ({
  useWorkItems: () => ({
    workItems: [],
    loading: false,
    error: null,
    updateDueDate: jest.fn(),
    refetch: jest.fn(),
  }),
}));

jest.mock('../useChangelog', () => ({
  useChangelog: () => ({
    data: { currentVersion: '1.0.0', entries: [] },
    isLoading: false,
    isError: false,
    isFetched: true,
  }),
}));

// useAppShell now consumes useProjectMenuConfig, which fires its own
// /api/menu-config fetch via TanStack Query. Mock it so it does not consume
// the sequential fetch mocks these tests rely on for auth + permissions.
jest.mock('../useProjectMenuConfig', () => ({
  useProjectMenuConfig: () => ({ enabledViews: [], isLoading: false }),
}));

jest.mock('../useFeatureFlags', () => ({
  useFeatureFlag: jest.fn(() => true),
  useFeatureFlags: () => ({ flags: { 'work-board': true }, isLoading: false, isFetched: true }),
}));

jest.mock('../../config/env', () => ({
  env: { VITE_TEAMS: 'ProjectA|ProjectA/Team1~~~ProjectB|ProjectB/Team2' },
}));

import { useAppShell } from '../useAppShell';
import { useFeatureFlag } from '../useFeatureFlags';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

function mockPermissionsResponse(overrides?: Partial<Record<string, unknown>>) {
  return {
    permissions: ['chat:view'],
    roles: ['member'],
    groups: [],
    userId: 'user1',
    isSuperAdmin: false,
    changelogUnread: false,
    showChangelogOnLogin: false,
    betaAnnouncementDismissed: true,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('selectedProject', 'ProjectA');
  jest.restoreAllMocks();
});

describe('useAppShell – project-aware permissions refetch', () => {
  it('fetches /api/me/permissions?project=ProjectA on auth', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ authenticated: true, user: { name: 'Test' } }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockPermissionsResponse()) });
    global.fetch = fetchMock;

    const { wrapper } = createWrapper();
    renderHook(() => useAppShell(), { wrapper });

    await waitFor(() => {
      const permCall = fetchMock.mock.calls.find(
        (c: [string, ...unknown[]]) => typeof c[0] === 'string' && c[0].includes('/api/me/permissions')
      );
      expect(permCall).toBeDefined();
      expect(permCall![0]).toBe('/api/me/permissions?project=ProjectA');
    });
  });

  it('refetches permissions with new project param when selectedProject changes', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ authenticated: true, user: { name: 'Test' } }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockPermissionsResponse()) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockPermissionsResponse({ permissions: ['admin:roles'] })) });
    global.fetch = fetchMock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAppShell(), { wrapper });

    await waitFor(() => expect(result.current.permissionsLoaded).toBe(true));

    act(() => { result.current.changeProject('ProjectB'); });

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        (c: [string, ...unknown[]]) => typeof c[0] === 'string' && c[0].includes('/api/me/permissions')
      );
      expect(calls.length).toBeGreaterThanOrEqual(2);
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toBe('/api/me/permissions?project=ProjectB');
    });

    await waitFor(() => {
      expect(result.current.permissions).toContain('admin:roles');
    });
  });

  it('toggles permissionsLoaded to false during refetch then back to true', async () => {
    let resolveSecondPermissions: (v: unknown) => void;
    const secondPermissionsPromise = new Promise(r => { resolveSecondPermissions = r; });

    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ authenticated: true, user: { name: 'Test' } }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockPermissionsResponse()) })
      .mockImplementationOnce(() => secondPermissionsPromise);
    global.fetch = fetchMock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAppShell(), { wrapper });

    await waitFor(() => expect(result.current.permissionsLoaded).toBe(true));

    act(() => { result.current.changeProject('ProjectB'); });

    await waitFor(() => expect(result.current.permissionsLoaded).toBe(false));

    await act(async () => {
      resolveSecondPermissions!({ ok: true, json: () => Promise.resolve(mockPermissionsResponse()) });
    });

    await waitFor(() => expect(result.current.permissionsLoaded).toBe(true));
  });
});

describe('useAppShell – work-board flag', () => {
  beforeEach(() => {
    (useFeatureFlag as jest.Mock).mockReturnValue(true);
  });

  it('uses board work items for Apex when the flag is on', async () => {
    localStorage.setItem('selectedProject', 'Apex');
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ authenticated: true, user: { name: 'Test' } }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockPermissionsResponse()) });
    global.fetch = fetchMock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAppShell(), { wrapper });

    await waitFor(() => expect(result.current.permissionsLoaded).toBe(true));
    expect(result.current.workBoardEnabled).toBe(true);
    expect(result.current.usesBoardWorkItems).toBe(true);
  });

  it('falls back to Azure DevOps work items when the flag is off, including Apex', async () => {
    (useFeatureFlag as jest.Mock).mockReturnValue(false);
    localStorage.setItem('selectedProject', 'Apex');
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ authenticated: true, user: { name: 'Test' } }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockPermissionsResponse()) });
    global.fetch = fetchMock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAppShell(), { wrapper });

    await waitFor(() => expect(result.current.permissionsLoaded).toBe(true));
    expect(result.current.workBoardEnabled).toBe(false);
    expect(result.current.usesBoardWorkItems).toBe(false);
  });
});
