import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRfpQueue, useRfpStatusTransition } from '../useRfpTriage';

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

describe('useRfpQueue / useRfpStatusTransition', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PBI-005 AC-0 loads the triage queue with status and verdict filters', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ items: [{ id: 'rfp-1', title: 'One' }], total: 1 }),
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => useRfpQueue({ status: 'evaluated', verdict: 'build', q: 'intake', page: 0, enabled: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/rfp-intake/triage/requests?limit=50&offset=0&status=evaluated&verdict=build&q=intake',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('PBI-005 AC-1 surfaces the error and keeps the mutation unsuccessful', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: 'Invalid status transition' }),
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRfpStatusTransition(), { wrapper });

    await act(async () => {
      result.current.mutate({ id: 'rfp-1', target: 'accepted' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/invalid status transition/i);
  });
});
