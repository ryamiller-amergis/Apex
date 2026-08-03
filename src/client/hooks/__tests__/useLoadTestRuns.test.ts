/**
 * useEnqueueRun — POST /load-tests/:id/runs
 */
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { loadTestsQueryKey } from '../useLoadTests';
import {
  LoadTestRunApiError,
  loadTestRunQueryKey,
  useEnqueueRun,
} from '../useLoadTestRuns';

const PROJECT = 'project-a';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

describe('useEnqueueRun', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs to definition runs and caches the run', async () => {
    const run = {
      id: 'run-1',
      projectId: PROJECT,
      loadTestId: 'def-1',
      status: 'dispatched',
      runSource: 'app',
      queuedAt: '2026-07-25T00:00:00.000Z',
      cancelRequested: false,
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ run }),
    }) as unknown as typeof fetch;

    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useEnqueueRun(PROJECT), { wrapper });

    let created: typeof run | undefined;
    await act(async () => {
      created = await result.current.mutateAsync({ definitionId: 'def-1' });
    });

    expect(created?.id).toBe('run-1');
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/projects/${PROJECT}/load-tests/def-1/runs`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ runSource: 'app' }),
      }),
    );
    expect(queryClient.getQueryData(loadTestRunQueryKey(PROJECT, 'run-1'))).toEqual(run);
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: loadTestsQueryKey(PROJECT) });
    });
  });

  it('throws LoadTestRunApiError on failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Busy', code: 'TARGET_BUSY' }),
    }) as unknown as typeof fetch;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useEnqueueRun(PROJECT), { wrapper });

    await expect(
      act(async () => {
        await result.current.mutateAsync({ definitionId: 'def-1' });
      }),
    ).rejects.toBeInstanceOf(LoadTestRunApiError);
  });
});
