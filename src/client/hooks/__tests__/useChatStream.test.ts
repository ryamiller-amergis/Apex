import { renderHook, act } from '@testing-library/react';
import { useChatStream } from '../useChatStream';

// ── EventSource mock ───────────────────────────────────────────────────────────

type Listener = (e: MessageEvent) => void;

interface MockES {
  url: string;
  listeners: Record<string, Listener[]>;
  addEventListener: jest.Mock;
  close: jest.Mock;
  // test helpers
  emit: (type: string, data: unknown, lastEventId?: string) => void;
  emitOpen: () => void;
  emitError: () => void;
}

let lastES: MockES | null = null;

function makeMockES(url: string): MockES {
  const listeners: Record<string, Listener[]> = {};

  const es: MockES = {
    url,
    listeners,
    addEventListener: jest.fn((type: string, cb: Listener) => {
      listeners[type] = listeners[type] ?? [];
      listeners[type].push(cb);
    }),
    close: jest.fn(),
    emit(type: string, data: unknown, lastEventId = '') {
      const cbs = listeners[type] ?? [];
      const event = { data: JSON.stringify(data), lastEventId } as MessageEvent;
      cbs.forEach((cb) => cb(event));
    },
    emitOpen() {
      (listeners['open'] ?? []).forEach((cb) => cb({} as MessageEvent));
    },
    emitError() {
      (listeners['error'] ?? []).forEach((cb) => cb({} as MessageEvent));
    },
  };

  return es;
}

beforeEach(() => {
  lastES = null;
  (global as any).EventSource = jest.fn().mockImplementation((url: string) => {
    lastES = makeMockES(url);
    return lastES;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useChatStream', () => {
  it('starts disconnected and idle when given a threadId', () => {
    const { result } = renderHook(() => useChatStream('thread-1'));
    expect(result.current.isConnected).toBe(false);
    expect(result.current.status).toBe('idle');
    expect(result.current.messages).toEqual([]);
    expect(result.current.streamingText).toBe('');
  });

  it('opens an EventSource to the correct URL', () => {
    renderHook(() => useChatStream('thread-42'));
    expect(global.EventSource).toHaveBeenCalledWith(
      '/api/chat/threads/thread-42/stream',
      expect.objectContaining({ withCredentials: true }),
    );
  });

  it('sets isConnected=true on open event', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => lastES!.emitOpen());
    expect(result.current.isConnected).toBe(true);
  });

  it('sets isConnected=false on error event', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => lastES!.emitOpen());
    expect(result.current.isConnected).toBe(true);
    act(() => lastES!.emitError());
    expect(result.current.isConnected).toBe(false);
  });

  it('accumulates token events into streamingText', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      lastES!.emit('message', { type: 'token', text: 'Hello' });
      lastES!.emit('message', { type: 'token', text: ', world' });
    });
    expect(result.current.streamingText).toBe('Hello, world');
  });

  it('commits message event and clears streaming buffer', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      lastES!.emit('message', { type: 'token', text: 'partial' });
    });
    expect(result.current.streamingText).toBe('partial');

    const msg = { id: 'msg-1', role: 'agent', text: 'full text', ts: '2026-01-01T00:00:00Z' };
    act(() => {
      lastES!.emit('message', { type: 'message', message: msg });
    });
    expect(result.current.streamingText).toBe('');
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toEqual(msg);
  });

  it('deduplicates message events with the same id', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    const msg = { id: 'dup-1', role: 'agent', text: 'text', ts: '2026-01-01T00:00:00Z' };
    act(() => {
      lastES!.emit('message', { type: 'message', message: msg });
      lastES!.emit('message', { type: 'message', message: msg });
    });
    expect(result.current.messages).toHaveLength(1);
  });

  it('deduplicates replayed durable SSE events by lastEventId before applying them', () => {
    const { result } = renderHook(() => useChatStream('t1'));

    act(() => {
      lastES!.emit('message', {
        type: 'tool_status',
        callId: 'call-1',
        toolName: 'read_file',
        status: 'running',
      }, 'event-1');
      lastES!.emit('message', {
        type: 'tool_status',
        callId: 'call-1',
        toolName: 'read_file',
        status: 'running',
      }, 'event-1');
    });

    expect(result.current.toolProgress).toHaveLength(1);
  });

  it('does not drop tokens or final messages when EventSource sticky lastEventId repeats', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    const msg = {
      id: 'msg-live-1',
      role: 'agent',
      text: 'final answer',
      ts: '2026-01-01T00:00:00Z',
    };

    act(() => {
      // Durable events carry SSE ids. Token/message frames often do not, but the
      // browser still reports the previous id via MessageEvent.lastEventId.
      lastES!.emit('message', {
        type: 'tool_status',
        callId: 'call-1',
        toolName: 'shell',
        status: 'completed',
      }, 'tool-event-1');
      lastES!.emit('message', { type: 'token', text: 'Hel' }, 'tool-event-1');
      lastES!.emit('message', { type: 'token', text: 'lo' }, 'tool-event-1');
      lastES!.emit('message', { type: 'message', message: msg }, 'tool-event-1');
    });

    expect(result.current.streamingText).toBe('');
    expect(result.current.messages).toEqual([msg]);
  });

  it('ignores a replayed durable event ID after the EventSource reconnects', () => {
    const { result } = renderHook(() => useChatStream('t1'));

    act(() => {
      lastES!.emitOpen();
      lastES!.emit('message', {
        type: 'status',
        status: 'running',
      }, 'event-7');
      lastES!.emitError();
      lastES!.emitOpen();
      lastES!.emit('message', {
        type: 'status',
        status: 'running',
      }, 'event-7');
      lastES!.emit('message', {
        type: 'status',
        status: 'idle',
      }, 'event-8');
    });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.status).toBe('idle');
  });

  it('bounds remembered durable event IDs and accepts an ID again after eviction', () => {
    const { result } = renderHook(() => useChatStream('t1'));

    act(() => {
      lastES!.emit('message', {
        type: 'status',
        status: 'running',
      }, 'event-0');
      for (let i = 1; i <= 512; i++) {
        lastES!.emit('message', {
          type: 'status',
          status: 'running',
        }, `event-${i}`);
      }
      lastES!.emit('message', {
        type: 'status',
        status: 'idle',
      }, 'event-0');
    });

    expect(result.current.status).toBe('idle');
  });

  it('continues processing events without an SSE ID for backward compatibility', () => {
    const { result } = renderHook(() => useChatStream('t1'));

    act(() => {
      lastES!.emit('message', { type: 'token', text: 'A' });
      lastES!.emit('message', { type: 'token', text: 'A' });
    });

    expect(result.current.streamingText).toBe('AA');
  });

  it('tracks the last meaningful progress time without treating thinking fragments as progress', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const { result } = renderHook(() => useChatStream('t1'));
      expect(result.current.lastProgressAt).toBeNull();

      act(() => {
        lastES!.emit('message', { type: 'thinking', text: 'raw thought' }, 'thinking-1');
      });
      expect(result.current.lastProgressAt).toBeNull();

      jest.setSystemTime(new Date('2026-01-01T00:00:05Z'));
      act(() => {
        lastES!.emit('message', {
          type: 'tool_status',
          callId: 'call-1',
          toolName: 'read_file',
          status: 'running',
        }, 'tool-1');
      });
      expect(result.current.lastProgressAt).toBe(new Date('2026-01-01T00:00:05Z').getTime());
    } finally {
      jest.useRealTimers();
    }
  });

  it('consumes durable semantic phase events with safe normalized metadata', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-14T12:10:00Z'));
    try {
      const { result } = renderHook(() => useChatStream('t1'));

      act(() => {
        lastES!.emit('message', {
          type: 'phase',
          phase: 'testing',
          status: 'running',
          detail: '  Running\n focused   tests  ',
          durationMs: 1_250,
          runId: 'run-1',
          eventTimestamp: '2026-07-14T12:09:55.000Z',
        }, 'phase-1');
      });

      expect(result.current.phaseEvents).toEqual([{
        id: 'phase-1',
        runId: 'run-1',
        phase: 'testing',
        status: 'running',
        detail: 'Running focused tests',
        durationMs: 1_250,
        timestamp: Date.parse('2026-07-14T12:09:55.000Z'),
      }]);
      expect(result.current.lastProgressAt).toBe(Date.parse('2026-07-14T12:09:55.000Z'));
    } finally {
      jest.useRealTimers();
    }
  });

  it('consumes semantic envelope metadata from durable tool events without inference', () => {
    const { result } = renderHook(() => useChatStream('t1'));

    act(() => {
      lastES!.emit('message', {
        type: 'tool_status',
        callId: 'call-1',
        toolName: 'run_terminal_cmd',
        status: 'running',
        semanticPhase: 'typecheck',
        semanticStatus: 'running',
        semanticDetail: 'Checking server types',
        runId: 'run-1',
        eventTimestamp: '2026-07-14T12:09:55.000Z',
      }, 'tool-phase-1');
    });

    expect(result.current.phaseEvents).toEqual([
      expect.objectContaining({
        id: 'tool-phase-1',
        phase: 'typecheck',
        status: 'running',
        detail: 'Checking server types',
      }),
    ]);
  });

  it('ignores malformed phase values and health events do not advance meaningful progress', () => {
    const { result } = renderHook(() => useChatStream('t1'));

    act(() => {
      lastES!.emit('message', {
        type: 'phase',
        phase: '__proto__',
        status: 'running',
        detail: 'unsafe',
      }, 'invalid-phase');
      lastES!.emit('message', {
        type: 'health',
        health: 'progress_stale',
        detail: 'No meaningful progress for more than 2 minutes',
        runId: 'run-1',
        eventTimestamp: '2026-07-14T12:10:00.000Z',
      }, 'health-1');
    });

    expect(result.current.phaseEvents).toEqual([]);
    expect(result.current.runHealth).toMatchObject({
      health: 'progress_stale',
      detail: 'No meaningful progress for more than 2 minutes',
    });
    expect(result.current.lastProgressAt).toBeNull();
  });

  it('clears thinkingText on tool_call without adding a message', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      lastES!.emit('message', { type: 'thinking', text: 'Planning next step…' });
    });
    expect(result.current.thinkingText).toBe('Planning next step…');

    act(() => {
      lastES!.emit('message', { type: 'tool_call', toolName: 'list_files' });
    });
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.thinkingText).toBe('');
  });

  it('tracks tool_status events in toolProgress', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      lastES!.emit('message', {
        type: 'tool_status',
        callId: 'call-1',
        toolName: 'list_files',
        status: 'running',
      });
    });
    expect(result.current.toolProgress).toHaveLength(1);
    expect(result.current.toolProgress[0]).toMatchObject({
      callId: 'call-1',
      toolName: 'list_files',
      status: 'running',
    });
  });

  it('updates status on status event', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      lastES!.emit('message', { type: 'status', status: 'running' });
    });
    expect(result.current.status).toBe('running');
  });

  it('adds system error message and sets status=error on error event', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      lastES!.emit('message', { type: 'error', error: 'Something went wrong' });
    });
    expect(result.current.status).toBe('error');
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].role).toBe('system');
    expect(result.current.messages[0].text).toContain('Something went wrong');
  });

  it('clears streamingText on done event', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      lastES!.emit('message', { type: 'token', text: 'partial' });
    });
    expect(result.current.streamingText).toBe('partial');
    act(() => {
      lastES!.emit('message', { type: 'done' });
    });
    expect(result.current.streamingText).toBe('');
  });

  it('does not open EventSource when threadId is null', () => {
    renderHook(() => useChatStream(null));
    expect(global.EventSource).not.toHaveBeenCalled();
  });

  it('closes the EventSource when the component unmounts', () => {
    const { unmount } = renderHook(() => useChatStream('t1'));
    const es = lastES!;
    unmount();
    expect(es.close).toHaveBeenCalledTimes(1);
  });

  it('closes the old EventSource and opens a new one when threadId changes', () => {
    const { rerender } = renderHook(({ id }) => useChatStream(id), {
      initialProps: { id: 'thread-a' as string | null },
    });
    const firstES = lastES!;

    rerender({ id: 'thread-b' });

    expect(firstES.close).toHaveBeenCalledTimes(1);
    expect(global.EventSource).toHaveBeenLastCalledWith(
      '/api/chat/threads/thread-b/stream',
      expect.anything(),
    );
  });

  it('seeds messages from initialMessages option', () => {
    const initial = [{ id: 'init-1', role: 'user' as const, text: 'hi', ts: '2026-01-01T00:00:00Z' }];
    const { result } = renderHook(() =>
      useChatStream('t1', { initialMessages: initial }),
    );
    expect(result.current.messages).toEqual(initial);
  });

  it('uses initialStatus when provided', () => {
    const { result } = renderHook(() =>
      useChatStream('t1', { initialStatus: 'running' }),
    );
    expect(result.current.status).toBe('running');
  });

  it('ignores malformed SSE data without throwing', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      const cbs = lastES!.listeners['message'] ?? [];
      cbs.forEach((cb) => cb({ data: 'not-json' } as MessageEvent));
    });
    expect(result.current.messages).toHaveLength(0);
  });

  it('sets prdReady=true when done event carries prdReady flag', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    expect(result.current.prdReady).toBe(false);
    act(() => {
      lastES!.emit('message', { type: 'done', prdReady: true });
    });
    expect(result.current.prdReady).toBe(true);
  });

  it('sets backlogReady=true when done event carries backlogReady flag', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    expect(result.current.backlogReady).toBe(false);
    act(() => {
      lastES!.emit('message', { type: 'done', backlogReady: true });
    });
    expect(result.current.backlogReady).toBe(true);
  });

  it('does not set prdReady when done event has no flag', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      lastES!.emit('message', { type: 'done' });
    });
    expect(result.current.prdReady).toBe(false);
    expect(result.current.backlogReady).toBe(false);
  });

  it('resets prdReady and backlogReady when threadId changes', () => {
    const { result, rerender } = renderHook(({ id }) => useChatStream(id), {
      initialProps: { id: 'thread-a' as string | null },
    });

    act(() => {
      lastES!.emit('message', { type: 'done', prdReady: true, backlogReady: true });
    });
    expect(result.current.prdReady).toBe(true);
    expect(result.current.backlogReady).toBe(true);

    rerender({ id: 'thread-b' });
    expect(result.current.prdReady).toBe(false);
    expect(result.current.backlogReady).toBe(false);
  });

  it('resets prdReady when threadId is set to null', () => {
    const { result, rerender } = renderHook(({ id }) => useChatStream(id), {
      initialProps: { id: 'thread-a' as string | null },
    });

    act(() => {
      lastES!.emit('message', { type: 'done', prdReady: true });
    });
    expect(result.current.prdReady).toBe(true);

    rerender({ id: null });
    expect(result.current.prdReady).toBe(false);
  });

  // ── Retry state ────────────────────────────────────────────────────────────

  it('starts with isRetrying=false and retryReason=null', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    expect(result.current.isRetrying).toBe(false);
    expect(result.current.retryReason).toBeNull();
  });

  it('sets isRetrying=true and retryReason when a retrying event arrives', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      lastES!.emit('message', { type: 'retrying', attempt: 1, maxAttempts: 3 });
    });
    expect(result.current.isRetrying).toBe(true);
    expect(result.current.retryReason).toBe('Retrying… (attempt 1 of 3)');
  });

  it('clears isRetrying when a token event arrives after retrying', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      lastES!.emit('message', { type: 'retrying', attempt: 1, maxAttempts: 3 });
    });
    expect(result.current.isRetrying).toBe(true);

    act(() => {
      lastES!.emit('message', { type: 'token', text: 'Hello' });
    });
    expect(result.current.isRetrying).toBe(false);
    expect(result.current.retryReason).toBeNull();
  });

  it('clears isRetrying when a committed message event arrives after retrying', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      lastES!.emit('message', { type: 'retrying', attempt: 2, maxAttempts: 3 });
    });
    expect(result.current.isRetrying).toBe(true);

    const msg = { id: 'msg-r', role: 'agent', text: 'Recovered', ts: '2026-01-01T00:00:00Z' };
    act(() => {
      lastES!.emit('message', { type: 'message', message: msg });
    });
    expect(result.current.isRetrying).toBe(false);
    expect(result.current.retryReason).toBeNull();
  });

  it('clears isRetrying when a done event arrives after retrying', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      lastES!.emit('message', { type: 'retrying', attempt: 1, maxAttempts: 3 });
    });
    expect(result.current.isRetrying).toBe(true);

    act(() => {
      lastES!.emit('message', { type: 'done' });
    });
    expect(result.current.isRetrying).toBe(false);
    expect(result.current.retryReason).toBeNull();
  });

  it('sets isRetrying=true with "Retrying…" reason for a transient error', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      lastES!.emit('message', { type: 'error', error: 'Connection timeout', errorCode: 'transient' });
    });
    expect(result.current.isRetrying).toBe(true);
    expect(result.current.retryReason).toBe('Retrying…');
    expect(result.current.status).not.toBe('error');
  });

  it('sets isRetrying=true with rate-limit reason for a rate_limit error', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      lastES!.emit('message', { type: 'error', error: 'Too many requests', errorCode: 'rate_limit' });
    });
    expect(result.current.isRetrying).toBe(true);
    expect(result.current.retryReason).toBe('Rate limited, retrying…');
    expect(result.current.status).not.toBe('error');
  });

  it('adds a session-expired message and sets status=error for an auth error', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      lastES!.emit('message', { type: 'error', error: 'Unauthorized', errorCode: 'auth' });
    });
    expect(result.current.status).toBe('error');
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].role).toBe('system');
    expect(result.current.messages[0].text).toContain('Session expired');
    expect(result.current.isRetrying).toBe(false);
  });

  it('adds a fallback error message and clears isRetrying after the retry timeout', () => {
    jest.useFakeTimers();
    try {
      const { result } = renderHook(() => useChatStream('t1'));
      act(() => {
        lastES!.emit('message', { type: 'error', error: 'Upstream timeout', errorCode: 'transient' });
      });
      expect(result.current.isRetrying).toBe(true);

      act(() => {
        jest.advanceTimersByTime(5001);
      });

      expect(result.current.isRetrying).toBe(false);
      expect(result.current.retryReason).toBeNull();
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].text).toContain('Upstream timeout');
      expect(result.current.status).toBe('error');
    } finally {
      jest.useRealTimers();
    }
  });

  it('resets isRetrying when threadId changes', () => {
    const { result, rerender } = renderHook(({ id }) => useChatStream(id), {
      initialProps: { id: 'thread-a' as string | null },
    });
    act(() => {
      lastES!.emit('message', { type: 'retrying', attempt: 1, maxAttempts: 3 });
    });
    expect(result.current.isRetrying).toBe(true);

    rerender({ id: 'thread-b' });
    expect(result.current.isRetrying).toBe(false);
    expect(result.current.retryReason).toBeNull();
  });

  it('keeps the EventSource open when only initialMessages identity changes', () => {
    const seed = [{ id: 'u1', role: 'user' as const, text: 'go', ts: '2026-01-01T00:00:00Z' }];
    const { result, rerender } = renderHook(
      ({ messages }) => useChatStream('t1', { initialMessages: messages }),
      { initialProps: { messages: seed } },
    );
    const openES = lastES!;

    act(() => {
      openES.emit('message', {
        type: 'tool_status',
        callId: 'c1',
        toolName: 'edit_file',
        status: 'running',
        semanticPhase: 'implementation',
        semanticStatus: 'running',
        runId: 'run-1',
        eventTimestamp: '2026-01-01T00:01:00Z',
      }, 'evt-tool-1');
    });
    expect(result.current.toolProgress).toHaveLength(1);
    expect(result.current.phaseEvents).toHaveLength(1);

    // Simulate React Query refetch after sendMessage — new array, same content.
    rerender({ messages: [...seed] });

    expect(openES.close).not.toHaveBeenCalled();
    expect(result.current.toolProgress).toHaveLength(1);
    expect(result.current.phaseEvents).toHaveLength(1);
    expect(global.EventSource).toHaveBeenCalledTimes(1);
  });

  it('merges newly loaded initialMessages into an empty live message list', () => {
    const seed = [{ id: 'u1', role: 'user' as const, text: 'hi', ts: '2026-01-01T00:00:00Z' }];
    const { result, rerender } = renderHook(
      ({ messages }) => useChatStream('t1', { initialMessages: messages }),
      { initialProps: { messages: undefined as typeof seed | undefined } },
    );

    expect(result.current.messages).toEqual([]);

    rerender({ messages: seed });
    expect(result.current.messages).toEqual(seed);
    expect(lastES!.close).not.toHaveBeenCalled();
  });
});
