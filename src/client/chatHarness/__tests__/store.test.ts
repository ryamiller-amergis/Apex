import { createChatHarnessStore } from '../store';
import {
  MAX_SEEN_EVENT_IDS,
  durableTokenKey,
  sortChatMessagesByTs,
} from '../reducers/eventReducer';
import type { ChatMessage, SseEvent } from '../../../shared/types/chat';
import {
  FIXTURE_CMD_ID_1,
  FIXTURE_CMD_ID_2,
  FIXTURE_RUN_ID,
  FIXTURE_THREAD_ID,
  makeMessage,
  makeReceipt,
  makeSnapshot,
  makeThreadState,
} from '../testFixtures';

describe('S3 chatHarness store and eventReducer', () => {
  describe('VT-01 / PBI-011 AC-0: immediate work box feedback and live activity log', () => {
    it('adds optimistic message and "Sending…" label synchronously, then records tool activity', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);

      store.recordOptimisticSend(FIXTURE_CMD_ID_1, 'Inspect the auth middleware');

      const afterSend = store.getState();
      expect(afterSend.progressLabel).toBe('Sending…');
      expect(afterSend.optimisticMessages).toHaveLength(1);
      expect(afterSend.optimisticMessages[0]).toMatchObject({
        commandId: FIXTURE_CMD_ID_1,
        failed: false,
        message: {
          id: FIXTURE_CMD_ID_1,
          commandId: FIXTURE_CMD_ID_1,
          role: 'user',
          text: 'Inspect the auth middleware',
        },
      });
      expect(afterSend.pendingCommands).toEqual([
        expect.objectContaining({
          commandId: FIXTURE_CMD_ID_1,
          kind: 'send',
          status: 'pending',
        }),
      ]);
      expect(store.getDisplayedMessages()).toHaveLength(1);

      store.applyEvent(
        {
          type: 'tool_status',
          callId: 'call-read-1',
          toolName: 'Read',
          status: 'running',
          args: { target: 'src/server/middleware/auth.ts' },
          result: 'SECRET_RESULT_MUST_NOT_LEAK',
          runId: FIXTURE_RUN_ID,
        },
        'ev-1',
      );

      const afterTool = store.getState();
      expect(afterTool.activity).toEqual([
        {
          id: 'call-read-1',
          kind: 'tool',
          toolName: 'Read',
          status: 'running',
          target: 'src/server/middleware/auth.ts',
        },
      ]);
      expect(afterTool.activity[0]).not.toHaveProperty('result');

      store.applyEvent(
        {
          type: 'tool_status',
          callId: 'call-read-1',
          toolName: 'Read',
          status: 'error',
          args: { target: 'src/server/middleware/auth.ts' },
          result: 'ENOENT raw stderr',
          runId: FIXTURE_RUN_ID,
        },
        'ev-2',
      );

      expect(store.getState().activity).toEqual([
        {
          id: 'call-read-1',
          kind: 'tool',
          toolName: 'Read',
          status: 'error',
          target: 'src/server/middleware/auth.ts',
        },
      ]);
      expect(store.getState().activity[0]).not.toHaveProperty('result');
    });
  });

  describe('VT-10 / PBI-013 AC-0 / TBI-017 DoD-3: optimistic match by commandId without duplicates', () => {
    it('replaces optimistic message when server message event arrives with matching commandId', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);
      store.recordOptimisticSend(FIXTURE_CMD_ID_1, 'Summarize this diff');

      expect(store.getDisplayedMessages()).toHaveLength(1);

      const serverCopy = makeMessage({
        id: 'server-msg-101',
        commandId: FIXTURE_CMD_ID_1,
        role: 'user',
        text: 'Summarize this diff',
        ts: '2026-11-19T00:00:02.000Z',
      });

      store.applyEvent({ type: 'message', message: serverCopy }, 'ev-msg-1');

      const state = store.getState();
      expect(state.optimisticMessages).toHaveLength(0);
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].id).toBe('server-msg-101');
      expect(store.getDisplayedMessages()).toHaveLength(1);
      expect(store.getDisplayedMessages()[0].id).toBe('server-msg-101');
    });

    it('replaces optimistic message when snapshot carries matching commandId', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);
      store.recordOptimisticSend(FIXTURE_CMD_ID_1, 'Check deployment');

      store.applySnapshot(
        makeSnapshot({
          messages: [
            makeMessage({
              id: 'server-msg-202',
              commandId: FIXTURE_CMD_ID_1,
              role: 'user',
              text: 'Check deployment',
              ts: '2026-11-19T00:00:03.000Z',
            }),
          ],
        }),
      );

      expect(store.getState().optimisticMessages).toHaveLength(0);
      expect(store.getDisplayedMessages()).toHaveLength(1);
      expect(store.getDisplayedMessages()[0].id).toBe('server-msg-202');
    });

    it('preserves two identical-text messages with distinct commandIds (no text-equality dedupe)', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);
      store.recordOptimisticSend(FIXTURE_CMD_ID_1, 'yes');
      store.recordOptimisticSend(FIXTURE_CMD_ID_2, 'yes');

      // Only the first command arrives from server; second must stay in transcript
      store.applyEvent(
        {
          type: 'message',
          message: makeMessage({
            id: 'srv-1',
            commandId: FIXTURE_CMD_ID_1,
            role: 'user',
            text: 'yes',
            ts: '2026-11-19T00:00:01.000Z',
          }),
        },
        'ev-u1',
      );

      expect(store.getState().optimisticMessages).toHaveLength(1);
      expect(store.getState().optimisticMessages[0].commandId).toBe(FIXTURE_CMD_ID_2);
      expect(store.getDisplayedMessages()).toHaveLength(2);

      // Second command arrives from server; both remain
      store.applyEvent(
        {
          type: 'message',
          message: makeMessage({
            id: 'srv-2',
            commandId: FIXTURE_CMD_ID_2,
            role: 'user',
            text: 'yes',
            ts: '2026-11-19T00:00:02.000Z',
          }),
        },
        'ev-u2',
      );

      expect(store.getState().optimisticMessages).toHaveLength(0);
      expect(store.getDisplayedMessages().map((m) => m.id)).toEqual(['srv-1', 'srv-2']);
    });
  });

  describe('VT-11 / PBI-013 AC-1: rejected send keeps failed message and failure state for Retry', () => {
    it('marks optimistic message failed and sets lastFailure on rejected send receipt', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);
      store.recordOptimisticSend(FIXTURE_CMD_ID_1, 'Please draft the migration');

      store.applyReceipt(
        makeReceipt({
          commandId: FIXTURE_CMD_ID_1,
          kind: 'send',
          status: 'rejected',
          reason: 'Did not reach the agent',
          runId: FIXTURE_RUN_ID,
        }),
      );

      const state = store.getState();
      expect(state.pendingCommands).toHaveLength(0);
      expect(state.optimisticMessages).toHaveLength(1);
      expect(state.optimisticMessages[0].failed).toBe(true);
      expect(state.optimisticMessages[0].failureReason).toBe('Did not reach the agent');
      expect(state.lastFailure).toMatchObject({
        commandId: FIXTURE_CMD_ID_1,
        runId: FIXTURE_RUN_ID,
        reason: 'Did not reach the agent',
      });
      expect(state.lastReceipt).toMatchObject({
        commandId: FIXTURE_CMD_ID_1,
        status: 'rejected',
        tone: 'error',
        text: 'Did not reach the agent',
      });
      expect(state.progressLabel).toBeNull();
      expect(store.getDisplayedMessages()).toHaveLength(1);
      expect(store.getDisplayedMessages()[0].text).toBe('Please draft the migration');
    });
  });

  describe('VT-12 / PBI-013 AC-2: Stop freezes streaming immediately until server settles', () => {
    it('freezes streamingText on beginLocalStop, ignores late tokens/thinking, and clears on idle state frame', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);
      store.applyStateFrame(
        makeThreadState({
          threadStatus: 'running',
          activeRunId: FIXTURE_RUN_ID,
          phase: 'running',
        }),
      );
      store.applyEvent(
        { type: 'token', text: 'Partial answer', streamOffset: 0, runId: FIXTURE_RUN_ID },
        't-1',
      );
      expect(store.getState().streamingText).toBe('Partial answer');

      const cancelCmdId = '10000000-0000-4000-8000-000000000299';
      store.beginLocalStop(cancelCmdId);

      expect(store.getState().stopping).toBe(true);
      expect(store.getState().streamingText).toBe('Partial answer');
      expect(store.getState().pendingCommands).toContainEqual(
        expect.objectContaining({ commandId: cancelCmdId, kind: 'cancel', status: 'pending' }),
      );

      // Late tokens and thinking events must be ignored while stopping
      store.applyEvent(
        { type: 'token', text: ' that arrived late', streamOffset: 14, runId: FIXTURE_RUN_ID },
        't-2',
      );
      store.applyEvent(
        { type: 'thinking', text: 'Late thought', seq: 1, runId: FIXTURE_RUN_ID },
        'th-1',
      );

      expect(store.getState().streamingText).toBe('Partial answer');
      expect(store.getState().thinkingText).toBe('');
      expect(store.getState().activity).toHaveLength(0);

      // Server confirms idle via state frame
      const revBefore = store.getState().terminalRevision;
      store.applyStateFrame(
        makeThreadState({
          threadStatus: 'idle',
          activeRunId: null,
          phase: 'idle',
          pendingCommands: [],
        }),
      );

      const finalState = store.getState();
      expect(finalState.stopping).toBe(false);
      expect(finalState.status).toBe('idle');
      expect(finalState.activeRunId).toBeNull();
      expect(finalState.terminalRevision).toBe(revBefore + 1);
    });
  });

  describe('VT-18, VT-19, VT-20 / PBI-015 AC-1..3: retry failure, idempotency, and lost write access', () => {
    it('VT-18: updates lastFailure with new reason when Retry fails a second time while keeping user message', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);
      store.recordOptimisticSend(FIXTURE_CMD_ID_1, 'Build the chart');
      store.applyReceipt(
        makeReceipt({
          commandId: FIXTURE_CMD_ID_1,
          kind: 'send',
          status: 'rejected',
          reason: 'Did not reach the agent',
          runId: FIXTURE_RUN_ID,
        }),
      );

      store.recordPendingCommand(FIXTURE_CMD_ID_2, 'retry');
      store.applyReceipt(
        makeReceipt({
          commandId: FIXTURE_CMD_ID_2,
          kind: 'retry',
          status: 'rejected',
          reason: 'Wait for this reply to finish',
          runId: FIXTURE_RUN_ID,
        }),
      );

      const state = store.getState();
      expect(state.lastFailure).toMatchObject({
        commandId: FIXTURE_CMD_ID_2,
        runId: FIXTURE_RUN_ID,
        reason: 'Wait for this reply to finish',
      });
      expect(store.getDisplayedMessages()).toHaveLength(1);
      expect(store.getDisplayedMessages()[0].text).toBe('Build the chart');
    });

    it('VT-19: handles already-applied retry and duplicate receipts idempotently with zero duplicates', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);
      const userMsg = makeMessage({
        id: 'u-1',
        commandId: FIXTURE_CMD_ID_1,
        role: 'user',
        text: 'Check status',
        ts: '2026-11-19T00:00:01.000Z',
      });
      const agentMsg = makeMessage({
        id: 'a-1',
        role: 'agent',
        text: 'All systems nominal.',
        ts: '2026-11-19T00:00:02.000Z',
      });
      store.applySnapshot(makeSnapshot({ messages: [userMsg, agentMsg] }));

      store.markCommandFailed(FIXTURE_CMD_ID_2, 'retry', 'Did not reach the agent', FIXTURE_RUN_ID);
      expect(store.getState().lastFailure).not.toBeNull();

      const appliedReceipt = makeReceipt({
        commandId: FIXTURE_CMD_ID_2,
        kind: 'retry',
        status: 'applied',
        runId: FIXTURE_RUN_ID,
      });

      store.applyReceipt(appliedReceipt);
      expect(store.getState().lastFailure).toBeNull();
      expect(store.getDisplayedMessages()).toHaveLength(2);

      // Duplicate settled receipt is a complete no-op
      const listener = jest.fn();
      store.subscribe(listener);
      const snapshotBefore = store.getState();
      store.applyReceipt(appliedReceipt);

      expect(listener).not.toHaveBeenCalled();
      expect(store.getState()).toBe(snapshotBefore);
      expect(store.getDisplayedMessages()).toHaveLength(2);
    });

    it('VT-20: shows read-only rejection reason on retry without removing transcript message', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);
      store.applySnapshot(
        makeSnapshot({
          messages: [
            makeMessage({
              id: 'u-1',
              commandId: FIXTURE_CMD_ID_1,
              role: 'user',
              text: 'Analyze logs',
            }),
          ],
          canWrite: true,
        }),
      );

      store.recordPendingCommand(FIXTURE_CMD_ID_2, 'retry');
      store.applyReceipt({
        commandId: FIXTURE_CMD_ID_2,
        kind: 'retry',
        status: 'rejected',
        reason: 'no_write_access',
        runId: FIXTURE_RUN_ID,
      });

      const state = store.getState();
      expect(state.lastReceipt).toMatchObject({
        status: 'rejected',
        text: 'You have read-only access to this thread.',
        tone: 'error',
      });
      expect(state.lastFailure).toMatchObject({
        reason: 'You have read-only access to this thread.',
      });
      expect(store.getDisplayedMessages()).toHaveLength(1);
      expect(store.getDisplayedMessages()[0].text).toBe('Analyze logs');
    });
  });

  describe('Reducer port: tokens, eventId dedupe, thinking, tool grouping, summary, phases, auth', () => {
    it('exports sortChatMessagesByTs and durableTokenKey', () => {
      const a: ChatMessage = makeMessage({ id: 'b', ts: '2026-11-19T00:00:02.000Z' });
      const b: ChatMessage = makeMessage({ id: 'a', ts: '2026-11-19T00:00:01.000Z' });
      const c: ChatMessage = makeMessage({ id: 'a2', ts: '2026-11-19T00:00:02.000Z' });
      expect(sortChatMessagesByTs([a, b, c]).map((m) => m.id)).toEqual(['a', 'a2', 'b']);

      expect(durableTokenKey('ev-9', { type: 'token', text: 'hi', streamOffset: 4 })).toBe('ev-9:4');
      expect(durableTokenKey('ev-9', { type: 'token', text: 'hi' })).toBe('ev-9:legacy');
    });

    it('merges offset tokens with overlap, dedupe, out-of-order pending drain, and pre-tool trim', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);

      // Out-of-order future chunk arrives first
      store.applyEvent({ type: 'token', text: 'world!', streamOffset: 6 }, 'tok-2');
      expect(store.getState().streamingText).toBe('');

      // Gap filler arrives with overlapping boundary
      store.applyEvent({ type: 'token', text: 'Hello wo', streamOffset: 0 }, 'tok-1');
      expect(store.getState().streamingText).toBe('Hello world!');

      // Duplicate token event key is ignored
      store.applyEvent({ type: 'token', text: 'Hello wo', streamOffset: 0 }, 'tok-1');
      expect(store.getState().streamingText).toBe('Hello world!');

      // Overlapping continuation extends only the unseen suffix
      store.applyEvent({ type: 'token', text: 'world! Done.', streamOffset: 6 }, 'tok-3');
      expect(store.getState().streamingText).toBe('Hello world! Done.');

      // Running tool trims pre-tool narration without breaking subsequent offset alignment
      store.applyEvent(
        {
          type: 'tool_status',
          callId: 'c-1',
          toolName: 'mcp',
          status: 'running',
          args: { toolName: 'search_repo_code', target: 'login' },
        },
        'tool-1',
      );
      expect(store.getState().streamingText).toBe('');
      expect(store.getState().activity).toEqual([
        {
          id: 'c-1',
          kind: 'tool',
          toolName: 'mcp:search_repo_code',
          status: 'running',
          target: 'login',
        },
      ]);

      store.applyEvent({ type: 'token', text: 'After tool.', streamOffset: 18 }, 'tok-4');
      expect(store.getState().streamingText).toBe('After tool.');
    });

    it('dedupes durable eventIds within the 2048-id sliding window and accepts evicted ids again', () => {
      expect(MAX_SEEN_EVENT_IDS).toBe(2048);
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);

      const phaseEv: SseEvent = {
        type: 'phase',
        phase: 'analysis',
        status: 'running',
        detail: 'First pass',
      };

      store.applyEvent(phaseEv, 'durable-0');
      expect(store.getState().phaseEvents).toHaveLength(1);

      // Immediate duplicate dropped
      store.applyEvent(phaseEv, 'durable-0');
      expect(store.getState().phaseEvents).toHaveLength(1);

      // Push 2048 distinct durable ids to evict 'durable-0'
      for (let i = 1; i <= MAX_SEEN_EVENT_IDS; i += 1) {
        store.applyEvent(
          { type: 'phase', phase: 'analysis', status: 'running', detail: `Step ${i}` },
          `durable-${i}`,
        );
      }

      // Now 'durable-0' has been evicted and is accepted again
      const beforeReapply = store.getState().phaseEvents[store.getState().phaseEvents.length - 1];
      expect(beforeReapply.detail).toBe(`Step ${MAX_SEEN_EVENT_IDS}`);

      store.applyEvent(phaseEv, 'durable-0');
      const afterReapply = store.getState().phaseEvents[store.getState().phaseEvents.length - 1];
      expect(afterReapply.detail).toBe('First pass');
    });

    it('merges thinking by seq (dropping repeats) and folds live activity onto agent reply message', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);

      store.applyEvent({ type: 'thinking', text: 'Inspecting ', seq: 1 }, '');
      store.applyEvent({ type: 'thinking', text: 'Inspecting ', seq: 1 }, '');
      store.applyEvent({ type: 'thinking', text: 'routes.', seq: 2 }, '');

      expect(store.getState().thinkingText).toBe('Inspecting routes.');
      expect(store.getState().activity).toEqual([
        { id: 'thinking-1', kind: 'thinking', text: 'Inspecting routes.' },
      ]);

      store.applyEvent(
        {
          type: 'tool_status',
          callId: 't-1',
          toolName: 'Read',
          status: 'running',
          args: { target: 'src/routes.ts' },
        },
        'ev-t1',
      );
      store.applyEvent(
        {
          type: 'tool_status',
          callId: 't-1',
          toolName: 'Read',
          status: 'completed',
          args: { target: 'src/routes.ts' },
        },
        'ev-t2',
      );

      // Agent reply without server-provided activity inherits accumulated live activity
      store.applyEvent(
        {
          type: 'message',
          message: makeMessage({
            id: 'agent-1',
            role: 'agent',
            text: 'Routes look clean.',
            ts: '2026-11-19T00:00:10.000Z',
          }),
        },
        'ev-m1',
      );

      const state = store.getState();
      expect(state.activity).toEqual([]);
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].activity).toEqual([
        { id: 'thinking-1', kind: 'thinking', text: 'Inspecting routes.' },
        {
          id: 't-1',
          kind: 'tool',
          toolName: 'Read',
          status: 'completed',
          target: 'src/routes.ts',
        },
      ]);
    });

    it('groups concurrent running tools and explicit groupId tools into tool-group while keeping single calls plain', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);

      // 1. Single sequential tool stays kind: 'tool'
      store.applyEvent(
        { type: 'tool_status', callId: 'solo-1', toolName: 'Read', status: 'running', args: { target: 'a.ts' } },
        'e-1',
      );
      store.applyEvent(
        { type: 'tool_status', callId: 'solo-1', toolName: 'Read', status: 'completed', args: { target: 'a.ts' } },
        'e-2',
      );
      expect(store.getState().activity).toHaveLength(1);
      expect(store.getState().activity[0].kind).toBe('tool');

      // 2. Concurrent running tools without groupId form a tool-group
      store.applyEvent(
        { type: 'tool_status', callId: 'par-1', toolName: 'Read', status: 'running', args: { target: 'b.ts' } },
        'e-3',
      );
      store.applyEvent(
        { type: 'tool_status', callId: 'par-2', toolName: 'Grep', status: 'running', args: { target: 'useChat' } },
        'e-4',
      );

      let activity = store.getState().activity;
      expect(activity).toHaveLength(2);
      expect(activity[1]).toMatchObject({
        kind: 'tool-group',
        status: 'running',
        tools: [
          { id: 'par-1', toolName: 'Read', status: 'running', target: 'b.ts' },
          { id: 'par-2', toolName: 'Grep', status: 'running', target: 'useChat' },
        ],
      });

      // Completing one keeps group running; failing the other transitions group to error
      store.applyEvent(
        { type: 'tool_status', callId: 'par-1', toolName: 'Read', status: 'completed' },
        'e-5',
      );
      expect(store.getState().activity[1].status).toBe('running');

      store.applyEvent(
        { type: 'tool_status', callId: 'par-2', toolName: 'Grep', status: 'error' },
        'e-6',
      );
      expect(store.getState().activity[1].status).toBe('error');

      // 3. Explicit groupId groups tools even when sequential
      store.applyEvent(
        {
          type: 'tool_status',
          callId: 'grp-1',
          toolName: 'Glob',
          status: 'completed',
          groupId: 'step-group-42',
          args: { target: '*.ts' },
        },
        'e-7',
      );
      // Single member with groupId starts as plain tool until a second shares groupId
      expect(store.getState().activity[2].kind).toBe('tool');

      store.applyEvent(
        {
          type: 'tool_status',
          callId: 'grp-2',
          toolName: 'Read',
          status: 'completed',
          groupId: 'step-group-42',
          args: { target: 'index.ts' },
        },
        'e-8',
      );
      activity = store.getState().activity;
      expect(activity[2]).toEqual({
        id: 'step-group-42',
        kind: 'tool-group',
        status: 'completed',
        tools: [
          { id: 'grp-1', toolName: 'Glob', status: 'completed', target: '*.ts' },
          { id: 'grp-2', toolName: 'Read', status: 'completed', target: 'index.ts' },
        ],
      });
    });

    it('handles summary events (running, fallback, error, completed) and state-frame summary status', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);

      store.applyEvent({ type: 'summary', status: 'running' }, 'sum-1');
      expect(store.getState().summaryNotice).toEqual({
        status: 'running',
        text: 'Summarizing conversation…',
        isFallback: false,
      });

      store.applyEvent({ type: 'summary', status: 'fallback' }, 'sum-2');
      expect(store.getState().summaryNotice).toMatchObject({
        status: 'fallback',
        isFallback: true,
      });
      expect(store.getState().summaryNotice?.text.length).toBeGreaterThan(0);

      store.applyEvent({ type: 'summary', status: 'error' }, 'sum-3');
      expect(store.getState().summaryNotice).toMatchObject({
        status: 'error',
        isFallback: false,
      });

      store.applyEvent({ type: 'summary', status: 'completed' }, 'sum-4');
      expect(store.getState().summaryNotice).toBeNull();

      // State frame with summarizing phase updates summaryNotice
      store.applyStateFrame(
        makeThreadState({
          threadStatus: 'running',
          phase: 'summarizing',
        }),
      );
      expect(store.getState().summaryNotice).toEqual({
        status: 'running',
        text: 'Summarizing conversation…',
        isFallback: false,
      });

      // State frame finishing with fallback summary marker sets fallback notice
      store.applyStateFrame(
        makeThreadState({
          threadStatus: 'idle',
          phase: 'idle',
          latestSummary: {
            id: 'sum-marker-1',
            source: 'user',
            fallback: true,
            createdAt: '2026-11-19T00:01:00.000Z',
          },
        }),
      );
      expect(store.getState().summaryNotice).toMatchObject({
        status: 'fallback',
        isFallback: true,
      });
    });

    it('normalizes phase detail (whitespace collapse + 500 char cap) and handles done/error/grounding/health', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);
      const longDetail = `   ${'a'.repeat(600)}\n\t   extra  `;

      store.applyEvent(
        { type: 'phase', phase: 'planning', status: 'running', detail: longDetail, runId: FIXTURE_RUN_ID },
        'ph-1',
      );
      expect(store.getState().phaseEvents[0].detail?.length).toBe(500);

      store.applyEvent(
        { type: 'grounding', status: 'preparing', message: 'Fetching repo…', retryAfterMs: 3000 },
        'gr-1',
      );
      expect(store.getState().groundingPreparation).toEqual({
        status: 'preparing',
        message: 'Fetching repo…',
        retryAfterMs: 3000,
      });

      store.applyEvent(
        { type: 'health', health: 'long_running', detail: 'Still working on tests' },
        'h-1',
      );
      expect(store.getState().runHealth?.health).toBe('long_running');

      const revBeforeDone = store.getState().terminalRevision;
      store.applyEvent(
        { type: 'done', runId: FIXTURE_RUN_ID, prdReady: true, backlogReady: true },
        'd-1',
      );
      expect(store.getState().prdReady).toBe(true);
      expect(store.getState().backlogReady).toBe(true);
      expect(store.getState().groundingPreparation).toBeNull();
      expect(store.getState().terminalRevision).toBe(revBeforeDone + 1);

      // Transient error does not increment terminalRevision
      const revBeforeTransient = store.getState().terminalRevision;
      store.applyEvent(
        { type: 'error', error: '429', errorCode: 'rate_limit', runId: FIXTURE_RUN_ID },
        'err-1',
      );
      expect(store.getState().isRetrying).toBe(true);
      expect(store.getState().terminalRevision).toBe(revBeforeTransient);

      // Fatal error increments terminalRevision and sets retryableRunId
      store.applyEvent(
        { type: 'error', error: 'Boom', errorCode: 'fatal', runId: FIXTURE_RUN_ID },
        'err-2',
      );
      expect(store.getState().status).toBe('error');
      expect(store.getState().retryableRunId).toBe(FIXTURE_RUN_ID);
      expect(store.getState().terminalRevision).toBe(revBeforeTransient + 1);
    });

    it('clears transcript and activity on 401/403 snapshot errors and signed-out connection state', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);
      store.applySnapshot(
        makeSnapshot({
          messages: [makeMessage({ id: 'secret-1', text: 'Confidential thread data' })],
        }),
      );
      store.applyEvent({ type: 'thinking', text: 'Private reasoning', seq: 1 }, '');
      expect(store.getState().messages).toHaveLength(1);
      expect(store.getState().activity).toHaveLength(1);

      store.applySnapshotError(403, 'Forbidden');
      expect(store.getState().snapshotLoaded).toBe(true);
      expect(store.getState().snapshotStatusCode).toBe(403);
      expect(store.getState().snapshotError).toBe('Forbidden');
      expect(store.getState().messages).toEqual([]);
      expect(store.getState().activity).toEqual([]);

      // 401 also clears transcript and activity
      store.applySnapshot(
        makeSnapshot({
          messages: [makeMessage({ id: 'secret-401', text: 'Auth required data' })],
        }),
      );
      store.applySnapshotError(401, 'Unauthorized');
      expect(store.getState().snapshotStatusCode).toBe(401);
      expect(store.getState().messages).toEqual([]);
      expect(store.getState().activity).toEqual([]);

      // Re-seed then sign out via connection state
      store.applySnapshot(
        makeSnapshot({
          messages: [makeMessage({ id: 'secret-2', text: 'More confidential data' })],
        }),
      );
      store.recordOptimisticSend(FIXTURE_CMD_ID_1, 'Pending message');
      store.applyEvent({ type: 'token', text: 'Streaming…', streamOffset: 0 }, 't-s1');

      store.applyConnectionState('signed-out');
      const signedOut = store.getState();
      expect(signedOut.connectionState).toBe('signed-out');
      expect(signedOut.isConnected).toBe(false);
      expect(signedOut.hasConnectionError).toBe(true);
      expect(signedOut.messages).toEqual([]);
      expect(signedOut.optimisticMessages).toEqual([]);
      expect(signedOut.streamingText).toBe('');
      expect(signedOut.thinkingText).toBe('');
      expect(signedOut.activity).toEqual([]);
    });

    it('supports clearReceipt, clearFailure, and reset across thread changes', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);
      store.recordOptimisticSend(FIXTURE_CMD_ID_1, 'Hello');
      store.applyReceipt(
        makeReceipt({
          commandId: FIXTURE_CMD_ID_1,
          kind: 'send',
          status: 'rejected',
          reason: 'Did not reach the agent',
        }),
      );
      expect(store.getState().lastReceipt).not.toBeNull();
      expect(store.getState().lastFailure).not.toBeNull();

      store.clearReceipt();
      expect(store.getState().lastReceipt).toBeNull();
      store.clearFailure();
      expect(store.getState().lastFailure).toBeNull();

      store.reset('thread-2');
      expect(store.getState().threadId).toBe('thread-2');
      expect(store.getState().optimisticMessages).toEqual([]);
      expect(store.getState().messages).toEqual([]);
      expect(store.getState().snapshotLoaded).toBe(false);
    });

    it('clears isRetrying and retryReason when running phase, thinking, tool_call, or tool_status arrives', () => {
      let store = createChatHarnessStore(FIXTURE_THREAD_ID);
      const events: Array<Parameters<typeof store.applyEvent>[0]> = [
        { type: 'phase', phase: 'analysis', status: 'running', detail: 'Thinking…' },
        { type: 'thinking', text: 'Inspecting files', seq: 1 },
        { type: 'tool_call', toolName: 'read', input: { path: 'a.ts' } },
        { type: 'tool_status', callId: 'c-1', toolName: 'read', status: 'running', args: { path: 'a.ts' } },
      ];

      for (const nextEvent of events) {
        store = createChatHarnessStore(FIXTURE_THREAD_ID);
        store.applyEvent(
          { type: 'retrying', attempt: 1, maxAttempts: 1, reason: 'reconnecting' },
          '',
        );
        expect(store.getState().isRetrying).toBe(true);
        expect(store.getState().retryReason).toBe('Reconnecting to the agent…');

        store.applyEvent(nextEvent, '');
        expect(store.getState().isRetrying).toBe(false);
        expect(store.getState().retryReason).toBeNull();
      }
    });

    it('clears settled send/retry/cancel pendingCommands on done, terminal status, and error without dropping queued steers, and ignores stale accepted receipts or idle state frames afterward', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);

      // 1. Send -> accepted -> running -> assistant message -> done
      store.recordOptimisticSend(FIXTURE_CMD_ID_1, 'Summarize the open PRs');
      store.applyReceipt(
        makeReceipt({
          commandId: FIXTURE_CMD_ID_1,
          kind: 'send',
          status: 'accepted',
          runId: FIXTURE_RUN_ID,
        }),
      );
      expect(store.getState().activeRunId).toBe(FIXTURE_RUN_ID);
      expect(store.getState().pendingCommands).toEqual([
        expect.objectContaining({
          commandId: FIXTURE_CMD_ID_1,
          kind: 'send',
          status: 'accepted',
        }),
      ]);

      // Queue a follow-up steer that should survive the current turn finishing
      store.applyReceipt(
        makeReceipt({
          commandId: FIXTURE_CMD_ID_2,
          kind: 'steer',
          status: 'queued',
        }),
      );

      store.applyStateFrame(
        makeThreadState({
          threadStatus: 'running',
          activeRunId: FIXTURE_RUN_ID,
          phase: 'running',
          pendingCommands: [
            { commandId: FIXTURE_CMD_ID_1, kind: 'send', status: 'accepted' },
            { commandId: FIXTURE_CMD_ID_2, kind: 'steer', status: 'queued' },
          ],
        }),
      );

      store.applyEvent(
        {
          type: 'message',
          message: makeMessage({
            id: 'agent-final-1',
            role: 'agent',
            text: 'Here are the open PRs.',
          }),
        },
        'ev-msg-final',
      );
      store.applyEvent({ type: 'done', runId: FIXTURE_RUN_ID }, 'ev-done-final');

      const afterDone = store.getState();
      expect(afterDone.status).toBe('idle');
      expect(afterDone.activeRunId).toBeNull();
      expect(afterDone.progressLabel).toBeNull();
      expect(afterDone.pendingCommands).toEqual([
        expect.objectContaining({
          commandId: FIXTURE_CMD_ID_2,
          kind: 'steer',
          status: 'queued',
        }),
      ]);

      // Late accepted receipt for the already-completed send must not resurrect it
      store.applyReceipt(
        makeReceipt({
          commandId: FIXTURE_CMD_ID_1,
          kind: 'send',
          status: 'accepted',
          runId: FIXTURE_RUN_ID,
        }),
      );
      expect(
        store.getState().pendingCommands.some((c) => c.commandId === FIXTURE_CMD_ID_1),
      ).toBe(false);

      // Stale idle state frame or snapshot carrying an old accepted send must not resurrect it
      store.applyStateFrame(
        makeThreadState({
          threadStatus: 'idle',
          activeRunId: null,
          phase: 'idle',
          pendingCommands: [
            { commandId: FIXTURE_CMD_ID_1, kind: 'send', status: 'accepted' },
          ],
        }),
      );
      expect(store.getState().pendingCommands).toEqual([]);

      store.applySnapshot(
        makeSnapshot({
          state: makeThreadState({
            threadStatus: 'idle',
            activeRunId: null,
            phase: 'idle',
            pendingCommands: [
              { commandId: '10000000-0000-4000-8000-000000000999', kind: 'send', status: 'accepted' },
            ],
          }),
        }),
      );
      expect(store.getState().pendingCommands).toEqual([]);
    });

    it('clears send/retry pendingCommands on terminal status:idle after running and on fatal error', () => {
      const store = createChatHarnessStore(FIXTURE_THREAD_ID);
      store.recordOptimisticSend(FIXTURE_CMD_ID_1, 'Check status');
      store.applyStateFrame(
        makeThreadState({
          threadStatus: 'running',
          activeRunId: FIXTURE_RUN_ID,
          phase: 'running',
        }),
      );
      store.applyEvent({ type: 'status', status: 'idle' }, 'ev-status-idle');
      expect(store.getState().status).toBe('idle');
      expect(store.getState().activeRunId).toBeNull();
      expect(store.getState().pendingCommands).toEqual([]);

      store.recordPendingCommand(FIXTURE_CMD_ID_2, 'retry');
      store.applyReceipt(
        makeReceipt({
          commandId: FIXTURE_CMD_ID_2,
          kind: 'retry',
          status: 'accepted',
          runId: FIXTURE_RUN_ID,
        }),
      );
      store.applyEvent(
        { type: 'error', error: 'Agent crashed', runId: FIXTURE_RUN_ID },
        'ev-err-1',
      );
      expect(store.getState().status).toBe('error');
      expect(store.getState().activeRunId).toBeNull();
      expect(store.getState().pendingCommands).toEqual([]);
    });
  });
});
