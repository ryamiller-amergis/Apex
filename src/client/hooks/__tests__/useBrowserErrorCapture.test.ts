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
});
