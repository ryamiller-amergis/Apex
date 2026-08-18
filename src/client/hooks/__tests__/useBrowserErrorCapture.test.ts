/**
 * S5 / VT-11 — browser error adapters.
 */
import { renderHook, act } from '@testing-library/react';
import { useBrowserErrorCapture } from '../useBrowserErrorCapture';
import { reportCaughtClientError } from '../../observability/clientErrorReporter';
import type { BrowserTraceEventCandidate } from '../../../shared/types/observability';

describe('useBrowserErrorCapture (VT-11)', () => {
  it('projects Error Boundary, window.error, and unhandledrejection into safe events', () => {
    const enqueue = jest.fn();
    renderHook(() =>
      useBrowserErrorCapture(true, {
        enqueue,
        getTraceId: () => '4bf92f3577b34da6a3ce929d0e0e4736',
        getRouteTemplate: () => '/home',
      }),
    );

    act(() => {
      reportCaughtClientError(new Error('boundary failed'), 'boundary');
      window.dispatchEvent(new ErrorEvent('error', { message: 'window failed', error: new Error('window failed') }));
      window.dispatchEvent(new Event('unhandledrejection'));
    });

    const types = enqueue.mock.calls.map((call) => (call[0] as BrowserTraceEventCandidate).type);
    expect(types).toEqual(expect.arrayContaining(['client_error', 'unhandled_rejection']));
    for (const [event] of enqueue.mock.calls as [BrowserTraceEventCandidate][]) {
      expect(JSON.stringify(event)).not.toMatch(/password|Authorization/);
      if (event.type !== 'route_view') {
        expect(event.details.message).toBeTruthy();
      }
    }
  });

  it('allocates a fresh W3C trace ID when no active request trace exists', () => {
    const enqueue = jest.fn();
    renderHook(() =>
      useBrowserErrorCapture(true, {
        enqueue,
        getTraceId: () => null,
        getRouteTemplate: () => '/home',
      }),
    );

    act(() => {
      reportCaughtClientError(new Error('orphan error'), 'boundary');
      reportCaughtClientError(new Error('second orphan'), 'boundary');
    });

    const ids = (enqueue.mock.calls as [BrowserTraceEventCandidate][]).map(([event]) => event.traceId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(ids[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(ids[0]).not.toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(ids[0]).not.toBe(ids[1]);
  });
});
