/**
 * FEAT-007 / TBI-009 — client interactive stream transport.
 *
 * Normalizes the two interchangeable agent transports behind one contract so
 * consumers (useChatStream, useAskApex, …) are transport-agnostic:
 *
 *   - **SSE (default/legacy):** `EventSource` on `…/stream`; the browser owns
 *     auto-reconnect and `Last-Event-ID` resume.
 *   - **WebSocket (interactive gateway):** frames `{ type:'event', id, data }`
 *     from the Dapr actor tier; this module owns reconnect + ordinal resume via
 *     `?lastEventId=` so the durable replay contract matches SSE (VT-04).
 *
 * Both backends deliver the SAME `(data, lastEventId)` pair the SSE message
 * handler already expects — `data` is the serialized `SseEvent`, `lastEventId`
 * is the durable ordinal used for de-dupe/resume. Default is SSE, so existing
 * behavior is unchanged until the interactive transport is switched on.
 */

export interface ThreadStreamHandlers {
  onOpen?: () => void;
  onError?: () => void;
  /** `data` is the serialized SseEvent; `lastEventId` is the durable ordinal. */
  onMessage: (data: string, lastEventId: string) => void;
}

export interface ThreadStreamHandle {
  close(): void;
}

export type ThreadStreamTransport = 'auto' | 'sse' | 'ws';

export interface OpenThreadEventStreamOptions {
  /** Resume from this durable ordinal (WS backend only; SSE uses the browser). */
  lastEventId?: string;
  /** Force a transport; 'auto' picks WS when enabled, else SSE. */
  transport?: ThreadStreamTransport;
  /** Reconnect backoff for the WS backend (ms). */
  reconnectDelayMs?: number;
  /** Injectable factories for tests. */
  eventSourceFactory?: (url: string) => EventSource;
  webSocketFactory?: (url: string) => WebSocket;
}

export interface OpenInteractiveStreamOptions extends OpenThreadEventStreamOptions {
  /** SSE endpoint (EventSource) for this surface. */
  sseUrl: string;
  /** WebSocket URL builder; receives the resume ordinal. Omit for SSE-only. */
  wsUrlFor?: (lastEventId?: string) => string;
}

interface GatewayFrame {
  type: 'event';
  id: string;
  data: unknown;
}

/**
 * Interactive WebSocket transport is opt-in and off by default. Enabled via a
 * global set at bootstrap (`window.__APEX_INTERACTIVE_WS__ = true`) or a
 * `localStorage` override, so the SSE→WS cutover is a single runtime flip.
 */
export const INTERACTIVE_WS_CHANGED_EVENT = 'apex-interactive-ws-changed';

export function isInteractiveWsEnabled(): boolean {
  try {
    const globalFlag = (globalThis as { __APEX_INTERACTIVE_WS__?: unknown })
      .__APEX_INTERACTIVE_WS__;
    if (globalFlag === true) return true;
    if (globalFlag === false) return false;
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('apex.interactiveWs') === 'true';
    }
  } catch {
    // Sandboxed/SSR — fall back to SSE.
  }
  return false;
}

/** Publish the interactive transport preference and notify open chat streams. */
export function setInteractiveWsEnabled(enabled: boolean): void {
  (globalThis as { __APEX_INTERACTIVE_WS__?: boolean }).__APEX_INTERACTIVE_WS__ =
    enabled;
  try {
    globalThis.dispatchEvent?.(new Event(INTERACTIVE_WS_CHANGED_EVENT));
  } catch {
    // Non-DOM runtimes (tests/SSR) — global write is enough.
  }
}

function sseStreamUrl(threadId: string): string {
  return `/api/chat/threads/${threadId}/stream`;
}

function wsStreamUrl(threadId: string, lastEventId?: string): string {
  const loc = globalThis.location;
  const protocol = loc && loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = loc?.host ?? 'localhost';
  const query = lastEventId ? `?lastEventId=${encodeURIComponent(lastEventId)}` : '';
  return `${protocol}//${host}/api/interactive/threads/${encodeURIComponent(
    threadId,
  )}/stream${query}`;
}

function openSse(
  sseUrl: string,
  handlers: ThreadStreamHandlers,
  options: OpenInteractiveStreamOptions,
): ThreadStreamHandle {
  const factory =
    options.eventSourceFactory ??
    ((url: string) => new EventSource(url, { withCredentials: true } as EventSourceInit));
  const source = factory(sseUrl);
  source.addEventListener('open', () => handlers.onOpen?.());
  source.addEventListener('error', () => handlers.onError?.());
  source.addEventListener('message', (event: MessageEvent) => {
    handlers.onMessage(event.data as string, event.lastEventId);
  });
  return {
    close: () => source.close(),
  };
}

function openWs(
  wsUrlFor: (lastEventId?: string) => string,
  handlers: ThreadStreamHandlers,
  options: OpenInteractiveStreamOptions,
): ThreadStreamHandle {
  const factory =
    options.webSocketFactory ?? ((url: string) => new WebSocket(url));
  const reconnectDelayMs = options.reconnectDelayMs ?? 3_000;
  let closed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Track the latest durable ordinal so a reconnect resumes with no gaps.
  let lastEventId = options.lastEventId;

  const connect = (): void => {
    if (closed) return;
    socket = factory(wsUrlFor(lastEventId));
    socket.onopen = () => handlers.onOpen?.();
    socket.onerror = () => handlers.onError?.();
    socket.onmessage = (event: MessageEvent) => {
      let frame: GatewayFrame;
      try {
        frame = JSON.parse(event.data as string) as GatewayFrame;
      } catch {
        return;
      }
      if (!frame || frame.type !== 'event') return;
      if (frame.id) lastEventId = frame.id;
      handlers.onMessage(JSON.stringify(frame.data), frame.id ?? '');
    };
    socket.onclose = () => {
      handlers.onError?.();
      if (closed) return;
      reconnectTimer = setTimeout(connect, reconnectDelayMs);
    };
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}

/**
 * Open a normalized interactive stream from explicit SSE/WS URLs. Returns a
 * handle whose `close()` tears down the transport (and cancels WS reconnects).
 * WS is used only when enabled AND a `wsUrlFor` builder is provided, so
 * surfaces without a WS backing (e.g. Ask Apex today) stay on SSE.
 */
export function openInteractiveStream(
  handlers: ThreadStreamHandlers,
  options: OpenInteractiveStreamOptions,
): ThreadStreamHandle {
  const transport: ThreadStreamTransport = options.transport ?? 'auto';
  const wsEligible = Boolean(options.wsUrlFor);
  const useWs =
    wsEligible &&
    (transport === 'ws' || (transport === 'auto' && isInteractiveWsEnabled()));
  return useWs
    ? openWs(options.wsUrlFor!, handlers, options)
    : openSse(options.sseUrl, handlers, options);
}

/**
 * Open a normalized interactive stream for a chat `threadId` (backed by the
 * Dapr actor gateway when WS is enabled). Behavior is unchanged from the legacy
 * SSE stream until the interactive transport is switched on.
 */
export function openThreadEventStream(
  threadId: string,
  handlers: ThreadStreamHandlers,
  options: OpenThreadEventStreamOptions = {},
): ThreadStreamHandle {
  return openInteractiveStream(handlers, {
    ...options,
    sseUrl: sseStreamUrl(threadId),
    wsUrlFor: (lastEventId?: string) => wsStreamUrl(threadId, lastEventId),
  });
}
