import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionTimelineResponse } from '../../../shared/types/observability';
import { ObservabilityApiError } from '../useObservabilityQueries';
import { buildSessionTimelineUrl, useSessionTimeline } from '../useSessionTimeline';

const SESSION = '22222222-2222-4222-8222-222222222222';

const page: SessionTimelineResponse = {
  session: { sessionId: SESSION, runIds: ['run-1'] },
  verdict: {
    health: 'healthy',
    label: 'Healthy',
    detail: 'The latest run is progressing within established limits.',
    hangPointEventId: null,
    assessedAt: '2026-08-17T18:00:00.000Z',
  },
  sourceStatus: {
    agent: { state: 'complete' },
    trace: { state: 'empty' },
  },
  entries: [],
  page: { nextCursor: 'cursor-2', returned: 0, loaded: 50, cap: 500, capReached: false },
  partial: false,
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper, queryClient };
}

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as jest.Mock;
}

describe('useSessionTimeline', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PBI-006 AC-0 / VT-16 builds an isolated timeline URL with opaque cursor', () => {
    const url = buildSessionTimelineUrl('Apex', SESSION, 'cursor-1');
    expect(url).toContain(`/api/platform-admin/observability/sessions/${SESSION}/timeline?`);
    expect(url).toContain('project=Apex');
    expect(url).toContain('cursor=cursor-1');
  });

  it('PBI-006 AC-0 fetches the first timeline page when a session is selected', async () => {
    mockFetch(200, page);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSessionTimeline('Apex', SESSION), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pages[0].session.sessionId).toBe(SESSION);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('PBI-006 AC-3 / VT-18 does not fetch when no session is selected', () => {
    mockFetch(200, page);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSessionTimeline('Apex', null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('PBI-006 AC-3 maps unknown-session 404 without treating it as success', async () => {
    mockFetch(404, { error: 'Not found', code: 'OBSERVABILITY_NOT_FOUND' });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSessionTimeline('Apex', SESSION), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ObservabilityApiError);
    expect(result.current.error?.status).toBe(404);
    expect(result.current.data).toBeUndefined();
  });
});
