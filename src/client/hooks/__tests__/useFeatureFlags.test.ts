import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFeatureFlag, useFeatureFlags } from '../useFeatureFlags';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper };
}

function mockFetchOk(data: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(data),
  }) as jest.Mock;
}

describe('useFeatureFlags', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches evaluated flags for the current project', async () => {
    mockFetchOk({
      flags: {
        'example-flag-demo': true,
        'new-dashboard': false,
      },
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useFeatureFlags('MaxView'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.flags).toEqual({
      'example-flag-demo': true,
      'new-dashboard': false,
    });
    expect(global.fetch).toHaveBeenCalledWith('/api/feature-flags/evaluate?project=MaxView', {
      credentials: 'include',
    });
  });

  it('does not fetch when project is undefined', async () => {
    global.fetch = jest.fn() as jest.Mock;
    const { wrapper } = createWrapper();

    renderHook(() => useFeatureFlags(undefined), { wrapper });

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('useFeatureFlag', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns whether a single flag is enabled', async () => {
    mockFetchOk({
      flags: {
        'example-flag-demo': true,
      },
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useFeatureFlag('example-flag-demo', 'MaxView'), { wrapper });

    await waitFor(() => expect(result.current).toBe(true));
  });

  it('defaults to false when the flag is missing from the response', async () => {
    mockFetchOk({ flags: {} });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useFeatureFlag('missing-flag', 'MaxView'), { wrapper });

    await waitFor(() => expect(result.current).toBe(false));
  });
});
