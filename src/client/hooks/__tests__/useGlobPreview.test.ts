import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGlobPreview } from '../useGlobPreview';

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

describe('useGlobPreview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('POSTs globs to preview-globs and returns matches', async () => {
    const payload = {
      matches: [{ pattern: 'src/**/*.ts', files: ['src/a.ts'] }],
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useGlobPreview(), { wrapper });

    await act(async () => {
      result.current.mutate({ sourceGlobs: ['src/**/*.ts'] });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(payload);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/design-modules/preview-globs',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      })
    );
  });

  it('surfaces API errors', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Invalid globs' }),
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useGlobPreview(), { wrapper });

    await act(async () => {
      result.current.mutate({ sourceGlobs: [] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Invalid globs');
  });
});
