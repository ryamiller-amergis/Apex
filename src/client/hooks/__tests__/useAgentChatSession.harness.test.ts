import { act, renderHook, waitFor } from '@testing-library/react';
import { useAgentChatSession } from '../useAgentChatSession';
import {
  FIXTURE_CMD_ID_1,
  FIXTURE_CMD_ID_2,
  FIXTURE_RUN_ID,
  FIXTURE_THREAD_ID,
  makeMessage,
  makeReceipt,
  makeSnapshot,
  makeThreadState,
} from '../../chatHarness/testFixtures';
import type { HarnessThreadSnapshot } from '../../../shared/types/chatHarness';

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

const CMD_ID_3 = '10000000-0000-4000-8000-000000000203';
const CMD_ID_4 = '10000000-0000-4000-8000-000000000204';
const CMD_ID_5 = '10000000-0000-4000-8000-000000000205';

function createRuntimeTestRig(
  snapshotOrResponse: HarnessThreadSnapshot | Response = makeSnapshot(),
) {
  const sockets: FakeWebSocket[] = [];
  const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
    async (input) => {
      const url = String(input);
      if (url.endsWith('/snapshot')) {
        return 'ok' in snapshotOrResponse
          ? snapshotOrResponse
          : jsonResponse(snapshotOrResponse, 200);
      }
      return jsonResponse({ ok: true }, 200);
    },
  );

  const webSocketFactory = (url: string): WebSocket => {
    const ws = new FakeWebSocket(url);
    sockets.push(ws);
    return ws as unknown as WebSocket;
  };

  return {
    sockets,
    fetchMock,
    runtimeDeps: {
      webSocketFactory,
      fetchImpl: fetchMock as unknown as typeof fetch,
    },
  };
}

describe('S5 useAgentChatSession harness delegation', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('VT-08 / PBI-012 derived-neg: 403 snapshot hides thread data and sets error state', () => {
    it('exposes empty messages/activity and populates snapshotError + sendError on 403', async () => {
      const rig = createRuntimeTestRig(
        jsonResponse({ error: 'Forbidden: no access to this thread' }, 403, 'Forbidden'),
      );

      const { result, unmount } = renderHook(() =>
        useAgentChatSession(FIXTURE_THREAD_ID, {
          useHarness: true,
          initialMessages: [
            makeMessage({ id: 'seeded-secret', text: 'Should not be exposed' }),
          ],
          runtimeDeps: rig.runtimeDeps,
        }),
      );

      await waitFor(() => {
        expect(result.current.snapshotLoaded).toBe(true);
      });

      expect(result.current.snapshotStatusCode).toBe(403);
      expect(result.current.snapshotError).toBe('Forbidden: no access to this thread');
      expect(result.current.sendError).toBe('Forbidden: no access to this thread');
      expect(result.current.messages).toEqual([]);
      expect(result.current.visibleMessages).toEqual([]);
      expect(result.current.activity).toEqual([]);

      unmount();
    });
  });

  describe('VT-41 / TBI-017 no-area HTTP path: snapshot with harnessArea: null', () => {
    it('uses HTTP send/cancel/retry endpoints, disables Steer and Summarize, and still renders live WS events', async () => {
      const noAreaSnapshot = makeSnapshot({
        state: makeThreadState({
          harnessArea: null,
          threadStatus: 'idle',
          canWrite: true,
        }),
      });
      const rig = createRuntimeTestRig(noAreaSnapshot);

      const sendEndpoint = '/api/dev-sessions/s1/messages';
      const cancelEndpoint = '/api/dev-sessions/s1/cancel';
      const retryEndpoint = (runId: string) =>
        `/api/dev-sessions/s1/runs/${runId}/retry`;

      const { result, unmount } = renderHook(() =>
        useAgentChatSession(FIXTURE_THREAD_ID, {
          useHarness: true,
          sendEndpoint,
          cancelEndpoint,
          retryEndpoint,
          createTurnId: () => FIXTURE_CMD_ID_1,
          runtimeDeps: rig.runtimeDeps,
        }),
      );

      await waitFor(() => {
        expect(result.current.snapshotLoaded).toBe(true);
      });

      act(() => {
        rig.sockets[0].simulateOpen();
        rig.sockets[0].simulateMessage({
          type: 'state',
          state: makeThreadState({ harnessArea: null, threadStatus: 'idle' }),
        });
      });

      expect(result.current.harnessArea).toBeNull();
      expect(result.current.isSteerSupported).toBe(false);
      expect(result.current.isSummarizeSupported).toBe(false);

      // Steer and Summarize must return false without WS frames or HTTP calls
      const fetchCountBefore = rig.fetchMock.mock.calls.length;
      let steerOk = true;
      let summarizeOk = true;
      await act(async () => {
        steerOk = await result.current.steer('Change direction');
        summarizeOk = await result.current.summarize();
      });
      expect(steerOk).toBe(false);
      expect(summarizeOk).toBe(false);
      expect(rig.sockets[0].sent).toHaveLength(0);
      expect(rig.fetchMock.mock.calls.length).toBe(fetchCountBefore);

      // send() uses HTTP sendEndpoint
      await act(async () => {
        const ok = await result.current.send('Run dev check');
        expect(ok).toBe(true);
      });
      expect(rig.fetchMock).toHaveBeenCalledWith(
        sendEndpoint,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ turnId: FIXTURE_CMD_ID_1, text: 'Run dev check' }),
        }),
      );
      expect(rig.sockets[0].sent).toHaveLength(0);

      // Live WS events still render streamingText and messages
      act(() => {
        rig.sockets[0].simulateMessage({
          type: 'event',
          id: 'ev-tok-1',
          data: {
            type: 'token',
            text: 'Checking build…',
            streamOffset: 0,
            runId: FIXTURE_RUN_ID,
          },
        });
      });
      expect(result.current.streamingText).toBe('Checking build…');

      act(() => {
        rig.sockets[0].simulateMessage({
          type: 'event',
          id: 'ev-msg-1',
          data: {
            type: 'message',
            message: makeMessage({
              id: 'agent-reply-1',
              role: 'agent',
              text: 'Build is green.',
              ts: '2026-11-19T00:01:00.000Z',
            }),
          },
        });
        rig.sockets[0].simulateMessage({
          type: 'event',
          id: 'ev-done-1',
          data: { type: 'done', runId: FIXTURE_RUN_ID },
        });
      });
      expect(result.current.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'agent-reply-1', text: 'Build is green.' }),
        ]),
      );

      // cancel() uses HTTP cancelEndpoint
      await act(async () => {
        await result.current.cancel();
      });
      expect(rig.fetchMock).toHaveBeenCalledWith(
        cancelEndpoint,
        expect.objectContaining({ method: 'POST' }),
      );

      // retryFailedRun() uses HTTP retryEndpoint
      await act(async () => {
        await result.current.retryFailedRun(FIXTURE_RUN_ID);
      });
      expect(rig.fetchMock).toHaveBeenCalledWith(
        retryEndpoint(FIXTURE_RUN_ID),
        expect.objectContaining({ method: 'POST', body: '{}' }),
      );
      expect(rig.sockets[0].sent).toHaveLength(0);

      unmount();
    });
  });

  describe('Harness active (harnessArea: agent-home): send, steer, summarize, cancel, retry', () => {
    it('dispatches WS commands, commits optimistic send synchronously, updates receipts/summaryNotice/stopping, and retries by runId', async () => {
      const cmdIds = [
        FIXTURE_CMD_ID_1,
        FIXTURE_CMD_ID_2,
        CMD_ID_3,
        CMD_ID_4,
        CMD_ID_5,
      ];
      let cmdIdx = 0;
      const createTurnId = () => cmdIds[cmdIdx++];

      const rig = createRuntimeTestRig(
        makeSnapshot({
          state: makeThreadState({
            harnessArea: 'agent-home',
            threadStatus: 'idle',
            canWrite: true,
          }),
        }),
      );

      const { result, unmount } = renderHook(() =>
        useAgentChatSession(FIXTURE_THREAD_ID, {
          harnessArea: 'agent-home',
          createTurnId,
          runtimeDeps: rig.runtimeDeps,
        }),
      );

      await waitFor(() => {
        expect(result.current.snapshotLoaded).toBe(true);
      });

      act(() => {
        rig.sockets[0].simulateOpen();
        rig.sockets[0].simulateMessage({
          type: 'state',
          state: makeThreadState({ harnessArea: 'agent-home', threadStatus: 'idle' }),
        });
      });

      expect(result.current.isSteerSupported).toBe(true);
      expect(result.current.isSummarizeSupported).toBe(true);
      expect(result.current.harnessArea).toBe('agent-home');
      expect(result.current.connectionState).toBe('open');

      // 1. send() commits optimistic message synchronously and dispatches WS command
      act(() => {
        void result.current.send('Plan the sprint');
      });
      expect(result.current.visibleMessages).toEqual([
        expect.objectContaining({
          id: FIXTURE_CMD_ID_1,
          role: 'user',
          text: 'Plan the sprint',
        }),
      ]);
      expect(rig.sockets[0].sent).toHaveLength(1);
      expect(JSON.parse(rig.sockets[0].sent[0])).toEqual({
        type: 'command',
        commandId: FIXTURE_CMD_ID_1,
        kind: 'send',
        text: 'Plan the sprint',
      });

      // Server transitions turn to running and streams tokens
      act(() => {
        rig.sockets[0].simulateMessage({
          type: 'state',
          state: makeThreadState({
            harnessArea: 'agent-home',
            threadStatus: 'running',
            activeRunId: FIXTURE_RUN_ID,
            phase: 'running',
          }),
        });
        rig.sockets[0].simulateMessage({
          type: 'event',
          id: 't-1',
          data: {
            type: 'token',
            text: 'Working on it',
            streamOffset: 0,
            runId: FIXTURE_RUN_ID,
          },
        });
      });
      expect(result.current.isRunning).toBe(true);
      expect(result.current.streamingText).toBe('Working on it');

      // 2. steer() dispatches WS steer command and receipt populates lastReceipt ("Steer sent")
      await act(async () => {
        const ok = await result.current.steer('Include bug triage');
        expect(ok).toBe(true);
      });
      expect(JSON.parse(rig.sockets[0].sent[1])).toEqual({
        type: 'command',
        commandId: FIXTURE_CMD_ID_2,
        kind: 'steer',
        text: 'Include bug triage',
      });

      act(() => {
        rig.sockets[0].simulateMessage({
          type: 'receipt',
          receipt: makeReceipt({
            commandId: FIXTURE_CMD_ID_2,
            kind: 'steer',
            status: 'applied',
          }),
        });
      });
      expect(result.current.lastReceipt).toMatchObject({
        commandId: FIXTURE_CMD_ID_2,
        kind: 'steer',
        status: 'applied',
        text: 'Steer sent',
      });

      // 3. summarize() dispatches WS summarize command and shows summaryNotice
      await act(async () => {
        const ok = await result.current.summarize();
        expect(ok).toBe(true);
      });
      expect(JSON.parse(rig.sockets[0].sent[2])).toEqual({
        type: 'command',
        commandId: CMD_ID_3,
        kind: 'summarize',
      });

      act(() => {
        rig.sockets[0].simulateMessage({
          type: 'state',
          state: makeThreadState({
            harnessArea: 'agent-home',
            threadStatus: 'running',
            activeRunId: FIXTURE_RUN_ID,
            phase: 'summarizing',
          }),
        });
      });
      expect(result.current.summaryNotice).toEqual({
        status: 'running',
        text: 'Summarizing conversation…',
        isFallback: false,
      });

      // 4. cancel() immediately halts isRunning and freezes streamingText against late tokens
      act(() => {
        void result.current.cancel();
      });
      expect(result.current.isRunning).toBe(false);
      expect(JSON.parse(rig.sockets[0].sent[3])).toEqual({
        type: 'command',
        commandId: CMD_ID_4,
        kind: 'cancel',
      });

      // Late token must not advance streamingText while stopping
      act(() => {
        rig.sockets[0].simulateMessage({
          type: 'event',
          id: 't-late',
          data: {
            type: 'token',
            text: ' late text',
            streamOffset: 13,
            runId: FIXTURE_RUN_ID,
          },
        });
      });
      expect(result.current.streamingText).toBe('Working on it');

      // Server confirms idle -> streamingText clears
      act(() => {
        rig.sockets[0].simulateMessage({
          type: 'state',
          state: makeThreadState({
            harnessArea: 'agent-home',
            threadStatus: 'idle',
            activeRunId: null,
            phase: 'idle',
          }),
        });
      });
      expect(result.current.streamingText).toBe('');

      // 5. retryFailedRun() dispatches WS retry command with runId
      await act(async () => {
        await result.current.retryFailedRun(FIXTURE_RUN_ID);
      });
      expect(JSON.parse(rig.sockets[0].sent[4])).toEqual({
        type: 'command',
        commandId: CMD_ID_5,
        kind: 'retry',
        runId: FIXTURE_RUN_ID,
      });

      unmount();
      expect(rig.sockets[0].close).toHaveBeenCalled();
    });
  });

  describe('canWrite: false blocks mutating commands', () => {
    it('sets canWrite=false from snapshot or state frame and blocks send, steer, summarize, cancel', async () => {
      const rig = createRuntimeTestRig(
        makeSnapshot({
          state: makeThreadState({
            harnessArea: 'agent-home',
            threadStatus: 'running',
            activeRunId: FIXTURE_RUN_ID,
            canWrite: true,
          }),
          canWrite: true,
        }),
      );

      const { result, unmount } = renderHook(() =>
        useAgentChatSession(FIXTURE_THREAD_ID, {
          harnessArea: 'agent-home',
          runtimeDeps: rig.runtimeDeps,
        }),
      );

      await waitFor(() => {
        expect(result.current.snapshotLoaded).toBe(true);
      });
      expect(result.current.canWrite).toBe(true);

      act(() => {
        rig.sockets[0].simulateOpen();
        rig.sockets[0].simulateMessage({
          type: 'state',
          state: makeThreadState({
            harnessArea: 'agent-home',
            threadStatus: 'running',
            activeRunId: FIXTURE_RUN_ID,
            canWrite: false,
          }),
        });
      });

      expect(result.current.canWrite).toBe(false);

      let sendOk = true;
      let steerOk = true;
      let summarizeOk = true;
      await act(async () => {
        sendOk = await result.current.send('Blocked message');
        steerOk = await result.current.steer('Blocked steer');
        summarizeOk = await result.current.summarize();
        await result.current.cancel();
        await result.current.retryFailedRun(FIXTURE_RUN_ID);
      });

      expect(sendOk).toBe(false);
      expect(steerOk).toBe(false);
      expect(summarizeOk).toBe(false);
      expect(rig.sockets[0].sent).toHaveLength(0);

      unmount();
    });
  });

  describe('sign_in_required receipt over open socket retries once over HTTP', () => {
    it('resends the cached command body once via HTTP commands route on sign_in_required receipt', async () => {
      const httpAcceptedReceipt = makeReceipt({
        commandId: FIXTURE_CMD_ID_1,
        kind: 'send',
        status: 'accepted',
        runId: FIXTURE_RUN_ID,
      });

      const sockets: FakeWebSocket[] = [];
      const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
        async (input) => {
          const url = String(input);
          if (url.endsWith('/snapshot')) {
            return jsonResponse(makeSnapshot(), 200);
          }
          if (url.endsWith('/commands')) {
            return jsonResponse(httpAcceptedReceipt, 200);
          }
          return jsonResponse({ ok: true }, 200);
        },
      );

      const { result, unmount } = renderHook(() =>
        useAgentChatSession(FIXTURE_THREAD_ID, {
          harnessArea: 'agent-home',
          createTurnId: () => FIXTURE_CMD_ID_1,
          runtimeDeps: {
            webSocketFactory: (url) => {
              const ws = new FakeWebSocket(url);
              sockets.push(ws);
              return ws as unknown as WebSocket;
            },
            fetchImpl: fetchMock as unknown as typeof fetch,
          },
        }),
      );

      await waitFor(() => {
        expect(result.current.snapshotLoaded).toBe(true);
      });

      act(() => {
        sockets[0].simulateOpen();
        sockets[0].simulateMessage({
          type: 'state',
          state: makeThreadState({ harnessArea: 'agent-home' }),
        });
      });

      await act(async () => {
        await result.current.send('Refresh my auth session');
      });
      expect(sockets[0].sent).toHaveLength(1);

      // Server rejects over open WS with sign_in_required reason
      act(() => {
        sockets[0].simulateMessage({
          type: 'receipt',
          receipt: makeReceipt({
            commandId: FIXTURE_CMD_ID_1,
            kind: 'send',
            status: 'rejected',
            reason: 'Sign in again to continue',
          }),
        });
      });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/harness/threads/${FIXTURE_THREAD_ID}/commands`,
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
              commandId: FIXTURE_CMD_ID_1,
              kind: 'send',
              text: 'Refresh my auth session',
            }),
          }),
        );
      });

      await waitFor(() => {
        expect(result.current.lastReceipt).toMatchObject({
          commandId: FIXTURE_CMD_ID_1,
          kind: 'send',
          status: 'accepted',
        });
      });

      // Only retried once over HTTP
      const commandPostCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/commands'),
      );
      expect(commandPostCalls).toHaveLength(1);

      unmount();
    });
  });

  describe('terminalRevision increments when a running turn finishes', () => {
    it('increments terminalRevision on done event and on running->idle state transition', async () => {
      const rig = createRuntimeTestRig(
        makeSnapshot({
          state: makeThreadState({
            harnessArea: 'brainstorm',
            threadStatus: 'running',
            activeRunId: FIXTURE_RUN_ID,
            phase: 'running',
          }),
        }),
      );

      const { result, unmount } = renderHook(() =>
        useAgentChatSession(FIXTURE_THREAD_ID, {
          harnessArea: 'brainstorm',
          runtimeDeps: rig.runtimeDeps,
        }),
      );

      await waitFor(() => {
        expect(result.current.snapshotLoaded).toBe(true);
      });

      const initialRev = result.current.terminalRevision;
      expect(initialRev).toBe(0);

      act(() => {
        rig.sockets[0].simulateOpen();
        rig.sockets[0].simulateMessage({
          type: 'event',
          id: 'done-1',
          data: { type: 'done', runId: FIXTURE_RUN_ID },
        });
      });

      expect(result.current.terminalRevision).toBe(initialRev + 1);
      expect(result.current.isRunning).toBe(false);

      // Start second turn, finish via idle state frame
      act(() => {
        rig.sockets[0].simulateMessage({
          type: 'state',
          state: makeThreadState({
            harnessArea: 'brainstorm',
            threadStatus: 'running',
            activeRunId: 'run-2',
            phase: 'running',
          }),
        });
      });
      expect(result.current.isRunning).toBe(true);

      act(() => {
        rig.sockets[0].simulateMessage({
          type: 'state',
          state: makeThreadState({
            harnessArea: 'brainstorm',
            threadStatus: 'idle',
            activeRunId: null,
            phase: 'idle',
          }),
        });
      });
      expect(result.current.terminalRevision).toBe(initialRev + 2);

      unmount();
    });
  });

  describe('receipt auto-dismiss timer', () => {
    it('auto-dismisses non-error receipts after autoDismissMs and clears timer on unmount', async () => {
      jest.useFakeTimers();
      const rig = createRuntimeTestRig(
        makeSnapshot({
          state: makeThreadState({ harnessArea: 'agent-home' }),
        }),
      );

      const { result, unmount } = renderHook(() =>
        useAgentChatSession(FIXTURE_THREAD_ID, {
          harnessArea: 'agent-home',
          runtimeDeps: rig.runtimeDeps,
        }),
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      act(() => {
        rig.sockets[0].simulateOpen();
        rig.sockets[0].simulateMessage({
          type: 'state',
          state: makeThreadState({ harnessArea: 'agent-home' }),
        });
        rig.sockets[0].simulateMessage({
          type: 'receipt',
          receipt: makeReceipt({
            commandId: FIXTURE_CMD_ID_1,
            kind: 'steer',
            status: 'applied',
          }),
        });
      });

      expect(result.current.lastReceipt?.text).toBe('Steer sent');

      act(() => {
        jest.advanceTimersByTime(4_999);
      });
      expect(result.current.lastReceipt?.text).toBe('Steer sent');

      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(result.current.lastReceipt).toBeNull();

      unmount();
    });
  });

  describe('completed turn clears awaiting/working/stop state', () => {
    it('stops showing awaiting/busy state once the assistant message and done event finish an accepted send', async () => {
      const rig = createRuntimeTestRig(
        makeSnapshot({
          state: makeThreadState({
            harnessArea: 'agent-home',
            threadStatus: 'idle',
            canWrite: true,
          }),
        }),
      );

      const { result, unmount } = renderHook(() =>
        useAgentChatSession(FIXTURE_THREAD_ID, {
          harnessArea: 'agent-home',
          createTurnId: () => FIXTURE_CMD_ID_1,
          runtimeDeps: rig.runtimeDeps,
        }),
      );

      await waitFor(() => {
        expect(result.current.snapshotLoaded).toBe(true);
      });

      act(() => {
        rig.sockets[0].simulateOpen();
        rig.sockets[0].simulateMessage({
          type: 'state',
          state: makeThreadState({
            harnessArea: 'agent-home',
            threadStatus: 'idle',
            activeRunId: null,
            phase: 'idle',
            pendingCommands: [],
          }),
        });
      });

      // Send a message: becomes awaiting immediately
      let sendPromise: Promise<boolean>;
      act(() => {
        sendPromise = result.current.send('What should we prioritize?');
      });
      expect(result.current.isAwaitingAgentResponse).toBe(true);
      await act(async () => {
        await sendPromise!;
      });

      // Server accepts send and enters running state
      act(() => {
        rig.sockets[0].simulateMessage({
          type: 'receipt',
          receipt: makeReceipt({
            commandId: FIXTURE_CMD_ID_1,
            kind: 'send',
            status: 'accepted',
            runId: FIXTURE_RUN_ID,
          }),
        });
        rig.sockets[0].simulateMessage({
          type: 'state',
          state: makeThreadState({
            harnessArea: 'agent-home',
            threadStatus: 'running',
            activeRunId: FIXTURE_RUN_ID,
            phase: 'running',
            pendingCommands: [
              { commandId: FIXTURE_CMD_ID_1, kind: 'send', status: 'accepted' },
            ],
          }),
        });
      });
      expect(result.current.isRunning).toBe(true);

      // Assistant message arrives, turn finishes, and trailing idle state frame arrives
      act(() => {
        rig.sockets[0].simulateMessage({
          type: 'event',
          id: 'ev-msg-agent',
          data: {
            type: 'message',
            message: makeMessage({
              id: 'agent-reply-complete',
              role: 'agent',
              text: 'Here are three options to consider.',
              ts: '2026-11-19T00:01:00.000Z',
            }),
          },
        });
        rig.sockets[0].simulateMessage({
          type: 'event',
          id: 'ev-done-complete',
          data: { type: 'done', runId: FIXTURE_RUN_ID },
        });
        // Even if a stale state frame still echoes the finished send command,
        // an idle thread with no activeRunId must not stay stuck awaiting.
        rig.sockets[0].simulateMessage({
          type: 'state',
          state: makeThreadState({
            harnessArea: 'agent-home',
            threadStatus: 'idle',
            activeRunId: null,
            phase: 'idle',
            pendingCommands: [
              { commandId: FIXTURE_CMD_ID_1, kind: 'send', status: 'accepted' },
            ],
          }),
        });
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.isRunning).toBe(false);
      expect(result.current.isAwaitingAgentResponse).toBe(false);
      expect(result.current.isInteractionBusy).toBe(false);
      expect(result.current.showTypingIndicator).toBe(false);
      expect(result.current.pendingCommands).toEqual([]);

      unmount();
    });

    it('never marks an idle reloaded thread as awaiting when a snapshot includes a stale accepted send', async () => {
      const rig = createRuntimeTestRig(
        makeSnapshot({
          messages: [
            makeMessage({ id: 'u-1', role: 'user', text: 'First question' }),
            makeMessage({ id: 'a-1', role: 'agent', text: 'Finished answer' }),
          ],
          state: makeThreadState({
            harnessArea: 'agent-home',
            threadStatus: 'idle',
            activeRunId: null,
            phase: 'idle',
            pendingCommands: [
              { commandId: FIXTURE_CMD_ID_1, kind: 'send', status: 'accepted' },
            ],
          }),
        }),
      );

      const { result, unmount } = renderHook(() =>
        useAgentChatSession(FIXTURE_THREAD_ID, {
          harnessArea: 'agent-home',
          runtimeDeps: rig.runtimeDeps,
        }),
      );

      await waitFor(() => {
        expect(result.current.snapshotLoaded).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.isRunning).toBe(false);
      expect(result.current.isAwaitingAgentResponse).toBe(false);
      expect(result.current.isInteractionBusy).toBe(false);
      expect(result.current.pendingCommands).toEqual([]);

      unmount();
    });
  });
});
