import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useApplyProposedPrd, useRejectProposedPrd } from '../useInterviews';

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

function mockFetchOk(data: unknown, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status,
    json: () => Promise.resolve(data),
  }) as jest.Mock;
}

// ── useApplyProposedPrd ────────────────────────────────────────────────────────

describe('useApplyProposedPrd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/interviews/prds/:prdId/apply-proposed when mutate is called', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useApplyProposedPrd('prd-42'), { wrapper });

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-42/apply-proposed',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('invalidates [prd, prdId] query on success', async () => {
    mockFetchOk({ ok: true });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useApplyProposedPrd('prd-42'), { wrapper });

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['prd', 'prd-42'] }),
    );
  });
});

// ── useRejectProposedPrd ───────────────────────────────────────────────────────

describe('useRejectProposedPrd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/interviews/prds/:prdId/reject-proposed when mutate is called', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useRejectProposedPrd('prd-99'), { wrapper });

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-99/reject-proposed',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('invalidates [prd, prdId] query on success', async () => {
    mockFetchOk({ ok: true });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useRejectProposedPrd('prd-99'), { wrapper });

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['prd', 'prd-99'] }),
    );
  });
});
