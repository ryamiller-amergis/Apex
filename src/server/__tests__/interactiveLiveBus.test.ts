/**
 * FEAT-007 — interactive live bus (Redis pub/sub) contract.
 *
 * Verifies:
 *  - publish → subscribe round-trip delivers the exact envelope
 *  - graceful no-op when Redis is unconfigured (no client constructed)
 *  - multiple subscribers on a thread each receive; unsubscribe is precise
 *  - malformed frames never crash a socket
 *  - env resolution (REDIS_URL and REDIS_HOST/PORT/KEY)
 */
import {
  createInteractiveLiveBus,
  resolveRedisConfig,
  type RedisLike,
  type ResolvedRedisConfig,
} from '../services/interactiveLiveBus';
import type { AgentRunEventEnvelope } from '../../shared/types/chat';

function envelope(
  eventId: string,
  overrides: Partial<AgentRunEventEnvelope> = {},
): AgentRunEventEnvelope {
  return {
    eventId,
    threadId: 't1',
    runId: 'run-1',
    sourceInstance: 'ai-runs-interactive-actor',
    sequence: 1,
    timestamp: '2026-08-07T00:00:00.000Z',
    type: 'token',
    phase: 'implementation',
    status: 'running',
    event: { type: 'token', text: `tok-${eventId}` },
    ...overrides,
  };
}

/** In-memory Redis pub/sub shared across a pub client and a sub client. */
class FakeRedisHub {
  private readonly channels = new Map<string, Set<FakeRedis>>();

  register(channel: string, client: FakeRedis): void {
    let subs = this.channels.get(channel);
    if (!subs) {
      subs = new Set();
      this.channels.set(channel, subs);
    }
    subs.add(client);
  }

  unregister(channel: string, client: FakeRedis): void {
    this.channels.get(channel)?.delete(client);
  }

  emit(channel: string, message: string): number {
    const subs = this.channels.get(channel);
    if (!subs) return 0;
    for (const client of subs) client.deliver(channel, message);
    return subs.size;
  }
}

class FakeRedis implements RedisLike {
  readonly subscribed = new Set<string>();
  private messageListener: ((channel: string, message: string) => void) | null =
    null;

  constructor(
    private readonly hub: FakeRedisHub,
    readonly role: 'pub' | 'sub',
  ) {}

  async publish(channel: string, message: string): Promise<number> {
    return this.hub.emit(channel, message);
  }

  async subscribe(...channels: string[]): Promise<number> {
    for (const channel of channels) {
      this.subscribed.add(channel);
      this.hub.register(channel, this);
    }
    return this.subscribed.size;
  }

  async unsubscribe(...channels: string[]): Promise<number> {
    for (const channel of channels) {
      this.subscribed.delete(channel);
      this.hub.unregister(channel, this);
    }
    return this.subscribed.size;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    if (event === 'message') {
      this.messageListener = listener as (c: string, m: string) => void;
    }
    return this;
  }

  deliver(channel: string, message: string): void {
    this.messageListener?.(channel, message);
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }
}

function makeBus(config: ResolvedRedisConfig | null = { host: 'h', port: 6380, password: 'k', tls: true }) {
  const hub = new FakeRedisHub();
  const created: FakeRedis[] = [];
  const bus = createInteractiveLiveBus({
    config,
    createClient: (role) => {
      const client = new FakeRedis(hub, role);
      created.push(client);
      return client;
    },
    logger: () => {},
  });
  return { bus, created };
}

describe('interactiveLiveBus', () => {
  it('delivers a published envelope to a thread subscriber (round-trip)', async () => {
    const { bus } = makeBus();
    const received: AgentRunEventEnvelope[] = [];
    const unsub = bus.subscribe('t1', (env) => received.push(env));

    await bus.publish('t1', envelope('e1'));

    expect(received).toHaveLength(1);
    expect(received[0].eventId).toBe('e1');
    expect(received[0].event).toEqual({ type: 'token', text: 'tok-e1' });
    unsub();
  });

  it('scopes delivery by threadId (no cross-thread leakage)', async () => {
    const { bus } = makeBus();
    const t1: string[] = [];
    const t2: string[] = [];
    bus.subscribe('t1', (env) => t1.push(env.eventId));
    bus.subscribe('t2', (env) => t2.push(env.eventId));

    await bus.publish('t1', envelope('a', { threadId: 't1' }));
    await bus.publish('t2', envelope('b', { threadId: 't2' }));

    expect(t1).toEqual(['a']);
    expect(t2).toEqual(['b']);
  });

  it('fans out to multiple subscribers on the same thread', async () => {
    const { bus, created } = makeBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe('t1', (env) => a.push(env.eventId));
    bus.subscribe('t1', (env) => b.push(env.eventId));

    await bus.publish('t1', envelope('x'));

    expect(a).toEqual(['x']);
    expect(b).toEqual(['x']);
    // One subscriber connection is shared and the channel subscribed once.
    const sub = created.find((c) => c.role === 'sub')!;
    expect([...sub.subscribed]).toEqual(['apex:interactive:live:t1']);
  });

  it('unsubscribe is precise and leaves the channel for remaining callbacks', async () => {
    const { bus, created } = makeBus();
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = bus.subscribe('t1', (env) => a.push(env.eventId));
    bus.subscribe('t1', (env) => b.push(env.eventId));

    unsubA();
    await bus.publish('t1', envelope('y'));

    expect(a).toEqual([]);
    expect(b).toEqual(['y']);
    const sub = created.find((c) => c.role === 'sub')!;
    expect(sub.subscribed.has('apex:interactive:live:t1')).toBe(true);
  });

  it('unsubscribes the channel once the last subscriber leaves', async () => {
    const { bus, created } = makeBus();
    const unsub = bus.subscribe('t1', () => {});
    unsub();
    // Let the async unsubscribe settle.
    await Promise.resolve();
    const sub = created.find((c) => c.role === 'sub')!;
    expect(sub.subscribed.has('apex:interactive:live:t1')).toBe(false);
  });

  it('ignores malformed frames without throwing', async () => {
    const { bus, created } = makeBus();
    const received: AgentRunEventEnvelope[] = [];
    bus.subscribe('t1', (env) => received.push(env));

    const sub = created.find((c) => c.role === 'sub')!;
    expect(() => sub.deliver('apex:interactive:live:t1', 'not-json{')).not.toThrow();
    expect(received).toHaveLength(0);
  });

  it('is a graceful no-op when Redis is unconfigured', async () => {
    const created: unknown[] = [];
    const bus = createInteractiveLiveBus({
      config: null,
      createClient: () => {
        created.push({});
        throw new Error('should not construct a client when disabled');
      },
      logger: () => {},
    });

    expect(bus.isEnabled()).toBe(false);
    const received: AgentRunEventEnvelope[] = [];
    const unsub = bus.subscribe('t1', (env) => received.push(env));
    await expect(bus.publish('t1', envelope('e1'))).resolves.toBeUndefined();
    expect(received).toEqual([]);
    expect(created).toEqual([]);
    expect(() => unsub()).not.toThrow();
  });
});

describe('resolveRedisConfig', () => {
  it('prefers REDIS_URL and detects TLS from the rediss scheme', () => {
    expect(resolveRedisConfig({ REDIS_URL: 'rediss://x:6380' } as NodeJS.ProcessEnv))
      .toEqual({ url: 'rediss://x:6380', tls: true });
    expect(resolveRedisConfig({ REDIS_URL: 'redis://x:6379' } as NodeJS.ProcessEnv))
      .toEqual({ url: 'redis://x:6379', tls: false });
  });

  it('builds a TLS config from REDIS_HOST/REDIS_SSL_PORT/REDIS_KEY', () => {
    expect(
      resolveRedisConfig({
        REDIS_HOST: 'redis-apex-ai-dev.redis.cache.windows.net',
        REDIS_SSL_PORT: '6380',
        REDIS_KEY: 'secret',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      host: 'redis-apex-ai-dev.redis.cache.windows.net',
      port: 6380,
      password: 'secret',
      tls: true,
    });
  });

  it('returns null when neither URL nor host+key are present', () => {
    expect(resolveRedisConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveRedisConfig({ REDIS_HOST: 'h' } as NodeJS.ProcessEnv)).toBeNull();
  });
});
