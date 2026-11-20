import type {
  ChatAttachmentMeta,
  ChatMessage,
  SseEvent,
} from '../../shared/types/chat';
import {
  formatHarnessReceipt,
  type ConnectionState,
  type HarnessAgentPhase,
  type HarnessCommandKind,
  type HarnessReceipt,
  type HarnessReceiptRaw,
  type HarnessReceiptStatus,
  type HarnessThreadSnapshot,
  type HarnessThreadState,
  type OptimisticMessageEntry,
  type PendingCommand,
  type RuntimeState,
} from './types';
import {
  MAX_SEEN_EVENT_IDS,
  SUMMARY_ERROR_TEXT,
  SUMMARY_RUNNING_TEXT,
  clearTurnBufferMeta,
  createEventReducerMeta,
  deriveSummaryNotice,
  reduceHarnessEvent,
  sortChatMessagesByTs,
  type EventReducerMeta,
} from './reducers/eventReducer';

export interface ChatHarnessStore {
  getState(): RuntimeState;
  subscribe(listener: () => void): () => void;
  applySnapshot(snapshot: HarnessThreadSnapshot): void;
  applySnapshotError(statusCode: number, message: string): void;
  applyStateFrame(state: HarnessThreadState): void;
  applyReceipt(receipt: HarnessReceipt | HarnessReceiptRaw): void;
  applyEvent(event: SseEvent, eventId: string): void;
  applyConnectionState(state: ConnectionState): void;
  recordOptimisticSend(
    commandId: string,
    text: string,
    attachments?: ChatAttachmentMeta[],
  ): void;
  recordPendingCommand(commandId: string, kind: HarnessCommandKind): void;
  beginLocalStop(commandId: string): void;
  markCommandFailed(
    commandId: string,
    kind: HarnessCommandKind,
    reason: string,
    runId?: string | null,
  ): void;
  clearReceipt(): void;
  clearFailure(): void;
  getDisplayedMessages(): ChatMessage[];
  reset(nextThreadId: string | null, initial?: Partial<RuntimeState>): void;
}

function createInitialRuntimeState(
  threadId: string | null,
  initial?: Partial<RuntimeState>,
): RuntimeState {
  const base: RuntimeState = {
    threadId,
    harnessArea: null,
    snapshotLoaded: false,
    snapshotError: null,
    snapshotStatusCode: null,
    canWrite: true,
    connectionState: threadId ? 'connecting' : 'closed',
    isConnected: false,
    hasConnectionError: false,
    lastEventId: null,

    status: 'idle',
    activeRunId: null,
    phase: 'idle',
    latestSummary: null,
    summaryNotice: null,

    messages: [],
    optimisticMessages: [],
    streamingText: '',
    thinkingText: '',
    toolProgress: [],
    activity: [],
    phaseEvents: [],
    runHealth: null,
    progressLabel: null,
    progressPhase: null,
    lastProgressAt: null,
    prdReady: false,
    backlogReady: false,
    isRetrying: false,
    retryReason: null,
    retryableRunId: null,
    groundingPreparation: null,

    pendingCommands: [],
    lastReceipt: null,
    stopping: false,
    lastFailure: null,
    terminalRevision: 0,
  };

  if (!initial) return base;
  return {
    ...base,
    ...initial,
    messages: initial.messages
      ? sortChatMessagesByTs(initial.messages)
      : base.messages,
  };
}

function phaseProgressLabel(
  phase: HarnessAgentPhase,
  currentLabel: string | null,
): string | null {
  switch (phase) {
    case 'starting':
      return 'Starting…';
    case 'resuming':
      return 'Resuming…';
    case 'recreating':
      return 'Reconnecting…';
    case 'summarizing':
      return SUMMARY_RUNNING_TEXT;
    case 'running':
      return !currentLabel || currentLabel === 'Sending…'
        ? 'Thinking…'
        : currentLabel;
    case 'idle':
      return null;
  }
}

function mergePendingCommands(
  current: PendingCommand[],
  serverPending: HarnessThreadState['pendingCommands'],
  settledCommandIds: ReadonlySet<string>,
  now: number,
  options: {
    dropLocalCancel: boolean;
    dropLocalTurnCommands: boolean;
    hasActiveRun: boolean;
  },
): PendingCommand[] {
  const existingById = new Map(current.map((item) => [item.commandId, item]));
  const filteredServer = serverPending.filter((item) => {
    if (settledCommandIds.has(item.commandId)) return false;
    // A thread with no active run cannot still have an in-flight accepted turn command.
    if (
      !options.hasActiveRun &&
      item.status === 'accepted' &&
      (item.kind === 'send' || item.kind === 'retry' || item.kind === 'summarize')
    ) {
      return false;
    }
    return true;
  });
  const serverIds = new Set(filteredServer.map((item) => item.commandId));

  const merged: PendingCommand[] = filteredServer.map((item) => ({
    commandId: item.commandId,
    kind: item.kind,
    status: item.status,
    sentAt: existingById.get(item.commandId)?.sentAt ?? now,
  }));

  for (const item of current) {
    if (serverIds.has(item.commandId)) continue;
    if (item.status !== 'pending') continue;
    if (settledCommandIds.has(item.commandId)) continue;
    if (options.dropLocalCancel && item.kind === 'cancel') continue;
    if (
      options.dropLocalTurnCommands &&
      (item.kind === 'send' || item.kind === 'retry' || item.kind === 'summarize')
    ) {
      continue;
    }
    merged.push(item);
  }

  return merged;
}

function filterMatchedOptimistic(
  optimistic: OptimisticMessageEntry[],
  serverMessages: ChatMessage[],
): OptimisticMessageEntry[] {
  if (optimistic.length === 0 || serverMessages.length === 0) {
    return optimistic;
  }
  const serverIds = new Set<string>();
  const serverCommandIds = new Set<string>();
  for (const msg of serverMessages) {
    serverIds.add(msg.id);
    if (msg.commandId) serverCommandIds.add(msg.commandId);
  }
  return optimistic.filter(
    (entry) =>
      !serverCommandIds.has(entry.commandId) && !serverIds.has(entry.commandId),
  );
}

function mergeSnapshotMessages(
  currentMessages: ChatMessage[],
  snapshotMessages: ChatMessage[],
): ChatMessage[] {
  if (currentMessages.length === 0) {
    return sortChatMessagesByTs(snapshotMessages);
  }
  const snapIds = new Set<string>();
  const snapCommandIds = new Set<string>();
  for (const msg of snapshotMessages) {
    snapIds.add(msg.id);
    if (msg.commandId) snapCommandIds.add(msg.commandId);
  }
  const extraLive = currentMessages.filter(
    (msg) =>
      !snapIds.has(msg.id) &&
      !(msg.commandId && snapCommandIds.has(msg.commandId)),
  );
  return sortChatMessagesByTs([...snapshotMessages, ...extraLive]);
}

function clearThreadContent(
  _state: RuntimeState,
  meta: EventReducerMeta,
): Partial<RuntimeState> {
  clearTurnBufferMeta(meta);
  meta.failedRunId = null;
  return {
    messages: [],
    optimisticMessages: [],
    streamingText: '',
    thinkingText: '',
    toolProgress: [],
    activity: [],
    phaseEvents: [],
    runHealth: null,
    progressLabel: null,
    progressPhase: null,
    latestSummary: null,
    summaryNotice: null,
    lastFailure: null,
    pendingCommands: [],
    stopping: false,
    isRetrying: false,
    retryReason: null,
    retryableRunId: null,
    groundingPreparation: null,
  };
}

export function createChatHarnessStore(
  threadId: string | null,
  initial?: Partial<RuntimeState>,
): ChatHarnessStore {
  let state: RuntimeState = createInitialRuntimeState(threadId, initial);
  let meta: EventReducerMeta = createEventReducerMeta();
  const listeners = new Set<() => void>();
  const settledReceipts = new Map<string, HarnessReceiptStatus>();
  const settledReceiptOrder: string[] = [];

  function recordSettledReceipt(
    commandId: string,
    status: HarnessReceiptStatus,
  ): void {
    if (!settledReceipts.has(commandId)) {
      settledReceiptOrder.push(commandId);
    }
    settledReceipts.set(commandId, status);
    if (settledReceiptOrder.length > MAX_SEEN_EVENT_IDS) {
      const evicted = settledReceiptOrder.shift();
      if (evicted) settledReceipts.delete(evicted);
    }
  }

  function setState(next: RuntimeState): void {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function applySnapshot(snapshot: HarnessThreadSnapshot): void {
    const now = Date.now();
    const mergedMessages = mergeSnapshotMessages(
      state.messages,
      snapshot.messages,
    );
    const nextOptimistic = filterMatchedOptimistic(
      state.optimisticMessages,
      mergedMessages,
    );
    const nextCanWrite =
      snapshot.canWrite ?? snapshot.state.canWrite ?? state.canWrite;
    const nextLatestSummary =
      snapshot.latestSummary ?? snapshot.state.latestSummary ?? null;
    const nextStatus = snapshot.state.threadStatus;
    const isRunning = nextStatus === 'running';
    const transitionedToTerminal = state.status === 'running' && !isRunning;

    const settledIds = new Set<string>(settledReceipts.keys());
    for (const msg of mergedMessages) {
      if (msg.commandId) settledIds.add(msg.commandId);
    }

    const nextPending = mergePendingCommands(
      state.pendingCommands,
      snapshot.state.pendingCommands,
      settledIds,
      now,
      {
        dropLocalCancel: !isRunning,
        dropLocalTurnCommands: transitionedToTerminal,
        hasActiveRun: isRunning || Boolean(snapshot.state.activeRunId),
      },
    );

    if (transitionedToTerminal) {
      clearTurnBufferMeta(meta);
      const remainingIds = new Set(nextPending.map((item) => item.commandId));
      for (const item of state.pendingCommands) {
        if (!remainingIds.has(item.commandId)) {
          recordSettledReceipt(item.commandId, 'applied');
        }
      }
    }

    setState({
      ...state,
      snapshotLoaded: true,
      snapshotError: null,
      snapshotStatusCode: null,
      canWrite: nextCanWrite,
      status: nextStatus,
      activeRunId: snapshot.state.activeRunId,
      phase: snapshot.state.phase,
      harnessArea: snapshot.state.harnessArea,
      latestSummary: nextLatestSummary,
      summaryNotice: deriveSummaryNotice(
        snapshot.state.phase,
        nextLatestSummary,
        state.summaryNotice,
      ),
      messages: mergedMessages,
      optimisticMessages: nextOptimistic,
      pendingCommands: nextPending,
      stopping: isRunning ? state.stopping : false,
      ...(transitionedToTerminal
        ? {
            streamingText: '',
            thinkingText: '',
            toolProgress: [],
            activity: [],
            progressLabel: null,
            progressPhase: null,
            isRetrying: false,
            retryReason: null,
            groundingPreparation: null,
            terminalRevision: state.terminalRevision + 1,
          }
        : isRunning
          ? {
              progressLabel: phaseProgressLabel(
                snapshot.state.phase,
                state.progressLabel,
              ),
            }
          : {}),
    });
  }

  function applySnapshotError(statusCode: number, message: string): void {
    const mustClearContent = statusCode === 401 || statusCode === 403;
    setState({
      ...state,
      ...(mustClearContent ? clearThreadContent(state, meta) : {}),
      snapshotLoaded: true,
      snapshotError: message,
      snapshotStatusCode: statusCode,
    });
  }

  function applyStateFrame(serverState: HarnessThreadState): void {
    const now = Date.now();
    const nextStatus = serverState.threadStatus;
    const isRunning = nextStatus === 'running';
    const transitionedToTerminal = state.status === 'running' && !isRunning;

    const nextPending = mergePendingCommands(
      state.pendingCommands,
      serverState.pendingCommands,
      new Set<string>(settledReceipts.keys()),
      now,
      {
        dropLocalCancel: !isRunning,
        dropLocalTurnCommands: transitionedToTerminal,
        hasActiveRun: isRunning || Boolean(serverState.activeRunId),
      },
    );

    if (transitionedToTerminal) {
      clearTurnBufferMeta(meta);
      const remainingIds = new Set(nextPending.map((item) => item.commandId));
      for (const item of state.pendingCommands) {
        if (!remainingIds.has(item.commandId)) {
          recordSettledReceipt(item.commandId, 'applied');
        }
      }
    }

    const nextProgressLabel = isRunning
      ? phaseProgressLabel(serverState.phase, state.progressLabel)
      : transitionedToTerminal
        ? null
        : state.progressLabel;

    setState({
      ...state,
      status: nextStatus,
      activeRunId: serverState.activeRunId,
      phase: serverState.phase,
      harnessArea: serverState.harnessArea,
      latestSummary: serverState.latestSummary,
      canWrite: serverState.canWrite ?? state.canWrite,
      pendingCommands: nextPending,
      stopping: isRunning ? state.stopping : false,
      summaryNotice: deriveSummaryNotice(
        serverState.phase,
        serverState.latestSummary,
        state.summaryNotice,
      ),
      progressLabel: nextProgressLabel,
      ...(transitionedToTerminal
        ? {
            streamingText: '',
            thinkingText: '',
            toolProgress: [],
            activity: [],
            progressPhase: null,
            isRetrying: false,
            retryReason: null,
            groundingPreparation: null,
            lastReceipt:
              state.lastReceipt &&
              state.lastReceipt.kind === 'steer' &&
              state.lastReceipt.status === 'accepted'
                ? null
                : state.lastReceipt,
            terminalRevision: state.terminalRevision + 1,
          }
        : {}),
    });
  }

  function applyReceipt(receipt: HarnessReceipt | HarnessReceiptRaw): void {
    const isTerminal =
      receipt.status === 'applied' || receipt.status === 'rejected';

    // Never regress an already-settled command back to accepted/queued, and stay
    // idempotent per settled (commandId, status).
    const priorSettled = settledReceipts.get(receipt.commandId);
    if (priorSettled !== undefined && (!isTerminal || priorSettled === receipt.status)) {
      return;
    }

    if (isTerminal) {
      recordSettledReceipt(receipt.commandId, receipt.status);
    }

    const now = Date.now();
    const formatted = formatHarnessReceipt(receipt);

    // Update pendingCommands
    let nextPending: PendingCommand[];
    if (isTerminal) {
      nextPending = state.pendingCommands.filter(
        (item) => item.commandId !== receipt.commandId,
      );
    } else {
      const idx = state.pendingCommands.findIndex(
        (item) => item.commandId === receipt.commandId,
      );
      if (idx >= 0) {
        nextPending = state.pendingCommands.map((item, i) =>
          i === idx ? { ...item, status: receipt.status as 'accepted' | 'queued' } : item,
        );
      } else {
        nextPending = [
          ...state.pendingCommands,
          {
            commandId: receipt.commandId,
            kind: receipt.kind,
            status: receipt.status as 'accepted' | 'queued',
            sentAt: now,
          },
        ];
      }
    }

    let nextOptimistic = state.optimisticMessages;
    let nextLastFailure = state.lastFailure;
    let nextProgressLabel = state.progressLabel;
    let nextProgressPhase = state.progressPhase;
    let nextStopping = state.stopping;
    let nextRetryableRunId = state.retryableRunId;
    let nextSummaryNotice = state.summaryNotice;
    let nextActiveRunId = state.activeRunId;

    if (receipt.kind === 'send' && receipt.status === 'rejected') {
      let matchedMessageId: string | undefined;
      nextOptimistic = state.optimisticMessages.map((entry) => {
        if (entry.commandId !== receipt.commandId) return entry;
        matchedMessageId = entry.message.id;
        return {
          ...entry,
          failed: true,
          failureReason: formatted.text,
        };
      });
      nextLastFailure = {
        commandId: receipt.commandId,
        runId: receipt.runId ?? state.retryableRunId ?? null,
        reason: formatted.text,
        failedAt: formatted.updatedAt,
        messageId: matchedMessageId ?? receipt.commandId,
      };
      if (state.status !== 'running') {
        nextProgressLabel = null;
        nextProgressPhase = null;
      }
    } else if (
      receipt.kind === 'send' &&
      (receipt.status === 'accepted' || receipt.status === 'applied')
    ) {
      if (state.lastFailure?.commandId === receipt.commandId) {
        nextLastFailure = null;
      }
      nextRetryableRunId = null;
      if (receipt.status === 'accepted' && receipt.runId) {
        nextActiveRunId = receipt.runId;
      }
    } else if (receipt.kind === 'retry' && receipt.status === 'rejected') {
      nextLastFailure = {
        commandId: receipt.commandId,
        runId:
          receipt.runId ??
          state.lastFailure?.runId ??
          state.retryableRunId ??
          null,
        reason: formatted.text,
        failedAt: formatted.updatedAt,
        messageId: state.lastFailure?.messageId,
      };
      if (state.lastFailure?.messageId) {
        const failedMsgId = state.lastFailure.messageId;
        nextOptimistic = state.optimisticMessages.map((entry) =>
          entry.message.id === failedMsgId
            ? { ...entry, failed: true, failureReason: formatted.text }
            : entry,
        );
      }
      if (state.status !== 'running') {
        nextProgressLabel = null;
        nextProgressPhase = null;
      }
    } else if (
      receipt.kind === 'retry' &&
      (receipt.status === 'applied' || receipt.status === 'accepted')
    ) {
      nextLastFailure = null;
      nextRetryableRunId = null;
      if (receipt.status === 'accepted' && receipt.runId) {
        nextActiveRunId = receipt.runId;
      }
    } else if (receipt.kind === 'cancel' && receipt.status === 'rejected') {
      nextStopping = false;
    } else if (
      receipt.kind === 'summarize' &&
      receipt.status === 'accepted' &&
      receipt.runId
    ) {
      nextActiveRunId = receipt.runId;
    } else if (receipt.kind === 'summarize' && receipt.status === 'rejected') {
      if (state.summaryNotice?.status === 'running') {
        nextSummaryNotice = {
          status: 'error',
          text: formatted.text || SUMMARY_ERROR_TEXT,
          isFallback: false,
          error: formatted.text || SUMMARY_ERROR_TEXT,
        };
      }
    }

    setState({
      ...state,
      activeRunId: nextActiveRunId,
      pendingCommands: nextPending,
      lastReceipt: formatted,
      optimisticMessages: nextOptimistic,
      lastFailure: nextLastFailure,
      progressLabel: nextProgressLabel,
      progressPhase: nextProgressPhase,
      stopping: nextStopping,
      retryableRunId: nextRetryableRunId,
      summaryNotice: nextSummaryNotice,
    });
  }

  function applyEvent(event: SseEvent, eventId: string): void {
    const prevPending = state.pendingCommands;
    const result = reduceHarnessEvent(state, meta, event, eventId);
    if (!result.changed) return;
    if (result.state.pendingCommands !== prevPending) {
      const remainingIds = new Set(
        result.state.pendingCommands.map((item) => item.commandId),
      );
      for (const item of prevPending) {
        if (!remainingIds.has(item.commandId)) {
          recordSettledReceipt(item.commandId, 'applied');
        }
      }
    }
    setState(result.state);
  }

  function applyConnectionState(connectionState: ConnectionState): void {
    const isConnected =
      connectionState === 'open' || connectionState === 'restored';
    const hasConnectionError =
      connectionState === 'unavailable' || connectionState === 'signed-out';

    if (connectionState === 'signed-out') {
      setState({
        ...state,
        ...clearThreadContent(state, meta),
        connectionState,
        isConnected,
        hasConnectionError,
      });
      return;
    }

    if (
      state.connectionState === connectionState &&
      state.isConnected === isConnected &&
      state.hasConnectionError === hasConnectionError
    ) {
      return;
    }

    setState({
      ...state,
      connectionState,
      isConnected,
      hasConnectionError,
    });
  }

  function recordOptimisticSend(
    commandId: string,
    text: string,
    attachments?: ChatAttachmentMeta[],
  ): void {
    const now = Date.now();
    const alreadyPresent =
      state.optimisticMessages.some((entry) => entry.commandId === commandId) ||
      state.messages.some(
        (msg) => msg.commandId === commandId || msg.id === commandId,
      );

    const nextOptimistic = alreadyPresent
      ? state.optimisticMessages
      : [
          ...state.optimisticMessages,
          {
            commandId,
            failed: false,
            message: {
              id: commandId,
              commandId,
              role: 'user' as const,
              text,
              ts: new Date(now).toISOString(),
              ...(attachments && attachments.length > 0 ? { attachments } : {}),
            },
          },
        ];

    const nextPending = [
      ...state.pendingCommands.filter((item) => item.commandId !== commandId),
      {
        commandId,
        kind: 'send' as const,
        status: 'pending' as const,
        sentAt: now,
      },
    ];

    setState({
      ...state,
      optimisticMessages: nextOptimistic,
      pendingCommands: nextPending,
      progressLabel: 'Sending…',
      stopping: false,
      lastFailure: null,
      retryableRunId: null,
    });
  }

  function recordPendingCommand(
    commandId: string,
    kind: HarnessCommandKind,
  ): void {
    if (state.pendingCommands.some((item) => item.commandId === commandId)) {
      return;
    }
    setState({
      ...state,
      pendingCommands: [
        ...state.pendingCommands,
        {
          commandId,
          kind,
          status: 'pending',
          sentAt: Date.now(),
        },
      ],
    });
  }

  function beginLocalStop(commandId: string): void {
    const nextPending = state.pendingCommands.some(
      (item) => item.commandId === commandId,
    )
      ? state.pendingCommands
      : [
          ...state.pendingCommands,
          {
            commandId,
            kind: 'cancel' as const,
            status: 'pending' as const,
            sentAt: Date.now(),
          },
        ];

    setState({
      ...state,
      stopping: true,
      pendingCommands: nextPending,
    });
  }

  function markCommandFailed(
    commandId: string,
    kind: HarnessCommandKind,
    reason: string,
    runId?: string | null,
  ): void {
    let matchedMessageId: string | undefined;
    const nextOptimistic =
      kind === 'send'
        ? state.optimisticMessages.map((entry) => {
            if (entry.commandId !== commandId) return entry;
            matchedMessageId = entry.message.id;
            return {
              ...entry,
              failed: true,
              failureReason: reason,
            };
          })
        : state.optimisticMessages;

    const nextPending = state.pendingCommands.filter(
      (item) => item.commandId !== commandId,
    );

    setState({
      ...state,
      optimisticMessages: nextOptimistic,
      pendingCommands: nextPending,
      stopping: kind === 'cancel' ? false : state.stopping,
      progressLabel: state.status !== 'running' ? null : state.progressLabel,
      progressPhase: state.status !== 'running' ? null : state.progressPhase,
      lastFailure: {
        commandId,
        runId: runId ?? state.lastFailure?.runId ?? state.retryableRunId ?? null,
        reason,
        failedAt: new Date().toISOString(),
        messageId:
          matchedMessageId ??
          (kind === 'send' ? commandId : state.lastFailure?.messageId),
      },
    });
  }

  function clearReceipt(): void {
    if (state.lastReceipt === null) return;
    setState({ ...state, lastReceipt: null });
  }

  function clearFailure(): void {
    if (state.lastFailure === null) return;
    setState({ ...state, lastFailure: null });
  }

  function getDisplayedMessages(): ChatMessage[] {
    if (state.optimisticMessages.length === 0) {
      return state.messages;
    }
    const serverIds = new Set<string>();
    const serverCommandIds = new Set<string>();
    for (const msg of state.messages) {
      serverIds.add(msg.id);
      if (msg.commandId) serverCommandIds.add(msg.commandId);
    }
    const unmatched = state.optimisticMessages
      .filter(
        (entry) =>
          !serverCommandIds.has(entry.commandId) &&
          !serverIds.has(entry.commandId),
      )
      .map((entry) => entry.message);

    if (unmatched.length === 0) {
      return state.messages;
    }
    return sortChatMessagesByTs([...state.messages, ...unmatched]);
  }

  function reset(
    nextThreadId: string | null,
    nextInitial?: Partial<RuntimeState>,
  ): void {
    meta = createEventReducerMeta();
    settledReceipts.clear();
    settledReceiptOrder.length = 0;
    setState(createInitialRuntimeState(nextThreadId, nextInitial));
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    applySnapshot,
    applySnapshotError,
    applyStateFrame,
    applyReceipt,
    applyEvent,
    applyConnectionState,
    recordOptimisticSend,
    recordPendingCommand,
    beginLocalStop,
    markCommandFailed,
    clearReceipt,
    clearFailure,
    getDisplayedMessages,
    reset,
  };
}
