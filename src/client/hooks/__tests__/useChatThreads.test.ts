import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useChatThreadList,
  useChatThread,
  useStartChat,
  useDeleteThread,
  useFlagThread,
} from '../useChatThreads';
import type { ChatThreadSummary } from '../../../shared/types/chat';

// ── QueryClient wrapper ───────────────────────────────────────────────────────

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

// ── Fetch mock helpers ────────────────────────────────────────────────────────

function mockFetchOk(data: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
  }) as jest.Mock;
}

function mockFetchError(status: number, body: unknown = {}) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  }) as jest.Mock;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const threadSummary: ChatThreadSummary = {
  id: 'thread-1',
  userId: 'user-1',
  title: 'Grill With Docs',
  status: 'idle',
  kickoff: { project: 'TestProject', repo: 'TestRepo' },
  flagged: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActivityAt: '2026-01-02T00:00:00.000Z',
};

const threadSummary2: ChatThreadSummary = {
  ...threadSummary,
  id: 'thread-2',
  title: 'Another Thread',
};

// ── useChatThreadList ─────────────────────────────────────────────────────────

describe('useChatThreadList', () => {
  afterEach(() => jest.restoreAllMocks());

  it('fetches thread summaries and returns them', async () => {
    mockFetchOk([threadSummary, threadSummary2]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useChatThreadList(50, 'TestProject'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data![0].id).toBe('thread-1');
  });

  it('calls /api/chat/threads with project param', async () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();

    renderHook(() => useChatThreadList(50, 'MyProject'), { wrapper });

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/chat/threads?limit=50&project=MyProject',
        expect.objectContaining({ credentials: 'include' }),
      ),
    );
  });

  it('calls /api/chat/threads with a custom limit and project', async () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();

    renderHook(() => useChatThreadList(10, 'TestProject'), { wrapper });

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/chat/threads?limit=10&project=TestProject',
        expect.objectContaining({ credentials: 'include' }),
      ),
    );
  });

  it('does not retain another project history while the new project loads', async () => {
    const maxViewThread = {
      ...threadSummary,
      kickoff: { ...threadSummary.kickoff, project: 'MaxView' },
    };
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('project=MaxView')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([maxViewThread]),
        });
      }
      return new Promise(() => {});
    }) as jest.Mock;
    const { wrapper } = createWrapper();

    const { result, rerender } = renderHook(
      ({ project }) => useChatThreadList(50, project),
      { wrapper, initialProps: { project: 'MaxView' } },
    );
    await waitFor(() => expect(result.current.data).toEqual([maxViewThread]));

    rerender({ project: 'Apex' });

    expect(result.current.data).toBeUndefined();
    expect(result.current.isPlaceholderData).toBe(false);
  });

  it('is disabled when project is not provided', () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useChatThreadList(50), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('is disabled when project is null', () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useChatThreadList(50, null), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('surfaces an error when the API returns a non-ok response', async () => {
    mockFetchError(500, { error: 'Internal Server Error' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useChatThreadList(50, 'TestProject'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Internal Server Error');
  });

  it('falls back to HTTP status when the response body has no error field', async () => {
    mockFetchError(503, {});
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useChatThreadList(50, 'TestProject'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('HTTP 503');
  });

  // ── TBI-004 / search term (FEAT-002) ───────────────────────────────────────

  describe('TBI-004 debounced search term', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('DoD-0 / VT-01: does not fire a search fetch before ~300ms debounce', async () => {
      mockFetchOk([]);
      const { wrapper } = createWrapper();

      const { rerender } = renderHook(
        ({ term }) => useChatThreadList(50, 'TestProject', { searchTerm: term }),
        { wrapper, initialProps: { term: '' } },
      );

      await waitFor(() => expect(global.fetch).toHaveBeenCalled());
      const callsBefore = (global.fetch as jest.Mock).mock.calls.length;

      rerender({ term: 'de' });
      act(() => {
        jest.advanceTimersByTime(299);
      });

      expect((global.fetch as jest.Mock).mock.calls.length).toBe(callsBefore);
    });

    it('DoD-0 / VT-02: after debounce sends q when term length >= 2', async () => {
      mockFetchOk([
        {
          ...threadSummary,
          match: {
            messageId: 'msg-1',
            role: 'user',
            snippet: 'design system tokens',
            matchedAt: '2026-01-02T00:00:00.000Z',
          },
          titleOnly: false,
        },
      ]);
      const { wrapper } = createWrapper();

      renderHook(
        () => useChatThreadList(50, 'TestProject', { searchTerm: 'design' }),
        { wrapper },
      );

      // Initial mount uses empty debounced term → non-search fetch
      await act(async () => {
        jest.advanceTimersByTime(300);
      });

      await waitFor(() => {
        const urls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('q=design'))).toBe(true);
      });
    });

    it('DoD-1 / VT-03: terms under 2 chars fall back to normal list without q', async () => {
      mockFetchOk([threadSummary]);
      const { wrapper } = createWrapper();

      renderHook(
        () => useChatThreadList(50, 'TestProject', { searchTerm: 'd' }),
        { wrapper },
      );

      await act(async () => {
        jest.advanceTimersByTime(300);
      });

      await waitFor(() => expect(global.fetch).toHaveBeenCalled());
      const urls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(urls.every((u) => !u.includes('q='))).toBe(true);
    });

    it('DoD-2: returned search data carries match context for snippets', async () => {
      const searchHit = {
        ...threadSummary,
        match: {
          messageId: 'msg-1',
          role: 'user' as const,
          snippet: 'plain design excerpt around the hit',
          matchedAt: '2026-01-02T00:00:00.000Z',
        },
        titleOnly: false,
      };
      mockFetchOk([searchHit]);
      const { wrapper } = createWrapper();

      const { result } = renderHook(
        () => useChatThreadList(50, 'TestProject', { searchTerm: 'design' }),
        { wrapper },
      );

      await act(async () => {
        jest.advanceTimersByTime(300);
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const row = result.current.data![0] as typeof searchHit;
      expect(row.match?.snippet).toBe('plain design excerpt around the hit');
      expect(row.titleOnly).toBe(false);
    });

    it('VT-04 / AC-3: clearing the term collapses back to the non-search key (no q)', async () => {
      mockFetchOk([threadSummary]);
      const { wrapper } = createWrapper();

      const { rerender } = renderHook(
        ({ term }) => useChatThreadList(50, 'TestProject', { searchTerm: term }),
        { wrapper, initialProps: { term: 'design' } },
      );

      await act(async () => {
        jest.advanceTimersByTime(300);
      });
      await waitFor(() => {
        const urls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('q=design'))).toBe(true);
      });

      rerender({ term: '' });
      await act(async () => {
        jest.advanceTimersByTime(300);
      });

      await waitFor(() => {
        const calls = (global.fetch as jest.Mock).mock.calls;
        const lastUrl = String(calls[calls.length - 1][0]);
        expect(lastUrl).not.toContain('q=');
        expect(lastUrl).toContain('project=TestProject');
      });
    });

    it('BR-006: passes flaggedOnly when searching with the toggle active', async () => {
      mockFetchOk([]);
      const { wrapper } = createWrapper();

      renderHook(
        () =>
          useChatThreadList(50, 'TestProject', {
            searchTerm: 'notif',
            flaggedOnly: true,
          }),
        { wrapper },
      );

      await act(async () => {
        jest.advanceTimersByTime(300);
      });

      await waitFor(() => {
        const urls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
        expect(
          urls.some((u) => u.includes('q=notif') && u.includes('flaggedOnly=true')),
        ).toBe(true);
      });
    });

    it('NFR: search and non-search share the chat-thread-list query-key family', async () => {
      mockFetchOk([]);
      const { queryClient, wrapper } = createWrapper();

      const { rerender } = renderHook(
        ({ term }) => useChatThreadList(50, 'TestProject', { searchTerm: term }),
        { wrapper, initialProps: { term: '' } },
      );

      await waitFor(() => expect(global.fetch).toHaveBeenCalled());

      rerender({ term: 'design' });
      await act(async () => {
        jest.advanceTimersByTime(300);
      });
      await waitFor(() => {
        const urls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('q=design'))).toBe(true);
      });

      const cacheKeys = queryClient
        .getQueryCache()
        .getAll()
        .map((q) => q.queryKey);
      expect(cacheKeys.every((k) => k[0] === 'chat-thread-list')).toBe(true);
      expect(cacheKeys.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ── useChatThread ─────────────────────────────────────────────────────────────

describe('useChatThread', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does not fetch when threadId is null', () => {
    mockFetchOk({});
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useChatThread(null), { wrapper });

    // Query is disabled — status remains 'pending' but no fetch is triggered
    expect(result.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fetches the thread when a threadId is provided', async () => {
    mockFetchOk({ id: 'thread-1', messages: [] });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useChatThread('thread-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/chat/threads/thread-1',
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});

// ── useStartChat ──────────────────────────────────────────────────────────────

describe('useStartChat', () => {
  afterEach(() => jest.restoreAllMocks());

  it('POSTs to /api/chat/threads and returns the threadId', async () => {
    mockFetchOk({ threadId: 'new-thread-123' });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useStartChat(), { wrapper });

    let response: { threadId: string } | undefined;
    await act(async () => {
      response = await result.current.mutateAsync({
        kickoff: { project: 'TestProject', repo: 'TestRepo' },
      });
    });

    expect(response).toEqual({ threadId: 'new-thread-123' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/chat/threads',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('includes the full kickoff body in the request', async () => {
    mockFetchOk({ threadId: 'thread-xyz' });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useStartChat(), { wrapper });

    const kickoff = {
      project: 'MyProject',
      repo: 'MyRepo',
      branch: 'feature/auth',
      skillPath: '.cursor/skills/grill-with-docs/SKILL.md',
    };

    await act(async () => {
      await result.current.mutateAsync({ kickoff });
    });

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.kickoff).toEqual(kickoff);
  });
});

// ── useDeleteThread ───────────────────────────────────────────────────────────

describe('useDeleteThread', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends DELETE to the correct thread URL', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDeleteThread(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('thread-1');
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/chat/threads/thread-1',
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    );
  });

  it('removes the deleted thread from the chat-thread-list cache', async () => {
    mockFetchOk({ ok: true });
    const { queryClient, wrapper } = createWrapper();

    // Pre-populate the cache with two summaries
    queryClient.setQueryData<ChatThreadSummary[]>(
      ['chat-thread-list', 50],
      [threadSummary, threadSummary2],
    );

    const { result } = renderHook(() => useDeleteThread(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('thread-1');
    });

    const cached = queryClient.getQueryData<ChatThreadSummary[]>(['chat-thread-list', 50]);
    expect(cached).toHaveLength(1);
    expect(cached![0].id).toBe('thread-2');
  });

  it('removes the full-thread cache entry for the deleted thread', async () => {
    mockFetchOk({ ok: true });
    const { queryClient, wrapper } = createWrapper();

    // Pre-populate the full-thread cache
    queryClient.setQueryData(['chat-thread', 'thread-1'], { id: 'thread-1', messages: [] });

    const { result } = renderHook(() => useDeleteThread(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('thread-1');
    });

    const cached = queryClient.getQueryData(['chat-thread', 'thread-1']);
    expect(cached).toBeUndefined();
  });

  it('leaves other threads untouched in the list cache', async () => {
    mockFetchOk({ ok: true });
    const { queryClient, wrapper } = createWrapper();

    queryClient.setQueryData<ChatThreadSummary[]>(
      ['chat-thread-list', 50],
      [threadSummary, threadSummary2],
    );

    const { result } = renderHook(() => useDeleteThread(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('thread-1');
    });

    const cached = queryClient.getQueryData<ChatThreadSummary[]>(['chat-thread-list', 50]);
    expect(cached!.find((t) => t.id === 'thread-2')).toBeDefined();
  });

  it('handles an empty list cache gracefully (does not throw)', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDeleteThread(), { wrapper });

    // No cache pre-populated — should not throw
    await expect(
      act(async () => {
        await result.current.mutateAsync('thread-1');
      }),
    ).resolves.not.toThrow();
  });
});

// ── useFlagThread ────────────────────────────────────────────────────────────

describe('useFlagThread', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends PATCH to /api/chat/threads/:id/flag with { flagged: true }', async () => {
    mockFetchOk({ flagged: true, flaggedAt: '2026-05-14T12:00:00.000Z' });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useFlagThread(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ threadId: 'thread-1', flagged: true });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/chat/threads/thread-1/flag',
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ flagged: true });
  });

  it('sends PATCH with { flagged: false } to unflag', async () => {
    mockFetchOk({ flagged: false, flaggedAt: null });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useFlagThread(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ threadId: 'thread-1', flagged: false });
    });

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ flagged: false });
  });

  it('updates the flagged state in the chat-thread-list cache', async () => {
    mockFetchOk({ flagged: true, flaggedAt: '2026-05-14T12:00:00.000Z' });
    const { queryClient, wrapper } = createWrapper();

    queryClient.setQueryData<ChatThreadSummary[]>(
      ['chat-thread-list', 50],
      [threadSummary, threadSummary2],
    );

    const { result } = renderHook(() => useFlagThread(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ threadId: 'thread-1', flagged: true });
    });

    const cached = queryClient.getQueryData<ChatThreadSummary[]>(['chat-thread-list', 50]);
    expect(cached!.find((t) => t.id === 'thread-1')!.flagged).toBe(true);
    expect(cached!.find((t) => t.id === 'thread-1')!.flaggedAt).toBe('2026-05-14T12:00:00.000Z');
  });

  it('does not modify other threads in the list cache', async () => {
    mockFetchOk({ flagged: true, flaggedAt: '2026-05-14T12:00:00.000Z' });
    const { queryClient, wrapper } = createWrapper();

    queryClient.setQueryData<ChatThreadSummary[]>(
      ['chat-thread-list', 50],
      [threadSummary, threadSummary2],
    );

    const { result } = renderHook(() => useFlagThread(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ threadId: 'thread-1', flagged: true });
    });

    const cached = queryClient.getQueryData<ChatThreadSummary[]>(['chat-thread-list', 50]);
    expect(cached!.find((t) => t.id === 'thread-2')!.flagged).toBe(false);
  });

  it('sets flaggedAt to undefined when the API returns null', async () => {
    mockFetchOk({ flagged: false, flaggedAt: null });
    const { queryClient, wrapper } = createWrapper();

    const flaggedSummary: ChatThreadSummary = {
      ...threadSummary,
      flagged: true,
      flaggedAt: '2026-05-14T12:00:00.000Z',
    };
    queryClient.setQueryData<ChatThreadSummary[]>(
      ['chat-thread-list', 50],
      [flaggedSummary],
    );

    const { result } = renderHook(() => useFlagThread(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ threadId: 'thread-1', flagged: false });
    });

    const cached = queryClient.getQueryData<ChatThreadSummary[]>(['chat-thread-list', 50]);
    expect(cached![0].flagged).toBe(false);
    expect(cached![0].flaggedAt).toBeUndefined();
  });

  it('handles an empty list cache gracefully', async () => {
    mockFetchOk({ flagged: true, flaggedAt: '2026-05-14T12:00:00.000Z' });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useFlagThread(), { wrapper });

    await expect(
      act(async () => {
        await result.current.mutateAsync({ threadId: 'thread-1', flagged: true });
      }),
    ).resolves.not.toThrow();
  });

  it('surfaces an error when the API returns a non-ok response', async () => {
    mockFetchError(400, { error: 'flagged (boolean) is required' });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useFlagThread(), { wrapper });

    act(() => {
      result.current.mutate({ threadId: 'thread-1', flagged: true });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('flagged (boolean) is required');
  });
});
