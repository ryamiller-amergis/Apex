import { useState, useCallback, useEffect, useRef } from 'react';
import { useChatStream } from './useChatStream';
import type {
  ChatAttachment,
  ChatMessage,
  ChatThreadStatus,
} from '../../shared/types/chat';
import type {
  ToolProgress,
  RunPhaseProgress,
  RunHealthProgress,
} from './useChatStream';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentChatSessionOptions {
  /** Initial messages to seed from the persisted thread */
  initialMessages?: ChatMessage[];
  /** Initial thread status if already known */
  initialStatus?: ChatThreadStatus;
  /** Set to true when the thread was loaded and a durable PRD file already exists */
  initialPrdReady?: boolean;

  /**
   * When true, the session is locked / read-only (no send/cancel allowed).
   * Typically derived from ownership / document status checks.
   */
  locked?: boolean;

  /**
   * Called before the message is sent. Return false (or throw) to abort.
   * Useful for standup syncToken or confirmation dialogs.
   */
  beforeSend?: (text: string) => Promise<void | boolean> | void | boolean;

  /**
   * Called after a message is successfully sent (HTTP 2xx). Useful for
   * side-effects like refetching diffs or clearing external state.
   */
  afterSend?: () => void | Promise<void>;

  /**
   * Override the endpoint used for sending messages.
   * Defaults to `/api/chat/threads/${threadId}/messages`.
   */
  sendEndpoint?: string;

  /**
   * Override the endpoint used for cancelling runs.
   * Defaults to `/api/chat/threads/${threadId}/cancel`.
   */
  cancelEndpoint?: string;

  /**
   * Filter applied to messages before computing "visible" messages.
   * If omitted, hidden "Begin." prompts are filtered by default.
   */
  visibleMessageFilter?: (message: ChatMessage) => boolean;

  /**
   * When true, enables the "preparing" state detection (no visible messages +
   * in-progress context + no streaming text). Default: false.
   */
  enablePreparationState?: boolean;
}

export interface SendOptions {
  attachments?: ChatAttachment[];
  model?: string;
}

export interface AgentChatSession {
  // --- Messages & streaming ---
  messages: ChatMessage[];
  visibleMessages: ChatMessage[];
  streamingText: string;
  thinkingText: string;
  toolProgress: ToolProgress[];
  phaseEvents: RunPhaseProgress[];
  runHealth: RunHealthProgress | null;
  progressLabel: string | null;
  progressPhase: string | null;
  prdReady: boolean;
  backlogReady: boolean;
  isRetrying: boolean;
  retryReason: string | null;
  isConnected: boolean;
  lastProgressAt: number | null;

  // --- Derived status flags ---
  status: ChatThreadStatus;
  isRunning: boolean;
  isSending: boolean;
  isCancelling: boolean;
  isAwaitingAgentResponse: boolean;
  isPreparing: boolean;
  hasPreparationError: boolean;
  isInteractionBusy: boolean;

  // --- Actions ---
  send: (text: string, opts?: SendOptions) => Promise<void>;
  retryLast: () => void;
  cancel: () => Promise<void>;

  // --- Errors ---
  sendError: string | null;
  clearSendError: () => void;
}

// Default visible-message filter: hide hidden internal prompts
const DEFAULT_VISIBLE_FILTER = (m: ChatMessage): boolean =>
  !(m.role === 'user' && m.text === 'Begin.' && !m.attachments?.length);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentChatSession(
  threadId: string | null,
  options: AgentChatSessionOptions = {},
): AgentChatSession {
  const {
    initialMessages,
    initialStatus,
    initialPrdReady,
    locked = false,
    beforeSend,
    afterSend,
    sendEndpoint,
    cancelEndpoint,
    visibleMessageFilter = DEFAULT_VISIBLE_FILTER,
    enablePreparationState = false,
  } = options;

  // --- useChatStream (the SSE subscription) ---
  const stream = useChatStream(threadId, {
    initialMessages,
    initialStatus,
    initialPrdReady,
  });

  const {
    messages,
    streamingText,
    thinkingText,
    toolProgress,
    status,
    isConnected,
    lastProgressAt,
    phaseEvents,
    runHealth,
    progressLabel,
    progressPhase,
    prdReady,
    backlogReady,
    isRetrying,
    retryReason,
  } = stream;

  // --- Local state ---
  const [isSending, setIsSending] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isAwaitingAgentResponse, setIsAwaitingAgentResponse] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [optimisticUserMessage, setOptimisticUserMessage] =
    useState<ChatMessage | null>(null);
  const optimisticBaselineIdsRef = useRef<Set<string>>(new Set());

  // Refs for pending-message tracking (generalized from Interview)
  const pendingMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingObservedRunningRef = useRef(false);

  // Derived
  const isRunning = status === 'running';
  const hasPersistedOptimisticEcho = Boolean(
    optimisticUserMessage &&
    messages.some(
      (message) =>
        message.role === 'user' &&
        message.text === optimisticUserMessage.text &&
        !optimisticBaselineIdsRef.current.has(message.id),
    ),
  );
  const displayedMessages =
    optimisticUserMessage && !hasPersistedOptimisticEcho
      ? [...messages, optimisticUserMessage]
      : messages;
  const visibleMessages = displayedMessages.filter(visibleMessageFilter);

  // Preparation state (opt-in)
  const isEmptyInProgress = enablePreparationState
    && visibleMessages.length === 0
    && !streamingText;
  const isPreparing = Boolean(isEmptyInProgress && status !== 'error');
  const hasPreparationError = Boolean(isEmptyInProgress && status === 'error');

  const isInteractionBusy = isRunning || isSending || isAwaitingAgentResponse || isPreparing;

  // --- Awaiting-agent-response tracking ---
  const beginAwaitingAgentResponse = useCallback(() => {
    pendingMessageIdsRef.current = new Set(messages.map((m) => m.id));
    pendingObservedRunningRef.current = false;
    setIsAwaitingAgentResponse(true);
  }, [messages]);

  const clearAwaitingAgentResponse = useCallback(() => {
    pendingMessageIdsRef.current.clear();
    pendingObservedRunningRef.current = false;
    setIsAwaitingAgentResponse(false);
  }, []);

  // Clear when agent responds or thread transitions
  useEffect(() => {
    if (!isAwaitingAgentResponse) return;

    if (isRunning) {
      pendingObservedRunningRef.current = true;
      return;
    }

    const receivedAgentOutcome = messages.some(
      (m) =>
        !pendingMessageIdsRef.current.has(m.id)
        && (m.role === 'agent' || m.role === 'system'),
    );

    if (
      receivedAgentOutcome
      || pendingObservedRunningRef.current
      || status === 'error'
      || status === 'closed'
    ) {
      clearAwaitingAgentResponse();
    }
  }, [clearAwaitingAgentResponse, isAwaitingAgentResponse, isRunning, messages, status]);

  // Reset awaiting on thread change
  useEffect(() => {
    clearAwaitingAgentResponse();
    setOptimisticUserMessage(null);
    setIsCancelling(false);
  }, [threadId, clearAwaitingAgentResponse]);

  useEffect(() => {
    if (hasPersistedOptimisticEcho) setOptimisticUserMessage(null);
  }, [hasPersistedOptimisticEcho]);

  useEffect(() => {
    if (isCancelling && !isRunning) setIsCancelling(false);
  }, [isCancelling, isRunning]);

  // --- Send ---
  const send = useCallback(async (text: string, opts: SendOptions = {}) => {
    if (locked || !threadId) return;
    if (!text && !opts.attachments?.length) return;
    if (isInteractionBusy) return;

    // beforeSend hook (e.g. syncToken)
    if (beforeSend) {
      const result = await beforeSend(text);
      if (result === false) return;
    }

    setSendError(null);
    setIsSending(true);
    optimisticBaselineIdsRef.current = new Set(messages.map((message) => message.id));
    setOptimisticUserMessage({
      id: `optimistic-user-${Date.now()}`,
      role: 'user',
      text,
      ts: new Date().toISOString(),
      ...(opts.attachments?.length
        ? {
            attachments: opts.attachments.map(({ id, name, type, size }) => ({
              id,
              name,
              type,
              size,
            })),
          }
        : {}),
    });
    beginAwaitingAgentResponse();

    try {
      const endpoint = sendEndpoint ?? `/api/chat/threads/${threadId}/messages`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          text,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
        }),
      });

      if (!res.ok) {
        let msg = 'Failed to send message';
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch { /* use default */ }
        setSendError(msg);
        setOptimisticUserMessage(null);
        clearAwaitingAgentResponse();
        return;
      }

      // afterSend hook (e.g. refetchDiff)
      if (afterSend) {
        await afterSend();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send message';
      setSendError(msg);
      setOptimisticUserMessage(null);
      clearAwaitingAgentResponse();
    } finally {
      setIsSending(false);
    }
  }, [
    locked,
    threadId,
    isInteractionBusy,
    beforeSend,
    beginAwaitingAgentResponse,
    messages,
    sendEndpoint,
    afterSend,
    clearAwaitingAgentResponse,
  ]);

  // --- Retry last user message ---
  const retryLast = useCallback(() => {
    if (locked || !threadId || isInteractionBusy) return;
    const lastUserMsg = [...visibleMessages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) return;
    void send(lastUserMsg.text);
  }, [locked, threadId, isInteractionBusy, visibleMessages, send]);

  // --- Cancel ---
  const cancel = useCallback(async () => {
    if (!threadId || isCancelling) return;
    const endpoint = cancelEndpoint ?? `/api/chat/threads/${threadId}/cancel`;
    setIsCancelling(true);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) setIsCancelling(false);
    } catch {
      setIsCancelling(false);
    }
  }, [threadId, cancelEndpoint, isCancelling]);

  // --- Clear send error ---
  const clearSendError = useCallback(() => setSendError(null), []);

  return {
    // Messages & streaming
    messages: displayedMessages,
    visibleMessages,
    streamingText,
    thinkingText,
    toolProgress,
    phaseEvents,
    runHealth,
    progressLabel,
    progressPhase,
    prdReady,
    backlogReady,
    isRetrying,
    retryReason,
    isConnected,
    lastProgressAt,

    // Status flags
    status,
    isRunning,
    isSending,
    isCancelling,
    isAwaitingAgentResponse,
    isPreparing,
    hasPreparationError,
    isInteractionBusy,

    // Actions
    send,
    retryLast,
    cancel,

    // Errors
    sendError,
    clearSendError,
  };
}
