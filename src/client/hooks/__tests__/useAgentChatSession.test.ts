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
  lastProgressAt: number | null;
  phaseEvents: RunPhaseProgress[];
  runHealth: RunHealthProgress | null;
  progressLabel: string | null;
  progressPhase: AgentRunPhase | null;
  prdReady: boolean;
  backlogReady: boolean;
  isRetrying: boolean;
  retryReason: string | null;
  groundingPreparation: GroundingPreparationProgress | null;
}

const mockStreamReturn: MockStreamReturn = {
  messages: [],
  streamingText: '',
  thinkingText: '',
  toolProgress: [],
  status: 'idle',
  isConnected: true,
  lastProgressAt: null,
  phaseEvents: [],
  runHealth: null,
  progressLabel: null,
  progressPhase: null,
  prdReady: false,
  backlogReady: false,
  isRetrying: false,
  retryReason: null,
  groundingPreparation: null,
};

let currentStreamReturn: MockStreamReturn = { ...mockStreamReturn };

jest.mock('../useChatStream', () => ({
  useChatStream: () => currentStreamReturn,
}));

describe('useAgentChatSession', () => {
  beforeEach(() => {
    currentStreamReturn = { ...mockStreamReturn };
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock;
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
    const { result } = renderHook(() => useAgentChatSession('thread-1'));

    await act(async () => {
      await result.current.send('Hello');
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/chat/threads/thread-1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'Hello' }),
      })
    );
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

  it('exposes a stopping state until the running stream becomes idle', async () => {
    currentStreamReturn = { ...mockStreamReturn, status: 'running' };
    const { result, rerender } = renderHook(() =>
      useAgentChatSession('thread-1')
    );

    await act(async () => {
      await result.current.cancel();
    });
    expect(result.current.isCancelling).toBe(true);

    currentStreamReturn = { ...mockStreamReturn, status: 'idle' };
    rerender();
    await waitFor(() => expect(result.current.isCancelling).toBe(false));
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

  it('hides typing once an agent reply is on screen while the run is still finishing', () => {
    currentStreamReturn = {
      ...mockStreamReturn,
      status: 'running',
      messages: [
        { id: '1', role: 'user', text: 'Hi', ts: '2026-01-01T00:00:00Z' },
        { id: '2', role: 'agent', text: 'Hello!', ts: '2026-01-01T00:00:01Z' },
      ],
    };
    const { result } = renderHook(() => useAgentChatSession('thread-1'));
    expect(result.current.isRunning).toBe(true);
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
});
