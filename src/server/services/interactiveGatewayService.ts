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
 *   2. Subscribe to the in-memory owner stream AND the cross-worker Postgres
 *      LISTEN/NOTIFY fan-out.
 *   3. Buffer live events during replay, then flush them ordered by
 *      (timestamp, sequence) so replay always precedes live (VT-04).
 *   4. De-duplicate by `eventId` across replay + both live sources.
 *
 * Transport specifics (ws handshake, auth, ping/pong) live in the host mount;
 * this core is socket-agnostic and never inspects prompt/snapshot content
 * (BR-019).
 */
import type { AgentRunEventEnvelope, SseEvent } from '../../shared/types/chat';
import {
  replayRunEvents as defaultReplayRunEvents,
  subscribeRunEvents as defaultSubscribeRunEvents,
  RUN_EVENT_SOURCE_INSTANCE,
} from './pgNotifyService';
import { subscribeToThread as defaultSubscribeToThread } from './chatAgentService';
import {
  eventForRunEnvelope as defaultEventForRunEnvelope,
  shouldForwardPgRunEvent as defaultShouldForwardPgRunEvent,
} from '../routes/chat';

/** Minimal socket contract satisfied by a `ws` WebSocket (and test fakes). */
export interface InteractiveGatewaySocket {
  send(data: string): void;
  onClose(handler: () => void): void;
}

/** Framed gateway message. `id` is the durable ordinal used for resume. */
export interface InteractiveGatewayFrame {
  type: 'event';
  id: string;
  data: SseEvent;
}

export interface AttachInteractiveThreadOptions {
  /** Last durable ordinal the client acknowledged (resume point). */
  lastEventId?: string;
  /** Local source id used to drop Postgres echoes of our own events. */
  localInstance?: string;
}

export interface InteractiveGatewayDependencies {
  replayRunEvents: (
    threadId: string,
    lastEventId?: string,
  ) => Promise<AgentRunEventEnvelope[]>;
  subscribeToThread: (
    threadId: string,
    callback: (event: SseEvent, envelope?: AgentRunEventEnvelope) => void,
  ) => () => void;
  subscribeRunEvents: (
    threadId: string,
    callback: (envelope: AgentRunEventEnvelope) => void,
  ) => () => void;
  eventForRunEnvelope: (envelope: AgentRunEventEnvelope) => SseEvent;
  shouldForwardPgRunEvent: (
    envelope: AgentRunEventEnvelope,
    localInstance?: string,
  ) => boolean;
}

const defaultDependencies: InteractiveGatewayDependencies = {
  replayRunEvents: defaultReplayRunEvents,
  subscribeToThread: defaultSubscribeToThread,
  subscribeRunEvents: defaultSubscribeRunEvents,
  eventForRunEnvelope: defaultEventForRunEnvelope,
  shouldForwardPgRunEvent: defaultShouldForwardPgRunEvent,
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
  const localInstance = options.localInstance ?? RUN_EVENT_SOURCE_INSTANCE;
  const sentEventIds = new Set<string>();
  let replaying = true;
  let detached = false;
  const pendingLiveEvents: AgentRunEventEnvelope[] = [];

  const sendEnvelope = (envelope: AgentRunEventEnvelope): void => {
    if (detached) return;
    // De-dupe by durable ordinal across replay + both live sources (VT-04).
    if (sentEventIds.has(envelope.eventId)) return;
    sentEventIds.add(envelope.eventId);
    const frame: InteractiveGatewayFrame = {
      type: 'event',
      id: envelope.eventId,
      data: dependencies.eventForRunEnvelope(envelope),
    };
    socket.send(JSON.stringify(frame));
  };

  const queueOrSend = (envelope: AgentRunEventEnvelope): void => {
    if (replaying) pendingLiveEvents.push(envelope);
    else sendEnvelope(envelope);
  };

  // Subscribe BEFORE replay so no live event is missed during the async
  // replay window (mirrors the SSE route ordering).
  const unsubscribeThread = dependencies.subscribeToThread(
    threadId,
    (_event, envelope) => {
      if (envelope) queueOrSend(envelope);
    },
  );
  const unsubscribeNotify = dependencies.subscribeRunEvents(
    threadId,
    (envelope) => {
      // The owner already delivered this via the in-memory subscriber; the
      // Postgres echo is only for OTHER workers.
      if (!dependencies.shouldForwardPgRunEvent(envelope, localInstance)) return;
      queueOrSend(envelope);
    },
  );

  const detach = (): void => {
    if (detached) return;
    detached = true;
    unsubscribeThread();
    unsubscribeNotify();
  };
  socket.onClose(detach);

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
        left.timestamp.localeCompare(right.timestamp) ||
        left.sequence - right.sequence,
    )
    .forEach(sendEnvelope);

  return detach;
}
