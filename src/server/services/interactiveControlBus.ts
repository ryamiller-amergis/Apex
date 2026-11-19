/**
 * FEAT-002 / S5 — interactive harness control channel (Redis pub/sub).
 *
 * Low-latency control fan-out from App Service to interactive actor replicas
 * (`apex:interactive:control:<threadId>`) and disposition acks back to App
 * Service (`apex:interactive:control-ack:<threadId>`).
 *
 * Lives beside `interactiveLiveBus.ts` with zero database imports so both App
 * Service (via `chatHarness/chatHarnessControlBus.ts` re-export) and the V2
 * interactive actor host (`interactiveActorHost/`) share one transport without
 * crossing the `chatHarness/` boundary.
 *
 * Never logs steer text or message payloads; logs only sanitized connection
 * lifecycle events.
 */
import Redis from 'ioredis';
import type { HarnessControlMessage } from '../../shared/types/chatHarness';
import {
  resolveRedisConfig,
  type RedisLike,
  type ResolvedRedisConfig,
} from './interactiveLiveBus';

const CONTROL_CHANNEL_PREFIX = 'apex:interactive:control';
const CONTROL_ACK_CHANNEL_PREFIX = 'apex:interactive:control-ack';
const DEFAULT_KEEP_ALIVE_MS = 60_000;

export type HarnessSteerDisposition =
  | 'steered'
  | 'held'
  | 'merged'
  | 'turn-ended';

export type HarnessCancelDisposition = 'cancelled' | 'turn-ended';

export type HarnessControlDisposition = HarnessSteerDisposition | 'cancelled';

export interface HarnessControlAck {
  threadId: string;
  runId: string;
  commandId: string;
  kind: 'steer' | 'cancel';
  disposition: HarnessControlDisposition;
  timestamp: string;
}

export type ControlMessageCallback = (message: HarnessControlMessage) => void;
export type ControlAckCallback = (ack: HarnessControlAck) => void;

export interface ChatHarnessControlBus {
  /** True when Redis is configured; false -> graceful no-op. */
  isEnabled(): boolean;
  /** Publish a control message (steer / cancel) to the thread's control channel. */
  publishControl(message: HarnessControlMessage): Promise<void>;
  /** Subscribe to control messages for a thread. Returns an unsubscribe fn. */
  subscribeControl(threadId: string, cb: ControlMessageCallback): () => void;
  /** Publish a control disposition ack back to App Service. */
  publishAck(ack: HarnessControlAck): Promise<void>;
  /** Subscribe to control acks for a thread. Returns an unsubscribe fn. */
  subscribeAck(threadId: string, cb: ControlAckCallback): () => void;
  /** Eagerly establish connections (safe no-op when unconfigured). */
  init(): Promise<void>;
  /** Tear down connections on shutdown. */
  shutdown(): Promise<void>;
}

export interface ChatHarnessControlBusOptions {
  /** Resolved config; defaults to {@link resolveRedisConfig} over process.env. */
  config?: ResolvedRedisConfig | null;
  /** Client factory (injected in tests). Defaults to a lazy `ioredis` client. */
  createClient?: (role: 'pub' | 'sub', config: ResolvedRedisConfig) => RedisLike;
  /** Structured logger for connection lifecycle (never receives steer text). */
  logger?: (event: Record<string, unknown>) => void;
  /** Interval between PINGs on each open connection; 0 disables. */
  keepAliveMs?: number;
}

export function controlChannelFor(threadId: string): string {
  return `${CONTROL_CHANNEL_PREFIX}:${threadId}`;
}

export function controlAckChannelFor(threadId: string): string {
  return `${CONTROL_ACK_CHANNEL_PREFIX}:${threadId}`;
}

function defaultCreateClient(
  role: 'pub' | 'sub',
  config: ResolvedRedisConfig,
): RedisLike {
  const options: Record<string, unknown> = {
    maxRetriesPerRequest: role === 'sub' ? null : 3,
    enableReadyCheck: true,
    connectionName: `apex-interactive-control-${role}`,
    retryStrategy: (times: number) => Math.min(times * 200, 2_000),
  };
  if (config.tls) options.tls = {};

  const client = config.url
    ? new Redis(config.url, options)
    : new Redis({
        host: config.host,
        port: config.port,
        password: config.password,
        ...options,
      });
  return client as unknown as RedisLike;
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}

function parseControlMessage(raw: string): HarnessControlMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.threadId !== 'string' ||
    obj.threadId.trim().length === 0 ||
    typeof obj.runId !== 'string' ||
    obj.runId.trim().length === 0 ||
    typeof obj.commandId !== 'string' ||
    obj.commandId.trim().length === 0 ||
    typeof obj.sentAt !== 'string' ||
    obj.sentAt.trim().length === 0
  ) {
    return null;
  }
  if (obj.kind === 'steer') {
    if (typeof obj.text !== 'string' || obj.text.trim().length === 0) {
      return null;
    }
    return {
      kind: 'steer',
      threadId: obj.threadId,
      runId: obj.runId,
      commandId: obj.commandId,
      text: obj.text,
      sentAt: obj.sentAt,
    };
  }
  if (obj.kind === 'cancel') {
    return {
      kind: 'cancel',
      threadId: obj.threadId,
      runId: obj.runId,
      commandId: obj.commandId,
      sentAt: obj.sentAt,
    };
  }
  return null;
}

const VALID_DISPOSITIONS = new Set<string>([
  'steered',
  'held',
  'merged',
  'turn-ended',
  'cancelled',
]);

function parseControlAck(raw: string): HarnessControlAck | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.threadId !== 'string' ||
    obj.threadId.trim().length === 0 ||
    typeof obj.runId !== 'string' ||
    obj.runId.trim().length === 0 ||
    typeof obj.commandId !== 'string' ||
    obj.commandId.trim().length === 0 ||
    (obj.kind !== 'steer' && obj.kind !== 'cancel') ||
    typeof obj.disposition !== 'string' ||
    !VALID_DISPOSITIONS.has(obj.disposition) ||
    typeof obj.timestamp !== 'string' ||
    obj.timestamp.trim().length === 0
  ) {
    return null;
  }
  return {
    threadId: obj.threadId,
    runId: obj.runId,
    commandId: obj.commandId,
    kind: obj.kind,
    disposition: obj.disposition as HarnessControlDisposition,
    timestamp: obj.timestamp,
  };
}

/**
 * Create a chat harness control bus. Prefer {@link chatHarnessControlBus}
 * singleton in runtime code; this factory lets tests inject a fake Redis client.
 */
export function createChatHarnessControlBus(
  options: ChatHarnessControlBusOptions = {},
): ChatHarnessControlBus {
  const config =
    options.config !== undefined ? options.config : resolveRedisConfig();
  const createClient = options.createClient ?? defaultCreateClient;
  const log = options.logger ?? ((event) => console.log(JSON.stringify(event)));

  const enabled = config !== null;
  const controlSubscribers = new Map<string, Set<ControlMessageCallback>>();
  const ackSubscribers = new Map<string, Set<ControlAckCallback>>();

  let publisher: RedisLike | null = null;
  let subscriber: RedisLike | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;

  const ensureKeepAlive = (): void => {
    if (keepAliveTimer || keepAliveMs <= 0) return;
    keepAliveTimer = setInterval(() => {
      for (const client of [publisher, subscriber]) {
        client?.ping?.().catch(() => {});
      }
    }, keepAliveMs);
    keepAliveTimer.unref?.();
  };

  const ensurePublisher = (): RedisLike | null => {
    if (!enabled || !config) return null;
    if (!publisher) {
      publisher = createClient('pub', config);
      publisher.on('error', (err: unknown) =>
        log({
          event: 'ChatHarnessControlBusPublisherError',
          errorType: errName(err),
        }),
      );
      publisher.on('ready', () =>
        log({ event: 'ChatHarnessControlBusPublisherReady' }),
      );
      publisher.on('reconnecting', () =>
        log({ event: 'ChatHarnessControlBusPublisherReconnecting' }),
      );
      ensureKeepAlive();
    }
    return publisher;
  };

  const ensureSubscriber = (): RedisLike | null => {
    if (!enabled || !config) return null;
    if (!subscriber) {
      subscriber = createClient('sub', config);
      subscriber.on('error', (err: unknown) =>
        log({
          event: 'ChatHarnessControlBusSubscriberError',
          errorType: errName(err),
        }),
      );
      subscriber.on('ready', () =>
        log({ event: 'ChatHarnessControlBusSubscriberReady' }),
      );
      subscriber.on('reconnecting', () =>
        log({ event: 'ChatHarnessControlBusSubscriberReconnecting' }),
      );
      subscriber.on('message', (channel: string, rawMessage: string) => {
        const controlSubs = controlSubscribers.get(channel);
        if (controlSubs && controlSubs.size > 0) {
          const parsed = parseControlMessage(rawMessage);
          if (!parsed) return;
          for (const cb of controlSubs) {
            try {
              cb(parsed);
            } catch {
              // Isolate subscriber errors.
            }
          }
          return;
        }
        const ackSubs = ackSubscribers.get(channel);
        if (ackSubs && ackSubs.size > 0) {
          const parsed = parseControlAck(rawMessage);
          if (!parsed) return;
          for (const cb of ackSubs) {
            try {
              cb(parsed);
            } catch {
              // Isolate subscriber errors.
            }
          }
        }
      });
      ensureKeepAlive();
    }
    return subscriber;
  };

  const subscribeChannel = <T>(
    map: Map<string, Set<T>>,
    channel: string,
    cb: T,
  ): (() => void) => {
    if (!enabled) return () => {};
    let subs = map.get(channel);
    if (!subs) {
      subs = new Set<T>();
      map.set(channel, subs);
      const client = ensureSubscriber();
      client
        ?.subscribe(channel)
        .then(() =>
          log({ event: 'ChatHarnessControlBusSubscribed', channel }),
        )
        .catch((err: unknown) =>
          log({
            event: 'ChatHarnessControlBusSubscribeFailed',
            errorType: errName(err),
          }),
        );
    }
    subs.add(cb);

    return () => {
      const current = map.get(channel);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) {
        map.delete(channel);
        subscriber?.unsubscribe(channel).catch(() => {});
      }
    };
  };

  return {
    isEnabled: () => enabled,

    async publishControl(message: HarnessControlMessage): Promise<void> {
      const client = ensurePublisher();
      if (!client) return;
      try {
        await client.publish(
          controlChannelFor(message.threadId),
          JSON.stringify(message),
        );
      } catch (err) {
        // Best-effort fast path; slow path delivers via ingestResponse.pendingControl.
        log({
          event: 'ChatHarnessControlBusPublishFailed',
          kind: message.kind,
          errorType: errName(err),
        });
      }
    },

    subscribeControl(threadId: string, cb: ControlMessageCallback): () => void {
      return subscribeChannel(
        controlSubscribers,
        controlChannelFor(threadId),
        cb,
      );
    },

    async publishAck(ack: HarnessControlAck): Promise<void> {
      const client = ensurePublisher();
      if (!client) return;
      try {
        await client.publish(
          controlAckChannelFor(ack.threadId),
          JSON.stringify(ack),
        );
      } catch (err) {
        log({
          event: 'ChatHarnessControlBusPublishAckFailed',
          kind: ack.kind,
          errorType: errName(err),
        });
      }
    },

    subscribeAck(threadId: string, cb: ControlAckCallback): () => void {
      return subscribeChannel(
        ackSubscribers,
        controlAckChannelFor(threadId),
        cb,
      );
    },

    async init(): Promise<void> {
      if (!enabled) return;
      ensurePublisher();
      ensureSubscriber();
    },

    async shutdown(): Promise<void> {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      const closing: Array<Promise<unknown>> = [];
      if (publisher) closing.push(publisher.quit().catch(() => {}));
      if (subscriber) closing.push(subscriber.quit().catch(() => {}));
      publisher = null;
      subscriber = null;
      controlSubscribers.clear();
      ackSubscribers.clear();
      await Promise.all(closing);
    },
  };
}

/** Process-wide singleton used by App Service and actor hosts. */
export const chatHarnessControlBus: ChatHarnessControlBus =
  createChatHarnessControlBus();

export async function initChatHarnessControlBus(): Promise<void> {
  await chatHarnessControlBus.init();
}

export async function shutdownChatHarnessControlBus(): Promise<void> {
  await chatHarnessControlBus.shutdown();
}
