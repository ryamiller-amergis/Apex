/**
 * FEAT-007 / TBI-009 — client interactive stream transport (VT-04).
 */
import {
  INTERACTIVE_WS_CHANGED_EVENT,
  isInteractiveWsEnabled,
  openThreadEventStream,
  setInteractiveWsEnabled,
} from '../threadEventStream';

class FakeEventSource {
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  close = jest.fn();
  constructor(public url: string) {}
  addEventListener(type: string, cb: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  emit(type: string, event: unknown): void {
    (this.listeners[type] ?? []).forEach((cb) => cb(event));
  }
}

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  close = jest.fn();
  constructor(public url: string) {}
}

afterEach(() => {
  jest.useRealTimers();
  delete (globalThis as { __APEX_INTERACTIVE_WS__?: unknown }).__APEX_INTERACTIVE_WS__;
});

describe('isInteractiveWsEnabled', () => {
  it('defaults to false and honors the global flag', () => {
    expect(isInteractiveWsEnabled()).toBe(false);
    (globalThis as { __APEX_INTERACTIVE_WS__?: unknown }).__APEX_INTERACTIVE_WS__ = true;
    expect(isInteractiveWsEnabled()).toBe(true);
  });
});

describe('setInteractiveWsEnabled', () => {
  it('writes the global and notifies listeners', () => {
    const listener = jest.fn();
    globalThis.addEventListener(INTERACTIVE_WS_CHANGED_EVENT, listener);
    setInteractiveWsEnabled(true);
    expect(isInteractiveWsEnabled()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    setInteractiveWsEnabled(false);
    expect(isInteractiveWsEnabled()).toBe(false);
    globalThis.removeEventListener(INTERACTIVE_WS_CHANGED_EVENT, listener);
  });
});

describe('openThreadEventStream — SSE backend (default)', () => {
  it('opens the SSE endpoint with credentials and normalizes (data, lastEventId)', () => {
    let created: FakeEventSource | null = null;
    const messages: Array<[string, string]> = [];
    let opened = false;

    openThreadEventStream(
      'thread-1',
      {
        onOpen: () => {
          opened = true;
        },
        onMessage: (data, lastEventId) => messages.push([data, lastEventId]),
      },
      {
        transport: 'sse',
        eventSourceFactory: (url) => {
          created = new FakeEventSource(url) as unknown as FakeEventSource;
          return created as unknown as EventSource;
        },
      },
    );

    expect(created!.url).toBe('/api/chat/threads/thread-1/stream');
    created!.emit('open', {});
    expect(opened).toBe(true);
    created!.emit('message', { data: '{"type":"token","text":"hi"}', lastEventId: 'e5' });
    expect(messages).toEqual([['{"type":"token","text":"hi"}', 'e5']]);
  });
});

describe('openThreadEventStream — WebSocket backend', () => {
  it('parses gateway frames and resumes from the last ordinal on reconnect', () => {
    jest.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const messages: Array<[string, string]> = [];

    const handle = openThreadEventStream(
      'thread-9',
      { onMessage: (data, lastEventId) => messages.push([data, lastEventId]) },
      {
        transport: 'ws',
        reconnectDelayMs: 1000,
        webSocketFactory: (url) => {
          const ws = new FakeWebSocket(url);
          sockets.push(ws);
          return ws as unknown as WebSocket;
        },
      },
    );

    // First socket connects with no resume ordinal.
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toContain('/api/interactive/threads/thread-9/stream');
    expect(sockets[0].url).not.toContain('lastEventId');

    // Deliver a framed event; the transport unwraps `data` and forwards the id.
    sockets[0].onmessage?.({
      data: JSON.stringify({ type: 'event', id: 'e7', data: { type: 'token', text: 'a' } }),
    });
    expect(messages).toEqual([['{"type":"token","text":"a"}', 'e7']]);

    // Socket drops → reconnect after the delay, resuming from ordinal e7.
    sockets[0].onclose?.();
    jest.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toContain('lastEventId=e7');

    // Closing the handle stops further reconnects.
    handle.close();
    sockets[1].onclose?.();
    jest.advanceTimersByTime(5000);
    expect(sockets).toHaveLength(2);
  });
});
