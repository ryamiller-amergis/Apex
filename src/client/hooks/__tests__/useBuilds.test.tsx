import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BuildApiError,
  useActiveBuildCount,
  useBuilds,
  useStartBuild,
  useStartLocalBuildPreview,
} from '../useBuilds';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as jest.Mock;
}

const emptyList = { builds: [], total: 0, limit: 50, offset: 0 };

describe('useBuilds', () => {
  beforeEach(() => jest.clearAllMocks());

  it('VT-15 asks for one project page with scope, state, and paging', async () => {
    mockFetch(200, emptyList);
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => useBuilds('Apex', { state: 'active', limit: 50, offset: 50 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/builds?project=Apex&scope=project&state=active&limit=50&offset=50',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('VT-24 counts only my active builds for the pill', async () => {
    mockFetch(200, { ...emptyList, total: 2, limit: 1 });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useActiveBuildCount('Apex', true), { wrapper });
    await waitFor(() => expect(result.current.data?.total).toBe(2));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/builds?project=Apex&scope=mine&state=active&limit=1',
      expect.anything(),
    );
  });

  it('VT-22 does not ask for the count while the pill is hidden', () => {
    mockFetch(200, emptyList);
    const { wrapper } = createWrapper();
    renderHook(() => useActiveBuildCount('Apex', false), { wrapper });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('VT-04 turns a 409 into an error with each refusal sentence', async () => {
    mockFetch(409, {
      error: 'Two items need attention.',
      code: 'BUILD_PREFLIGHT_REFUSED',
      refusals: ['The code map is missing. A Platform Admin can fix this.', 'The pipeline is missing. A project admin can fix this.'],
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useStartBuild('Apex'), { wrapper });
    let caught: unknown;
    await act(async () => {
      caught = await result.current
        .mutateAsync({ repository: 'apex', prompt: 'x', clientRequestId: 'r1' })
        .catch((error: unknown) => error);
    });
    expect(caught).toBeInstanceOf(BuildApiError);
    expect(caught).toMatchObject({ status: 409, code: 'BUILD_PREFLIGHT_REFUSED' });
    expect((caught as BuildApiError).refusals).toHaveLength(2);
  });

  it('refreshes the list and the pill count after a start', async () => {
    mockFetch(202, { buildRunId: 'b', playbookRunId: 'r', status: 'intake', queuePosition: null, queueReason: null, replayed: false });
    const { wrapper, queryClient } = createWrapper();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useStartBuild('Apex'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ repository: 'apex', prompt: 'x', clientRequestId: 'r1' });
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/builds?project=Apex',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['builds', 'Apex'] });
  });

  it('starts a local preview and refreshes the selected build', async () => {
    mockFetch(202, { status: 'started', revisionNumber: 2 });
    const { wrapper, queryClient } = createWrapper();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(
      () => useStartLocalBuildPreview('Apex', 'build-1'),
      { wrapper }
    );

    await act(async () => {
      await result.current.mutateAsync({});
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/builds/build-1/local-preview?project=Apex',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ project: 'Apex' }),
      })
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['build', 'Apex', 'build-1'],
    });
  });
});
