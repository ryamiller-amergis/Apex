import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CaptureHealthResponse, TraceEventPage } from '../../../shared/types/observability';
import {
  ObservabilityApiError,
  buildHealthQueryUrl,
  buildTrailQueryUrl,
  useObservabilityHealth,
  useObservabilityTrail,
} from '../useObservabilityQueries';
import type { AppliedWorkspaceFilters } from '../../observability/workspaceFilters';

const FILTERS: AppliedWorkspaceFilters = {
  actorId: '11111111-1111-4111-8111-111111111111',
  from: '2026-08-17T17:00:00.000Z',
  to: '2026-08-17T18:00:00.000Z',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  eventType: 'api_request',
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper };
}

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as jest.Mock;
}

describe('observability query URLs', () => {
  it('PBI-004 AC-0 / TC-PBI-004-009 includes actor, range, trace, event type, and optional route template', () => {
    const url = buildTrailQueryUrl('Apex', { ...FILTERS, routeTemplate: '/home' }, 'cursor-1');
    expect(url).toContain('/api/platform-admin/observability/trail?');
    expect(url).toContain('project=Apex');
    expect(url).toContain('actorId=11111111-1111-4111-8111-111111111111');
    expect(url).toContain('traceId=4bf92f3577b34da6a3ce929d0e0e4736');
    expect(url).toContain('eventType=api_request');
    expect(url).toContain('routeTemplate=%2Fhome');
    expect(url).toContain('cursor=cursor-1');
  });
});

describe('useObservabilityTrail', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PBI-004 AC-0 fetches a safe trail page when filters are applied', async () => {
    const page: TraceEventPage = {
      items: [
        {
          id: 'evt-1',
          eventType: 'api_request',
          occurredAt: '2026-08-17T17:30:00.000Z',
          actorId: FILTERS.actorId,
          projectId: 'Apex',
          traceId: FILTERS.traceId!,
          sessionId: '22222222-2222-4222-8222-222222222222',
          routeTemplate: '/api/timecards',
          method: 'POST',
          statusCode: 201,
          durationMs: 142,
          severity: 'info',
          trigger: 'human',
          diagnosticSummary: null,
        },
      ],
      nextCursor: null,
      capReached: false,
    };
    mockFetch(200, page);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useObservabilityTrail('Apex', FILTERS, null), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items).toHaveLength(1);
    expect(JSON.stringify(result.current.data)).not.toMatch(/authorization|cookie|email/i);
  });

  it('PBI-004 AC-1 surfaces a recoverable query failure without treating it as success', async () => {
    mockFetch(503, { error: 'Internal server error' });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useObservabilityTrail('Apex', FILTERS, null), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeInstanceOf(ObservabilityApiError);
    expect(result.current.error?.status).toBe(503);
  });

  it('PBI-003 AC-3 / PBI-004 AC-3 / TC-PBI-004-012 does not fetch when filters are absent', () => {
    mockFetch(200, { items: [], nextCursor: null, capReached: false });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useObservabilityTrail('Apex', null, null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('useObservabilityHealth', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PBI-005 AC-0 fetches the Capture Health snapshot', async () => {
    const health: CaptureHealthResponse = {
      capturedAt: '2026-08-17T18:00:00.000Z',
      instanceId: 'instance-1',
      captureEnabled: true,
      pipeline: {
        scope: 'instance',
        droppedEvents: 142,
        droppedEventsPerSecond: 0.3,
        bufferDepth: 8700,
        bufferCapacity: 10_000,
        flushErrorCount: 3,
        latestFlushError: null,
        ingestedEventsPerSecond: 80.2,
      },
      store: {
        scope: 'database',
        approximateStoreBytes: 1_024,
        oldestRetainedEventAt: '2026-08-01T00:00:00.000Z',
      },
    };
    mockFetch(200, health);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useObservabilityHealth('Apex', true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pipeline.droppedEvents).toBe(142);
    expect(JSON.stringify(result.current.data)).not.toMatch(/"details"|stack|authorization/i);
  });

  it('PBI-005 AC-1 treats a health endpoint failure as an error', async () => {
    mockFetch(502, { error: 'Internal server error' });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useObservabilityHealth('Apex', true), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.status).toBe(502);
  });

  it('PBI-005 AC-3 does not request health when the panel is not active', () => {
    mockFetch(200, {});
    const { wrapper } = createWrapper();
    renderHook(() => useObservabilityHealth('Apex', false), { wrapper });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(buildHealthQueryUrl('Apex')).toBe('/api/platform-admin/observability/health?project=Apex');
  });
});
