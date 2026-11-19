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
import { friendlyChatErrorMessage, friendlyChatProgressLabel } from '../../shared/utils/chatProgressCopy';
import { createChatTurnId } from '../utils/chatTurnId';
import type { ThreadStreamTransport } from '../utils/threadEventStream';
import type { ChatAreaId, HarnessAreaId } from '../../shared/types/chatHarness';
import { emitChatTiming } from '../services/chatTimingTelemetry';
import {
  useChatRuntime,
  type AgentActivityItem,
  type ConnectionState,
  type CreateChatRuntimeDeps,
  type HarnessMessageFailureState,
  type HarnessReceiptView,
  type HarnessSummaryNoticeState,
  type PendingCommand,
} from '../chatHarness';

const EMPTY_ACTIVITY: AgentActivityItem[] = [];
const EMPTY_PENDING_COMMANDS: PendingCommand[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_TOOL_PROGRESS: ToolProgress[] = [];
const EMPTY_PHASE_EVENTS: RunPhaseProgress[] = [];
const DISABLED_STREAM_OPTIONS = {};

function mapSendErrorMessage(raw: string): string {
  return friendlyChatErrorMessage(raw);
}

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
   * Override the endpoint used for retrying a failed run.
   * Defaults to `/api/chat/threads/${threadId}/runs/${runId}/retry`.
   */
  retryEndpoint?: (runId: string) => string;

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

  /** Force the live event transport. Omit to keep the shared auto choice. */
  streamTransport?: ThreadStreamTransport;

  /** Optional canonical chat area id for baseline / harness timing telemetry. */
  area?: ChatAreaId;

  /** Optional project identifier for baseline / harness timing telemetry. */
  projectId?: string | null;

  /** Marks this surface as a governed harness area (activates the harness runtime). */
  harnessArea?: HarnessAreaId;

  /**
   * Explicit opt-in to the harness runtime even when `harnessArea` is determined
   * from the server snapshot.
   */
  useHarness?: boolean;

  /** Optional injectable dependencies for the harness runtime (e.g. tests). */
  runtimeDeps?: CreateChatRuntimeDeps;
}

export interface SendOptions {
  attachments?: ChatAttachment[];
  model?: string;
  mode?: string;
  skill?: ChatTurnSkill;
  /**
   * Send the opening prompt while the empty-thread preparation state is the
   * only reason the session is busy. A live run, an in-flight send, or an
   * awaited reply still blocks.
   */
  duringPreparation?: boolean;
  /**
   * Allow sending when a caller-owned ledger already confirms the prior turn
   * is settled (e.g. Brainstorm's `brainstorm_messages` ledger) even if the
   * WebSocket stream has not yet emitted its terminal frame.
   */
  ignoreStaleStreamBusy?: boolean;
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
  send: (text: string, opts?: SendOptions) => Promise<boolean>;
  retryLast: () => void;
  /**
   * Retry a failed durable run by identity — never resends text. Uses
   * `runId` when given, otherwise the run id carried by the stream.
   */
  retryFailedRun: (runId?: string) => Promise<void>;
  /** Failed durable run ID from the stream, if the terminal error carried one. */
  retryableRunId: string | null;
  /**
   * True after send returns false because the request was rejected.
   * Stays false when send returns early and never leaves the browser.
   */
  sendRejectedRef: { current: boolean };
  cancel: () => Promise<void>;

  // --- Errors ---
  sendError: string | null;
  clearSendError: () => void;

  // --- Harness controls & state ---
  steer: (text: string) => Promise<boolean>;
  summarize: () => Promise<boolean>;
  connectionState: ConnectionState;
  pendingCommands: PendingCommand[];
  lastReceipt: HarnessReceiptView | null;
  clearReceipt: () => void;
  activity: AgentActivityItem[];
  summaryNotice: HarnessSummaryNoticeState | null;
  canWrite: boolean;
  lastFailure: HarnessMessageFailureState | null;
  snapshotLoaded: boolean;
  snapshotError: string | null;
  snapshotStatusCode: number | null;
  retrySnapshot: () => Promise<void>;
  terminalRevision: number;
  harnessArea: HarnessAreaId | null;
  isSteerSupported: boolean;
  isSummarizeSupported: boolean;
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
    retryEndpoint,
    visibleMessageFilter = DEFAULT_VISIBLE_FILTER,
    enablePreparationState = false,
    initialActiveRunId,
    createTurnId = createChatTurnId,
    streamTransport,
    area,
    projectId,
    harnessArea,
    useHarness,
    runtimeDeps,
  } = options;

  const useHarnessRuntime = Boolean(harnessArea || useHarness);
  const httpFetchImpl = runtimeDeps?.fetchImpl;

  // --- useChatStream (the legacy SSE subscription; disabled when harness runtime is active) ---
  const stream = useChatStream(
    useHarnessRuntime ? null : threadId,
    useHarnessRuntime
      ? DISABLED_STREAM_OPTIONS
      : {
          initialMessages,
          initialStatus,
          initialPrdReady,
          streamTransport,
        },
  );

  // --- useChatRuntime (the governed harness runtime; disabled on legacy callers) ---
  const { runtime, state: runtimeState } = useChatRuntime(
    useHarnessRuntime ? threadId : null,
    {
      enabled: useHarnessRuntime,
      area: harnessArea ?? area,
      initialMessages,
      initialStatus,
      initialPrdReady,
      initialHarnessArea: harnessArea ?? null,
      ...runtimeDeps,
    },
  );

  const effectiveHarnessArea: HarnessAreaId | null = useHarnessRuntime
    ? (runtimeState.harnessArea ??
        (runtimeState.snapshotLoaded ? null : (harnessArea ?? null)))
    : null;
  const isHarnessCommandMode =
    useHarnessRuntime && effectiveHarnessArea !== null;
  const isForbiddenSnapshot =
    useHarnessRuntime &&
    (runtimeState.snapshotStatusCode === 403 ||
      runtimeState.snapshotStatusCode === 401);
  const effectiveCanWrite = useHarnessRuntime
    ? !locked && runtimeState.canWrite
    : !locked;

  const messages = useHarnessRuntime
    ? isForbiddenSnapshot
      ? EMPTY_MESSAGES
      : runtime
        ? runtime.getDisplayedMessages()
        : runtimeState.messages
    : stream.messages;
  const streamingText = useHarnessRuntime
    ? isForbiddenSnapshot
      ? ''
      : runtimeState.streamingText
    : stream.streamingText;
  const thinkingText = useHarnessRuntime
    ? isForbiddenSnapshot
      ? ''
      : runtimeState.thinkingText
    : stream.thinkingText;
  const toolProgress = useHarnessRuntime
    ? isForbiddenSnapshot
      ? EMPTY_TOOL_PROGRESS
      : runtimeState.toolProgress
    : stream.toolProgress;
  const status = useHarnessRuntime ? runtimeState.status : stream.status;
  const isConnected = useHarnessRuntime
    ? runtimeState.isConnected
    : stream.isConnected;
  const hasConnectionError = useHarnessRuntime
    ? runtimeState.hasConnectionError
    : stream.hasConnectionError;
  const lastProgressAt = useHarnessRuntime
    ? runtimeState.lastProgressAt
    : stream.lastProgressAt;
  const phaseEvents = useHarnessRuntime
    ? isForbiddenSnapshot
      ? EMPTY_PHASE_EVENTS
      : runtimeState.phaseEvents
    : stream.phaseEvents;
  const runHealth = useHarnessRuntime
    ? isForbiddenSnapshot
      ? null
      : runtimeState.runHealth
    : stream.runHealth;
  const progressLabel = useHarnessRuntime
    ? runtimeState.progressLabel
    : stream.progressLabel;
  const progressPhase = useHarnessRuntime
    ? runtimeState.progressPhase
    : stream.progressPhase;
  const prdReady = useHarnessRuntime ? runtimeState.prdReady : stream.prdReady;
  const backlogReady = useHarnessRuntime
    ? runtimeState.backlogReady
    : stream.backlogReady;
  const isRetrying = useHarnessRuntime
    ? runtimeState.isRetrying
    : stream.isRetrying;
  const retryReason = useHarnessRuntime
    ? runtimeState.retryReason
    : stream.retryReason;
  const retryableRunId = useHarnessRuntime
    ? runtimeState.retryableRunId
    : stream.retryableRunId;
  const clearRetryableRunId = stream.clearRetryableRunId;
  const groundingPreparation = useHarnessRuntime
    ? runtimeState.groundingPreparation
    : stream.groundingPreparation;

  // --- Local state ---
  const [isSending, setIsSending] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isStopConfirmed, setIsStopConfirmed] = useState(false);
  const [isAwaitingAgentResponse, setIsAwaitingAgentResponse] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [snapshotErrorDismissed, setSnapshotErrorDismissed] = useState(false);
  const sendRejectedRef = useRef(false);
  const timingRef = useRef<{
    sendStartedAt: number | null;
    feedbackRecorded: boolean;
    firstTokenRecorded: boolean;
    lastActivityAt: number | null;
    longestGapMs: number;
    wasDisconnected: boolean;
    disconnectedAt: number | null;
  }>({
    sendStartedAt: null,
    feedbackRecorded: false,
    firstTokenRecorded: false,
    lastActivityAt: null,
    longestGapMs: 0,
    wasDisconnected: false,
    disconnectedAt: null,
  });
  const [optimisticUserMessage, setOptimisticUserMessage] =
    useState<ChatMessage | null>(null);
  /** Immediate Queued/Dispatched from the 202 acceptance before stream events. */
  const [admissionPhase, setAdmissionPhase] = useState<
    'queued' | 'dispatched' | null
  >(null);
  const optimisticBaselineIdsRef = useRef<Set<string>>(new Set());

  // Refs for pending-message tracking (generalized from Interview)
  const pendingMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingObservedRunningRef = useRef(false);
  const skipThinkingRestoreRef = useRef(false);
  // A send from an idle-closed thread starts while status is still `closed`.
  const statusAtAwaitStartRef = useRef<ChatThreadStatus | null>(null);

  // Derived
  const streamIsRunning = status === 'running';
  const hasPersistedOptimisticEcho = Boolean(
    optimisticUserMessage &&
    messages.some(
      (message) =>
        message.id === optimisticUserMessage.id ||
        (message.role === 'user' &&
          message.text === optimisticUserMessage.text &&
          !optimisticBaselineIdsRef.current.has(message.id))
    )
  );
  // The reply can stream in before the persisted user echo (V2 turns publish
  // it on another channel), so keep the pending question ahead of anything
  // that arrived after it was sent.
  const firstMessageAfterSend =
    optimisticUserMessage && !hasPersistedOptimisticEcho
      ? messages.findIndex(
          (message) => !optimisticBaselineIdsRef.current.has(message.id)
        )
      : -1;
  const displayedMessages =
    optimisticUserMessage && !hasPersistedOptimisticEcho
      ? firstMessageAfterSend === -1
        ? [...messages, optimisticUserMessage]
        : [
            ...messages.slice(0, firstMessageAfterSend),
            optimisticUserMessage,
            ...messages.slice(firstMessageAfterSend),
          ]
      : messages;
  const visibleMessages = displayedMessages.filter(visibleMessageFilter);
  const lastVisibleRole = visibleMessages[visibleMessages.length - 1]?.role;
  // A persisted agent message is the completed response for this turn. The
  // terminal status event can arrive a little later, especially through the
  // actor lane; do not keep answers and the composer locked during that gap.
  const isWaitingForUser =
    lastVisibleRole === 'agent' && !streamingText && !thinkingText;
  const isRunning = useHarnessRuntime
    ? runtimeState.status === 'running' &&
      !runtimeState.stopping &&
      !isStopConfirmed
    : streamIsRunning && !isStopConfirmed && !isWaitingForUser;

  const effectiveIsCancelling = useHarnessRuntime
    ? runtimeState.stopping || isCancelling
    : isCancelling;

  const hasPendingHarnessSend =
    isHarnessCommandMode &&
    !runtimeState.stopping &&
    runtimeState.pendingCommands.some(
      (cmd) => cmd.kind === 'send' || cmd.kind === 'retry',
    );
  const effectiveIsAwaitingAgentResponse = isHarnessCommandMode
    ? hasPendingHarnessSend
    : isAwaitingAgentResponse;

  // Preparation state (opt-in)
  const isEmptyInProgress =
    enablePreparationState && visibleMessages.length === 0 && !streamingText;
  // An empty idle thread with no queued or running run is waiting for its first
  // message (threads created with skipAutoKickoff), not preparing.
  const hasPendingRun = status === 'running' || Boolean(initialActiveRunId);
  const isPreparing = Boolean(
    groundingPreparation?.status === 'preparing' ||
    (enablePreparationState && isEmptyInProgress && hasPendingRun && status !== 'error')
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
    isRunning || isSending || effectiveIsAwaitingAgentResponse || isPreparing;

  const showTypingIndicator = shouldShowAgentTypingIndicator({
    isBusy: isRunning || isSending || effectiveIsAwaitingAgentResponse,
    streamingText,
    lastVisibleRole: visibleMessages[visibleMessages.length - 1]?.role,
    isRetrying,
  });

  // --- Awaiting-agent-response tracking ---
  const beginAwaitingAgentResponse = useCallback(() => {
    skipThinkingRestoreRef.current = false;
    pendingMessageIdsRef.current = new Set(messages.map((m) => m.id));
    pendingObservedRunningRef.current = false;
    statusAtAwaitStartRef.current = status;
    setIsAwaitingAgentResponse(true);
  }, [messages, status]);

  const clearAwaitingAgentResponse = useCallback(() => {
    pendingMessageIdsRef.current.clear();
    pendingObservedRunningRef.current = false;
    statusAtAwaitStartRef.current = null;
    setIsAwaitingAgentResponse(false);
  }, []);

  // Clear when an agent reply lands or the thread errors/closes — not when a
  // refresh snapshot briefly looks idle while the turn is still in flight.
  useEffect(() => {
    if (!isAwaitingAgentResponse) return;

    if (status !== 'closed' && statusAtAwaitStartRef.current === 'closed') {
      statusAtAwaitStartRef.current = status;
    }

    const receivedAgentOutcome = messages.some(
      (m) =>
        !pendingMessageIdsRef.current.has(m.id) &&
        (m.role === 'agent' || m.role === 'system')
    );

    if (
      receivedAgentOutcome ||
      lastVisibleRole === 'agent' ||
      status === 'error' ||
      (status === 'closed' && statusAtAwaitStartRef.current !== 'closed')
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
    setAdmissionPhase(null);
    pendingMessageIdsRef.current.clear();
    pendingObservedRunningRef.current = false;
    setIsAwaitingAgentResponse(false);
  }, [threadId]);

  // Prefer live stream phase; keep admission phase until the stream advances.
  useEffect(() => {
    if (!progressPhase) return;
    if (progressPhase === 'queued' || progressPhase === 'dispatched') {
      setAdmissionPhase(progressPhase);
      return;
    }
    setAdmissionPhase(null);
  }, [progressPhase]);

  // Clear the queued/dispatched admission state as soon as the agent emits
  // thinking, tool activity, or tokens — even if the HTTP send response
  // resolved after the first live event.
  useEffect(() => {
    if (!admissionPhase) return;
    if (thinkingText || streamingText || (toolProgress?.length ?? 0) > 0) {
      setAdmissionPhase(null);
    }
  }, [admissionPhase, streamingText, thinkingText, toolProgress?.length]);

  const effectiveProgressPhase: AgentRunPhase | null =
    progressPhase ?? admissionPhase;
  const effectiveProgressLabel =
    effectiveProgressPhase === 'queued' ||
    effectiveProgressPhase === 'dispatched'
      ? friendlyChatProgressLabel(progressLabel, effectiveProgressPhase)
      : progressLabel;

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

  useEffect(() => {
    setSnapshotErrorDismissed(false);
  }, [runtimeState.snapshotError, threadId]);

  // --- Baseline / harness timing telemetry (TBI-004 / PBI-003 AC-3) ---
  useEffect(() => {
    if (useHarnessRuntime) return;
    const t = timingRef.current;
    if (t.sendStartedAt === null) return;
    const nowMs = Date.now();
    const hasVisibleFeedback = Boolean(
      optimisticUserMessage || progressLabel || streamingText || thinkingText,
    );
    if (!t.feedbackRecorded && hasVisibleFeedback) {
      t.feedbackRecorded = true;
      emitChatTiming('send_to_feedback', {
        area,
        projectId,
        threadId,
        durationMs: Math.max(0, nowMs - t.sendStartedAt),
        status: 'ok',
      });
    }
    if (!t.firstTokenRecorded && streamingText) {
      t.firstTokenRecorded = true;
      emitChatTiming('first_token', {
        area,
        projectId,
        threadId,
        durationMs: Math.max(0, nowMs - t.sendStartedAt),
        status: 'ok',
      });
    }
    if (lastProgressAt !== null || streamingText || thinkingText || progressLabel) {
      if (t.lastActivityAt !== null) {
        t.longestGapMs = Math.max(t.longestGapMs, nowMs - t.lastActivityAt);
      }
      t.lastActivityAt = nowMs;
    }
    if (!isRunning && !isSending && !isAwaitingAgentResponse && t.feedbackRecorded) {
      emitChatTiming('longest_gap', {
        area,
        projectId,
        threadId,
        durationMs: t.longestGapMs,
        status: status === 'error' ? 'error' : 'ok',
      });
      t.sendStartedAt = null;
    }
  }, [
    area,
    projectId,
    threadId,
    optimisticUserMessage,
    progressLabel,
    streamingText,
    thinkingText,
    lastProgressAt,
    isRunning,
    isSending,
    isAwaitingAgentResponse,
    status,
    useHarnessRuntime,
  ]);

  useEffect(() => {
    if (useHarnessRuntime) return;
    const t = timingRef.current;
    if (!threadId) return;
    if (hasConnectionError || !isConnected) {
      if (!t.wasDisconnected) {
        t.wasDisconnected = true;
        t.disconnectedAt = Date.now();
      }
      return;
    }
    if (t.wasDisconnected && isConnected) {
      const durationMs =
        t.disconnectedAt !== null ? Math.max(0, Date.now() - t.disconnectedAt) : 0;
      t.wasDisconnected = false;
      t.disconnectedAt = null;
      emitChatTiming('reconnect_restored', {
        area,
        projectId,
        threadId,
        durationMs,
        status: 'ok',
      });
    }
  }, [area, projectId, threadId, isConnected, hasConnectionError, useHarnessRuntime]);

  // --- Send ---
  const send = useCallback(
    async (text: string, opts: SendOptions = {}): Promise<boolean> => {
      if (!effectiveCanWrite || !threadId) return false;
      if (!text && !opts.attachments?.length) return false;

      if (isHarnessCommandMode) {
        if (!runtime) return false;
        if (beforeSend) {
          const result = await beforeSend(text);
          if (result === false) return false;
        }
        sendRejectedRef.current = false;
        setSendError(null);
        setIsSending(true);
        try {
          const turnId = createTurnId();
          const receipt = await runtime.send(turnId, text, {
            attachments: opts.attachments,
            model: opts.model,
            skill: opts.skill,
          });
          if (receipt?.status === 'rejected') {
            sendRejectedRef.current = true;
            return false;
          }
          const failure = runtime.getState().lastFailure;
          if (failure && failure.commandId === turnId) {
            sendRejectedRef.current = true;
            return false;
          }
          if (afterSend) {
            await afterSend();
          }
          return true;
        } finally {
          setIsSending(false);
        }
      }

      const preparationOnly =
        opts.duringPreparation === true &&
        isPreparing &&
        !isRunning &&
        !isSending &&
        !isAwaitingAgentResponse;
      const staleStreamOnly =
        opts.ignoreStaleStreamBusy === true &&
        !isSending;
      if (isInteractionBusy && !preparationOnly && !staleStreamOnly) return false;

      // beforeSend hook (e.g. syncToken)
      if (beforeSend) {
        const result = await beforeSend(text);
        if (result === false) return false;
      }

      sendRejectedRef.current = false;
      setSendError(null);
      setIsStopConfirmed(false);
      setIsSending(true);
      timingRef.current = {
        ...timingRef.current,
        sendStartedAt: Date.now(),
        feedbackRecorded: false,
        firstTokenRecorded: false,
        lastActivityAt: Date.now(),
        longestGapMs: 0,
      };
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
          ...(opts.mode ? { mode: opts.mode } : {}),
          ...(opts.skill ? { skill: opts.skill } : {}),
          ...(opts.attachments?.length
            ? { attachments: opts.attachments }
            : {}),
        });
        const activeFetch = httpFetchImpl ?? fetch;
        let res: Response | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            res = await activeFetch(endpoint, {
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
            if (body?.error) msg = mapSendErrorMessage(String(body.error));
          } catch {
            /* use default */
          }
          setSendError(msg);
          setOptimisticUserMessage(null);
          clearAwaitingAgentResponse();
          sendRejectedRef.current = true;
          return false;
        }

        try {
          const accepted = (await res.json()) as {
            status?: string;
          } | null;
          if (
            accepted?.status === 'queued' ||
            accepted?.status === 'dispatched'
          ) {
            setAdmissionPhase((current) => {
              if (
                progressPhase &&
                progressPhase !== 'queued' &&
                progressPhase !== 'dispatched'
              ) {
                return null;
              }
              return current ?? (accepted.status as 'queued' | 'dispatched');
            });
          }
        } catch {
          // Legacy `{ ok: true }` responses have no durable phase.
        }

        clearRetryableRunId();

        // afterSend hook (e.g. refetchDiff)
        if (afterSend) {
          await afterSend();
        }
        return true;
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : 'Failed to send message';
        setSendError(msg);
        setOptimisticUserMessage(null);
        clearAwaitingAgentResponse();
        sendRejectedRef.current = true;
        return false;
      } finally {
        setIsSending(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send callback intentionally omits transient progressPhase
    [
      effectiveCanWrite,
      threadId,
      isHarnessCommandMode,
      runtime,
      httpFetchImpl,
      isInteractionBusy,
      isPreparing,
      isRunning,
      isSending,
      isAwaitingAgentResponse,
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

  // --- Harness-only steer & summarize ---
  const steer = useCallback(
    async (text: string): Promise<boolean> => {
      if (!isHarnessCommandMode || !runtime || !effectiveCanWrite) {
        return false;
      }
      if (!text.trim()) return false;
      const commandId = createTurnId();
      const receipt = await runtime.steer(commandId, text);
      if (receipt?.status === 'rejected') return false;
      const failure = runtime.getState().lastFailure;
      if (failure && failure.commandId === commandId) return false;
      return true;
    },
    [isHarnessCommandMode, runtime, effectiveCanWrite, createTurnId],
  );

  const summarize = useCallback(async (): Promise<boolean> => {
    if (!isHarnessCommandMode || !runtime || !effectiveCanWrite) {
      return false;
    }
    const commandId = createTurnId();
    const receipt = await runtime.summarize(commandId);
    if (receipt?.status === 'rejected') return false;
    const failure = runtime.getState().lastFailure;
    if (failure && failure.commandId === commandId) return false;
    return true;
  }, [isHarnessCommandMode, runtime, effectiveCanWrite, createTurnId]);

  const clearReceipt = useCallback(() => {
    runtime?.clearReceipt();
  }, [runtime]);

  const retrySnapshot = useCallback(async () => {
    if (!runtime) return;
    setSnapshotErrorDismissed(false);
    await runtime.refreshSnapshot();
  }, [runtime]);

  // Legacy blind resend of the last user message. Prefer retryFailedRun for
  // durable failed runs so the server retries by identity without resending text.
  const retryLast = useCallback(() => {
    if (!effectiveCanWrite || !threadId || isInteractionBusy) return;
    const lastUserMsg = [...visibleMessages]
      .reverse()
      .find((m) => m.role === 'user');
    if (!lastUserMsg) return;
    void send(lastUserMsg.text);
  }, [effectiveCanWrite, threadId, isInteractionBusy, visibleMessages, send]);

  // --- Retry failed durable run by identity (no text / optimistic message) ---
  const retryFailedRun = useCallback(async (runIdOverride?: string) => {
    if (!effectiveCanWrite || !threadId) return;

    if (isHarnessCommandMode) {
      if (!runtime) return;
      const runId =
        runIdOverride ??
        runtimeState.retryableRunId ??
        runtimeState.lastFailure?.runId ??
        null;
      if (!runId) return;
      setSendError(null);
      setIsSending(true);
      try {
        const commandId = createTurnId();
        const receipt = await runtime.retry(commandId, runId);
        if (receipt?.status === 'rejected') return;
        const failure = runtime.getState().lastFailure;
        if (failure && failure.commandId === commandId) return;
        if (afterSend) {
          await afterSend();
        }
      } finally {
        setIsSending(false);
      }
      return;
    }

    if (isInteractionBusy) return;
    const runId = runIdOverride ?? retryableRunId;
    if (!runId) return;

    setSendError(null);
    setIsStopConfirmed(false);
    setIsSending(true);
    beginAwaitingAgentResponse();

    try {
      const endpoint = retryEndpoint
        ? retryEndpoint(runId)
        : `/api/chat/threads/${threadId}/runs/${runId}/retry`;
      const activeFetch = httpFetchImpl ?? fetch;
      let res: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          res = await activeFetch(endpoint, {
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
          if (body?.error) msg = mapSendErrorMessage(String(body.error));
        } catch {
          /* use default */
        }
        setSendError(msg);
        clearAwaitingAgentResponse();
        return;
      }

      try {
        const accepted = (await res.json()) as {
          status?: string;
        } | null;
        if (
          accepted?.status === 'queued' ||
          accepted?.status === 'dispatched'
        ) {
          setAdmissionPhase(accepted.status);
        }
      } catch {
        // Empty or non-JSON success bodies are ignored.
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
    effectiveCanWrite,
    threadId,
    isHarnessCommandMode,
    runtime,
    runtimeState.retryableRunId,
    runtimeState.lastFailure?.runId,
    createTurnId,
    httpFetchImpl,
    isInteractionBusy,
    retryableRunId,
    retryEndpoint,
    beginAwaitingAgentResponse,
    clearRetryableRunId,
    afterSend,
    clearAwaitingAgentResponse,
  ]);

  // --- Cancel ---
  const cancel = useCallback(async () => {
    if (!threadId) return;

    if (isHarnessCommandMode) {
      if (!effectiveCanWrite || !runtime) return;
      setSendError(null);
      await runtime.cancel(createTurnId());
      return;
    }

    if (useHarnessRuntime && !effectiveCanWrite) return;
    if (isCancelling) return;
    const stopStartedAt = Date.now();
    const endpoint = cancelEndpoint ?? `/api/chat/threads/${threadId}/cancel`;
    setSendError(null);
    setIsCancelling(true);
    clearRetryableRunId();
    skipThinkingRestoreRef.current = true;
    try {
      const activeFetch = httpFetchImpl ?? fetch;
      const response = await activeFetch(endpoint, {
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
        emitChatTiming('stop', {
          area,
          projectId,
          threadId,
          durationMs: Math.max(0, Date.now() - stopStartedAt),
          status: 'error',
        });
      } else {
        // The endpoint returns only after the server has persisted the idle
        // thread state. Do not leave the composer blocked on a delayed stream.
        clearAwaitingAgentResponse();
        setIsStopConfirmed(true);
        setIsCancelling(false);
        emitChatTiming('stop', {
          area,
          projectId,
          threadId,
          durationMs: Math.max(0, Date.now() - stopStartedAt),
          status: 'ok',
        });
      }
    } catch (error) {
      setSendError(
        error instanceof Error
          ? error.message
          : 'Failed to stop the agent. Please try again.'
      );
      setIsCancelling(false);
      emitChatTiming('stop', {
        area,
        projectId,
        threadId,
        durationMs: Math.max(0, Date.now() - stopStartedAt),
        status: 'error',
      });
    }
  }, [
    area,
    projectId,
    threadId,
    isHarnessCommandMode,
    useHarnessRuntime,
    effectiveCanWrite,
    runtime,
    createTurnId,
    httpFetchImpl,
    cancelEndpoint,
    isCancelling,
    clearAwaitingAgentResponse,
    clearRetryableRunId,
  ]);

  // --- Clear send error ---
  const clearSendError = useCallback(() => {
    setSendError(null);
    setSnapshotErrorDismissed(true);
    runtime?.clearFailure();
  }, [runtime]);

  const effectiveSendError =
    sendError ??
    (useHarnessRuntime && !snapshotErrorDismissed
      ? runtimeState.snapshotError
      : null);

  const connectionState: ConnectionState = useHarnessRuntime
    ? runtimeState.connectionState
    : isConnected
      ? 'open'
      : hasConnectionError
        ? 'unavailable'
        : 'connecting';

  const activity = useHarnessRuntime
    ? isForbiddenSnapshot
      ? EMPTY_ACTIVITY
      : runtimeState.activity
    : EMPTY_ACTIVITY;

  return {
    // Messages & streaming
    messages: isForbiddenSnapshot ? EMPTY_MESSAGES : displayedMessages,
    visibleMessages: isForbiddenSnapshot ? EMPTY_MESSAGES : visibleMessages,
    streamingText,
    thinkingText,
    toolProgress,
    phaseEvents,
    runHealth,
    progressLabel: effectiveProgressLabel,
    progressPhase: effectiveProgressPhase,
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
    isCancelling: effectiveIsCancelling,
    isAwaitingAgentResponse: effectiveIsAwaitingAgentResponse,
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
    sendError: effectiveSendError,
    clearSendError,
    sendRejectedRef,

    // Harness controls & state
    steer,
    summarize,
    connectionState,
    pendingCommands: useHarnessRuntime
      ? runtimeState.pendingCommands
      : EMPTY_PENDING_COMMANDS,
    lastReceipt: useHarnessRuntime ? runtimeState.lastReceipt : null,
    clearReceipt,
    activity,
    summaryNotice: useHarnessRuntime ? runtimeState.summaryNotice : null,
    canWrite: effectiveCanWrite,
    lastFailure: useHarnessRuntime ? runtimeState.lastFailure : null,
    snapshotLoaded: useHarnessRuntime ? runtimeState.snapshotLoaded : true,
    snapshotError: useHarnessRuntime ? runtimeState.snapshotError : null,
    snapshotStatusCode: useHarnessRuntime
      ? runtimeState.snapshotStatusCode
      : null,
    retrySnapshot,
    terminalRevision: useHarnessRuntime ? runtimeState.terminalRevision : 0,
    harnessArea: effectiveHarnessArea,
    isSteerSupported: isHarnessCommandMode,
    isSummarizeSupported: isHarnessCommandMode,
  };
}
