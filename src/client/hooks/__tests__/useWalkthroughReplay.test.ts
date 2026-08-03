/**
 * FEAT-006 — useWalkthroughReplay hooks (PBI-007 / PBI-008)
 */
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useUpdateWalkthroughProgress,
  useWalkthroughDefinition,
  useWalkthroughReplayList,
} from '../useWalkthroughReplay';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

describe('useWalkthroughReplay (FEAT-006)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('PBI-008 AC-0 — loads replay list for project', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            walkthrough: { id: 'wt-1', userTitle: 'New Guide', revision: 1 },
            progress: null,
            state: 'new',
          },
          {
            walkthrough: { id: 'wt-2', userTitle: 'Done Guide', revision: 1 },
            progress: { status: 'completed', acknowledged: true },
            state: 'acknowledged',
          },
        ],
        nextCursor: null,
      }),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useWalkthroughReplayList('Apex'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items).toHaveLength(2);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/Apex/walkthroughs/replay',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('PBI-008 AC-1 — surfaces typed error when list fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useWalkthroughReplayList('Apex'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('boom');
  });

  it('PBI-008 AC-3 — definition refetch returns 404 for inaccessible Walkthrough', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Walkthrough not found', code: 'WALKTHROUGH_NOT_FOUND' }),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useWalkthroughDefinition('Apex', 'wt-gone'), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.status).toBe(404);
  });

  it('PBI-007 AC-0 — progress mutation PUTs caller-bound body without userId', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        walkthroughId: 'wt-1',
        userId: 'user-1',
        revision: 1,
        status: 'completed',
        acknowledged: true,
        lastStepId: 's1',
        seenAt: '2026-07-01T00:00:00Z',
        acknowledgedAt: '2026-07-01T00:00:00Z',
        updatedAt: '2026-07-01T00:00:00Z',
      }),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useUpdateWalkthroughProgress('Apex'), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        walkthroughId: 'wt-1',
        body: { status: 'completed', revision: 1, lastStepId: 's1' },
      });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/Apex/walkthroughs/wt-1/progress',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ status: 'completed', revision: 1, lastStepId: 's1' }),
      }),
    );
  });

  it('PBI-007 AC-1 — progress mutation failure does not claim success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'db down' }),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useUpdateWalkthroughProgress('Apex'), { wrapper });

    await expect(
      act(async () => {
        await result.current.mutateAsync({
          walkthroughId: 'wt-1',
          body: { status: 'dismissed', revision: 1, lastStepId: 's1' },
        });
      }),
    ).rejects.toThrow('db down');
  });
});
