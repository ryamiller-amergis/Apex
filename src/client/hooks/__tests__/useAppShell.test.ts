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

jest.mock('../../config/env', () => ({
  env: { VITE_TEAMS: 'ProjectA|ProjectA/Team1~~~ProjectB|ProjectB/Team2' },
}));

import { useAppShell } from '../useAppShell';

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
