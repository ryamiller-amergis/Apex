/**
 * S5 / VT-01 / VT-10 — same-origin fetch/XHR instrumentation.
 */
import {
  installRequestInstrumentation,
  resetRequestInstrumentationForTests,
  shouldInstrumentUrl,
} from '../requestInstrumentation';
import { parseTraceparent } from '../../../shared/utils/w3cTrace';

describe('request instrumentation (S5)', () => {
  const originalFetch = window.fetch;
  let restore: () => void;

  afterEach(() => {
    restore?.();
    resetRequestInstrumentationForTests();
    window.fetch = originalFetch;
  });

  it('VT-10 skips ingest, static, and external URLs', () => {
    const origin = 'https://apex.example';
    expect(shouldInstrumentUrl('/api/projects', origin)).toBe(true);
    expect(shouldInstrumentUrl('/api/observability/events', origin)).toBe(false);
    expect(shouldInstrumentUrl('/static/app.js', origin)).toBe(false);
    expect(shouldInstrumentUrl('https://example.com/api/projects', origin)).toBe(false);
  });

  it('VT-01 / AC-0 adds a fresh span under the active trace and preserves fetch behavior', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    window.fetch = fetchFn as unknown as typeof fetch;
    restore = installRequestInstrumentation({
      getTraceId: () => '4bf92f3577b34da6a3ce929d0e0e4736',
      origin: 'https://apex.example',
    });

    const response = await window.fetch('/api/projects', { method: 'GET', credentials: 'include' });
    expect(response.status).toBe(200);
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    const parsed = parseTraceparent(headers.get('traceparent'));
    expect(parsed?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(parsed?.spanId).toHaveLength(16);
    expect(parsed?.spanId).not.toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('VT-10 preserves an existing valid traceparent and skips ingest', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 201 });
    window.fetch = fetchFn as unknown as typeof fetch;
    restore = installRequestInstrumentation({
      getTraceId: () => '4bf92f3577b34da6a3ce929d0e0e4736',
      origin: 'https://apex.example',
    });
    await window.fetch('/api/observability/events', { method: 'POST', body: '{}' });
    const ingestInit = fetchFn.mock.calls[0][1] as RequestInit | undefined;
    const ingestHeaders = new Headers(ingestInit?.headers);
    expect(ingestHeaders.get('traceparent')).toBeNull();

    fetchFn.mockClear();
    const existing = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
    await window.fetch('/api/projects', { headers: { traceparent: existing } });
    const headers = new Headers((fetchFn.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('traceparent')).toBe(existing);
  });
});
