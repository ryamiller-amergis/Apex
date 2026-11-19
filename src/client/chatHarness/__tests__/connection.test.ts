import type { SseEvent } from '../../../shared/types/chat';
import type {
  ConnectionState,
  HarnessCommandBody,
  HarnessErrorFrame,
  HarnessReceipt,
  HarnessThreadSnapshot,
  HarnessThreadState,
} from '../types';
import {
  createChatHarnessConnection,
  type ChatHarnessConnectionHandlers,
  type ChatHarnessConnectionOptions,
} from '../connection';
import {
  FIXTURE_CMD_ID_1,
  FIXTURE_CMD_ID_2,
  FIXTURE_RUN_ID,
  FIXTURE_THREAD_ID,
  makeMessage,
  makeReceipt,
  makeSnapshot,
  makeThreadState,
} from './fixtures';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  close = jest.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
  });

  constructor(public readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.onmessage?.({ data } as MessageEvent);
  }

  simulateDrop(withError = true): void {
    this.readyState = FakeWebSocket.CLOSED;
    if (withError) {
      this.onerror?.(new Event('error'));
    }
    this.onclose?.({ code: 1006, reason: '' } as CloseEvent);
  }
}

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createHarnessTestRig(
  overrides: Partial<ChatHarnessConnectionOptions> = {},
  fetchMock?: jest.Mock<Promise<Response>, never[]> | jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>,
) {
  const sockets: FakeWebSocket[] = [];
  const states: ConnectionState[] = [];
  const snapshots: HarnessThreadSnapshot[] = [];
  const snapshotErrors: Array<{ status: number; message: string }> = [];
  const events: Array<{ event: SseEvent; id: string }> = [];
  const receipts: HarnessReceipt[] = [];
  const stateFrames: HarnessThreadState[] = [];
  const errorFrames: HarnessErrorFrame[] = [];
  const onSignedOut = jest.fn();

  const defaultFetch =
    fetchMock ??
    jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async () =>
      jsonResponse(makeSnapshot()),
    );

  const handlers: ChatHarnessConnectionHandlers = {
    onStateChange: (s) => states.push(s),
    onSnapshot: (snap) => snapshots.push(snap),
    onSnapshotError: (status, message) => snapshotErrors.push({ status, message }),
    onEvent: (event, id) => events.push({ event, id }),
    onReceipt: (receipt) => receipts.push(receipt),
    onStateFrame: (state) => stateFrames.push(state),
    onErrorFrame: (frame) => errorFrames.push(frame),
    onSignedOut,
  };

  const connection = createChatHarnessConnection(FIXTURE_THREAD_ID, handlers, {
    webSocketFactory: (url) => {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
    fetchImpl: defaultFetch as unknown as typeof fetch,
    ...overrides,
  });

  return {
    connection,
    sockets,
    states,
    snapshots,
    snapshotErrors,
    events,
    receipts,
    stateFrames,
    errorFrames,
    onSignedOut,
    fetchMock: defaultFetch,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('S2 chatHarness connection module', () => {
  describe('initial mount and snapshot loading', () => {
    it('fetches initial snapshot and opens WebSocket in parallel on start()', async () => {
      const snapshot = makeSnapshot({
        messages: [makeMessage({ id: 'msg-1', text: 'Existing message' })],
      });
      const fetchMock = jest.fn(async () => jsonResponse(snapshot));
      const rig = createHarnessTestRig({}, fetchMock);

      expect(rig.connection.getState()).toBe('connecting');

      rig.connection.start();

      // Socket opens immediately in parallel with snapshot fetch.
      expect(rig.sockets).toHaveLength(1);
      expect(rig.sockets[0].url).toMatch(
        new RegExp(`^wss?://[^/]+/api/interactive/threads/${FIXTURE_THREAD_ID}/stream$`),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/harness/threads/${FIXTURE_THREAD_ID}/snapshot`,
        expect.objectContaining({
          method: 'GET',
          credentials: 'include',
        }),
      );

      rig.sockets[0].simulateOpen();
      await flushMicrotasks();

      expect(rig.connection.getState()).toBe('open');
      expect(rig.states).toEqual(['open']);
      expect(rig.snapshots).toEqual([snapshot]);

      rig.connection.close();
    });

    it('passes initial lastEventId query param when provided in options', () => {
      const rig = createHarnessTestRig({ lastEventId: '19' });
      rig.connection.start();

      expect(rig.connection.getLastEventId()).toBe('19');
      expect(rig.sockets[0].url).toContain('?lastEventId=19');

      rig.connection.close();
    });

    it('reports non-OK non-401 snapshot errors via onSnapshotError', async () => {
      const fetchMock = jest.fn(async () =>
        jsonResponse({ error: 'Forbidden for this project' }, 403, 'Forbidden'),
      );
      const rig = createHarnessTestRig({}, fetchMock);

      rig.connection.start();
      await flushMicrotasks();

      expect(rig.snapshots).toHaveLength(0);
      expect(rig.snapshotErrors).toEqual([
        { status: 403, message: 'Forbidden for this project' },
      ]);
      expect(rig.onSignedOut).not.toHaveBeenCalled();

      rig.connection.close();
    });

    it('transitions to signed-out and closes socket when initial snapshot returns 401', async () => {
      const fetchMock = jest.fn(async () =>
        jsonResponse({ error: 'Authentication required' }, 401, 'Unauthorized'),
      );
      const rig = createHarnessTestRig({}, fetchMock);

      rig.connection.start();
      await flushMicrotasks();

      expect(rig.connection.getState()).toBe('signed-out');
      expect(rig.onSignedOut).toHaveBeenCalledTimes(1);
      expect(rig.snapshots).toHaveLength(0);
      expect(rig.sockets[0].close).toHaveBeenCalled();

      jest.advanceTimersByTime(60_000);
      expect(rig.sockets).toHaveLength(1);
    });
  });

  describe('inbound frame dispatch and unknown frame ignore', () => {
    it('routes event, receipt, state, and error frames and silently ignores unknown frames', async () => {
      const rig = createHarnessTestRig();
      rig.connection.start();
      rig.sockets[0].simulateOpen();
      await flushMicrotasks();

      const statePayload = makeThreadState({
        threadStatus: 'running',
        activeRunId: FIXTURE_RUN_ID,
        phase: 'running',
      });
      const receiptPayload = makeReceipt({
        commandId: FIXTURE_CMD_ID_1,
        kind: 'steer',
        status: 'applied',
      });
      const eventPayload: SseEvent = {
        type: 'token',
        text: 'Hello',
        streamOffset: 0,
        runId: FIXTURE_RUN_ID,
      };
      const errorPayload: HarnessErrorFrame = {
        type: 'error',
        code: 'invalid_command',
        commandId: FIXTURE_CMD_ID_1,
      };

      expect(() => {
        rig.sockets[0].simulateMessage({ type: 'state', state: statePayload });
        rig.sockets[0].simulateMessage({ type: 'receipt', receipt: receiptPayload });
        rig.sockets[0].simulateMessage({ type: 'event', id: '25', data: eventPayload });
        rig.sockets[0].simulateMessage(errorPayload);
        rig.sockets[0].simulateMessage({ type: 'unknown_future_frame', foo: 'bar' });
        rig.sockets[0].simulateMessage('not valid json {{{');
      }).not.toThrow();

      expect(rig.stateFrames).toEqual([statePayload]);
      expect(rig.receipts).toEqual([receiptPayload]);
      expect(rig.events).toEqual([{ event: eventPayload, id: '25' }]);
      expect(rig.errorFrames).toEqual([errorPayload]);
      expect(rig.connection.getLastEventId()).toBe('25');

      rig.connection.close();
    });
  });

  describe('VT-15 / PBI-014 AC-1 / TBI-017 DoD-2: drop -> reconnecting -> restored with replay', () => {
    it('retries after 500ms with lastEventId, transitions to restored, and forwards replayed events', async () => {
      const rig = createHarnessTestRig();
      rig.connection.start();
      rig.sockets[0].simulateOpen();
      rig.sockets[0].simulateMessage({ type: 'state', state: makeThreadState() });
      await flushMicrotasks();

      // Receive events up to id '40'.
      rig.sockets[0].simulateMessage({
        type: 'event',
        id: '39',
        data: { type: 'token', text: 'part-1', streamOffset: 0, runId: FIXTURE_RUN_ID },
      });
      rig.sockets[0].simulateMessage({
        type: 'event',
        id: '40',
        data: { type: 'token', text: 'part-2', streamOffset: 6, runId: FIXTURE_RUN_ID },
      });
      expect(rig.connection.getLastEventId()).toBe('40');

      // Connection drops mid-turn.
      rig.sockets[0].simulateDrop();
      expect(rig.connection.getState()).toBe('reconnecting');

      // Does not reconnect before 500ms.
      jest.advanceTimersByTime(499);
      expect(rig.sockets).toHaveLength(1);

      // At 500ms, opens retry socket with ?lastEventId=40.
      jest.advanceTimersByTime(1);
      expect(rig.sockets).toHaveLength(2);
      expect(rig.sockets[1].url).toContain('?lastEventId=40');

      // Retry succeeds -> transitions to 'restored'.
      rig.sockets[1].simulateOpen();
      rig.sockets[1].simulateMessage({ type: 'state', state: makeThreadState() });
      expect(rig.connection.getState()).toBe('restored');
      expect(rig.states).toEqual(['open', 'reconnecting', 'restored']);

      // Replayed events 41..44 forwarded in order.
      for (const id of ['41', '42', '43', '44']) {
        rig.sockets[1].simulateMessage({
          type: 'event',
          id,
          data: { type: 'token', text: `chunk-${id}`, runId: FIXTURE_RUN_ID },
        });
      }

      expect(rig.events.map((e) => e.id)).toEqual(['39', '40', '41', '42', '43', '44']);
      expect(rig.connection.getLastEventId()).toBe('44');

      rig.connection.close();
    });
  });

  describe('VT-14 / PBI-014 AC-2 / TBI-017 DoD-2: failed retry -> unavailable -> backoff -> HTTP fallback -> active poll', () => {
    it('transitions to unavailable after failed first retry, loads snapshot, backs off exponentially capped at 30s, polls every 5s during active turn, and restores on success', async () => {
      const initialSnap = makeSnapshot({
        messages: [makeMessage({ id: 'm1', text: 'First' })],
      });
      const fallbackSnap = makeSnapshot({
        messages: [
          makeMessage({ id: 'm1', text: 'First' }),
          makeMessage({ id: 'm2', role: 'agent', text: 'Loaded over fallback' }),
        ],
      });

      const fetchMock = jest
        .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
        .mockResolvedValueOnce(jsonResponse(initialSnap))
        .mockResolvedValue(jsonResponse(fallbackSnap));

      const rig = createHarnessTestRig({}, fetchMock);
      rig.connection.start();
      rig.sockets[0].simulateOpen();
      rig.sockets[0].simulateMessage({ type: 'state', state: makeThreadState() });
      await flushMicrotasks();

      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Initial drop -> 'reconnecting', retry scheduled in 500ms.
      rig.sockets[0].simulateDrop();
      expect(rig.connection.getState()).toBe('reconnecting');

      jest.advanceTimersByTime(500);
      expect(rig.sockets).toHaveLength(2);

      // First retry fails before open -> 'unavailable' + immediate snapshot fetch.
      rig.sockets[1].simulateDrop();
      await flushMicrotasks();

      expect(rig.connection.getState()).toBe('unavailable');
      expect(rig.states).toEqual(['open', 'reconnecting', 'unavailable']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(rig.snapshots).toHaveLength(2);
      expect(rig.snapshots[1]).toEqual(fallbackSnap);

      // Exponential backoff sequence: 1s, 2s, 4s, 8s, 16s, 30s, 30s.
      const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
      let socketCount = 2;
      for (const delay of expectedDelays) {
        jest.advanceTimersByTime(delay - 1);
        expect(rig.sockets).toHaveLength(socketCount);

        jest.advanceTimersByTime(1);
        socketCount += 1;
        expect(rig.sockets).toHaveLength(socketCount);

        // Fail this silent retry -> stays 'unavailable'.
        rig.sockets[socketCount - 1].simulateDrop();
        expect(rig.connection.getState()).toBe('unavailable');
      }

      // Active-turn snapshot polling every 5s while unavailable.
      const snapshotsBeforePoll = fetchMock.mock.calls.length;
      rig.connection.setActiveTurn(true);

      jest.advanceTimersByTime(4_999);
      expect(fetchMock.mock.calls.length).toBe(snapshotsBeforePoll);

      jest.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(fetchMock.mock.calls.length).toBe(snapshotsBeforePoll + 1);

      jest.advanceTimersByTime(5_000);
      await flushMicrotasks();
      expect(fetchMock.mock.calls.length).toBe(snapshotsBeforePoll + 2);

      // Next scheduled backoff retry (at remaining 20s of the 30s backoff) succeeds!
      jest.advanceTimersByTime(20_000);
      expect(rig.sockets).toHaveLength(socketCount + 1);
      rig.sockets[socketCount].simulateOpen();
      rig.sockets[socketCount].simulateMessage({ type: 'state', state: makeThreadState() });
      await flushMicrotasks();

      expect(rig.connection.getState()).toBe('restored');

      // Polling stops once restored.
      const snapshotsAfterRestore = fetchMock.mock.calls.length;
      jest.advanceTimersByTime(15_000);
      expect(fetchMock.mock.calls.length).toBe(snapshotsAfterRestore);

      // Backoff reset verified: a subsequent drop retries at 500ms, not 30s.
      const countBeforeSecondDrop = rig.sockets.length;
      rig.sockets[socketCount].simulateDrop();
      expect(rig.connection.getState()).toBe('reconnecting');
      jest.advanceTimersByTime(500);
      expect(rig.sockets).toHaveLength(countBeforeSecondDrop + 1);

      rig.connection.close();
    });

    it('stops 5s snapshot polling when setActiveTurn(false) is called while unavailable', async () => {
      const rig = createHarnessTestRig();
      rig.connection.start();
      rig.sockets[0].simulateOpen();
      rig.sockets[0].simulateMessage({ type: 'state', state: makeThreadState() });
      await flushMicrotasks();

      // Drop and fail first retry -> unavailable.
      rig.sockets[0].simulateDrop();
      jest.advanceTimersByTime(500);
      rig.sockets[1].simulateDrop();
      await flushMicrotasks();

      expect(rig.connection.getState()).toBe('unavailable');
      const countBefore = rig.fetchMock.mock.calls.length;

      rig.connection.setActiveTurn(true);
      jest.advanceTimersByTime(5_000);
      await flushMicrotasks();
      expect(rig.fetchMock.mock.calls.length).toBe(countBefore + 1);

      rig.connection.setActiveTurn(false);
      jest.advanceTimersByTime(15_000);
      await flushMicrotasks();
      expect(rig.fetchMock.mock.calls.length).toBe(countBefore + 1);

      rig.connection.close();
    });
  });

  describe('VT-16 / PBI-014 AC-3: 401 session expiry after drop', () => {
    it('transitions to signed-out, emits onSignedOut, closes socket, and halts all reconnects', async () => {
      const fetchMock = jest
        .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
        .mockResolvedValueOnce(jsonResponse(makeSnapshot()))
        .mockResolvedValueOnce(
          jsonResponse({ error: 'Session expired' }, 401, 'Unauthorized'),
        );

      const rig = createHarnessTestRig({}, fetchMock);
      rig.connection.start();
      rig.sockets[0].simulateOpen();
      rig.sockets[0].simulateMessage({ type: 'state', state: makeThreadState() });
      await flushMicrotasks();

      expect(rig.snapshots).toHaveLength(1);

      // Session expires during drop: drop -> first retry fails -> snapshot returns 401.
      rig.sockets[0].simulateDrop();
      jest.advanceTimersByTime(500);
      rig.sockets[1].simulateDrop();
      await flushMicrotasks();

      expect(rig.connection.getState()).toBe('signed-out');
      expect(rig.onSignedOut).toHaveBeenCalledTimes(1);
      // No thread data emitted for the 401 snapshot.
      expect(rig.snapshots).toHaveLength(1);

      const socketCountAtSignOut = rig.sockets.length;
      const fetchCountAtSignOut = fetchMock.mock.calls.length;

      // No further reconnects or polls even with active turn set.
      rig.connection.setActiveTurn(true);
      jest.advanceTimersByTime(60_000);
      await flushMicrotasks();

      expect(rig.sockets).toHaveLength(socketCountAtSignOut);
      expect(fetchMock.mock.calls.length).toBe(fetchCountAtSignOut);
    });
  });

  describe('version-skew state-frame timeout guard', () => {
    it('reads snapshot if no state frame arrives within 2000ms of socket open', async () => {
      const rig = createHarnessTestRig();
      rig.connection.start();
      await flushMicrotasks();
      expect(rig.fetchMock).toHaveBeenCalledTimes(1);

      rig.sockets[0].simulateOpen();

      jest.advanceTimersByTime(1_999);
      expect(rig.fetchMock).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(rig.fetchMock).toHaveBeenCalledTimes(2);

      rig.connection.close();
    });

    it('cancels the 2000ms snapshot read when a state frame arrives in time', async () => {
      const rig = createHarnessTestRig();
      rig.connection.start();
      await flushMicrotasks();
      expect(rig.fetchMock).toHaveBeenCalledTimes(1);

      rig.sockets[0].simulateOpen();
      jest.advanceTimersByTime(500);
      rig.sockets[0].simulateMessage({ type: 'state', state: makeThreadState() });

      jest.advanceTimersByTime(5_000);
      await flushMicrotasks();
      expect(rig.fetchMock).toHaveBeenCalledTimes(1);

      rig.connection.close();
    });
  });

  describe('commands: WebSocket transport, HTTP fallback, and explicit HTTP retry', () => {
    it('sends command frame over open WebSocket and returns null', async () => {
      const rig = createHarnessTestRig();
      rig.connection.start();
      rig.sockets[0].simulateOpen();
      rig.sockets[0].simulateMessage({ type: 'state', state: makeThreadState() });
      await flushMicrotasks();

      const body: HarnessCommandBody = {
        commandId: FIXTURE_CMD_ID_1,
        kind: 'send',
        text: 'Draft a release note',
      };

      const receipt = await rig.connection.sendCommand(body);
      expect(receipt).toBeNull();
      expect(rig.sockets[0].sent).toHaveLength(1);
      expect(JSON.parse(rig.sockets[0].sent[0])).toEqual({
        type: 'command',
        ...body,
      });
      // Only initial snapshot fetch occurred; no HTTP command POST.
      expect(rig.fetchMock).toHaveBeenCalledTimes(1);

      rig.connection.close();
    });

    it('falls back to POST /api/harness/threads/:id/commands while socket is not open', async () => {
      const expectedReceipt = makeReceipt({
        commandId: FIXTURE_CMD_ID_1,
        kind: 'send',
        status: 'accepted',
        runId: FIXTURE_RUN_ID,
      });

      const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
        async (url) => {
          if (String(url).endsWith('/commands')) {
            return jsonResponse(expectedReceipt, 200);
          }
          return jsonResponse(makeSnapshot(), 200);
        },
      );

      const rig = createHarnessTestRig({}, fetchMock);
      rig.connection.start();
      rig.sockets[0].simulateOpen();
      rig.sockets[0].simulateMessage({ type: 'state', state: makeThreadState() });
      await flushMicrotasks();

      // Drop socket so readyState is CLOSED.
      rig.sockets[0].simulateDrop();

      const body: HarnessCommandBody = {
        commandId: FIXTURE_CMD_ID_1,
        kind: 'send',
        text: 'Hello over HTTP fallback',
      };

      const receipt = await rig.connection.sendCommand(body);
      expect(receipt).toEqual(expectedReceipt);
      expect(rig.receipts).toEqual([expectedReceipt]);
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/harness/threads/${FIXTURE_THREAD_ID}/commands`,
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );

      rig.connection.close();
    });

    it('sendCommandOverHttp posts to HTTP commands endpoint even while socket is open', async () => {
      const expectedReceipt = makeReceipt({
        commandId: FIXTURE_CMD_ID_2,
        kind: 'steer',
        status: 'applied',
      });
      const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
        async (url) => {
          if (String(url).endsWith('/commands')) {
            return jsonResponse(expectedReceipt, 200);
          }
          return jsonResponse(makeSnapshot(), 200);
        },
      );

      const rig = createHarnessTestRig({}, fetchMock);
      rig.connection.start();
      rig.sockets[0].simulateOpen();
      rig.sockets[0].simulateMessage({ type: 'state', state: makeThreadState() });
      await flushMicrotasks();

      const body: HarnessCommandBody = {
        commandId: FIXTURE_CMD_ID_2,
        kind: 'steer',
        text: 'Focus on the API contract',
      };

      const receipt = await rig.connection.sendCommandOverHttp(body);
      expect(receipt).toEqual(expectedReceipt);
      expect(rig.receipts).toEqual([expectedReceipt]);
      expect(rig.sockets[0].sent).toHaveLength(0);

      rig.connection.close();
    });

    it('transitions to signed-out when HTTP command returns 401', async () => {
      const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
        async (url) => {
          if (String(url).endsWith('/commands')) {
            return jsonResponse({ error: 'Unauthorized' }, 401, 'Unauthorized');
          }
          return jsonResponse(makeSnapshot(), 200);
        },
      );

      const rig = createHarnessTestRig({}, fetchMock);
      rig.connection.start();
      rig.sockets[0].simulateOpen();
      rig.sockets[0].simulateMessage({ type: 'state', state: makeThreadState() });
      await flushMicrotasks();

      const receipt = await rig.connection.sendCommandOverHttp({
        commandId: FIXTURE_CMD_ID_1,
        kind: 'cancel',
      });

      expect(receipt).toBeNull();
      expect(rig.connection.getState()).toBe('signed-out');
      expect(rig.onSignedOut).toHaveBeenCalledTimes(1);
      expect(rig.sockets[0].close).toHaveBeenCalled();
    });

    it('throws an Error when HTTP command returns a non-401 error status', async () => {
      const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
        async (url) => {
          if (String(url).endsWith('/commands')) {
            return jsonResponse({ error: 'Invalid command payload' }, 400, 'Bad Request');
          }
          return jsonResponse(makeSnapshot(), 200);
        },
      );

      const rig = createHarnessTestRig({}, fetchMock);
      rig.connection.start();
      await flushMicrotasks();

      await expect(
        rig.connection.sendCommandOverHttp({
          commandId: FIXTURE_CMD_ID_1,
          kind: 'summarize',
        }),
      ).rejects.toThrow('Invalid command payload');

      rig.connection.close();
    });
  });

  describe('cleanup and log privacy', () => {
    it('stops all timers and ignores events after close()', async () => {
      const rig = createHarnessTestRig();
      rig.connection.start();
      rig.sockets[0].simulateOpen();
      await flushMicrotasks();

      rig.connection.close();
      expect(rig.connection.getState()).toBe('closed');
      expect(rig.sockets[0].close).toHaveBeenCalled();

      // Late messages or drops do nothing.
      rig.sockets[0].simulateMessage({
        type: 'event',
        id: '99',
        data: { type: 'token', text: 'late', runId: FIXTURE_RUN_ID },
      });
      rig.sockets[0].simulateDrop();

      jest.advanceTimersByTime(60_000);
      expect(rig.events).toHaveLength(0);
      expect(rig.sockets).toHaveLength(1);
      expect(rig.fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never logs message or steer text to console', async () => {
      const sentinel = 'SENTINEL_SECRET_PROMPT_TEXT_9942';
      const consoleSpies = [
        jest.spyOn(console, 'log').mockImplementation(() => {}),
        jest.spyOn(console, 'info').mockImplementation(() => {}),
        jest.spyOn(console, 'warn').mockImplementation(() => {}),
        jest.spyOn(console, 'error').mockImplementation(() => {}),
        jest.spyOn(console, 'debug').mockImplementation(() => {}),
      ];

      const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
        async (url) => {
          if (String(url).endsWith('/commands')) {
            return jsonResponse({ error: 'Command rejected' }, 500, 'Internal Server Error');
          }
          return jsonResponse(makeSnapshot(), 200);
        },
      );

      const rig = createHarnessTestRig({}, fetchMock);
      rig.connection.start();
      rig.sockets[0].simulateOpen();
      await flushMicrotasks();

      // Over WS
      await rig.connection.sendCommand({
        commandId: FIXTURE_CMD_ID_1,
        kind: 'send',
        text: sentinel,
      });

      // Unknown frame containing sentinel
      rig.sockets[0].simulateMessage({ type: 'unknown', secret: sentinel });

      // Over HTTP failure
      await expect(
        rig.connection.sendCommandOverHttp({
          commandId: FIXTURE_CMD_ID_2,
          kind: 'steer',
          text: sentinel,
        }),
      ).rejects.toThrow('Command rejected');

      for (const spy of consoleSpies) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(sentinel);
        }
      }

      rig.connection.close();
    });
  });
});
