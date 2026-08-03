import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useDeleteAdr } from '../useAdrs';

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

function mockFetchNoContent() {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 204,
    json: () => Promise.resolve(undefined),
  }) as jest.Mock;
}

describe('useDeleteAdr', () => {
  beforeEach(() => jest.clearAllMocks());

  it('DELETEs /api/adr/:id', async () => {
    mockFetchNoContent();
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDeleteAdr(), { wrapper });

    await act(async () => {
      result.current.mutate('adr-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/adr/adr-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('removes the ADR detail query and invalidates the list on success', async () => {
    mockFetchNoContent();
    const { queryClient, wrapper } = createWrapper();
    const removeQueries = jest.spyOn(queryClient, 'removeQueries');
    const invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteAdr(), { wrapper });

    await act(async () => {
      result.current.mutate('adr-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(removeQueries).toHaveBeenCalledWith({ queryKey: ['adr', 'adr-1'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['adrs'] });
  });
});
