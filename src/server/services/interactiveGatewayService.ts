/**
 * FEAT-007 / TBI-008 — interactive WebSocket agent gateway (transport core).
 *
 * The stateless gateway attaches a client socket to a thread's live agent
 * stream. It reproduces the exact durability + ordering contract already used
 * by the SSE route (`GET /api/chat/threads/:id/stream`) so the two transports
 * are interchangeable during rollout:
 *
 *   1. Replay durable `agent_run_events` from the client's last acknowledged
 *      ordinal (`lastEventId`) — the client resumes with no gaps or dupes.
 *   2. Subscribe to the in-memory owner stream (this instance's transient thread
 *      events, e.g. the just-persisted user message) AND the Redis live bus,
 *      onto which the ACA actor tier publishes ephemeral token/tool/progress
 *      frames. Live push rides Redis; durability rides Postgres.
 *   3. Buffer live events during replay, then flush them ordered by
 *      (timestamp, sequence) so replay always precedes live (VT-04).
 *   4. De-duplicate by `eventId` across replay + both live sources.
 *
 * NOTE: the actor runs in a DIFFERENT process (ACA) than this gateway (App
 * Service), so there is no same-instance echo to drop. The historical
 * `shouldForwardPgRunEvent` same-instance filter — which silently dropped every
 * co-located pg_notify frame and hung the socket — is intentionally gone.
 *
 * Transport specifics (ws handshake, auth, ping/pong) live in the host mount;
 * this core is socket-agnostic and never inspects prompt/snapshot content
 * (BR-019).
 */
import type {
  AgentRunEventEnvelope,
  ChatMessage,
  ChatThreadStatus,
  SseEvent,
} from '../../shared/types/chat';
import { replayRunEvents as defaultReplayRunEvents } from './pgNotifyService';
import { interactiveLiveBus } from './interactiveLiveBus';
import {
  getThread as defaultGetThread,
  subscribeToThread as defaultSubscribeToThread,
} from './chatAgentService';
import { eventForRunEnvelope as defaultEventForRunEnvelope } from '../routes/chat';

/** Minimal socket contract satisfied by a `ws` WebSocket (and test fakes). */
export interface InteractiveGatewaySocket {
  send(data: string): void;
  onClose(handler: () => void): void;
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

export interface InteractiveThreadSnapshot {
  messages: ChatMessage[];
  status: ChatThreadStatus;
}

export interface AttachInteractiveThreadOptions {
  /** Last durable ordinal the client acknowledged (resume point). */
  lastEventId?: string;
  /**
   * Local source id. Retained for API compatibility; the live path no longer
   * filters by instance (the actor is a different process), so this is unused.
   */
  localInstance?: string;
}

export interface InteractiveGatewayDependencies {
  loadThreadSnapshot: (
    threadId: string,
  ) => Promise<InteractiveThreadSnapshot | null>;
  replayRunEvents: (
    threadId: string,
    lastEventId?: string,
  ) => Promise<AgentRunEventEnvelope[]>;
  subscribeToThread: (
    threadId: string,
    callback: (event: SseEvent, envelope?: AgentRunEventEnvelope) => void,
  ) => () => void;
  /**
   * Subscribe to the thread's live run-event fan-out (Redis). The actor tier
   * publishes ephemeral token/tool/progress envelopes here; durability rides
   * Postgres `replayRunEvents`. When Redis is unconfigured this is a no-op and
   * the socket relies on replay + the client's `/run-status` safety net.
   */
  subscribeLiveEvents: (
    threadId: string,
    callback: (envelope: AgentRunEventEnvelope) => void,
  ) => () => void;
  eventForRunEnvelope: (envelope: AgentRunEventEnvelope) => SseEvent;
}

const defaultDependencies: InteractiveGatewayDependencies = {
  loadThreadSnapshot: async (threadId) => {
    const thread = await defaultGetThread(threadId);
    return thread
      ? { messages: thread.messages, status: thread.status }
      : null;
  },
  replayRunEvents: defaultReplayRunEvents,
  subscribeToThread: defaultSubscribeToThread,
  subscribeLiveEvents: (threadId, callback) =>
    interactiveLiveBus.subscribe(threadId, callback),
  eventForRunEnvelope: defaultEventForRunEnvelope,
};

/**
 * Attach `socket` to `threadId`'s stream. Resolves once replay has flushed and
 * the socket is live; returns a detach function that unsubscribes both sources.
 * The socket's own close handler also detaches.
 */
export async function attachInteractiveThreadStream(
  socket: InteractiveGatewaySocket,
  threadId: string,
  options: AttachInteractiveThreadOptions = {},
  dependencies: InteractiveGatewayDependencies = defaultDependencies,
): Promise<() => void> {
  void options.localInstance; // retained for API compatibility; unused live-path filter
  const sentEventIds = new Set<string>();
  const sentMessageIds = new Set<string>();
  let replaying = true;
  let detached = false;
  let arrivalOrder = 0;
  const pendingLiveEvents: Array<{
    event: SseEvent;
    envelope?: AgentRunEventEnvelope;
    arrival: number;
  }> = [];

  const sendEvent = (
    event: SseEvent,
    eventId = '',
  ): void => {
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
    sendEvent(
      dependencies.eventForRunEnvelope(envelope),
      envelope.eventId,
    );
  };

  const queueOrSend = (
    event: SseEvent,
    envelope?: AgentRunEventEnvelope,
  ): void => {
    if (replaying) {
      pendingLiveEvents.push({
        event,
        envelope,
        arrival: arrivalOrder++,
      });
    } else if (envelope) {
      sendEnvelope(envelope);
    } else {
      sendEvent(event);
    }
  };

  // Subscribe BEFORE replay so no live event is missed during the async
  // replay window (mirrors the SSE route ordering).
  const unsubscribeThread = dependencies.subscribeToThread(
    threadId,
    (event, envelope) => queueOrSend(event, envelope),
  );
  // Live push from the ACA actor tier over Redis. No same-instance filter: the
  // actor runs in a different process, so every live envelope is forwarded and
  // de-duplicated by `eventId` against replay (root-cause fix for the hang).
  const unsubscribeLive = dependencies.subscribeLiveEvents(
    threadId,
    (envelope) => {
      queueOrSend(dependencies.eventForRunEnvelope(envelope), envelope);
    },
  );

  const detach = (): void => {
    if (detached) return;
    detached = true;
    unsubscribeThread();
    unsubscribeLive();
  };
  socket.onClose(detach);

  // Mirror the SSE route's initial snapshot so a socket that attaches after a
  // send still receives the persisted user message and current running state.
  // Subscriptions are already active, so the snapshot/live overlap is closed
  // by message-id and durable-event-id de-duplication.
  try {
    const snapshot = await dependencies.loadThreadSnapshot(threadId);
    if (snapshot) {
      for (const message of snapshot.messages) {
        sendEvent({ type: 'message', message });
      }
      sendEvent({ type: 'status', status: snapshot.status });
    }
  } catch {
    // A failed snapshot does not prevent durable/live streaming.
  }

  let replayEvents: AgentRunEventEnvelope[] = [];
  try {
    replayEvents = await dependencies.replayRunEvents(threadId, options.lastEventId);
  } catch {
    replayEvents = [];
  }
  for (const envelope of replayEvents) sendEnvelope(envelope);

  // Flush live events buffered during replay, ordered so replay precedes live.
  replaying = false;
  pendingLiveEvents
    .sort(
      (left, right) =>
        left.envelope && right.envelope
          ? left.envelope.timestamp.localeCompare(right.envelope.timestamp)
            || left.envelope.sequence - right.envelope.sequence
          : left.arrival - right.arrival,
    )
    .forEach(({ event, envelope }) => {
      if (envelope) sendEnvelope(envelope);
      else sendEvent(event);
    });

  return detach;
}
