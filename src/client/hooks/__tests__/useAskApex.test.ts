import { renderHook, act, waitFor } from '@testing-library/react';

// ── fetch mock helpers ──────────────────────────────────────────────────────────

function mockFetchOk(data: unknown, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status,
    json: () => Promise.resolve(data),
  }) as jest.Mock;
}

function mockFetchError(status: number, body: unknown = { error: `HTTP ${status}` }) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  }) as jest.Mock;
}

// ── EventSource mock ────────────────────────────────────────────────────────────

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials: boolean;
  readyState = 0;
  private listeners = new Map<string, Set<(e: any) => void>>();

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (e: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  removeEventListener(type: string, cb: (e: any) => void) {
    this.listeners.get(type)?.delete(cb);
  }

  close = jest.fn();

  simulateOpen() {
    this.readyState = 1;
    for (const cb of this.listeners.get('open') ?? []) cb({});
  }

  simulateMessage(data: object) {
    for (const cb of this.listeners.get('message') ?? []) {
      cb({ data: JSON.stringify(data) });
    }
  }

  simulateError() {
    for (const cb of this.listeners.get('error') ?? []) cb({});
  }
}

beforeAll(() => {
  (global as any).EventSource = MockEventSource;
});

afterAll(() => {
  delete (global as any).EventSource;
});

import { useAskApex } from '../useAskApex';

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('useAskApex', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    MockEventSource.instances = [];
  });

  // ── startSession ────────────────────────────────────────────────────────────

  describe('startSession', () => {
    it('calls POST /api/ask-apex/sessions and sets sessionId', async () => {
      mockFetchOk({ sessionId: 'sess-1' });

      const { result } = renderHook(() => useAskApex());

      await act(async () => {
        const sid = await result.current.startSession();
        expect(sid).toBe('sess-1');
      });

      expect(result.current.sessionId).toBe('sess-1');
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/ask-apex/sessions',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('opens an EventSource for SSE streaming', async () => {
      mockFetchOk({ sessionId: 'sess-1' });

      const { result } = renderHook(() => useAskApex());

      await act(async () => {
        await result.current.startSession();
      });

      expect(MockEventSource.instances).toHaveLength(1);
      expect(MockEventSource.instances[0].url).toBe(
        '/api/ask-apex/sessions/sess-1/stream',
      );
    });

    it('returns null when the API fails', async () => {
      mockFetchError(500);
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useAskApex());

      await act(async () => {
        const sid = await result.current.startSession();
        expect(sid).toBeNull();
      });

      expect(result.current.sessionId).toBeNull();
      consoleSpy.mockRestore();
    });
  });

  // ── sendMessage ─────────────────────────────────────────────────────────────

  describe('sendMessage', () => {
    it('calls POST /api/ask-apex/sessions/:id/messages with the text', async () => {
      mockFetchOk({ sessionId: 'sess-1' });
      const { result } = renderHook(() => useAskApex());

      await act(async () => {
        await result.current.startSession();
      });

      mockFetchOk({ ok: true });

      await act(async () => {
        await result.current.sendMessage('Hello');
      });

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/ask-apex/sessions/sess-1/messages',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ text: 'Hello' }),
        }),
      );
    });

    it('does nothing when there is no session', async () => {
      mockFetchOk({ ok: true });
      const { result } = renderHook(() => useAskApex());

      await act(async () => {
        await result.current.sendMessage('Hello');
      });

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('does nothing for empty text', async () => {
      mockFetchOk({ sessionId: 'sess-1' });
      const { result } = renderHook(() => useAskApex());

      await act(async () => {
        await result.current.startSession();
      });

      jest.clearAllMocks();

      await act(async () => {
        await result.current.sendMessage('   ');
      });

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('logs error when the message API fails', async () => {
      mockFetchOk({ sessionId: 'sess-1' });
      const { result } = renderHook(() => useAskApex());

      await act(async () => {
        await result.current.startSession();
      });

      mockFetchError(500);
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await act(async () => {
        await result.current.sendMessage('Hello');
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        '[useAskApex] sendMessage error:',
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });
  });

  // ── closeSession ────────────────────────────────────────────────────────────

  describe('closeSession', () => {
    it('calls DELETE /api/ask-apex/sessions/:id and resets state', async () => {
      mockFetchOk({ sessionId: 'sess-1' });
      const { result } = renderHook(() => useAskApex());

      await act(async () => {
        await result.current.startSession();
      });

      const es = MockEventSource.instances[0];
      mockFetchOk({ ok: true });

      act(() => {
        result.current.closeSession();
      });

      expect(es.close).toHaveBeenCalled();
      expect(result.current.sessionId).toBeNull();
      expect(result.current.messages).toEqual([]);
      expect(result.current.status).toBe('idle');
      expect(result.current.isConnected).toBe(false);

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/ask-apex/sessions/sess-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  // ── SSE event handling ──────────────────────────────────────────────────────

  describe('SSE events', () => {
    it('updates isConnected on open and error', async () => {
      mockFetchOk({ sessionId: 'sess-1' });
      const { result } = renderHook(() => useAskApex());

      await act(async () => {
        await result.current.startSession();
      });

      const es = MockEventSource.instances[0];

      act(() => es.simulateOpen());
      expect(result.current.isConnected).toBe(true);

      act(() => es.simulateError());
      expect(result.current.isConnected).toBe(false);
    });

    it('appends assistant messages from SSE message events', async () => {
      mockFetchOk({ sessionId: 'sess-1' });
      const { result } = renderHook(() => useAskApex());

      await act(async () => {
        await result.current.startSession();
      });

      const es = MockEventSource.instances[0];

      act(() => {
        es.simulateMessage({
          type: 'message',
          message: { id: 'msg-1', role: 'assistant', text: 'Hi', ts: '2026-07-01T00:00:00Z' },
        });
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]).toMatchObject({ id: 'msg-1', text: 'Hi' });
    });

    it('accumulates streaming tokens', async () => {
      mockFetchOk({ sessionId: 'sess-1' });
      const { result } = renderHook(() => useAskApex());

      await act(async () => {
        await result.current.startSession();
      });

      const es = MockEventSource.instances[0];

      act(() => {
        es.simulateMessage({ type: 'token', text: 'Hel' });
        es.simulateMessage({ type: 'token', text: 'lo' });
      });

      expect(result.current.streamingText).toBe('Hello');
    });

    it('updates status from SSE status events', async () => {
      mockFetchOk({ sessionId: 'sess-1' });
      const { result } = renderHook(() => useAskApex());

      await act(async () => {
        await result.current.startSession();
      });

      const es = MockEventSource.instances[0];

      act(() => {
        es.simulateMessage({ type: 'status', status: 'streaming' });
      });

      expect(result.current.status).toBe('streaming');
    });

    it('sets status to error on SSE error event', async () => {
      mockFetchOk({ sessionId: 'sess-1' });
      const { result } = renderHook(() => useAskApex());

      await act(async () => {
        await result.current.startSession();
      });

      const es = MockEventSource.instances[0];

      act(() => {
        es.simulateMessage({ type: 'error', error: 'Something went wrong' });
      });

      expect(result.current.status).toBe('error');
    });

    it('clears streaming text on done event', async () => {
      mockFetchOk({ sessionId: 'sess-1' });
      const { result } = renderHook(() => useAskApex());

      await act(async () => {
        await result.current.startSession();
      });

      const es = MockEventSource.instances[0];

      act(() => {
        es.simulateMessage({ type: 'token', text: 'partial' });
      });
      expect(result.current.streamingText).toBe('partial');

      act(() => {
        es.simulateMessage({ type: 'done' });
      });
      expect(result.current.streamingText).toBe('');
    });
  });
});
