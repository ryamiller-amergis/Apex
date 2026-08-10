/**
 * FEAT-007 — interactive live event bus (Redis pub/sub).
 *
 * Low-latency, EPHEMERAL fan-out of live agent run events (token / tool /
 * progress) from the ACA actor tier to whichever App Service gateway currently
 * holds the client socket. Durability is deliberately NOT this bus's job:
 * milestones, the final assistant message, and the terminal `done` are
 * persisted to `agent_run_events` (Postgres) for reconnect replay. A Redis blip
 * therefore only degrades real-time feel — it can never lose an event (the
 * client also polls `/run-status` as a terminal safety net).
 *
 * Connection is lazy and derived from `REDIS_*` env. When Redis is not
 * configured (local dev / unit tests) the bus is a graceful no-op: `publish`
 * resolves and `subscribe` returns a no-op unsubscribe, so callers fall back to
 * Postgres replay only. This module never logs prompt/snapshot/secret (BR-019);
 * only sanitized run-event envelopes cross the backplane.
 *
 * Transport: a standalone `ioredis` client. This depends on the Managed Redis
 * database using a single-logical-endpoint clustering policy (EnterpriseCluster
 * / NoCluster — see infra `ai_runs_interactive_managed_redis_clustering_policy`),
 * NOT OSS Cluster: an OSS-Cluster endpoint would not fan out pub/sub across the
 * proxy/shards for a standalone client, silently degrading the live token stream
 * to the durable replay/poll path. Emits sanitized connection-lifecycle logs
 * (`InteractiveLiveBus{Publisher,Subscriber}{Ready,Reconnecting,Error}` and
 * `InteractiveLiveBusSubscribed`) so cutovers can be validated from logs.
 */
import Redis from 'ioredis';
import type { AgentRunEventEnvelope } from '../../shared/types/chat';

const CHANNEL_PREFIX = 'apex:interactive:live';

/** Minimal ioredis surface used by the bus (satisfied by a `ws`-style fake). */
export interface RedisLike {
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<number>;
  unsubscribe(...channels: string[]): Promise<number>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  quit(): Promise<unknown>;
  disconnect?(): void;
}

export interface ResolvedRedisConfig {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  tls: boolean;
}

export type LiveEventCallback = (envelope: AgentRunEventEnvelope) => void;

export interface InteractiveLiveBus {
  /** True when Redis is configured; false → graceful no-op fan-out. */
  isEnabled(): boolean;
  /** Publish a live envelope (ephemeral). Never throws into the caller. */
  publish(threadId: string, envelope: AgentRunEventEnvelope): Promise<void>;
  /** Subscribe to a thread's live envelopes. Returns an unsubscribe fn. */
  subscribe(threadId: string, callback: LiveEventCallback): () => void;
  /** Eagerly establish connections (safe no-op when unconfigured). */
  init(): Promise<void>;
  /** Tear down connections on shutdown. */
  shutdown(): Promise<void>;
}

export interface InteractiveLiveBusOptions {
  /** Resolved config; defaults to {@link resolveRedisConfig} over process.env. */
  config?: ResolvedRedisConfig | null;
  /** Client factory (injected in tests). Defaults to a lazy `ioredis` client. */
  createClient?: (role: 'pub' | 'sub', config: ResolvedRedisConfig) => RedisLike;
  /** Structured logger for connection lifecycle (never receives payloads). */
  logger?: (event: Record<string, unknown>) => void;
}

/** Resolve Redis connection config from env; null → bus disabled (no-op). */
export function resolveRedisConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRedisConfig | null {
  const url = env.REDIS_URL?.trim();
  if (url) return { url, tls: url.startsWith('rediss://') };

  const host = env.REDIS_HOST?.trim();
  const password = env.REDIS_KEY?.trim() || env.REDIS_PASSWORD?.trim();
  if (!host || !password) return null;

  const parsedPort = Number(env.REDIS_SSL_PORT?.trim() || '6380');
  return {
    host,
    port: Number.isFinite(parsedPort) ? parsedPort : 6380,
    password,
    tls: true,
  };
}

function channelFor(threadId: string): string {
  return `${CHANNEL_PREFIX}:${threadId}`;
}

function defaultCreateClient(
  role: 'pub' | 'sub',
  config: ResolvedRedisConfig,
): RedisLike {
  const options: Record<string, unknown> = {
    // A subscriber connection must never queue commands behind a retry cap.
    maxRetriesPerRequest: role === 'sub' ? null : 3,
    enableReadyCheck: true,
    connectionName: `apex-interactive-${role}`,
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

/**
 * Create an interactive live bus. Prefer the shared {@link interactiveLiveBus}
 * singleton in app code; this factory exists so tests can inject a fake client.
 */
export function createInteractiveLiveBus(
  options: InteractiveLiveBusOptions = {},
): InteractiveLiveBus {
  const config =
    options.config !== undefined ? options.config : resolveRedisConfig();
  const createClient = options.createClient ?? defaultCreateClient;
  const log = options.logger ?? ((event) => console.log(JSON.stringify(event)));

  const enabled = config !== null;
  const subscribers = new Map<string, Set<LiveEventCallback>>();

  let publisher: RedisLike | null = null;
  let subscriber: RedisLike | null = null;

  const ensurePublisher = (): RedisLike | null => {
    if (!enabled || !config) return null;
    if (!publisher) {
      publisher = createClient('pub', config);
      publisher.on('error', (err: unknown) =>
        log({ event: 'InteractiveLiveBusPublisherError', errorType: errName(err) }),
      );
      publisher.on('ready', () =>
        log({ event: 'InteractiveLiveBusPublisherReady' }),
      );
      publisher.on('reconnecting', () =>
        log({ event: 'InteractiveLiveBusPublisherReconnecting' }),
      );
    }
    return publisher;
  };

  const ensureSubscriber = (): RedisLike | null => {
    if (!enabled || !config) return null;
    if (!subscriber) {
      subscriber = createClient('sub', config);
      subscriber.on('error', (err: unknown) =>
        log({ event: 'InteractiveLiveBusSubscriberError', errorType: errName(err) }),
      );
      subscriber.on('ready', () =>
        log({ event: 'InteractiveLiveBusSubscriberReady' }),
      );
      subscriber.on('reconnecting', () =>
        log({ event: 'InteractiveLiveBusSubscriberReconnecting' }),
      );
      subscriber.on('message', (channel: string, message: string) => {
        const subs = subscribers.get(channel);
        if (!subs || subs.size === 0) return;
        let envelope: AgentRunEventEnvelope;
        try {
          envelope = JSON.parse(message) as AgentRunEventEnvelope;
        } catch {
          return; // Ignore malformed frames — never crash a gateway socket.
        }
        for (const callback of subs) {
          try {
            callback(envelope);
          } catch {
            // A subscriber error must not disturb sibling sockets.
          }
        }
      });
    }
    return subscriber;
  };

  return {
    isEnabled: () => enabled,

    async publish(threadId, envelope): Promise<void> {
      const client = ensurePublisher();
      if (!client) return; // Disabled → durable replay is the source of truth.
      try {
        await client.publish(channelFor(threadId), JSON.stringify(envelope));
      } catch (err) {
        // Ephemeral fan-out is best effort; durability rides Postgres.
        log({ event: 'InteractiveLiveBusPublishFailed', errorType: errName(err) });
      }
    },

    subscribe(threadId, callback): () => void {
      if (!enabled) return () => {};
      const channel = channelFor(threadId);
      let subs = subscribers.get(channel);
      if (!subs) {
        subs = new Set();
        subscribers.set(channel, subs);
        const client = ensureSubscriber();
        client
          ?.subscribe(channel)
          .then(() => log({ event: 'InteractiveLiveBusSubscribed', channel }))
          .catch((err: unknown) =>
            log({ event: 'InteractiveLiveBusSubscribeFailed', errorType: errName(err) }),
          );
      }
      subs.add(callback);

      return () => {
        const current = subscribers.get(channel);
        if (!current) return;
        current.delete(callback);
        if (current.size === 0) {
          subscribers.delete(channel);
          subscriber?.unsubscribe(channel).catch(() => {});
        }
      };
    },

    async init(): Promise<void> {
      if (!enabled) return;
      ensurePublisher();
      ensureSubscriber();
    },

    async shutdown(): Promise<void> {
      const closing: Array<Promise<unknown>> = [];
      if (publisher) closing.push(publisher.quit().catch(() => {}));
      if (subscriber) closing.push(subscriber.quit().catch(() => {}));
      publisher = null;
      subscriber = null;
      subscribers.clear();
      await Promise.all(closing);
    },
  };
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}

/** Process-wide singleton used by the gateway (subscribe) and actor (publish). */
export const interactiveLiveBus: InteractiveLiveBus = createInteractiveLiveBus();

export async function initInteractiveLiveBus(): Promise<void> {
  await interactiveLiveBus.init();
}

export async function shutdownInteractiveLiveBus(): Promise<void> {
  await interactiveLiveBus.shutdown();
}
