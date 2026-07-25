/**
 * FEAT-009 / TBI-009 DoD-0 + PBI-011 AC-0/AC-1 — useLoadTestRunStream
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLoadTestRunStream } from '../useLoadTestRunStream';

type Handler = ((ev: MessageEvent) => void) | null;
type ErrHandler = ((ev: Event) => void) | null;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials: boolean;
  onmessage: Handler = null;
  onerror: ErrHandler = null;
  readyState = 0;
  closed = false;

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = Boolean(init?.withCredentials);
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  emitError() {
    this.onerror?.(new Event('error'));
  }
}

const PROJECT = 'project-a';
const RUN_ID = 'run-42';

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  MockEventSource.instances = [];
  Object.defineProperty(globalThis, 'EventSource', {
    writable: true,
    configurable: true,
    value: MockEventSource,
  });
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useLoadTestRunStream', () => {
  it('DoD-0 / AC-0: applies status and terminal threshold results from SSE', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLoadTestRunStream(PROJECT, RUN_ID), {
      wrapper: wrapper(client),
    });

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es.emit({
        type: 'status',
        runId: RUN_ID,
        projectId: PROJECT,
        status: 'running',
        at: '2026-07-25T00:00:01.000Z',
      });
    });
    expect(result.current.status).toBe('running');

    act(() => {
      es.emit({
        type: 'terminal',
        runId: RUN_ID,
        projectId: PROJECT,
        status: 'passed',
        overallResult: 'passed',
        thresholdResults: [
          { metric: 'http_req_duration', expression: 'p(95)<500', passed: true, observed: '400' },
        ],
        at: '2026-07-25T00:01:00.000Z',
      });
    });

    expect(result.current.status).toBe('passed');
    expect(result.current.overallResult).toBe('passed');
    expect(result.current.thresholdResults?.[0]?.passed).toBe(true);
    expect(es.closed).toBe(true);
  });

  it('AC-1: on SSE error sets reconnecting and schedules reconnect without clearing run context', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useLoadTestRunStream(PROJECT, RUN_ID, { initialStatus: 'running' }),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBe(1);
    });

    act(() => {
      MockEventSource.instances[0].emitError();
    });

    expect(result.current.reconnecting).toBe(true);
    expect(result.current.status).toBe('running');
    expect(result.current.error).toMatch(/reconnect/i);

    act(() => {
      jest.advanceTimersByTime(600);
    });

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBe(2);
    });
    expect(MockEventSource.instances[1].url).toContain(`/runs/${RUN_ID}/stream`);
  });
});
