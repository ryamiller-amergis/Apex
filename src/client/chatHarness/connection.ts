import type { SseEvent } from '../../shared/types/chat';
import type {
  ConnectionState,
  GatewayInboundFrame,
  HarnessCommandBody,
  HarnessErrorFrame,
  HarnessReceipt,
  HarnessThreadSnapshot,
  HarnessThreadState,
} from './types';

export interface ChatHarnessConnectionHandlers {
  onStateChange: (state: ConnectionState) => void;
  onSnapshot: (snapshot: HarnessThreadSnapshot) => void;
  onSnapshotError?: (status: number, message: string) => void;
  onEvent: (event: SseEvent, eventId: string) => void;
  onReceipt: (receipt: HarnessReceipt) => void;
  onStateFrame: (state: HarnessThreadState) => void;
  onErrorFrame?: (frame: HarnessErrorFrame) => void;
  onSignedOut?: () => void;
}

export interface ChatHarnessConnectionOptions {
  lastEventId?: string;
  webSocketFactory?: (url: string) => WebSocket;
  fetchImpl?: typeof fetch;
  firstRetryDelayMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  stateFrameTimeoutMs?: number;
  unavailablePollIntervalMs?: number;
  wsUrlFor?: (threadId: string, lastEventId?: string) => string;
}

export interface ChatHarnessConnection {
  start(): void;
  close(): void;
  getState(): ConnectionState;
  getLastEventId(): string | null;
  setActiveTurn(active: boolean): void;
  refreshSnapshot(): Promise<HarnessThreadSnapshot | null>;
  sendCommand(body: HarnessCommandBody): Promise<HarnessReceipt | null>;
  sendCommandOverHttp(body: HarnessCommandBody): Promise<HarnessReceipt | null>;
}

const DEFAULT_FIRST_RETRY_DELAY_MS = 500;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_STATE_FRAME_TIMEOUT_MS = 2_000;
const DEFAULT_UNAVAILABLE_POLL_INTERVAL_MS = 5_000;
const WS_READY_STATE_OPEN = 1;

function defaultWsUrlFor(threadId: string, lastEventId?: string): string {
  const loc = globalThis.location;
  const protocol = loc && loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = loc?.host || 'localhost';
  const query =
    lastEventId && lastEventId.length > 0
      ? `?lastEventId=${encodeURIComponent(lastEventId)}`
      : '';
  return `${protocol}//${host}/api/interactive/threads/${encodeURIComponent(threadId)}/stream${query}`;
}

async function extractErrorMessage(
  res: Response,
  fallback: string,
): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      if (typeof record.error === 'string' && record.error.trim().length > 0) {
        return record.error;
      }
      if (
        typeof record.message === 'string' &&
        record.message.trim().length > 0
      ) {
        return record.message;
      }
    }
  } catch {
    // Response was not JSON; fall back to statusText or default message.
  }
  return res.statusText && res.statusText.trim().length > 0
    ? res.statusText
    : fallback;
}

export function createChatHarnessConnection(
  threadId: string,
  handlers: ChatHarnessConnectionHandlers,
  options: ChatHarnessConnectionOptions = {},
): ChatHarnessConnection {
  const encodedThreadId = encodeURIComponent(threadId);
  const snapshotUrl = `/api/harness/threads/${encodedThreadId}/snapshot`;
  const commandsUrl = `/api/harness/threads/${encodedThreadId}/commands`;

  const webSocketFactory =
    options.webSocketFactory ?? ((url: string) => new WebSocket(url));
  const fetchImpl: typeof fetch =
    options.fetchImpl ??
    ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init));
  const wsUrlFor = options.wsUrlFor ?? defaultWsUrlFor;

  const firstRetryDelayMs =
    options.firstRetryDelayMs ?? DEFAULT_FIRST_RETRY_DELAY_MS;
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const stateFrameTimeoutMs =
    options.stateFrameTimeoutMs ?? DEFAULT_STATE_FRAME_TIMEOUT_MS;
  const unavailablePollIntervalMs =
    options.unavailablePollIntervalMs ?? DEFAULT_UNAVAILABLE_POLL_INTERVAL_MS;

  let state: ConnectionState = 'connecting';
  let started = false;
  let closed = false;
  let activeTurn = false;
  let lastEventId: string | null =
    options.lastEventId && options.lastEventId.length > 0
      ? options.lastEventId
      : null;
  let socket: WebSocket | null = null;
  let backoffAttempt = 0;

  let reconnectTimer: number | null = null;
  let stateFrameTimer: number | null = null;
  let unavailablePollTimer: number | null = null;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const clearStateFrameTimer = (): void => {
    if (stateFrameTimer !== null) {
      window.clearTimeout(stateFrameTimer);
      stateFrameTimer = null;
    }
  };

  const clearUnavailablePollTimer = (): void => {
    if (unavailablePollTimer !== null) {
      window.clearInterval(unavailablePollTimer);
      unavailablePollTimer = null;
    }
  };

  const clearAllTimers = (): void => {
    clearReconnectTimer();
    clearStateFrameTimer();
    clearUnavailablePollTimer();
  };

  const detachAndCloseSocket = (): void => {
    if (!socket) return;
    const current = socket;
    socket = null;
    current.onopen = null;
    current.onerror = null;
    current.onmessage = null;
    current.onclose = null;
    try {
      current.close();
    } catch {
      // Ignore close errors on already-terminated sockets.
    }
  };

  const syncUnavailablePoll = (): void => {
    if (state === 'unavailable' && activeTurn && !closed) {
      if (unavailablePollTimer === null) {
        unavailablePollTimer = window.setInterval(() => {
          if (state === 'unavailable' && activeTurn && !closed) {
            void refreshSnapshot();
          }
        }, unavailablePollIntervalMs);
      }
      return;
    }
    clearUnavailablePollTimer();
  };

  const setState = (next: ConnectionState): void => {
    if (state === next) return;
    state = next;
    syncUnavailablePoll();
    handlers.onStateChange(next);
  };

  const handleSignedOut = (): void => {
    if (closed || state === 'signed-out') return;
    clearAllTimers();
    detachAndCloseSocket();
    setState('signed-out');
    handlers.onSignedOut?.();
  };

  const scheduleReconnectAfter = (delayMs: number): void => {
    if (closed || state === 'signed-out') return;
    clearReconnectTimer();
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delayMs);
  };

  const scheduleBackoffReconnect = (): void => {
    const exponent = Math.min(backoffAttempt, 30);
    const delayMs = Math.min(
      backoffBaseMs * Math.pow(2, exponent),
      backoffMaxMs,
    );
    backoffAttempt += 1;
    scheduleReconnectAfter(delayMs);
  };

  const isInactive = (): boolean => closed || state === 'signed-out';

  const refreshSnapshot = async (): Promise<HarnessThreadSnapshot | null> => {
    if (isInactive()) {
      return null;
    }

    let res: Response;
    try {
      res = await fetchImpl(snapshotUrl, {
        method: 'GET',
        credentials: 'include',
      });
    } catch (err: unknown) {
      if (isInactive()) {
        return null;
      }
      handlers.onSnapshotError?.(
        0,
        err instanceof Error ? err.message : 'Network error loading snapshot',
      );
      return null;
    }

    if (isInactive()) {
      return null;
    }

    if (res.status === 401) {
      handleSignedOut();
      return null;
    }

    if (!res.ok) {
      const message = await extractErrorMessage(
        res,
        `Failed to load thread snapshot (HTTP ${res.status})`,
      );
      if (isInactive()) {
        return null;
      }
      handlers.onSnapshotError?.(res.status, message);
      return null;
    }

    const snapshot = (await res.json()) as HarnessThreadSnapshot;
    if (isInactive()) {
      return null;
    }

    handlers.onSnapshot(snapshot);
    return snapshot;
  };

  const handleInboundFrame = (rawData: unknown): void => {
    if (closed || state === 'signed-out') return;
    if (typeof rawData !== 'string') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      return;
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as { type?: unknown }).type !== 'string'
    ) {
      return;
    }

    const frame = parsed as GatewayInboundFrame;
    switch (frame.type) {
      case 'event': {
        const eventFrame = frame as {
          type: 'event';
          id?: unknown;
          data?: unknown;
        };
        if (eventFrame.data === undefined || eventFrame.data === null) return;
        const eventId =
          typeof eventFrame.id === 'string' ? eventFrame.id : '';
        if (eventId.length > 0) {
          lastEventId = eventId;
        }
        handlers.onEvent(eventFrame.data as SseEvent, eventId);
        return;
      }
      case 'receipt': {
        const receiptFrame = frame as {
          type: 'receipt';
          receipt?: unknown;
        };
        if (receiptFrame.receipt && typeof receiptFrame.receipt === 'object') {
          handlers.onReceipt(receiptFrame.receipt as HarnessReceipt);
        }
        return;
      }
      case 'state': {
        const stateFrame = frame as {
          type: 'state';
          state?: unknown;
        };
        if (stateFrame.state && typeof stateFrame.state === 'object') {
          clearStateFrameTimer();
          handlers.onStateFrame(stateFrame.state as HarnessThreadState);
        }
        return;
      }
      case 'error': {
        const errorFrame = frame as HarnessErrorFrame;
        handlers.onErrorFrame?.(errorFrame);
        return;
      }
      default:
        // Unknown frame types are ignored silently for forward compatibility.
        return;
    }
  };

  const handleDropTransition = (hadOpened: boolean): void => {
    if (closed || state === 'signed-out') return;

    if (hadOpened || state === 'connecting') {
      backoffAttempt = 0;
      setState('reconnecting');
      scheduleReconnectAfter(firstRetryDelayMs);
      return;
    }

    if (state === 'reconnecting') {
      backoffAttempt = 0;
      setState('unavailable');
      scheduleBackoffReconnect();
      void refreshSnapshot();
      return;
    }

    // Subsequent silent retries while already unavailable keep backing off.
    scheduleBackoffReconnect();
  };

  const openSocket = (): void => {
    if (closed || state === 'signed-out') return;

    detachAndCloseSocket();
    clearStateFrameTimer();

    const url = wsUrlFor(threadId, lastEventId ?? undefined);
    let sock: WebSocket;
    try {
      sock = webSocketFactory(url);
    } catch {
      handleDropTransition(false);
      return;
    }

    socket = sock;
    let opened = false;
    let dropped = false;

    const onSocketDrop = (): void => {
      if (dropped || sock !== socket || closed || state === 'signed-out') {
        return;
      }
      dropped = true;
      clearStateFrameTimer();
      detachAndCloseSocket();
      handleDropTransition(opened);
    };

    sock.onopen = () => {
      if (sock !== socket || closed || state === 'signed-out') return;
      opened = true;
      backoffAttempt = 0;
      clearReconnectTimer();

      const nextState: ConnectionState =
        state === 'reconnecting' || state === 'unavailable'
          ? 'restored'
          : 'open';
      setState(nextState);

      clearStateFrameTimer();
      stateFrameTimer = window.setTimeout(() => {
        stateFrameTimer = null;
        if (sock === socket && !closed && state !== 'signed-out') {
          void refreshSnapshot();
        }
      }, stateFrameTimeoutMs);
    };

    sock.onmessage = (event: MessageEvent) => {
      if (sock !== socket || closed || state === 'signed-out') return;
      handleInboundFrame(event.data);
    };

    sock.onerror = onSocketDrop;
    sock.onclose = onSocketDrop;
  };

  const sendCommandOverHttp = async (
    body: HarnessCommandBody,
  ): Promise<HarnessReceipt | null> => {
    if (isInactive()) {
      return null;
    }

    const res = await fetchImpl(commandsUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (isInactive()) {
      return null;
    }

    if (res.status === 401) {
      handleSignedOut();
      return null;
    }

    if (!res.ok) {
      const message = await extractErrorMessage(
        res,
        `Failed to send command (HTTP ${res.status})`,
      );
      throw new Error(message);
    }

    const receipt = (await res.json()) as HarnessReceipt;
    if (isInactive()) {
      return null;
    }

    handlers.onReceipt(receipt);
    return receipt;
  };

  const sendCommand = async (
    body: HarnessCommandBody,
  ): Promise<HarnessReceipt | null> => {
    if (closed || state === 'signed-out') {
      return null;
    }

    if (socket !== null && socket.readyState === WS_READY_STATE_OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'command', ...body }));
        return null;
      } catch {
        // Fall through to HTTP command route if the socket send fails.
      }
    }

    return sendCommandOverHttp(body);
  };

  return {
    start(): void {
      if (started || closed || state === 'signed-out') return;
      started = true;
      void refreshSnapshot();
      openSocket();
    },

    close(): void {
      if (closed) return;
      closed = true;
      clearAllTimers();
      detachAndCloseSocket();
      setState('closed');
    },

    getState(): ConnectionState {
      return state;
    },

    getLastEventId(): string | null {
      return lastEventId;
    },

    setActiveTurn(active: boolean): void {
      activeTurn = active;
      syncUnavailablePoll();
    },

    refreshSnapshot,
    sendCommand,
    sendCommandOverHttp,
  };
}
