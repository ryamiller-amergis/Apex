/**
 * S4 / VT-03 / VT-04 / VT-05 — browser queue and transport.
 */
import { BrowserEventQueue } from '../browserQueue';
import { sendBrowserBatch } from '../browserTransport';
import { OBSERVABILITY_INGEST_PATH, type BrowserTraceEventCandidate } from '../../../shared/types/observability';

function event(span = '00f067aa0ba902b7'): BrowserTraceEventCandidate {
  return {
    type: 'route_view',
    occurredAt: '2026-08-17T17:00:00.000Z',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: span,
    routeTemplate: '/home',
  };
}

describe('BrowserEventQueue (S4)', () => {
  it('VT-05 flushes at 10 events and stays bounded at 100', () => {
    const queue = new BrowserEventQueue({ capacity: 100, batchSize: 10 });
    for (let i = 0; i < 10; i += 1) {
      expect(queue.enqueue(event(i.toString(16).padStart(16, '1')))).toBe(true);
    }
    expect(queue.shouldFlush()).toBe(true);
    expect(queue.drain()).toHaveLength(10);
    expect(queue.size).toBe(0);

    const bounded = new BrowserEventQueue({ capacity: 2, batchSize: 10 });
    expect(bounded.enqueue(event('aaaaaaaaaaaaaaaa'))).toBe(true);
    expect(bounded.enqueue(event('bbbbbbbbbbbbbbbb'))).toBe(true);
    expect(bounded.enqueue(event('cccccccccccccccc'))).toBe(false);
    expect(bounded.size).toBe(2);
  });

  it('retains route views even when sampling is 0', () => {
    const queue = new BrowserEventQueue({ samplingRate: 0 });
    expect(queue.enqueue(event())).toBe(true);
  });
});

describe('browser transport (S4 / VT-03 / VT-04)', () => {
  it('VT-03 swallows fetch rejection during interval flush', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error('offline'));
    await expect(
      sendBrowserBatch({ project: 'Apex', events: [event()] }, 'interval', { fetchFn }),
    ).resolves.toBe(false);
  });

  it('VT-04 prefers sendBeacon on pagehide and does not throw', async () => {
    const sendBeacon = jest.fn().mockReturnValue(true);
    const fetchFn = jest.fn();
    const ok = await sendBrowserBatch({ project: 'Apex', events: [event()] }, 'pagehide', {
      sendBeacon,
      fetchFn,
    });
    expect(ok).toBe(true);
    expect(sendBeacon).toHaveBeenCalledWith(OBSERVABILITY_INGEST_PATH, expect.any(Blob));
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
