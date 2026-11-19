/**
 * TBI-004 NFR / PBI-003 AC-3 / VT-28 & PBI-002 AC-1 / VT-22:
 * Client timing telemetry allowlist (drops message text and unknown keys)
 * and `useAgentChatSession` resilience when a stream stalls/fails or delivers
 * unknown live events such as `summary`.
 */
import { act, renderHook } from '@testing-library/react';
import { CHAT_AREA_IDS, resolveChatAreaId } from '../../../shared/types/chatHarness';
import { emitChatTiming } from '../../services/chatTimingTelemetry';

const mockTrackEvent = jest.fn();
jest.mock('../../services/telemetry', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

let mockStreamState = {
  messages: [] as Array<{ id: string; role: 'user' | 'agent'; text: string; ts: string }>,
  streamingText: '',
  thinkingText: '',
  toolProgress: [],
  status: 'idle' as 'idle' | 'running' | 'error' | 'closed',
  isConnected: true,
  hasConnectionError: false,
  lastProgressAt: null as number | null,
  phaseEvents: [],
  runHealth: null,
  progressLabel: null as string | null,
  progressPhase: null,
  prdReady: false,
  backlogReady: false,
  isRetrying: false,
  retryReason: null,
  retryableRunId: null as string | null,
  clearRetryableRunId: jest.fn(),
  groundingPreparation: null,
};

jest.mock('../useChatStream', () => ({
  useChatStream: () => mockStreamState,
}));

import { useAgentChatSession } from '../useAgentChatSession';

describe('chatTimingTelemetry allowlist and area seed (PBI-003 AC-3 / VT-28)', () => {
  beforeEach(() => {
    mockTrackEvent.mockReset();
    mockStreamState = {
      ...mockStreamState,
      messages: [],
      streamingText: '',
      status: 'idle',
      isConnected: true,
      hasConnectionError: false,
      progressLabel: null,
      retryableRunId: null,
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'dispatched' }),
    }) as jest.Mock;
  });

  it('exports all 13 canonical chat area ids and maps workflow classes', () => {
    expect(CHAT_AREA_IDS).toHaveLength(13);
    expect(resolveChatAreaId('home-chat')).toBe('agent-home');
    expect(resolveChatAreaId('agent_home_chat')).toBe('agent-home');
    expect(resolveChatAreaId('brainstorm')).toBe('brainstorm');
    expect(resolveChatAreaId('interview')).toBe('interview');
  });

  it('PBI-003 AC-3 / VT-28: strips message text, prompt text, and non-allowlisted keys before calling trackEvent', () => {
    emitChatTiming('send_to_feedback', {
      area: 'brainstorm',
      projectId: 'Apex',
      threadId: 'thread-99',
      acquisitionMode: 'warm',
      durationMs: 142,
      status: 'ok',
      // Injected sensitive fields that must never be stored or forwarded:
      text: 'User confidential prompt message',
      prompt: 'System secret prompt',
      summary: 'Summary body',
    } as Record<string, unknown>);

    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [eventName, props] = mockTrackEvent.mock.calls[0];
    expect(eventName).toBe('chat.timing.send_to_feedback');
    expect(props).toEqual({
      area: 'brainstorm',
      projectId: 'Apex',
      threadId: 'thread-99',
      acquisitionMode: 'warm',
      durationMs: '142',
      status: 'ok',
    });
    expect(props).not.toHaveProperty('text');
    expect(props).not.toHaveProperty('prompt');
    expect(props).not.toHaveProperty('summary');
  });

  it('PBI-002 AC-1 / VT-22: keeps the user message and exposes retryableRunId when a stalled turn fails', async () => {
    const { result, rerender } = renderHook(() =>
      useAgentChatSession('thread-stall-1', {
        area: 'brainstorm',
        projectId: 'Apex',
        createTurnId: () => '10000000-0000-4000-8000-000000000099',
      }),
    );

    await act(async () => {
      await result.current.send('Check the deployment metrics');
    });

    expect(result.current.visibleMessages).toEqual([
      expect.objectContaining({
        role: 'user',
        text: 'Check the deployment metrics',
      }),
    ]);

    // Turn enters running with heartbeat label, then fails with retryableRunId.
    mockStreamState = {
      ...mockStreamState,
      status: 'running',
      progressLabel: 'Still working',
    };
    rerender();
    expect(result.current.isRunning).toBe(true);

    mockStreamState = {
      ...mockStreamState,
      status: 'error',
      progressLabel: null,
      retryableRunId: 'run-failed-42',
    };
    rerender();

    expect(result.current.isRunning).toBe(false);
    expect(result.current.visibleMessages).toEqual([
      expect.objectContaining({
        role: 'user',
        text: 'Check the deployment metrics',
      }),
    ]);
    expect(result.current.retryableRunId).toBe('run-failed-42');
  });
});
