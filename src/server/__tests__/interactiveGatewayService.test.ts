/**
 * FEAT-007 / TBI-008 — interactive gateway transport core (VT-04).
 *
 * Verifies the durability/ordering contract shared with the SSE route:
 *  - persisted thread messages/status are replayed on socket attach
 *  - envelope-less live user/final-agent messages are forwarded
 *  - ordinal resume from lastEventId
 *  - de-dupe by eventId across replay + in-memory + Postgres sources
 *  - replay always precedes live; live buffered during replay is flushed
 *    ordered by (timestamp, sequence)
 *  - Postgres echoes of the local instance are dropped
 *  - close detaches both subscriptions
 */
import {
  attachInteractiveThreadStream,
  type InteractiveGatewayDependencies,
  type InteractiveGatewayFrame,
  type InteractiveGatewaySocket,
} from '../services/interactiveGatewayService';
import type { AgentRunEventEnvelope, SseEvent } from '../../shared/types/chat';

function envelope(
  eventId: string,
  sequence: number,
  overrides: Partial<AgentRunEventEnvelope> = {},
): AgentRunEventEnvelope {
  return {
    eventId,
    threadId: 't1',
    runId: 'run-1',
    sourceInstance: 'worker-remote',
    sequence,
    timestamp: `2026-08-07T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    type: 'token',
    phase: 'implementation',
    status: 'running',
    event: { type: 'token', text: `tok-${eventId}` },
    ...overrides,
  };
}

function makeSocket(): {
  socket: InteractiveGatewaySocket;
  frames: InteractiveGatewayFrame[];
  triggerClose: () => void;
} {
  const frames: InteractiveGatewayFrame[] = [];
  let closeHandler: () => void = () => {};
  return {
    frames,
    triggerClose: () => closeHandler(),
    socket: {
      send: (data: string) => frames.push(JSON.parse(data) as InteractiveGatewayFrame),
      onClose: (handler: () => void) => {
        closeHandler = handler;
      },
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeDeps(
  overrides: Partial<InteractiveGatewayDependencies> = {},
): InteractiveGatewayDependencies & {
  emitThread: (env: AgentRunEventEnvelope) => void;
  emitTransient: (event: SseEvent) => void;
  emitNotify: (env: AgentRunEventEnvelope) => void;
  threadUnsub: jest.Mock;
  notifyUnsub: jest.Mock;
} {
  let threadCb: (event: SseEvent, env?: AgentRunEventEnvelope) => void = () => {};
  let notifyCb: (env: AgentRunEventEnvelope) => void = () => {};
  const threadUnsub = jest.fn();
  const notifyUnsub = jest.fn();
  return {
    emitThread: (env) => threadCb(env.event as SseEvent, env),
    emitTransient: (event) => threadCb(event),
    emitNotify: (env) => notifyCb(env),
    threadUnsub,
    notifyUnsub,
    loadThreadSnapshot: jest.fn(async () => null),
    replayRunEvents: jest.fn(async () => []),
    subscribeToThread: (_threadId, cb) => {
      threadCb = cb;
      return threadUnsub;
    },
    subscribeRunEvents: (_threadId, cb) => {
      notifyCb = cb;
      return notifyUnsub;
    },
    eventForRunEnvelope: (env) => env.event as InteractiveGatewayFrame['data'],
    shouldForwardPgRunEvent: (env, local) => env.sourceInstance !== local,
    ...overrides,
  };
}

describe('attachInteractiveThreadStream', () => {
  it('replays persisted user/agent messages and current status before durable events', async () => {
    const userMessage = {
      id: 'user-1',
      role: 'user' as const,
      text: 'hello',
      ts: '2026-08-07T00:00:00.000Z',
    };
    const agentMessage = {
      id: 'agent-1',
      role: 'agent' as const,
      text: 'Hello back',
      ts: '2026-08-07T00:00:01.000Z',
    };
    const deps = makeDeps({
      loadThreadSnapshot: jest.fn(async () => ({
        messages: [userMessage, agentMessage],
        status: 'idle' as const,
      })),
      replayRunEvents: jest.fn(async () => [envelope('done-1', 1, {
        event: { type: 'done' },
      })]),
    });
    const { socket, frames } = makeSocket();

    await attachInteractiveThreadStream(socket, 't1', {}, deps);

    expect(frames.map((frame) => frame.data)).toEqual([
      { type: 'message', message: userMessage },
      { type: 'message', message: agentMessage },
      { type: 'status', status: 'idle' },
      { type: 'done' },
    ]);
    expect(frames.map((frame) => frame.id)).toEqual(['', '', '', 'done-1']);
  });

  it('forwards envelope-less live user and final agent messages', async () => {
    const deps = makeDeps();
    const { socket, frames } = makeSocket();
    await attachInteractiveThreadStream(socket, 't1', {}, deps);

    deps.emitTransient({
      type: 'message',
      message: {
        id: 'user-live',
        role: 'user',
        text: 'question',
        ts: '2026-08-07T00:00:00.000Z',
      },
    });
    deps.emitTransient({
      type: 'message',
      message: {
        id: 'agent-live',
        role: 'agent',
        text: 'answer',
        ts: '2026-08-07T00:00:01.000Z',
      },
    });

    expect(frames.map((frame) => frame.data.type)).toEqual(['message', 'message']);
    expect(frames.map((frame) => frame.id)).toEqual(['', '']);
  });

  it('de-duplicates a message captured by both snapshot and live buffering', async () => {
    const snapshotGate = deferred<{
      messages: Array<{
        id: string;
        role: 'user';
        text: string;
        ts: string;
      }>;
      status: 'running';
    } | null>();
    const message = {
      id: 'user-race',
      role: 'user' as const,
      text: 'race-safe',
      ts: '2026-08-07T00:00:00.000Z',
    };
    const deps = makeDeps({
      loadThreadSnapshot: jest.fn(() => snapshotGate.promise),
    });
    const { socket, frames } = makeSocket();

    const attachPromise = attachInteractiveThreadStream(socket, 't1', {}, deps);
    deps.emitTransient({ type: 'message', message });
    snapshotGate.resolve({ messages: [message], status: 'running' });
    await attachPromise;

    expect(
      frames.filter((frame) => frame.data.type === 'message'),
    ).toHaveLength(1);
  });

  it('replays from the ordinal and de-dupes a later echo of the same event', async () => {
    const deps = makeDeps({
      replayRunEvents: jest.fn(async () => [envelope('e1', 1), envelope('e2', 2)]),
    });
    const { socket, frames } = makeSocket();

    await attachInteractiveThreadStream(socket, 't1', { lastEventId: 'e0' }, deps);

    // A Postgres echo re-delivers e2 (dupe) then a fresh e3.
    deps.emitNotify(envelope('e2', 2));
    deps.emitNotify(envelope('e3', 3));

    expect(frames.map((f) => f.id)).toEqual(['e1', 'e2', 'e3']);
    expect(deps.replayRunEvents).toHaveBeenCalledWith('t1', 'e0');
  });

  it('flushes live events buffered during replay AFTER replay, ordered by (timestamp, sequence)', async () => {
    const replayGate = deferred<AgentRunEventEnvelope[]>();
    const deps = makeDeps({ replayRunEvents: jest.fn(() => replayGate.promise) });
    const { socket, frames } = makeSocket();

    const attachPromise = attachInteractiveThreadStream(socket, 't1', {}, deps);

    // Live events arrive (out of order) WHILE replay is still pending.
    deps.emitThread(envelope('live-b', 6));
    deps.emitNotify(envelope('live-a', 5));

    // Nothing sent yet — still replaying.
    expect(frames).toHaveLength(0);

    replayGate.resolve([envelope('r1', 1), envelope('r2', 2)]);
    await attachPromise;

    // Replay first (in order), then buffered live sorted by seq/timestamp.
    expect(frames.map((f) => f.id)).toEqual(['r1', 'r2', 'live-a', 'live-b']);
  });

  it('drops Postgres echoes originating from the local instance', async () => {
    const deps = makeDeps();
    const { socket, frames } = makeSocket();

    await attachInteractiveThreadStream(
      socket,
      't1',
      { localInstance: 'this-node' },
      deps,
    );

    deps.emitNotify(envelope('own', 1, { sourceInstance: 'this-node' }));
    deps.emitNotify(envelope('other', 2, { sourceInstance: 'peer-node' }));

    expect(frames.map((f) => f.id)).toEqual(['other']);
  });

  it('detaches both subscriptions when the socket closes', async () => {
    const deps = makeDeps();
    const { socket, triggerClose } = makeSocket();

    const detach = await attachInteractiveThreadStream(socket, 't1', {}, deps);
    triggerClose();

    expect(deps.threadUnsub).toHaveBeenCalledTimes(1);
    expect(deps.notifyUnsub).toHaveBeenCalledTimes(1);

    // Idempotent: calling the returned detach again does not double-unsubscribe.
    detach();
    expect(deps.threadUnsub).toHaveBeenCalledTimes(1);
  });
});
