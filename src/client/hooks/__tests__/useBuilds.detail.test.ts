/**
 * TBI-015 DoD-0..DoD-3 / VT-15..VT-18.
 */
import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BUILD_RUN_STATUSES, type BuildRunStatus } from '../../../shared/types/build';
import {
  BuildApiError,
  isBuildLive,
  useBuild,
  useBuildEvents,
  useBuildIntake,
  useCancelBuild,
} from '../useBuilds';

const BUILD_ID = 'b1';

const clients: QueryClient[] = [];

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  clients.push(queryClient);
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function detail(status: BuildRunStatus) {
  return { build: { id: BUILD_ID, project: 'Apex', status, intakeInterviewId: 'iv-1' } };
}

let fetchMock: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

describe('isBuildLive', () => {
  it('TBI-015 DoD-1 treats queued through deploying and suspended as live and everything else as settled', () => {
    const live = BUILD_RUN_STATUSES.filter((status) => isBuildLive(status));
    expect(live).toEqual(['queued', 'intake', 'planning', 'building', 'checking', 'deploying', 'suspended']);
    expect(isBuildLive(undefined)).toBe(false);
  });
});

describe('useBuild', () => {
  it('VT-15 TBI-015 DoD-1 polls every 5 seconds while building and stops after preview_ready', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, detail('building')))
      .mockResolvedValueOnce(response(200, detail('building')))
      .mockResolvedValue(response(200, detail('preview_ready')));
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBuild('Apex', BUILD_ID), { wrapper });
    await waitFor(() => expect(result.current.data?.build.status).toBe('building'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/builds/b1?project=Apex',
      expect.objectContaining({ credentials: 'include' }),
    );
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(result.current.data?.build.status).toBe('preview_ready'));
    await advance(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('VT-15 never polls a cancelled build', async () => {
    fetchMock.mockResolvedValue(response(200, detail('cancelled')));
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBuild('Apex', BUILD_ID), { wrapper });
    await waitFor(() => expect(result.current.data?.build.status).toBe('cancelled'));
    await advance(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404])('VT-16 does not retry a %d', async (status) => {
    fetchMock.mockResolvedValue(response(status, { error: 'Forbidden' }));
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBuild('Apex', BUILD_ID), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((result.current.error as BuildApiError).status).toBe(status);
  });
});

describe('useBuildEvents', () => {
  it('VT-18 TBI-015 DoD-0 sends no request while disabled, then polls only while live', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(
      url.includes('/events')
        ? response(200, { events: [], total: 0 })
        : response(200, detail('building')),
    ));
    const { wrapper, queryClient } = createWrapper();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useBuildEvents('Apex', BUILD_ID, { enabled }),
      { wrapper, initialProps: { enabled: false } },
    );
    await advance(6_000);
    expect(fetchMock).not.toHaveBeenCalled();

    queryClient.setQueryData(['build', 'Apex', BUILD_ID], detail('building'));
    rerender({ enabled: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/builds/b1/events?project=Apex',
      expect.objectContaining({ credentials: 'include' }),
    );
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    queryClient.setQueryData(['build', 'Apex', BUILD_ID], detail('accepted'));
    await advance(5_000);
    const afterSettled = fetchMock.mock.calls.length;
    await advance(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(afterSettled);
  });
});

describe('useCancelBuild', () => {
  it('VT-17 TBI-015 DoD-2 invalidates detail and list keys on success and on 403', async () => {
    jest.useRealTimers();
    fetchMock
      .mockResolvedValueOnce(response(202, {}))
      .mockResolvedValueOnce(response(403, { error: 'Forbidden' }));
    const { wrapper, queryClient } = createWrapper();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useCancelBuild('Apex', BUILD_ID), { wrapper });

    await act(async () => { await result.current.mutateAsync({ reason: 'No longer needed' }); });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/builds/b1/cancel?project=Apex',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ reason: 'No longer needed', project: 'Apex' }) }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['build', 'Apex', BUILD_ID] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['builds', 'Apex'] });

    invalidate.mockClear();
    await act(async () => {
      await result.current.mutateAsync({ reason: 'again' }).catch(() => undefined);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['build', 'Apex', BUILD_ID] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['builds', 'Apex'] });
  });
});

describe('useBuildIntake', () => {
  it('reads the intake interview id from the detail route with the project', async () => {
    fetchMock.mockResolvedValue(response(200, detail('intake')));
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBuildIntake('Apex', BUILD_ID), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ interviewId: 'iv-1' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/builds/b1?project=Apex', expect.anything());
  });

  it('polls a live build until the interview id appears', async () => {
    const waiting = { build: { ...detail('intake').build, intakeInterviewId: null } };
    fetchMock.mockResolvedValueOnce(response(200, waiting)).mockResolvedValue(response(200, detail('intake')));
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBuildIntake('Apex', BUILD_ID), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ interviewId: null }));
    await advance(5_000);
    await waitFor(() => expect(result.current.data).toEqual({ interviewId: 'iv-1' }));
    await advance(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404])('stops polling after a %d', async (status) => {
    fetchMock.mockResolvedValue(response(status, { error: 'Denied' }));
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBuildIntake('Apex', BUILD_ID), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    await advance(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
