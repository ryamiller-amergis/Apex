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
  emit: (type: string, data: unknown) => void;
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
    emit(type: string, data: unknown) {
      const cbs = listeners[type] ?? [];
      const event = { data: JSON.stringify(data) } as MessageEvent;
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

  it('adds a synthetic tool_call message', () => {
    const { result } = renderHook(() => useChatStream('t1'));
    act(() => {
      lastES!.emit('message', { type: 'tool_call', toolName: 'list_files' });
    });
    expect(result.current.messages).toHaveLength(1);
    const toolMsg = result.current.messages[0];
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.text).toBe('→ list_files');
    expect(toolMsg.toolName).toBe('list_files');
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
});
