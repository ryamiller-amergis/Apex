import { useState, useCallback, useEffect, useRef } from 'react';
import { useChatStream } from './useChatStream';
import type {
  AgentRunPhase,
  ChatAttachment,
  ChatMessage,
  ChatThreadStatus,
} from '../../shared/types/chat';
import type {
  ToolProgress,
  RunPhaseProgress,
  RunHealthProgress,
} from './useChatStream';
import { friendlyChatProgressLabel } from '../../shared/utils/chatProgressCopy';

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

  /** Active run id from the persisted thread, used to restore thinking after refresh. */
  initialActiveRunId?: string | null;
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
  progressPhase: AgentRunPhase | null;
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
  preparationMessage: string | null;
  isInteractionBusy: boolean;
  /** True while a turn is in flight but the agent reply is not on screen yet. */
  showTypingIndicator: boolean;

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

/** Typing dots belong before the first on-screen agent bubble of this turn, not after it. */
export function shouldShowAgentTypingIndicator(input: {
  isBusy: boolean;
  streamingText: string;
  lastVisibleRole?: ChatMessage['role'];
  isRetrying?: boolean;
}): boolean {
  if (!input.isBusy) return false;
  if (input.streamingText) return false;
  if (input.isRetrying) return false;
  return input.lastVisibleRole !== 'agent';
}

const PENDING_THINKING_TTL_MS = 2 * 60 * 60 * 1000;

function pendingThinkingStorageKey(threadId: string): string {
  return `apex:pending-agent-thinking:${threadId}`;
}

function readPendingAgentThinking(threadId: string | null): boolean {
  if (!threadId || typeof window === 'undefined') return false;
  try {
    const raw = window.sessionStorage.getItem(pendingThinkingStorageKey(threadId));
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { startedAt?: number };
    if (typeof parsed.startedAt !== 'number') {
      window.sessionStorage.removeItem(pendingThinkingStorageKey(threadId));
      return false;
    }
    if (Date.now() - parsed.startedAt > PENDING_THINKING_TTL_MS) {
      window.sessionStorage.removeItem(pendingThinkingStorageKey(threadId));
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function writePendingAgentThinking(threadId: string | null): void {
  if (!threadId || typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      pendingThinkingStorageKey(threadId),
      JSON.stringify({ startedAt: Date.now() }),
    );
  } catch {
    /* ignore quota / private mode */
  }
}

function clearPendingAgentThinking(threadId: string | null): void {
  if (!threadId || typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(pendingThinkingStorageKey(threadId));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentChatSession(
  threadId: string | null,
  options: AgentChatSessionOptions = {}
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
    initialActiveRunId,
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
    groundingPreparation,
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
  const skipThinkingRestoreRef = useRef(false);

  // Derived
  const isRunning = status === 'running';
  const hasPersistedOptimisticEcho = Boolean(
    optimisticUserMessage &&
    messages.some(
      (message) =>
        message.role === 'user' &&
        message.text === optimisticUserMessage.text &&
        !optimisticBaselineIdsRef.current.has(message.id)
    )
  );
  const displayedMessages =
    optimisticUserMessage && !hasPersistedOptimisticEcho
      ? [...messages, optimisticUserMessage]
      : messages;
  const visibleMessages = displayedMessages.filter(visibleMessageFilter);

  // Preparation state (opt-in)
  const isEmptyInProgress =
    enablePreparationState && visibleMessages.length === 0 && !streamingText;
  const isPreparing = Boolean(
    groundingPreparation?.status === 'preparing' ||
    (enablePreparationState && isEmptyInProgress && status !== 'error')
  );
  const hasPreparationError = Boolean(
    groundingPreparation?.status === 'failed' ||
    (enablePreparationState && isEmptyInProgress && status === 'error')
  );
  const preparationMessage =
    groundingPreparation?.message
      ? friendlyChatProgressLabel(groundingPreparation.message, 'setup')
      : isPreparing
        ? friendlyChatProgressLabel('Preparing project repository…', 'setup')
        : null;

  const isInteractionBusy =
    isRunning || isSending || isAwaitingAgentResponse || isPreparing;

  const showTypingIndicator = shouldShowAgentTypingIndicator({
    isBusy: isRunning || isSending || isAwaitingAgentResponse,
    streamingText,
    lastVisibleRole: visibleMessages[visibleMessages.length - 1]?.role,
    isRetrying,
  });

  // --- Awaiting-agent-response tracking ---
  const lastVisibleRole = visibleMessages[visibleMessages.length - 1]?.role;

  const beginAwaitingAgentResponse = useCallback(() => {
    skipThinkingRestoreRef.current = false;
    pendingMessageIdsRef.current = new Set(messages.map((m) => m.id));
    pendingObservedRunningRef.current = false;
    setIsAwaitingAgentResponse(true);
    writePendingAgentThinking(threadId);
  }, [messages, threadId]);

  const clearAwaitingAgentResponse = useCallback(() => {
    pendingMessageIdsRef.current.clear();
    pendingObservedRunningRef.current = false;
    setIsAwaitingAgentResponse(false);
    clearPendingAgentThinking(threadId);
  }, [threadId]);

  // Clear when an agent reply lands or the thread errors/closes — not when a
  // refresh snapshot briefly looks idle while the turn is still in flight.
  useEffect(() => {
    if (!isAwaitingAgentResponse) return;

    const receivedAgentOutcome = messages.some(
      (m) =>
        !pendingMessageIdsRef.current.has(m.id) &&
        (m.role === 'agent' || m.role === 'system')
    );

    if (
      receivedAgentOutcome ||
      lastVisibleRole === 'agent' ||
      status === 'error' ||
      status === 'closed'
    ) {
      clearAwaitingAgentResponse();
    }
  }, [
    clearAwaitingAgentResponse,
    isAwaitingAgentResponse,
    lastVisibleRole,
    messages,
    status,
  ]);

  // Reset local turn state when switching threads.
  useEffect(() => {
    skipThinkingRestoreRef.current = false;
    setOptimisticUserMessage(null);
    setIsCancelling(false);
    pendingMessageIdsRef.current.clear();
    pendingObservedRunningRef.current = false;
    setIsAwaitingAgentResponse(false);
  }, [threadId]);

  // Restore thinking after refresh when the last visible line is still the user.
  useEffect(() => {
    if (!threadId || isAwaitingAgentResponse || skipThinkingRestoreRef.current) return;

    if (lastVisibleRole === 'agent') {
      clearPendingAgentThinking(threadId);
      return;
    }

    if (lastVisibleRole !== 'user') return;

    const shouldResume =
      isRunning ||
      initialStatus === 'running' ||
      Boolean(initialActiveRunId) ||
      readPendingAgentThinking(threadId);

    if (!shouldResume) return;

    pendingMessageIdsRef.current = new Set(messages.map((m) => m.id));
    pendingObservedRunningRef.current = false;
    setIsAwaitingAgentResponse(true);
    writePendingAgentThinking(threadId);
  }, [
    initialActiveRunId,
    initialStatus,
    isAwaitingAgentResponse,
    isRunning,
    lastVisibleRole,
    messages,
    threadId,
  ]);

  useEffect(() => {
    if (!threadId) return;
    if (lastVisibleRole === 'agent' || status === 'error' || status === 'closed') {
      clearPendingAgentThinking(threadId);
      return;
    }
    if (
      !isCancelling &&
      (isRunning || isAwaitingAgentResponse) &&
      lastVisibleRole === 'user'
    ) {
      writePendingAgentThinking(threadId);
    }
  }, [
    isAwaitingAgentResponse,
    isCancelling,
    isRunning,
    lastVisibleRole,
    status,
    threadId,
  ]);

  useEffect(() => {
    if (hasPersistedOptimisticEcho) setOptimisticUserMessage(null);
  }, [hasPersistedOptimisticEcho]);

  useEffect(() => {
    if (isCancelling && !isRunning) setIsCancelling(false);
  }, [isCancelling, isRunning]);

  // --- Send ---
  const send = useCallback(
    async (text: string, opts: SendOptions = {}) => {
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
      optimisticBaselineIdsRef.current = new Set(
        messages.map((message) => message.id)
      );
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
        const endpoint =
          sendEndpoint ?? `/api/chat/threads/${threadId}/messages`;
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            text,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.attachments?.length
              ? { attachments: opts.attachments }
              : {}),
          }),
        });

        if (!res.ok) {
          let msg = 'Failed to send message';
          try {
            const body = await res.json();
            if (body?.error) msg = body.error;
          } catch {
            /* use default */
          }
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
        const msg =
          err instanceof Error ? err.message : 'Failed to send message';
        setSendError(msg);
        setOptimisticUserMessage(null);
        clearAwaitingAgentResponse();
      } finally {
        setIsSending(false);
      }
    },
    [
      locked,
      threadId,
      isInteractionBusy,
      beforeSend,
      beginAwaitingAgentResponse,
      messages,
      sendEndpoint,
      afterSend,
      clearAwaitingAgentResponse,
    ]
  );

  // --- Retry last user message ---
  const retryLast = useCallback(() => {
    if (locked || !threadId || isInteractionBusy) return;
    const lastUserMsg = [...visibleMessages]
      .reverse()
      .find((m) => m.role === 'user');
    if (!lastUserMsg) return;
    void send(lastUserMsg.text);
  }, [locked, threadId, isInteractionBusy, visibleMessages, send]);

  // --- Cancel ---
  const cancel = useCallback(async () => {
    if (!threadId || isCancelling) return;
    const endpoint = cancelEndpoint ?? `/api/chat/threads/${threadId}/cancel`;
    setIsCancelling(true);
    skipThinkingRestoreRef.current = true;
    clearAwaitingAgentResponse();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) setIsCancelling(false);
    } catch {
      setIsCancelling(false);
    }
  }, [threadId, cancelEndpoint, isCancelling, clearAwaitingAgentResponse]);

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
    preparationMessage,
    isInteractionBusy,
    showTypingIndicator,

    // Actions
    send,
    retryLast,
    cancel,

    // Errors
    sendError,
    clearSendError,
  };
}
