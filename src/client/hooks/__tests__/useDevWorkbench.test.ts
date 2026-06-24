import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useAssignedWorkItems,
  useStartDevSession,
  useActiveSessions,
  useCloseDevSession,
  useDevSession,
  useDevDiff,
  usePushBranch,
} from '../useDevWorkbench';

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
    status: 200,
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

const assignedItems = [
  {
    id: 42,
    title: 'Implement login',
    workItemType: 'Product Backlog Item',
    state: 'In Progress',
    assignedTo: 'jane@example.com',
    project: 'MaxView',
  },
];

describe('useAssignedWorkItems', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches assigned work items for the selected project', async () => {
    mockFetchOk(assignedItems);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAssignedWorkItems('MaxView'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(assignedItems);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/workitems?project=MaxView',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('does not fetch when project is null', async () => {
    global.fetch = jest.fn() as jest.Mock;
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAssignedWorkItems(null), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('surfaces API errors', async () => {
    mockFetchError(500, { error: 'Failed to fetch assigned work items' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAssignedWorkItems('MaxView'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Failed to fetch assigned work items');
  });
});

describe('useStartDevSession', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /start and invalidates dev-workbench queries', async () => {
    mockFetchOk({ sessionId: 'session-1' });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useStartDevSession(), { wrapper });

    await act(async () => {
      const response = await result.current.mutateAsync({ workItemId: 42, project: 'MaxView' });
      expect(response).toEqual({ sessionId: 'session-1' });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/start',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workItemId: 42, project: 'MaxView' }),
      }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dev-workbench'] });
  });
});

describe('useActiveSessions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches active sessions for the selected project', async () => {
    mockFetchOk([{ id: 'session-1', workItemId: 42, status: 'in_progress' }]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useActiveSessions('MaxView'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/sessions?project=MaxView',
      expect.any(Object),
    );
  });
});

describe('useDevSession', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches a single session by id', async () => {
    mockFetchOk({
      id: 'session-1',
      workItemId: 42,
      status: 'in_progress',
      chatThreadId: 'thread-1',
      branchName: 'feature/42',
      setupError: null,
      createdAt: '2026-06-01T00:00:00Z',
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDevSession('session-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/sessions/session-1',
      expect.any(Object),
    );
  });
});

describe('useCloseDevSession', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to close and invalidates dev-workbench queries', async () => {
    mockFetchOk({ ok: true });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useCloseDevSession(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('session-1');
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/sessions/session-1/close',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dev-workbench'] });
  });
});

describe('usePushBranch', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to push the session branch', async () => {
    mockFetchOk({ ok: true, branch: 'feature/42' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePushBranch(), { wrapper });

    await act(async () => {
      const response = await result.current.mutateAsync('session-1');
      expect(response.branch).toBe('feature/42');
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/sessions/session-1/push',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('useDevDiff', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches diff data for a chat thread', async () => {
    mockFetchOk({ diffText: '+line', changedFiles: ['a.ts'], branch: 'feature/42' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDevDiff('thread-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/threads/thread-1/diff',
      expect.any(Object),
    );
  });
});
