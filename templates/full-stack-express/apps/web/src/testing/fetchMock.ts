import { vi } from 'vitest';

export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  contentType: string | null;
  accept: string | null;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function headerValue(
  headers: HeadersInit | undefined,
  name: string
): string | null {
  if (!headers) {
    return null;
  }
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  if (Array.isArray(headers)) {
    const found = headers.find(
      ([key]) => key.toLowerCase() === name.toLowerCase()
    );
    return found?.[1] ?? null;
  }
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find(
    (item) => item.toLowerCase() === name.toLowerCase()
  );
  return key ? (record[key] ?? null) : null;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

export function installFetch(
  handler: (call: FetchCall) => Promise<Response> | Response
): FetchCall[] {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: unknown;
      if (typeof init?.body === 'string' && init.body !== '') {
        body = JSON.parse(init.body) as unknown;
      }
      const call: FetchCall = {
        url: requestUrl(input),
        method,
        body,
        contentType: headerValue(init?.headers, 'Content-Type'),
        accept: headerValue(init?.headers, 'Accept'),
      };
      calls.push(call);
      return handler(call);
    }
  );
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}
