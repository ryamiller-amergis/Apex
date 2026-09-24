import { useState, useCallback, useEffect, useRef } from 'react';
import { useChatStream } from './useChatStream';
import type {
  AgentRunPhase,
  ChatAttachment,
  ChatMessage,
  ChatTurnSkill,
  ChatThreadStatus,
} from '../../shared/types/chat';
import type {
  ToolProgress,
  RunPhaseProgress,
  RunHealthProgress,
} from './useChatStream';
import { friendlyChatProgressLabel } from '../../shared/utils/chatProgressCopy';
import { createChatTurnId } from '../utils/chatTurnId';

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

  /** Generates the idempotency identity once per user send attempt. */
  createTurnId?: () => string;
}

export interface SendOptions {
  attachments?: ChatAttachment[];
  model?: string;
  skill?: ChatTurnSkill;
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
  hasConnectionError: boolean;
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
  /** Retry a failed durable run by identity — never resends text. */
  retryFailedRun: () => Promise<void>;
  /** Failed durable run ID from the stream, if the terminal error carried one. */
  retryableRunId: string | null;
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
    createTurnId = createChatTurnId,
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
    hasConnectionError,
    lastProgressAt,
    phaseEvents,
    runHealth,
    progressLabel,
    progressPhase,
    prdReady,
    backlogReady,
    isRetrying,
    retryReason,
    retryableRunId,
    clearRetryableRunId,
    groundingPreparation,
  } = stream;

  // --- Local state ---
  const [isSending, setIsSending] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isStopConfirmed, setIsStopConfirmed] = useState(false);
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
  const streamIsRunning = status === 'running';
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
  const lastVisibleRole = visibleMessages[visibleMessages.length - 1]?.role;
  // A persisted agent message is the completed response for this turn. The
  // terminal status event can arrive a little later, especially through the
  // actor lane; do not keep answers and the composer locked during that gap.
  const isWaitingForUser =
    lastVisibleRole === 'agent' && !streamingText && !thinkingText;
  const isRunning =
    streamIsRunning && !isStopConfirmed && !isWaitingForUser;

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
  const beginAwaitingAgentResponse = useCallback(() => {
    skipThinkingRestoreRef.current = false;
    pendingMessageIdsRef.current = new Set(messages.map((m) => m.id));
    pendingObservedRunningRef.current = false;
    setIsAwaitingAgentResponse(true);
  }, [messages]);

  const clearAwaitingAgentResponse = useCallback(() => {
    pendingMessageIdsRef.current.clear();
    pendingObservedRunningRef.current = false;
    setIsAwaitingAgentResponse(false);
  }, []);

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
    setIsStopConfirmed(false);
    pendingMessageIdsRef.current.clear();
    pendingObservedRunningRef.current = false;
    setIsAwaitingAgentResponse(false);
  }, [threadId]);

  // Restore thinking after refresh when the last visible line is still the user.
  useEffect(() => {
    if (!threadId || isAwaitingAgentResponse || skipThinkingRestoreRef.current) return;

    if (lastVisibleRole === 'agent') return;
    if (lastVisibleRole !== 'user') return;

    // History is a snapshot, not a new turn. Restore the waiting indicator only
    // when the persisted thread identifies a run that is still active.
    const shouldResume =
      isRunning &&
      initialStatus === 'running' &&
      Boolean(initialActiveRunId);

    if (!shouldResume) return;

    pendingMessageIdsRef.current = new Set(messages.map((m) => m.id));
    pendingObservedRunningRef.current = false;
    setIsAwaitingAgentResponse(true);
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
    if (hasPersistedOptimisticEcho) setOptimisticUserMessage(null);
  }, [hasPersistedOptimisticEcho]);

  useEffect(() => {
    if (isCancelling && !isRunning) setIsCancelling(false);
  }, [isCancelling, isRunning]);

  useEffect(() => {
    if (status !== 'running') setIsStopConfirmed(false);
  }, [status]);

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
      setIsStopConfirmed(false);
      setIsSending(true);
      const turnId = createTurnId();
      optimisticBaselineIdsRef.current = new Set(
        messages.map((message) => message.id)
      );
      setOptimisticUserMessage({
        id: turnId,
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
        const body = JSON.stringify({
          turnId,
          text,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.skill ? { skill: opts.skill } : {}),
          ...(opts.attachments?.length
            ? { attachments: opts.attachments }
            : {}),
        });
        let res: Response | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            res = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body,
            });
            break;
          } catch (error) {
            if (attempt === 1) throw error;
          }
        }
        if (!res) {
          throw new Error('Failed to send message');
        }

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

        clearRetryableRunId();

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
      createTurnId,
      clearRetryableRunId,
    ]
  );

  // Legacy blind resend of the last user message. Prefer retryFailedRun for
  // durable failed runs so the server retries by identity without resending text.
  const retryLast = useCallback(() => {
    if (locked || !threadId || isInteractionBusy) return;
    const lastUserMsg = [...visibleMessages]
      .reverse()
      .find((m) => m.role === 'user');
    if (!lastUserMsg) return;
    void send(lastUserMsg.text);
  }, [locked, threadId, isInteractionBusy, visibleMessages, send]);

  // --- Retry failed durable run by identity (no text / optimistic message) ---
  const retryFailedRun = useCallback(async () => {
    if (locked || !threadId || isInteractionBusy) return;
    if (!retryableRunId) return;

    setSendError(null);
    setIsStopConfirmed(false);
    setIsSending(true);
    beginAwaitingAgentResponse();
    const runId = retryableRunId;

    try {
      const endpoint = `/api/chat/threads/${threadId}/runs/${runId}/retry`;
      let res: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: '{}',
          });
          break;
        } catch (error) {
          if (attempt === 1) throw error;
        }
      }
      if (!res) {
        throw new Error('Failed to retry run');
      }

      if (!res.ok) {
        let msg = 'Failed to retry run';
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch {
          /* use default */
        }
        setSendError(msg);
        clearAwaitingAgentResponse();
        return;
      }

      clearRetryableRunId();

      if (afterSend) {
        await afterSend();
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to retry run';
      setSendError(msg);
      clearAwaitingAgentResponse();
    } finally {
      setIsSending(false);
    }
  }, [
    locked,
    threadId,
    isInteractionBusy,
    retryableRunId,
    beginAwaitingAgentResponse,
    clearRetryableRunId,
    afterSend,
    clearAwaitingAgentResponse,
  ]);

  // --- Cancel ---
  const cancel = useCallback(async () => {
    if (!threadId || isCancelling) return;
    const endpoint = cancelEndpoint ?? `/api/chat/threads/${threadId}/cancel`;
    setSendError(null);
    setIsCancelling(true);
    clearRetryableRunId();
    skipThinkingRestoreRef.current = true;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) {
        let message = 'Failed to stop the agent. Please try again.';
        try {
          const body = await response.json();
          if (body?.error) message = body.error;
        } catch {
          /* use default */
        }
        setSendError(message);
        setIsCancelling(false);
      } else {
        // The endpoint returns only after the server has persisted the idle
        // thread state. Do not leave the composer blocked on a delayed stream.
        clearAwaitingAgentResponse();
        setIsStopConfirmed(true);
        setIsCancelling(false);
      }
    } catch (error) {
      setSendError(
        error instanceof Error
          ? error.message
          : 'Failed to stop the agent. Please try again.'
      );
      setIsCancelling(false);
    }
  }, [threadId, cancelEndpoint, isCancelling, clearAwaitingAgentResponse, clearRetryableRunId]);

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
    hasConnectionError,
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
    retryFailedRun,
    retryableRunId,
    cancel,

    // Errors
    sendError,
    clearSendError,
  };
}
