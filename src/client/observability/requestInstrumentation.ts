/**
 * Same-origin fetch/XHR W3C instrumentation. Restores originals on cleanup.
 */
import { OBSERVABILITY_INGEST_PATH } from '../../shared/types/observability';
import { formatTraceparent, generateSpanId, parseTraceparent } from '../../shared/utils/w3cTrace';

export interface RequestInstrumentationOptions {
  getTraceId: () => string | null;
  origin?: string;
}

const STATIC_EXTENSION_RE = /\.(?:js|css|map|mjs|cjs|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|txt|html|json)$/i;
const EXCLUDED_PREFIXES = [
  OBSERVABILITY_INGEST_PATH,
  '/api/health',
  '/health',
  '/api/ready',
  '/ready',
];

let installCount = 0;
let originalFetch: typeof fetch | null = null;
let originalXhrOpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXhrSend: typeof XMLHttpRequest.prototype.send | null = null;
let originalXhrSetHeader: typeof XMLHttpRequest.prototype.setRequestHeader | null = null;
let activeOptions: RequestInstrumentationOptions | null = null;

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
}

function isSameOriginApi(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin) return false;
    const path = parsed.pathname;
    if (!path.startsWith('/api/')) return false;
    if (STATIC_EXTENSION_RE.test(path)) return false;
    return !EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  } catch {
    return false;
  }
}

function existingTraceparent(init?: RequestInit, request?: Request): string | null {
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      return init.headers.get('traceparent');
    }
    if (Array.isArray(init.headers)) {
      const found = init.headers.find(([name]) => name.toLowerCase() === 'traceparent');
      return found?.[1] ?? null;
    }
    const record = init.headers as Record<string, string>;
    return record.traceparent ?? record.Traceparent ?? null;
  }
  if (request) return request.headers.get('traceparent');
  return null;
}

function withTraceparent(init: RequestInit | undefined, traceparent: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('traceparent', traceparent);
  return { ...init, headers };
}

function bindFetch(): typeof fetch | null {
  if (typeof window.fetch === 'function') {
    return window.fetch.bind(window);
  }
  return null;
}

function wrappedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const fetchFn = originalFetch ?? window.fetch;
  if (typeof fetchFn !== 'function') {
    return Promise.reject(new Error('fetch is not available'));
  }
  const origin = activeOptions?.origin ?? window.location.origin;
  const url = resolveUrl(input);
  const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
  if (!activeOptions || !isSameOriginApi(url, origin) || parseTraceparent(existingTraceparent(init, request))) {
    return fetchFn(input as RequestInfo, init);
  }
  const traceId = activeOptions.getTraceId();
  if (!traceId) return fetchFn(input as RequestInfo, init);
  const traceparent = formatTraceparent(traceId, generateSpanId());
  if (typeof Request !== 'undefined' && input instanceof Request) {
    const headers = new Headers(input.headers);
    headers.set('traceparent', traceparent);
    return fetchFn(new Request(input, { headers }), init);
  }
  return fetchFn(input, withTraceparent(init, traceparent));
}

export function shouldInstrumentUrl(url: string, origin = window.location.origin): boolean {
  return isSameOriginApi(url, origin);
}

export function installRequestInstrumentation(options: RequestInstrumentationOptions): () => void {
  activeOptions = options;
  if (installCount === 0) {
    originalFetch = bindFetch();
    if (originalFetch) {
      window.fetch = wrappedFetch as typeof fetch;
    }

    originalXhrOpen = XMLHttpRequest.prototype.open;
    originalXhrSend = XMLHttpRequest.prototype.send;
    originalXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function open(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) {
      (this as XMLHttpRequest & { __obsUrl?: string }).__obsUrl = String(url);
      return originalXhrOpen!.call(this, method, url, async ?? true, username, password);
    };

    XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(
      this: XMLHttpRequest,
      name: string,
      value: string,
    ) {
      if (name.toLowerCase() === 'traceparent') {
        (this as XMLHttpRequest & { __obsTraceparent?: string }).__obsTraceparent = value;
      }
      return originalXhrSetHeader!.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function send(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const origin = activeOptions?.origin ?? window.location.origin;
      const url = (this as XMLHttpRequest & { __obsUrl?: string }).__obsUrl ?? '';
      const existing = (this as XMLHttpRequest & { __obsTraceparent?: string }).__obsTraceparent;
      if (activeOptions && isSameOriginApi(url, origin) && !parseTraceparent(existing)) {
        const traceId = activeOptions.getTraceId();
        if (traceId) {
          originalXhrSetHeader!.call(this, 'traceparent', formatTraceparent(traceId, generateSpanId()));
        }
      }
      return originalXhrSend!.call(this, body);
    };
  }
  installCount += 1;
  return () => {
    installCount = Math.max(0, installCount - 1);
    if (installCount === 0) {
      if (originalFetch) window.fetch = originalFetch;
      if (originalXhrOpen) XMLHttpRequest.prototype.open = originalXhrOpen;
      if (originalXhrSend) XMLHttpRequest.prototype.send = originalXhrSend;
      if (originalXhrSetHeader) XMLHttpRequest.prototype.setRequestHeader = originalXhrSetHeader;
      originalFetch = null;
      originalXhrOpen = null;
      originalXhrSend = null;
      originalXhrSetHeader = null;
      activeOptions = null;
    }
  };
}

export function resetRequestInstrumentationForTests(): void {
  installCount = 0;
  if (originalFetch) window.fetch = originalFetch;
  if (originalXhrOpen) XMLHttpRequest.prototype.open = originalXhrOpen;
  if (originalXhrSend) XMLHttpRequest.prototype.send = originalXhrSend;
  if (originalXhrSetHeader) XMLHttpRequest.prototype.setRequestHeader = originalXhrSetHeader;
  originalFetch = null;
  originalXhrOpen = null;
  originalXhrSend = null;
  originalXhrSetHeader = null;
  activeOptions = null;
}
