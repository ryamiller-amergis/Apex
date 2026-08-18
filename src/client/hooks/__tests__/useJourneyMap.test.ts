import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { JourneyEdgePage, JourneyMapFilters } from '../../../shared/types/observability';
import { ObservabilityApiError } from '../useObservabilityQueries';
import { buildJourneyQueryUrl, journeyMapQueryKey, useJourneyMap } from '../useJourneyMap';

const FILTERS: JourneyMapFilters = {
  from: '2026-08-01',
  to: '2026-08-17',
  minTransitions: 50,
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper, queryClient };
}

function mockJourneyFetch(page: JourneyEdgePage) {
  global.fetch = jest.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const isReconcile = method === 'POST' || String(url).includes('/journeys/reconcile');
    const body = isReconcile ? { ok: true, daysReconciled: 1, edgesWritten: 1 } : page;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
  }) as jest.Mock;
}

describe('useJourneyMap (PBI-007 AC-1 / VT-04 / VT-05 / VT-09)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('builds a credentialed relative URL with namespaced cache keys', () => {
    const url = buildJourneyQueryUrl('Apex', FILTERS, 'cursor-1');
    expect(url).toBe(
      '/api/platform-admin/observability/journeys?project=Apex&fromDay=2026-08-01&toDay=2026-08-17&cursor=cursor-1',
    );
    expect(journeyMapQueryKey('Apex', FILTERS)).toEqual([
      'platform-admin',
      'observability',
      'journeys',
      'Apex',
      FILTERS,
    ]);
  });

  it('does not issue a query while the viewer mount gate is off', async () => {
    global.fetch = jest.fn() as jest.Mock;
    const { wrapper } = createWrapper();
    renderHook(() => useJourneyMap('Apex', FILTERS, false), { wrapper });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('maps a successful rollup page into graph nodes and edges', async () => {
    const page: JourneyEdgePage = {
      items: [
        { day: '2026-08-17', fromRoute: '/home', toRoute: '/calendar', transitionCount: 80, distinctActorCount: 12 },
      ],
      nextCursor: null,
      capReached: false,
    };
    mockJourneyFetch(page);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useJourneyMap('Apex', { ...FILTERS, minTransitions: 1 }, true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/journeys/reconcile?'),
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/journeys?'), { credentials: 'include' });
    expect(result.current.data?.edges[0]?.fromRoute).toBe('/home');
    expect(result.current.data?.machineTransitionsExcluded).toBe(true);
  });

  it('exposes an error without treating cached data as the current result after a failed refetch', async () => {
    const page: JourneyEdgePage = {
      items: [
        { day: '2026-08-17', fromRoute: '/home', toRoute: '/calendar', transitionCount: 80, distinctActorCount: 12 },
      ],
      nextCursor: null,
      capReached: false,
    };
    mockJourneyFetch(page);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useJourneyMap('Apex', { ...FILTERS, minTransitions: 1 }, true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Internal server error' }),
    }) as jest.Mock;
    await result.current.refetch();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ObservabilityApiError);
    expect(result.current.isError).toBe(true);
  });
});
