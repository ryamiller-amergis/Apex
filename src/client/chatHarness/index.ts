import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type {
  ChatAttachment,
  ChatAttachmentMeta,
  ChatMessage,
  ChatThreadStatus,
  ChatTurnSkill,
} from '../../shared/types/chat';
import type { trackEvent } from '../services/telemetry';
import {
  createChatHarnessConnection,
  type ChatHarnessConnection,
  type ChatHarnessConnectionHandlers,
  type ChatHarnessConnectionOptions,
} from './connection';
import { createChatHarnessStore, type ChatHarnessStore } from './store';
import {
  CHAT_HARNESS_TIMING_EVENT,
  HARNESS_TIMING_METRICS,
  createChatHarnessTelemetry,
  recordHarnessTiming,
  type ChatHarnessTelemetry,
  type ChatHarnessTelemetryConfig,
  type RecordHarnessTimingInput,
  type RecordHarnessTimingOptions,
} from './telemetry';
import {
  formatHarnessReceipt,
  isSignInRequiredReason,
  normalizeReceiptReason,
  type AgentActivityItem,
  type AgentActivityToolItem,
  type ConnectionState,
  type GatewayEventFrame,
  type GatewayInboundFrame,
  type HarnessAgentPhase,
  type HarnessAreaId,
  type HarnessCommandBody,
  type HarnessCommandKind,
  type HarnessErrorFrame,
  type HarnessMessageFailureState,
  type HarnessReceipt,
  type HarnessReceiptFrame,
  type HarnessReceiptRaw,
  type HarnessReceiptStatus,
  type HarnessReceiptView,
  type HarnessStateFrame,
  type HarnessSummaryMarker,
  type HarnessSummaryNoticeState,
  type HarnessThreadSnapshot,
  type HarnessThreadState,
  type HarnessTimingMetric,
  type HarnessTimingRecord,
  type HarnessTranscriptItem,
  type OptimisticMessageEntry,
  type PendingCommand,
  type RuntimeState,
} from './types';

export {
  CHAT_HARNESS_TIMING_EVENT,
  HARNESS_TIMING_METRICS,
  createChatHarnessConnection,
  createChatHarnessStore,
  createChatHarnessTelemetry,
  formatHarnessReceipt,
  isSignInRequiredReason,
  normalizeReceiptReason,
  recordHarnessTiming,
};

export type {
  AgentActivityItem,
  AgentActivityToolItem,
  ChatHarnessConnection,
  ChatHarnessConnectionHandlers,
  ChatHarnessConnectionOptions,
  ChatHarnessStore,
  ChatHarnessTelemetry,
  ChatHarnessTelemetryConfig,
  ConnectionState,
  GatewayEventFrame,
  GatewayInboundFrame,
  HarnessAgentPhase,
  HarnessAreaId,
  HarnessCommandBody,
  HarnessCommandKind,
  HarnessErrorFrame,
  HarnessMessageFailureState,
  HarnessReceipt,
  HarnessReceiptFrame,
  HarnessReceiptRaw,
  HarnessReceiptStatus,
  HarnessReceiptView,
  HarnessStateFrame,
  HarnessSummaryMarker,
  HarnessSummaryNoticeState,
  HarnessThreadSnapshot,
  HarnessThreadState,
  HarnessTimingMetric,
  HarnessTimingRecord,
  HarnessTranscriptItem,
  OptimisticMessageEntry,
  PendingCommand,
  RecordHarnessTimingInput,
  RecordHarnessTimingOptions,
  RuntimeState,
};

export interface CreateChatRuntimeDeps extends ChatHarnessConnectionOptions {
  area?: string;
  initialMessages?: ChatMessage[];
  initialStatus?: ChatThreadStatus;
  initialPrdReady?: boolean;
  initialHarnessArea?: HarnessAreaId | null;
  now?: () => number;
  emitTelemetry?: typeof trackEvent;
}

export interface UseChatRuntimeDeps extends CreateChatRuntimeDeps {
  enabled?: boolean;
}

export interface ChatRuntimeSendOptions {
  attachments?: ChatAttachment[];
  model?: string;
  skill?: ChatTurnSkill;
}

export interface ChatRuntime {
  subscribe(listener: () => void): () => void;
  getState(): RuntimeState;
  getDisplayedMessages(): ChatMessage[];
  start(): void;
  dispose(): void;
  refreshSnapshot(): Promise<HarnessThreadSnapshot | null>;
  send(
    commandId: string,
    text: string,
    opts?: ChatRuntimeSendOptions,
  ): Promise<HarnessReceipt | null>;
  steer(commandId: string, text: string): Promise<HarnessReceipt | null>;
  summarize(commandId: string): Promise<HarnessReceipt | null>;
  cancel(commandId: string): Promise<HarnessReceipt | null>;
  retry(commandId: string, runId: string): Promise<HarnessReceipt | null>;
  clearReceipt(): void;
  clearFailure(): void;
}

const IDLE_RUNTIME_STATE: RuntimeState = Object.freeze({
  threadId: null,
  harnessArea: null,
  snapshotLoaded: false,
  snapshotError: null,
  snapshotStatusCode: null,
  canWrite: true,
  connectionState: 'closed',
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
});

const NOOP_UNSUBSCRIBE = (): void => {};

export function createChatRuntime(
  threadId: string,
  deps: CreateChatRuntimeDeps = {},
): ChatRuntime {
  const initialStoreState: Partial<RuntimeState> = {};
  if (deps.initialMessages) {
    initialStoreState.messages = deps.initialMessages;
  }
  if (deps.initialStatus) {
    initialStoreState.status = deps.initialStatus;
  }
  if (deps.initialPrdReady !== undefined) {
    initialStoreState.prdReady = deps.initialPrdReady;
  }
  if (deps.initialHarnessArea !== undefined) {
    initialStoreState.harnessArea = deps.initialHarnessArea;
  }

  const store = createChatHarnessStore(threadId, initialStoreState);
  const telemetry = createChatHarnessTelemetry({
    area: deps.area ?? deps.initialHarnessArea ?? '',
    threadId,
    now: deps.now,
    emit: deps.emitTelemetry,
  });

  let started = false;
  let disposed = false;
  let firstSnapshotRecorded = false;
  let receiptDismissTimer: number | null = null;

  const inFlightCommands = new Map<string, HarnessCommandBody>();
  const retriedOverHttp = new Set<string>();
  const pendingSignInRetries = new Map<
    string,
    Promise<HarnessReceipt | null>
  >();

  const clearReceiptDismissTimer = (): void => {
    if (receiptDismissTimer !== null) {
      window.clearTimeout(receiptDismissTimer);
      receiptDismissTimer = null;
    }
  };

  const scheduleReceiptAutoDismiss = (): void => {
    clearReceiptDismissTimer();
    if (disposed) return;
    const receipt = store.getState().lastReceipt;
    if (!receipt || receipt.tone === 'error' || receipt.autoDismissMs === null) {
      return;
    }
    const expectedCommandId = receipt.commandId;
    const expectedUpdatedAt = receipt.updatedAt;
    receiptDismissTimer = window.setTimeout(() => {
      receiptDismissTimer = null;
      if (disposed) return;
      const current = store.getState().lastReceipt;
      if (
        current &&
        current.commandId === expectedCommandId &&
        current.updatedAt === expectedUpdatedAt
      ) {
        store.clearReceipt();
      }
    }, receipt.autoDismissMs);
  };

  const connection = createChatHarnessConnection(
    threadId,
    {
      onStateChange(nextState) {
        if (disposed) return;
        store.applyConnectionState(nextState);
        if (nextState === 'reconnecting' || nextState === 'unavailable') {
          telemetry.markDisconnected();
        } else if (nextState === 'restored') {
          telemetry.markReconnected();
        }
        connection.setActiveTurn(store.getState().status === 'running');
      },

      onSnapshot(snapshot) {
        if (disposed) return;
        store.applySnapshot(snapshot);
        if (!firstSnapshotRecorded) {
          firstSnapshotRecorded = true;
          telemetry.markReloadRestored();
        }
        connection.setActiveTurn(store.getState().status === 'running');
      },

      onSnapshotError(statusCode, message) {
        if (disposed) return;
        store.applySnapshotError(statusCode, message);
        connection.setActiveTurn(store.getState().status === 'running');
      },

      onEvent(event, eventId) {
        if (disposed) return;
        store.applyEvent(event, eventId);

        if (event.type === 'token') {
          telemetry.markFirstToken(event.runId);
          telemetry.markTurnActivity();
        } else if (
          event.type === 'thinking' ||
          event.type === 'phase' ||
          event.type === 'tool_call' ||
          event.type === 'tool_status' ||
          event.type === 'health' ||
          event.type === 'retrying' ||
          event.type === 'grounding' ||
          event.type === 'summary'
        ) {
          telemetry.markTurnActivity();
        } else if (event.type === 'done') {
          if (event.autoRetry) {
            telemetry.markTurnActivity();
          } else {
            const turnStatus =
              event.semanticStatus === 'failed'
                ? 'error'
                : event.semanticStatus === 'cancelled'
                  ? 'cancelled'
                  : 'ok';
            telemetry.markTurnFinished(turnStatus, event.runId);
          }
        } else if (event.type === 'error') {
          if (
            event.errorCode === 'transient' ||
            event.errorCode === 'rate_limit'
          ) {
            telemetry.markTurnActivity();
          } else {
            telemetry.markTurnFinished('error', event.runId);
          }
        }

        connection.setActiveTurn(store.getState().status === 'running');
      },

      onReceipt(receipt) {
        if (disposed) return;

        if (
          isSignInRequiredReason(receipt.reason) &&
          inFlightCommands.has(receipt.commandId) &&
          !retriedOverHttp.has(receipt.commandId)
        ) {
          const originalBody = inFlightCommands.get(receipt.commandId)!;
          retriedOverHttp.add(receipt.commandId);
          const retryPromise = connection
            .sendCommandOverHttp(originalBody)
            .catch((err: unknown) => {
              inFlightCommands.delete(originalBody.commandId);
              retriedOverHttp.delete(originalBody.commandId);
              const message =
                err instanceof Error ? err.message : 'Failed to send command';
              store.markCommandFailed(
                originalBody.commandId,
                originalBody.kind,
                message,
                originalBody.kind === 'retry' ? originalBody.runId : undefined,
              );
              return null;
            })
            .finally(() => {
              pendingSignInRetries.delete(originalBody.commandId);
            });
          pendingSignInRetries.set(originalBody.commandId, retryPromise);
          return;
        }

        store.applyReceipt(receipt);
        scheduleReceiptAutoDismiss();

        if (receipt.kind === 'steer') {
          telemetry.markSteerAcknowledged(receipt.commandId, receipt.status);
        } else if (receipt.kind === 'cancel') {
          telemetry.markStopConfirmed(receipt.commandId, receipt.status);
        }

        if (receipt.status === 'applied' || receipt.status === 'rejected') {
          inFlightCommands.delete(receipt.commandId);
          retriedOverHttp.delete(receipt.commandId);
        }

        connection.setActiveTurn(store.getState().status === 'running');
      },

      onStateFrame(threadState) {
        if (disposed) return;
        store.applyStateFrame(threadState);
        connection.setActiveTurn(threadState.threadStatus === 'running');
      },

      onSignedOut() {
        if (disposed) return;
        clearReceiptDismissTimer();
        store.applyConnectionState('signed-out');
        connection.setActiveTurn(false);
      },
    },
    {
      lastEventId: deps.lastEventId,
      webSocketFactory: deps.webSocketFactory,
      fetchImpl: deps.fetchImpl,
      firstRetryDelayMs: deps.firstRetryDelayMs,
      backoffBaseMs: deps.backoffBaseMs,
      backoffMaxMs: deps.backoffMaxMs,
      stateFrameTimeoutMs: deps.stateFrameTimeoutMs,
      unavailablePollIntervalMs: deps.unavailablePollIntervalMs,
      wsUrlFor: deps.wsUrlFor,
    },
  );

  async function dispatchCommand(
    body: HarnessCommandBody,
  ): Promise<HarnessReceipt | null> {
    if (disposed) return null;
    inFlightCommands.set(body.commandId, body);
    try {
      const receipt = await connection.sendCommand(body);
      const pendingRetry = pendingSignInRetries.get(body.commandId);
      if (pendingRetry) {
        return await pendingRetry;
      }
      if (
        receipt &&
        (receipt.status === 'applied' || receipt.status === 'rejected')
      ) {
        inFlightCommands.delete(body.commandId);
        retriedOverHttp.delete(body.commandId);
      }
      return receipt;
    } catch (err: unknown) {
      inFlightCommands.delete(body.commandId);
      retriedOverHttp.delete(body.commandId);
      const message =
        err instanceof Error ? err.message : 'Failed to send command';
      store.markCommandFailed(
        body.commandId,
        body.kind,
        message,
        body.kind === 'retry' ? body.runId : undefined,
      );
      return null;
    }
  }

  return {
    subscribe(listener) {
      return store.subscribe(listener);
    },

    getState() {
      return store.getState();
    },

    getDisplayedMessages() {
      return store.getDisplayedMessages();
    },

    start() {
      if (started || disposed) return;
      started = true;
      telemetry.markReloadStarted();
      connection.start();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      clearReceiptDismissTimer();
      inFlightCommands.clear();
      retriedOverHttp.clear();
      pendingSignInRetries.clear();
      connection.close();
    },

    refreshSnapshot() {
      if (disposed) return Promise.resolve(null);
      return connection.refreshSnapshot();
    },

    send(commandId, text, opts) {
      if (disposed) return Promise.resolve(null);
      const attachmentsMeta: ChatAttachmentMeta[] | undefined =
        opts?.attachments && opts.attachments.length > 0
          ? opts.attachments.map(({ id, name, type, size }) => ({
              id,
              name,
              type,
              size,
            }))
          : undefined;
      store.recordOptimisticSend(commandId, text, attachmentsMeta);
      telemetry.markSendStarted(commandId);
      telemetry.markFirstFeedback(commandId);

      const body: HarnessCommandBody = {
        commandId,
        kind: 'send',
        text,
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.skill ? { skill: opts.skill } : {}),
        ...(opts?.attachments && opts.attachments.length > 0
          ? { attachments: opts.attachments }
          : {}),
      };
      return dispatchCommand(body);
    },

    steer(commandId, text) {
      if (disposed) return Promise.resolve(null);
      store.recordPendingCommand(commandId, 'steer');
      telemetry.markSteerStarted(commandId);
      return dispatchCommand({ commandId, kind: 'steer', text });
    },

    summarize(commandId) {
      if (disposed) return Promise.resolve(null);
      store.recordPendingCommand(commandId, 'summarize');
      return dispatchCommand({ commandId, kind: 'summarize' });
    },

    cancel(commandId) {
      if (disposed) return Promise.resolve(null);
      store.beginLocalStop(commandId);
      telemetry.markStopRequested(commandId);
      telemetry.markStopUiHalted(commandId);
      return dispatchCommand({ commandId, kind: 'cancel' });
    },

    retry(commandId, runId) {
      if (disposed) return Promise.resolve(null);
      store.recordPendingCommand(commandId, 'retry');
      return dispatchCommand({ commandId, kind: 'retry', runId });
    },

    clearReceipt() {
      clearReceiptDismissTimer();
      store.clearReceipt();
    },

    clearFailure() {
      store.clearFailure();
    },
  };
}

export function useChatRuntime(
  threadId: string | null,
  deps?: UseChatRuntimeDeps,
): { runtime: ChatRuntime | null; state: RuntimeState } {
  const enabled = deps?.enabled !== false;
  const depsRef = useRef<UseChatRuntimeDeps | undefined>(deps);
  depsRef.current = deps;

  const [entry, setEntry] = useState<{
    threadId: string;
    runtime: ChatRuntime;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !threadId) {
      setEntry(null);
      return;
    }

    const runtime = createChatRuntime(threadId, depsRef.current);
    runtime.start();
    setEntry({ threadId, runtime });

    return () => {
      runtime.dispose();
    };
  }, [threadId, enabled]);

  const activeRuntime =
    enabled && threadId && entry && entry.threadId === threadId
      ? entry.runtime
      : null;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!activeRuntime) return NOOP_UNSUBSCRIBE;
      return activeRuntime.subscribe(onStoreChange);
    },
    [activeRuntime],
  );

  const getSnapshot = useCallback(
    (): RuntimeState =>
      activeRuntime ? activeRuntime.getState() : IDLE_RUNTIME_STATE,
    [activeRuntime],
  );

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return { runtime: activeRuntime, state };
}
