import React, { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useHomeDashboard } from '../useHomeDashboard';

const payload = {
  incompletePipeline: null,
  artifactCycleTime: null,
  myWork: null,
      openBugsOnPbis: null,
      bugToPbiRatio: null,
      devToProduction: null,
};

const createWrapper = (client: QueryClient) => ({ children }: { children: ReactNode }) =>
  React.createElement(QueryClientProvider, { client }, children);

describe('useHomeDashboard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    }) as jest.Mock;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('DoD-0 fetches the project-scoped dashboard with credentials and a project-keyed cache', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useHomeDashboard('Apex & Co'), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/home-dashboard?project=Apex%20%26%20Co&scope=team',
      { credentials: 'include' },
    );
    expect(client.getQueryData(['home-dashboard', 'Apex & Co', 'team'])).toEqual(payload);
  });

  it('DoD-0 stays disabled without a project', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useHomeDashboard(null), {
      wrapper: createWrapper(client),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('DoD-4 retries failures and supports an explicit refresh', async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({
        ok: true,
        json: async () => payload,
      });
    const client = new QueryClient();
    const { result } = renderHook(() => useHomeDashboard('Apex'), {
      wrapper: createWrapper(client),
    });

    await act(async () => {
      await jest.runAllTimersAsync();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await result.current.refetch();
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
