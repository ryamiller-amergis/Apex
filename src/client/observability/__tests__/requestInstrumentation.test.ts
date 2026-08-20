/**
 * S5 / VT-01 / VT-10 — same-origin fetch/XHR instrumentation.
 */
import {
  installRequestInstrumentation,
  resetRequestInstrumentationForTests,
  shouldInstrumentUrl,
} from '../requestInstrumentation';
import { parseTraceparent } from '../../../shared/utils/w3cTrace';

class TestRequest {
  url: string;
  headers: Headers;
  method: string;

  constructor(input: string | TestRequest, init?: RequestInit) {
    if (typeof input === 'string') {
      this.url = input;
      this.headers = new Headers(init?.headers);
      this.method = init?.method ?? 'GET';
      return;
    }
    this.url = input.url;
    this.method = init?.method ?? input.method;
    this.headers = new Headers(input.headers);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, name) => {
        this.headers.set(name, value);
      });
    }
  }
}

if (typeof globalThis.Request === 'undefined') {
  (globalThis as unknown as { Request: typeof Request }).Request = TestRequest as unknown as typeof Request;
}

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

  it('keeps injected traceparent when fetch is given a Request plus init.headers', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    window.fetch = fetchFn as unknown as typeof fetch;
    restore = installRequestInstrumentation({
      getTraceId: () => '4bf92f3577b34da6a3ce929d0e0e4736',
      origin: 'https://apex.example',
    });

    const request = new Request('https://apex.example/api/projects', {
      headers: { accept: 'application/json' },
    });
    await window.fetch(request, { headers: { authorization: 'Bearer test' } });

    const passed = fetchFn.mock.calls[0][0] as Request;
    expect(fetchFn.mock.calls[0][1]).toBeUndefined();
    const headers = new Headers(passed.headers);
    expect(parseTraceparent(headers.get('traceparent'))?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer test');
  });
});
