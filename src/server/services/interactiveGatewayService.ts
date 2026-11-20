/**
 * FEAT-007 / TBI-008 + FEAT-002 / TBI-010 — interactive WebSocket agent gateway
 * (transport core).
 *
 * The stateless gateway attaches a client socket to a thread's live agent
 * stream and command channel:
 *
 *   1. Replay durable `agent_run_events` from the client's last acknowledged
 *      ordinal (`lastEventId`) — the client resumes with no gaps or dupes.
 *   2. Emit a text-free `state` frame on connect and on every state change.
 *   3. Accept inbound `command` frames, dispatch them through `onCommand`, and
 *      return `receipt` + refreshed `state` frames (or `error` frames on
 *      invalid command payloads).
 *   4. Subscribe to cross-instance `thread_commands` pg_notify receipts, the
 *      in-memory thread stream, durable run events, and the Redis live bus.
 *   5. Buffer live events during replay, then flush them ordered by
 *      (timestamp, sequence) so replay always precedes live (VT-04).
 *   6. De-duplicate by `eventId` across replay + live sources.
 *
 * Transport specifics (ws handshake, auth, ping/pong) live in the host mount;
 * this core is socket-agnostic and never logs prompt/snapshot/command text.
 */
import type {
  AgentRunEventEnvelope,
  ChatMessage,
  ChatThreadStatus,
  SseEvent,
} from '../../shared/types/chat';
import {
  isHarnessCommandFrame,
  type HarnessCommandBody,
  type HarnessErrorFrame,
  type HarnessGatewayOutboundFrame,
  type HarnessReceipt,
  type HarnessReceiptFrame,
  type HarnessStateFrame,
  type HarnessThreadState,
} from '../../shared/types/chatHarness';
import {
  replayRunEventPage as defaultReplayRunEventPage,
  replayRunEvents as defaultReplayRunEvents,
  subscribeRunEvents as defaultSubscribeRunEvents,
  subscribeThreadCommands as defaultSubscribeThreadCommands,
  type RunEventPage,
} from './pgNotifyService';
import { interactiveLiveBus } from './interactiveLiveBus';
import {
  getThread as defaultGetThread,
  subscribeToThread as defaultSubscribeToThread,
} from './chatAgentService';
import {
  buildStreamStatusEvent,
  eventForRunEnvelope as defaultEventForRunEnvelope,
} from '../routes/chat';
import { isFeatureEnabled } from './featureFlagService';
import { HarnessCommandError } from './chatHarness/chatHarnessCommandHandler';
import { loadHarnessThreadState } from './chatHarness/chatHarnessStateFrame';

const MAX_DEDUPED_RECEIPTS = 500;

/** Minimal socket contract satisfied by a `ws` WebSocket (and test fakes). */
export interface InteractiveGatewaySocket {
  send(data: string): void;
  onClose(handler: () => void): void;
  onMessage?: (handler: (data: string) => void) => void;
}

/**
 * Framed gateway message. `id` is the durable ordinal used for resume, or an
 * empty string for transient thread events such as persisted chat messages.
 */
export interface InteractiveGatewayFrame {
  type: 'event';
  id: string;
  data: SseEvent;
}

export type InteractiveGatewayOutboundFrame =
  | InteractiveGatewayFrame
  | HarnessGatewayOutboundFrame;

export interface InteractiveThreadSnapshot {
  messages: ChatMessage[];
  status: ChatThreadStatus;
  eventDrivenTermination: boolean;
  activeRunId?: string;
}

export interface AttachInteractiveThreadOptions {
  /** Last durable ordinal the client acknowledged (resume point). */
  lastEventId?: string;
  /**
   * Local source id. Retained for API compatibility; the live path no longer
   * filters by instance (the actor is a different process), so this is unused.
   */
  localInstance?: string;
  /** Caller write capability for the attached thread (annotated onto state frames). */
  canWrite?: boolean;
}

export interface InteractiveGatewayDependencies {
  loadThreadSnapshot: (
    threadId: string
  ) => Promise<InteractiveThreadSnapshot | null>;
  /**
   * Load the text-free `HarnessThreadState` frame for this thread. Optional so
   * legacy unit tests without harness state continue unchanged.
   */
  loadThreadState?: (threadId: string) => Promise<HarnessThreadState | null>;
  /**
   * Paginated durable replay. Preferred by the gateway; loops while `hasMore`.
   */
  replayRunEventPage?: (
    threadId: string,
    options?: {
      afterEventId?: string;
      limit?: number;
      runId?: string;
      coldStart?: 'recent' | 'oldest';
    }
  ) => Promise<RunEventPage>;
  /**
   * One-page wrapper retained for callers/tests that still inject the legacy
   * shape. When only this is provided, the gateway pages through it.
   */
  replayRunEvents?: (
    threadId: string,
    lastEventId?: string,
    limit?: number,
    runId?: string,
    coldStart?: 'recent' | 'oldest',
  ) => Promise<AgentRunEventEnvelope[]>;
  /**
   * Subscribe to durable run events as they are committed. This closes the
   * replay/live race when Redis is unavailable: final messages and terminal
   * events still reach an already-connected socket without requiring a
   * reconnect.
   */
  subscribeDurableEvents: (
    threadId: string,
    callback: (envelope: AgentRunEventEnvelope) => void
  ) => () => void;
  subscribeToThread: (
    threadId: string,
    callback: (event: SseEvent, envelope?: AgentRunEventEnvelope) => void
  ) => () => void;
  /**
   * Subscribe to the thread's live run-event fan-out (Redis). The actor tier
   * publishes ephemeral token/tool/progress envelopes here; durability rides
   * Postgres `replayRunEventPage`. When Redis is unconfigured this is a no-op and
   * the socket relies on replay + the client's `/run-status` safety net.
   */
  subscribeLiveEvents: (
    threadId: string,
    callback: (envelope: AgentRunEventEnvelope) => void
  ) => () => void;
  /**
   * Subscribe to cross-instance harness command receipt updates (`thread_commands`).
   */
  subscribeThreadCommands?: (
    threadId: string,
    callback: (receipt: HarnessReceipt) => void
  ) => () => void;
  /**
   * Subscribe to Redis control-ack updates for this thread so multi-instance
   * App Service sockets also process actor steer/cancel dispositions.
   */
  subscribeControlAcks?: (threadId: string) => () => void;
  /**
   * Handle an inbound validated harness command frame from the socket.
   */
  onCommand?: (command: HarnessCommandBody) => Promise<HarnessReceipt>;
  eventForRunEnvelope: (envelope: AgentRunEventEnvelope) => SseEvent;
}

const defaultDependencies: InteractiveGatewayDependencies = {
  loadThreadSnapshot: async (threadId) => {
    const thread = await defaultGetThread(threadId);
    if (!thread) return null;
    const project = thread.kickoff?.project;
    const eventDrivenTermination = project
      ? await isFeatureEnabled('event-driven-run-termination', {
          userId: thread.userId,
          project,
        }).catch(() => false)
      : false;
    return {
      messages: thread.messages,
      status: thread.status,
      eventDrivenTermination,
      activeRunId: thread.activeRunId,
    };
  },
  loadThreadState: (threadId) => loadHarnessThreadState(threadId),
  replayRunEventPage: defaultReplayRunEventPage,
  replayRunEvents: defaultReplayRunEvents,
  subscribeDurableEvents: defaultSubscribeRunEvents,
  subscribeToThread: defaultSubscribeToThread,
  subscribeLiveEvents: (threadId, callback) =>
    interactiveLiveBus.subscribe(threadId, callback),
  subscribeThreadCommands: defaultSubscribeThreadCommands,
  eventForRunEnvelope: defaultEventForRunEnvelope,
};

export function createInteractiveGatewayDependencies(
  overrides: Partial<InteractiveGatewayDependencies> = {},
): InteractiveGatewayDependencies {
  return {
    ...defaultDependencies,
    ...overrides,
  };
}

function resolveReplayPage(
  dependencies: InteractiveGatewayDependencies,
): NonNullable<InteractiveGatewayDependencies['replayRunEventPage']> {
  if (dependencies.replayRunEventPage) {
    return dependencies.replayRunEventPage;
  }
  const legacy = dependencies.replayRunEvents ?? defaultReplayRunEvents;
  // Legacy one-page helpers do not use LIMIT+1. Request one extra row and apply
  // the same hasMore slice as replayRunEventPage so a full page is not treated
  // as a false "has more" when that was the final page.
  return async (threadId, options = {}) => {
    const boundedLimit = Math.max(1, Math.min(options.limit ?? 500, 500));
    const events = await legacy(
      threadId,
      options.afterEventId,
      boundedLimit + 1,
      options.runId,
      options.coldStart,
    );
    const hasMore = events.length > boundedLimit;
    const page = hasMore ? events.slice(0, boundedLimit) : events;
    return {
      events: page,
      nextEventId: page.length > 0 ? page[page.length - 1]!.eventId : null,
      hasMore,
    };
  };
}

function isStateChangingEvent(
  event: SseEvent,
  envelope?: AgentRunEventEnvelope,
): boolean {
  if (event.type === 'status' || event.type === 'done' || event.type === 'error') {
    return true;
  }
  if (!envelope) return false;
  const envType = envelope.type as string;
  const envStatus = envelope.status as string | undefined;
  return (
    envType === 'done' ||
    envType === 'error' ||
    envType === 'status' ||
    envType === 'phase' ||
    envType === 'summary' ||
    envType === 'cancel' ||
    envStatus === 'completed' ||
    envStatus === 'failed' ||
    envStatus === 'cancelled'
  );
}

/**
 * Attach `socket` to `threadId`'s stream. Resolves once replay has flushed and
 * the socket is live; returns a detach function that unsubscribes all sources.
 * The socket's own close handler also detaches.
 */
export async function attachInteractiveThreadStream(
  socket: InteractiveGatewaySocket,
  threadId: string,
  options: AttachInteractiveThreadOptions = {},
  dependencies: InteractiveGatewayDependencies = defaultDependencies
): Promise<() => void> {
  void options.localInstance; // retained for API compatibility; unused live-path filter
  const replayPage = resolveReplayPage(dependencies);
  const sentEventIds = new Set<string>();
  const sentMessageIds = new Set<string>();
  const sentReceiptKeys = new Set<string>();
  const sentReceiptKeyOrder: string[] = [];
  let replaying = true;
  let detached = false;
  let arrivalOrder = 0;
  const pendingLiveEvents: Array<{
    event: SseEvent;
    envelope?: AgentRunEventEnvelope;
    arrival: number;
  }> = [];
  const pendingReceipts: HarnessReceipt[] = [];

  const rememberReceiptKey = (receipt: HarnessReceipt): boolean => {
    const key = `${receipt.commandId}:${receipt.status}:${receipt.updatedAt}`;
    if (sentReceiptKeys.has(key)) return false;
    sentReceiptKeys.add(key);
    sentReceiptKeyOrder.push(key);
    if (sentReceiptKeyOrder.length > MAX_DEDUPED_RECEIPTS) {
      const oldest = sentReceiptKeyOrder.shift();
      if (oldest) sentReceiptKeys.delete(oldest);
    }
    return true;
  };

  const sendReceipt = (receipt: HarnessReceipt): void => {
    if (detached) return;
    if (!rememberReceiptKey(receipt)) return;
    const frame: HarnessReceiptFrame = {
      type: 'receipt',
      receipt,
    };
    socket.send(JSON.stringify(frame));
  };

  const sendError = (code: string, commandId?: string): void => {
    if (detached) return;
    const frame: HarnessErrorFrame = {
      type: 'error',
      code,
      ...(commandId ? { commandId } : {}),
    };
    socket.send(JSON.stringify(frame));
  };

  const emitStateFrame = async (): Promise<void> => {
    if (detached || !dependencies.loadThreadState) return;
    try {
      const loaded = await dependencies.loadThreadState(threadId);
      if (!loaded || detached) return;
      const state: HarnessThreadState =
        options.canWrite !== undefined && loaded.canWrite === undefined
          ? { ...loaded, canWrite: options.canWrite }
          : loaded;
      const frame: HarnessStateFrame = {
        type: 'state',
        state,
      };
      socket.send(JSON.stringify(frame));
    } catch {
      // A failed state frame load must not kill the stream.
    }
  };

  const sendEvent = (event: SseEvent, eventId = ''): void => {
    if (detached) return;
    if (event.type === 'message') {
      if (sentMessageIds.has(event.message.id)) return;
      sentMessageIds.add(event.message.id);
    }
    const frame: InteractiveGatewayFrame = {
      type: 'event',
      id: eventId,
      data: event,
    };
    socket.send(JSON.stringify(frame));
  };

  const sendEnvelope = (envelope: AgentRunEventEnvelope): void => {
    if (detached) return;
    // De-dupe by durable ordinal across replay + both live sources (VT-04).
    if (sentEventIds.has(envelope.eventId)) return;
    sentEventIds.add(envelope.eventId);
    sendEvent(dependencies.eventForRunEnvelope(envelope), envelope.eventId);
  };

  const queueOrSend = (
    event: SseEvent,
    envelope?: AgentRunEventEnvelope
  ): void => {
    if (replaying) {
      pendingLiveEvents.push({
        event,
        envelope,
        arrival: arrivalOrder++,
      });
    } else {
      if (envelope) {
        sendEnvelope(envelope);
      } else {
        sendEvent(event);
      }
      if (isStateChangingEvent(event, envelope)) {
        void emitStateFrame();
      }
    }
  };

  // Subscribe BEFORE replay so no live event or receipt is missed during the
  // async replay window (mirrors the SSE route ordering).
  const unsubscribeThread = dependencies.subscribeToThread(
    threadId,
    (event, envelope) => queueOrSend(event, envelope)
  );
  const unsubscribeDurable = dependencies.subscribeDurableEvents(
    threadId,
    (envelope) => {
      queueOrSend(dependencies.eventForRunEnvelope(envelope), envelope);
    }
  );
  // Live push from the ACA actor tier over Redis. No same-instance filter: the
  // actor runs in a different process, so every live envelope is forwarded and
  // de-duplicated by `eventId` against replay (root-cause fix for the hang).
  const unsubscribeLive = dependencies.subscribeLiveEvents(
    threadId,
    (envelope) => {
      queueOrSend(dependencies.eventForRunEnvelope(envelope), envelope);
    }
  );
  const unsubscribeCommands = dependencies.subscribeThreadCommands
    ? dependencies.subscribeThreadCommands(threadId, (receipt) => {
        if (detached) return;
        if (replaying) {
          pendingReceipts.push(receipt);
        } else {
          sendReceipt(receipt);
          void emitStateFrame();
        }
      })
    : () => {};
  const unsubscribeControlAcks = dependencies.subscribeControlAcks
    ? dependencies.subscribeControlAcks(threadId)
    : () => {};

  const detach = (): void => {
    if (detached) return;
    detached = true;
    unsubscribeThread();
    unsubscribeDurable();
    unsubscribeLive();
    unsubscribeCommands();
    unsubscribeControlAcks();
  };
  socket.onClose(detach);

  if (socket.onMessage && dependencies.onCommand) {
    const handleCommand = dependencies.onCommand;
    socket.onMessage((raw: string) => {
      void (async () => {
        if (detached) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          sendError('invalid-command');
          return;
        }

        const candidateCommandId =
          parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as { commandId?: unknown }).commandId === 'string'
            ? (parsed as { commandId: string }).commandId
            : undefined;

        if (!isHarnessCommandFrame(parsed)) {
          sendError('invalid-command', candidateCommandId);
          return;
        }

        const { type: _frameType, ...commandBody } = parsed;
        try {
          const receipt = await handleCommand(commandBody as HarnessCommandBody);
          if (detached) return;
          sendReceipt(receipt);
          await emitStateFrame();
        } catch (err) {
          if (detached) return;
          if (err instanceof HarnessCommandError) {
            sendError(err.code, commandBody.commandId);
          } else {
            sendError('command-failed', commandBody.commandId);
          }
        }
      })();
    });
  }

  // Mirror the SSE route's initial snapshot so a socket that attaches after a
  // send still receives the persisted user message and current running state.
  // Subscriptions are already active, so the snapshot/live overlap is closed
  // by message-id and durable-event-id de-duplication.
  let snapshot: InteractiveThreadSnapshot | null = null;
  try {
    snapshot = await dependencies.loadThreadSnapshot(threadId);
    if (snapshot) {
      for (const message of snapshot.messages) {
        sendEvent({ type: 'message', message });
      }
      sendEvent(
        buildStreamStatusEvent(
          snapshot.status,
          snapshot.eventDrivenTermination
        )
      );
    }
  } catch {
    // A failed snapshot does not prevent durable/live streaming.
  }

  // Emit one initial `state` frame right after snapshot, before replaying events.
  await emitStateFrame();

  const shouldReplayEvents =
    Boolean(options.lastEventId) || !snapshot || snapshot.status === 'running';
  if (shouldReplayEvents) {
    const coldStart =
      !options.lastEventId && snapshot?.status === 'running'
        ? 'oldest'
        : options.lastEventId
          ? 'oldest'
          : 'recent';
    let afterEventId = options.lastEventId;
    try {
      for (;;) {
        const page = await replayPage(threadId, {
          afterEventId,
          limit: 500,
          runId: snapshot?.activeRunId,
          coldStart: afterEventId ? 'oldest' : coldStart,
        });
        for (const envelope of page.events) sendEnvelope(envelope);
        if (!page.hasMore || !page.nextEventId) break;
        afterEventId = page.nextEventId;
      }
    } catch {
      // Replay failure does not prevent live streaming.
    }
  }

  // Flush live events buffered during replay, ordered so replay precedes live.
  replaying = false;
  let stateChangedDuringReplay = false;
  pendingLiveEvents
    .sort((left, right) =>
      left.envelope && right.envelope
        ? left.envelope.timestamp.localeCompare(right.envelope.timestamp) ||
          left.envelope.sequence - right.envelope.sequence
        : left.arrival - right.arrival
    )
    .forEach(({ event, envelope }) => {
      if (envelope) sendEnvelope(envelope);
      else sendEvent(event);
      if (isStateChangingEvent(event, envelope)) {
        stateChangedDuringReplay = true;
      }
    });

  for (const receipt of pendingReceipts) {
    sendReceipt(receipt);
    stateChangedDuringReplay = true;
  }

  if (stateChangedDuringReplay) {
    void emitStateFrame();
  }

  return detach;
}
