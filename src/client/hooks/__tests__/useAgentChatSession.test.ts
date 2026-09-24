import { renderHook, act, waitFor } from '@testing-library/react';
import { useAgentChatSession } from '../useAgentChatSession';
import type { ChatMessage, ChatThreadStatus, AgentRunPhase } from '../../../shared/types/chat';
import type {
  GroundingPreparationProgress,
  ToolProgress,
  RunPhaseProgress,
  RunHealthProgress,
} from '../useChatStream';

// Mock useChatStream
interface MockStreamReturn {
  messages: ChatMessage[];
  streamingText: string;
  thinkingText: string;
  toolProgress: ToolProgress[];
  status: ChatThreadStatus;
  isConnected: boolean;
  hasConnectionError: boolean;
  lastProgressAt: number | null;
  phaseEvents: RunPhaseProgress[];
  runHealth: RunHealthProgress | null;
  progressLabel: string | null;
  progressPhase: AgentRunPhase | null;
  prdReady: boolean;
  backlogReady: boolean;
  isRetrying: boolean;
  retryReason: string | null;
  retryableRunId: string | null;
  clearRetryableRunId: () => void;
  groundingPreparation: GroundingPreparationProgress | null;
}

const mockClearRetryableRunId = jest.fn();

const mockStreamReturn: MockStreamReturn = {
  messages: [],
  streamingText: '',
  thinkingText: '',
  toolProgress: [],
  status: 'idle',
  isConnected: true,
  hasConnectionError: false,
  lastProgressAt: null,
  phaseEvents: [],
  runHealth: null,
  progressLabel: null,
  progressPhase: null,
  prdReady: false,
  backlogReady: false,
  isRetrying: false,
  retryReason: null,
  retryableRunId: null,
  clearRetryableRunId: mockClearRetryableRunId,
  groundingPreparation: null,
};

let currentStreamReturn: MockStreamReturn = { ...mockStreamReturn };
const TURN_ID_1 = '10000000-0000-4000-8000-000000000001';
const TURN_ID_2 = '10000000-0000-4000-8000-000000000002';

jest.mock('../useChatStream', () => ({
  useChatStream: () => currentStreamReturn,
}));

describe('useAgentChatSession', () => {
  beforeEach(() => {
    currentStreamReturn = { ...mockStreamReturn };
    mockClearRetryableRunId.mockClear();
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock;
    window.sessionStorage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns idle state with no threadId', () => {
    const { result } = renderHook(() => useAgentChatSession(null));
    expect(result.current.isRunning).toBe(false);
    expect(result.current.isSending).toBe(false);
    expect(result.current.isInteractionBusy).toBe(false);
    expect(result.current.messages).toEqual([]);
  });

  it('exposes isRunning when stream status is running', () => {
    currentStreamReturn = { ...mockStreamReturn, status: 'running' };
    const { result } = renderHook(() => useAgentChatSession('thread-1'));
    expect(result.current.isRunning).toBe(true);
    expect(result.current.isInteractionBusy).toBe(true);
  });

  it('send posts to the correct endpoint', async () => {
    const { result } = renderHook(() =>
      useAgentChatSession('thread-1', {
        createTurnId: () => TURN_ID_1,
      }),
    );

    await act(async () => {
      await result.current.send('Hello');
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/chat/threads/thread-1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ turnId: TURN_ID_1, text: 'Hello' }),
      })
    );
  });

  it('reuses one turnId when the same send retries a network failure', async () => {
    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(new TypeError('network interrupted'))
      .mockResolvedValueOnce({ ok: true });
    const createTurnId = jest.fn(() => TURN_ID_1);
    const { result } = renderHook(() =>
      useAgentChatSession('thread-1', { createTurnId }),
    );

    await act(async () => {
      await result.current.send('Retry this admission');
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const bodies = (global.fetch as jest.Mock).mock.calls.map((call) =>
      JSON.parse(call[1].body),
    );
    expect(bodies).toEqual([
      { turnId: TURN_ID_1, text: 'Retry this admission' },
      { turnId: TURN_ID_1, text: 'Retry this admission' },
    ]);
    expect(createTurnId).toHaveBeenCalledTimes(1);
  });

  it('generates a new turnId for a new user turn', async () => {
    const createTurnId = jest
      .fn()
      .mockReturnValueOnce(TURN_ID_1)
      .mockReturnValueOnce(TURN_ID_2);
    const first = renderHook(() =>
      useAgentChatSession('thread-1', { createTurnId }),
    );
    await act(async () => {
      await first.result.current.send('First turn');
    });
    first.unmount();

    const second = renderHook(() =>
      useAgentChatSession('thread-1', { createTurnId }),
    );
    await act(async () => {
      await second.result.current.send('Second turn');
    });

    const bodies = (global.fetch as jest.Mock).mock.calls.map((call) =>
      JSON.parse(call[1].body),
    );
    expect(bodies).toEqual([
      { turnId: TURN_ID_1, text: 'First turn' },
      { turnId: TURN_ID_2, text: 'Second turn' },
    ]);
  });

  it('shows the user message optimistically before the agent processing state', async () => {
    let resolveSend!: (value: { ok: boolean }) => void;
    (global.fetch as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        })
    );
    const { result } = renderHook(() => useAgentChatSession('thread-1'));

    act(() => {
      void result.current.send('User answer');
    });

    expect(
      result.current.visibleMessages[result.current.visibleMessages.length - 1]
    ).toMatchObject({
      role: 'user',
      text: 'User answer',
    });
    expect(result.current.isAwaitingAgentResponse).toBe(true);

    await act(async () => {
      resolveSend({ ok: true });
      await Promise.resolve();
    });
  });

  it('reconciles the optimistic user message with the persisted stream echo', async () => {
    const { result, rerender } = renderHook(() =>
      useAgentChatSession('thread-1')
    );

    await act(async () => {
      await result.current.send('User answer');
    });
    expect(result.current.visibleMessages).toHaveLength(1);

    currentStreamReturn = {
      ...mockStreamReturn,
      status: 'running',
      messages: [
        {
          id: 'persisted-user',
          role: 'user',
          text: 'User answer',
          ts: '2026-01-01T00:00:00Z',
        },
      ],
    };
    rerender();

    expect(result.current.visibleMessages).toEqual([
      expect.objectContaining({ id: 'persisted-user', text: 'User answer' }),
    ]);
  });

  it('send includes model and attachments when provided', async () => {
    const { result } = renderHook(() => useAgentChatSession('thread-1'));

    await act(async () => {
      await result.current.send('Hello', {
        model: 'claude-opus-4-6',
        attachments: [
          {
            id: 'a1',
            name: 'file.txt',
            type: 'text/plain',
            size: 10,
            content: 'test',
          },
        ],
      });
    });

    const call = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.model).toBe('claude-opus-4-6');
    expect(body.attachments).toHaveLength(1);
  });

  it('does not send when locked', async () => {
    const { result } = renderHook(() =>
      useAgentChatSession('thread-1', { locked: true })
    );

    await act(async () => {
      await result.current.send('Hello');
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not send when threadId is null', async () => {
    const { result } = renderHook(() => useAgentChatSession(null));

    await act(async () => {
      await result.current.send('Hello');
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('cancel posts to the cancel endpoint', async () => {
    const { result } = renderHook(() => useAgentChatSession('thread-1'));

    await act(async () => {
      await result.current.cancel();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/chat/threads/thread-1/cancel',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('shows stopping immediately and unblocks when cancellation is confirmed', async () => {
    let resolveCancel!: (value: { ok: boolean }) => void;
    (global.fetch as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCancel = resolve;
        })
    );
    currentStreamReturn = { ...mockStreamReturn, status: 'running' };
    const { result } = renderHook(() =>
      useAgentChatSession('thread-1')
    );

    act(() => {
      void result.current.cancel();
    });
    expect(result.current.isCancelling).toBe(true);

    await act(async () => {
      resolveCancel({ ok: true });
      await Promise.resolve();
    });
    expect(result.current.isCancelling).toBe(false);
    expect(result.current.isRunning).toBe(false);
    expect(result.current.isInteractionBusy).toBe(false);
  });

  it('surfaces a cancel request failure and leaves Stop retryable', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Cancellation was not accepted' }),
    });
    currentStreamReturn = { ...mockStreamReturn, status: 'running' };
    const { result } = renderHook(() => useAgentChatSession('thread-1'));

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.isCancelling).toBe(false);
    expect(result.current.sendError).toBe('Cancellation was not accepted');
  });

  it('sets sendError when fetch fails', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Rate limited' }),
    });

    const { result } = renderHook(() => useAgentChatSession('thread-1'));

    await act(async () => {
      await result.current.send('Hello');
    });

    expect(result.current.sendError).toBe('Rate limited');
  });

  it('clearSendError clears the error', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Oops' }),
    });

    const { result } = renderHook(() => useAgentChatSession('thread-1'));

    await act(async () => {
      await result.current.send('Hello');
    });
    expect(result.current.sendError).toBe('Oops');

    act(() => {
      result.current.clearSendError();
    });
    expect(result.current.sendError).toBeNull();
  });

  it('calls beforeSend and aborts if it returns false', async () => {
    const beforeSend = jest.fn().mockReturnValue(false);
    const { result } = renderHook(() =>
      useAgentChatSession('thread-1', { beforeSend })
    );

    await act(async () => {
      await result.current.send('Hello');
    });

    expect(beforeSend).toHaveBeenCalledWith('Hello');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('calls afterSend after successful send', async () => {
    const afterSend = jest.fn();
    const { result } = renderHook(() =>
      useAgentChatSession('thread-1', { afterSend })
    );

    await act(async () => {
      await result.current.send('Hello');
    });

    expect(afterSend).toHaveBeenCalled();
  });

  it('uses custom sendEndpoint when provided', async () => {
    const { result } = renderHook(() =>
      useAgentChatSession('thread-1', { sendEndpoint: '/custom/send' })
    );

    await act(async () => {
      await result.current.send('Hello');
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/custom/send',
      expect.anything()
    );
  });

  it('computes isPreparing when enablePreparationState is true and no messages', () => {
    currentStreamReturn = { ...mockStreamReturn, status: 'idle' };
    const { result } = renderHook(() =>
      useAgentChatSession('thread-1', { enablePreparationState: true })
    );
    expect(result.current.isPreparing).toBe(true);
    expect(result.current.hasPreparationError).toBe(false);
  });

  it('computes hasPreparationError on error status with no messages', () => {
    currentStreamReturn = { ...mockStreamReturn, status: 'error' };
    const { result } = renderHook(() =>
      useAgentChatSession('thread-1', { enablePreparationState: true })
    );
    expect(result.current.isPreparing).toBe(false);
    expect(result.current.hasPreparationError).toBe(true);
  });

  it('PLAN-S3-AC-2 uses the structured grounding status for preparation copy', () => {
    currentStreamReturn = {
      ...mockStreamReturn,
      status: 'running',
      groundingPreparation: {
        status: 'preparing',
        message: 'Preparing project repository…',
        retryAfterMs: 1_000,
      },
    };
    const { result } = renderHook(() =>
      useAgentChatSession('thread-1', { enablePreparationState: true })
    );

    expect(result.current.isPreparing).toBe(true);
    expect(result.current.preparationMessage).toBe('Loading…');
  });

  it('PLAN-S3-AC-3 surfaces bounded grounding failure as an actionable retry error', () => {
    currentStreamReturn = {
      ...mockStreamReturn,
      status: 'error',
      groundingPreparation: {
        status: 'failed',
        message: 'Repository preparation timed out. Please retry.',
      },
    };
    const { result } = renderHook(() =>
      useAgentChatSession('thread-1', { enablePreparationState: true })
    );

    expect(result.current.isPreparing).toBe(false);
    expect(result.current.hasPreparationError).toBe(true);
    expect(result.current.preparationMessage).toBe(
      'Repository preparation timed out. Please retry.'
    );
  });

  it('unlocks input once an agent reply is on screen while terminal status catches up', () => {
    currentStreamReturn = {
      ...mockStreamReturn,
      status: 'running',
      messages: [
        { id: '1', role: 'user', text: 'Hi', ts: '2026-01-01T00:00:00Z' },
        { id: '2', role: 'agent', text: 'Hello!', ts: '2026-01-01T00:00:01Z' },
      ],
    };
    const { result } = renderHook(() => useAgentChatSession('thread-1'));
    expect(result.current.isRunning).toBe(false);
    expect(result.current.isInteractionBusy).toBe(false);
    expect(result.current.showTypingIndicator).toBe(false);
  });

  it('shows typing while running before the agent reply lands', () => {
    currentStreamReturn = {
      ...mockStreamReturn,
      status: 'running',
      messages: [
        { id: '1', role: 'user', text: 'Hi', ts: '2026-01-01T00:00:00Z' },
      ],
    };
    const { result } = renderHook(() => useAgentChatSession('thread-1'));
    expect(result.current.showTypingIndicator).toBe(true);
  });

  it('keeps restored idle history view-only when the last message is from the user', () => {
    currentStreamReturn = {
      ...mockStreamReturn,
      status: 'running',
      messages: [
        { id: '1', role: 'user', text: 'My answer', ts: '2026-01-01T00:00:00Z' },
      ],
    };
    const first = renderHook(() => useAgentChatSession('thread-1'));
    expect(first.result.current.showTypingIndicator).toBe(true);
    first.unmount();

    currentStreamReturn = {
      ...mockStreamReturn,
      status: 'idle',
      messages: [
        { id: '1', role: 'user', text: 'My answer', ts: '2026-01-01T00:00:00Z' },
      ],
    };
    const second = renderHook(() => useAgentChatSession('thread-1'));
    expect(second.result.current.showTypingIndicator).toBe(false);
    expect(second.result.current.isAwaitingAgentResponse).toBe(false);
  });

  it('does not restore thinking after remount once an agent reply is saved', () => {
    currentStreamReturn = {
      ...mockStreamReturn,
      status: 'running',
      messages: [
        { id: '1', role: 'user', text: 'My answer', ts: '2026-01-01T00:00:00Z' },
      ],
    };
    const first = renderHook(() => useAgentChatSession('thread-1'));
    expect(first.result.current.showTypingIndicator).toBe(true);
    first.unmount();

    currentStreamReturn = {
      ...mockStreamReturn,
      status: 'idle',
      messages: [
        { id: '1', role: 'user', text: 'My answer', ts: '2026-01-01T00:00:00Z' },
        { id: '2', role: 'agent', text: 'Next question', ts: '2026-01-01T00:00:02Z' },
      ],
    };
    const second = renderHook(() => useAgentChatSession('thread-1'));
    expect(second.result.current.showTypingIndicator).toBe(false);
    expect(second.result.current.isAwaitingAgentResponse).toBe(false);
  });

  it('restores thinking only when status and active run id both show active work', () => {
    currentStreamReturn = {
      ...mockStreamReturn,
      status: 'running',
      messages: [
        { id: '1', role: 'user', text: 'My answer', ts: '2026-01-01T00:00:00Z' },
      ],
    };
    const { result } = renderHook(() =>
      useAgentChatSession('thread-1', {
        initialStatus: 'running',
        initialActiveRunId: 'run-1',
      }),
    );
    expect(result.current.showTypingIndicator).toBe(true);
    expect(result.current.isAwaitingAgentResponse).toBe(true);
  });

  it('does not restore thinking from a stale active run id on idle history', () => {
    currentStreamReturn = {
      ...mockStreamReturn,
      status: 'idle',
      messages: [
        { id: '1', role: 'user', text: 'My answer', ts: '2026-01-01T00:00:00Z' },
      ],
    };
    const { result } = renderHook(() =>
      useAgentChatSession('thread-1', {
        initialStatus: 'idle',
        initialActiveRunId: 'stale-run',
      }),
    );
    expect(result.current.showTypingIndicator).toBe(false);
    expect(result.current.isAwaitingAgentResponse).toBe(false);
  });

  it('filters visible messages with default filter', () => {
    currentStreamReturn = {
      ...mockStreamReturn,
      messages: [
        { id: '1', role: 'user', text: 'Begin.', ts: '2026-01-01T00:00:00Z' },
        { id: '2', role: 'agent', text: 'Hello!', ts: '2026-01-01T00:00:01Z' },
      ] as ChatMessage[],
    };
    const { result } = renderHook(() => useAgentChatSession('thread-1'));
    expect(result.current.visibleMessages).toHaveLength(1);
    expect(result.current.visibleMessages[0].id).toBe('2');
  });

  it('retryFailedRun posts the retry route by run identity without text', async () => {
    currentStreamReturn = {
      ...mockStreamReturn,
      retryableRunId: '50000000-0000-4000-8000-000000000001',
      messages: [
        {
          id: '1',
          role: 'user',
          text: 'Hello world',
          ts: '2026-01-01T00:00:00Z',
        },
        {
          id: '2',
          role: 'system',
          text: 'Error: boom',
          ts: '2026-01-01T00:00:02Z',
        },
      ] as ChatMessage[],
      status: 'error' as const,
    };
    const { result } = renderHook(() => useAgentChatSession('thread-1'));

    await act(async () => {
      await result.current.retryFailedRun();
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/chat/threads/thread-1/runs/50000000-0000-4000-8000-000000000001/retry',
        expect.objectContaining({
          method: 'POST',
          body: '{}',
        }),
      );
    });
    const bodies = (global.fetch as jest.Mock).mock.calls.map(
      (call) => call[1]?.body as string,
    );
    expect(bodies.every((body) => !body.includes('Hello world'))).toBe(true);
    expect(mockClearRetryableRunId).toHaveBeenCalledTimes(1);
  });

  it('keeps retryableRunId when retry POST is non-OK', async () => {
    currentStreamReturn = {
      ...mockStreamReturn,
      retryableRunId: '50000000-0000-4000-8000-000000000001',
      status: 'error' as const,
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'RUN_NOT_RETRYABLE' }),
    }) as jest.Mock;
    const { result } = renderHook(() => useAgentChatSession('thread-1'));

    await act(async () => {
      await result.current.retryFailedRun();
    });

    await waitFor(() => {
      expect(result.current.sendError).toBe('RUN_NOT_RETRYABLE');
    });
    expect(mockClearRetryableRunId).not.toHaveBeenCalled();
  });

  it('keeps retryableRunId when retry POST throws', async () => {
    currentStreamReturn = {
      ...mockStreamReturn,
      retryableRunId: '50000000-0000-4000-8000-000000000001',
      status: 'error' as const,
    };
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockRejectedValueOnce(new TypeError('network')) as jest.Mock;
    const { result } = renderHook(() => useAgentChatSession('thread-1'));

    await act(async () => {
      await result.current.retryFailedRun();
    });

    await waitFor(() => {
      expect(result.current.sendError).toBe('network');
    });
    expect(mockClearRetryableRunId).not.toHaveBeenCalled();
  });

  // Legacy blind resend — prefer retryFailedRun for durable failed runs.
  it('retryLast resends the last user message', async () => {
    currentStreamReturn = {
      ...mockStreamReturn,
      messages: [
        {
          id: '1',
          role: 'user',
          text: 'Hello world',
          ts: '2026-01-01T00:00:00Z',
        },
        { id: '2', role: 'agent', text: 'Hi!', ts: '2026-01-01T00:00:01Z' },
      ] as ChatMessage[],
    };
    const { result } = renderHook(() => useAgentChatSession('thread-1'));

    await act(async () => {
      result.current.retryLast();
    });

    // Allow the async send from retryLast to resolve
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/chat/threads/thread-1/messages',
        expect.objectContaining({
          body: expect.stringContaining('Hello world'),
        })
      );
    });
  });

  it('maps USER_INTERACTIVE_LIMIT to the exact user-facing copy', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'USER_INTERACTIVE_LIMIT' }),
    });
    const { result } = renderHook(() => useAgentChatSession('thread-1'));

    await act(async () => {
      await result.current.send('Third turn');
    });

    expect(result.current.sendError).toBe(
      'You already have two active AI turns. Finish or stop one before starting another.',
    );
  });

  it('maps USER_AGENTIC_LIMIT to the exact user-facing copy', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'USER_AGENTIC_LIMIT' }),
    });
    const { result } = renderHook(() => useAgentChatSession('thread-1'));

    await act(async () => {
      await result.current.send('Second agentic');
    });

    expect(result.current.sendError).toBe(
      'You already have an agentic AI turn running. Finish or stop it before starting another.',
    );
  });

  it('shows Queued immediately after a durable InteractiveTurnAcceptedResponse', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        turnId: TURN_ID_1,
        runId: '50000000-0000-4000-8000-000000000001',
        status: 'queued',
        interactiveClass: 'fast',
      }),
    });
    const { result } = renderHook(() =>
      useAgentChatSession('thread-1', { createTurnId: () => TURN_ID_1 }),
    );

    await act(async () => {
      await result.current.send('Hello durable');
    });

    expect(result.current.progressPhase).toBe('queued');
    expect(result.current.progressLabel).toBe('Queued');
  });

  it('shows Dispatched when the durable stream advances to that phase', async () => {
    currentStreamReturn = {
      ...mockStreamReturn,
      status: 'running',
      progressPhase: 'dispatched',
      progressLabel: 'Starting…',
    };
    const { result } = renderHook(() => useAgentChatSession('thread-1'));

    expect(result.current.progressPhase).toBe('dispatched');
    expect(result.current.progressLabel).toBe('Dispatched');
  });
});
