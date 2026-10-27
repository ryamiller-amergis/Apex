import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithRequestContext } from '../observability/requestContext.ts';
import { createInFlightRegistry, type InFlightRegistry } from './inFlight.ts';
import {
  createShutdown,
  registerSignalHandlers,
  shutdownBudget,
  type ClosableResource,
  type ClosableServer,
  type ShutdownDeps,
} from './shutdown.ts';

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
  msg: string;
}

function fakeLogger(events: string[]) {
  const entries: LogEntry[] = [];
  const write = (level: LogEntry['level']) => (fields: object, msg: string) => {
    entries.push({ level, fields: fields as Record<string, unknown>, msg });
    events.push(msg);
  };
  return {
    entries,
    logger: { info: write('info'), warn: write('warn'), error: write('error') },
  };
}

function fakeServer(registry: InFlightRegistry, events: string[]) {
  let closeCallback: (() => void) | undefined;
  const finishClose = () => {
    const callback = closeCallback;
    closeCallback = undefined;
    if (callback) {
      events.push('server.closed');
      queueMicrotask(callback);
    }
  };
  registry.onIdle(finishClose);
  const server: ClosableServer = {
    close(callback) {
      events.push('server.close');
      closeCallback = () => callback?.();
      if (registry.size() === 0) {
        finishClose();
      }
      return server;
    },
    closeIdleConnections() {
      events.push('server.closeIdleConnections');
    },
    closeAllConnections() {
      events.push('server.closeAllConnections');
      finishClose();
    },
  };
  return server;
}

class FakeResponse extends EventEmitter {
  headersSent = false;
  readonly headers = new Map<string, string>();

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  finish() {
    this.headersSent = true;
    this.emit('finish');
  }
}

function openRequest(
  registry: InFlightRegistry,
  id: string,
  route = { baseUrl: '/api/v1', path: '/me', method: 'PUT' }
): FakeResponse {
  const req = {
    method: route.method,
    baseUrl: route.baseUrl,
    route: { path: route.path },
    url: `${route.baseUrl}${route.path}?email=hidden@example.test`,
  } as unknown as Request;
  const res = new FakeResponse();
  runWithRequestContext(
    { requestId: id, correlationId: id, startedAt: Date.now() },
    req,
    () =>
      registry.middleware(
        req,
        res as unknown as Response,
        (() => {}) as NextFunction
      )
  );
  return res;
}

function setup(overrides: Partial<ShutdownDeps> = {}) {
  const events: string[] = [];
  const registry = createInFlightRegistry();
  const { logger, entries } = fakeLogger(events);
  const database: ClosableResource = {
    name: 'database',
    close: vi.fn(async () => {
      events.push('database.close');
    }),
  };
  const telemetry = {
    shutdown: vi.fn(async () => {
      events.push('telemetry.shutdown');
    }),
  };
  const exitTimes: number[] = [];
  const exit = vi.fn((code: number) => {
    exitTimes.push(Date.now());
    events.push(`exit(${code})`);
  });
  const deps: ShutdownDeps = {
    server: fakeServer(registry, events),
    inFlight: registry,
    resources: [database],
    telemetry,
    logger,
    exit,
    timeoutMs: 10000,
    ...overrides,
  };
  const lifecycle = createShutdown(deps);
  return {
    deps,
    events,
    registry,
    entries,
    database,
    telemetry,
    exit,
    exitTimes,
    lifecycle,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('shutdownBudget', () => {
  it('keeps min(5000, 20% of the limit) for cleanup', () => {
    expect(shutdownBudget(25000)).toMatchObject({
      drainMs: 20000,
      cleanupMs: 5000,
    });
    expect(shutdownBudget(10000)).toMatchObject({
      drainMs: 8000,
      cleanupMs: 2000,
    });
    expect(shutdownBudget(60000)).toMatchObject({
      drainMs: 55000,
      cleanupMs: 5000,
    });
  });
});

describe('createShutdown', () => {
  it('VT-17 PBI-015 AC-0 TBI-018 DoD-0 DoD-2 lets an in-flight request finish, then closes and exits 0', async () => {
    const { lifecycle, registry, events, entries, exit } = setup();
    const res = openRequest(registry, 'req-slow');
    setTimeout(() => res.finish(), 2000);
    expect(lifecycle.isShuttingDown()).toBe(false);
    const done = lifecycle.begin('SIGTERM');
    expect(lifecycle.isShuttingDown()).toBe(true);
    expect(res.headers.get('connection')).toBe('close');
    await vi.advanceTimersByTimeAsync(1999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBe(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(events).not.toContain('shutdown.abandoned');
    expect(events.indexOf('database.close')).toBeGreaterThan(
      events.indexOf('server.closed')
    );
    expect(events.indexOf('telemetry.shutdown')).toBeGreaterThan(
      events.indexOf('database.close')
    );
    expect(entries[0]).toMatchObject({
      msg: 'shutdown.begin',
      fields: { signal: 'SIGTERM', inFlight: 1, timeoutMs: 10000 },
    });
    expect(entries.at(-1)).toMatchObject({
      msg: 'shutdown.complete',
      fields: { forced: false, exitCode: 0, elapsedMs: 2000 },
    });
  });

  it('VT-18 PBI-015 AC-1 TBI-018 DoD-3 abandons a hung request at the deadline and exits 1 within the limit', async () => {
    const { lifecycle, registry, events, entries, exit, exitTimes } = setup();
    openRequest(registry, 'req-hung');
    vi.advanceTimersByTime(300);
    const done = lifecycle.begin('SIGTERM');
    await vi.advanceTimersByTimeAsync(10000);
    await expect(done).resolves.toBe(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(exitTimes[0]).toBeLessThanOrEqual(300 + 10000);
    expect(events).toContain('server.closeAllConnections');
    const abandoned = entries.find((e) => e.msg === 'shutdown.abandoned');
    expect(abandoned).toMatchObject({
      level: 'warn',
      fields: {
        abandonedCount: 1,
        abandoned: [
          {
            requestId: 'req-hung',
            method: 'PUT',
            route: '/api/v1/me',
            ageMs: 300 + 8000,
          },
        ],
      },
    });
    expect(JSON.stringify(entries)).not.toContain('hidden@example.test');
    expect(events.indexOf('server.closeAllConnections')).toBeLessThan(
      events.indexOf('database.close')
    );
  });

  it('VT-18 lists at most 20 abandoned requests', async () => {
    const { lifecycle, registry, entries } = setup();
    for (let index = 0; index < 25; index += 1) {
      openRequest(registry, `req-${index}`);
    }
    const done = lifecycle.begin('SIGTERM');
    await vi.advanceTimersByTimeAsync(10000);
    await done;
    const abandoned = entries.find((e) => e.msg === 'shutdown.abandoned');
    expect(abandoned?.fields.abandonedCount).toBe(25);
    expect(abandoned?.fields.abandoned).toHaveLength(20);
  });

  it('VT-19 PBI-015 AC-2 TBI-018 DoD-2 exits 0 at once when idle: server, then database, then telemetry', async () => {
    const { lifecycle, events, exit } = setup();
    await expect(lifecycle.begin('SIGINT')).resolves.toBe(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(
      events.filter((e) =>
        [
          'server.close',
          'server.closed',
          'database.close',
          'telemetry.shutdown',
          'exit(0)',
        ].includes(e)
      )
    ).toEqual([
      'server.close',
      'server.closed',
      'database.close',
      'telemetry.shutdown',
      'exit(0)',
    ]);
  });

  it('VT-20 TBI-018 NFR a hung database close is logged and the sequence still exits within the limit', async () => {
    const hung: ClosableResource = {
      name: 'database',
      close: () => new Promise(() => {}),
    };
    const { lifecycle, entries, telemetry, exit, exitTimes } = setup({
      resources: [hung],
    });
    const done = lifecycle.begin('SIGTERM');
    await vi.advanceTimersByTimeAsync(10000);
    await expect(done).resolves.toBe(0);
    expect(exitTimes[0]).toBeLessThanOrEqual(10000);
    expect(
      entries.find((e) => e.msg === 'shutdown.cleanup_failed')
    ).toMatchObject({ level: 'error', fields: { step: 'database' } });
    expect(telemetry.shutdown).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('VT-20 a rejected telemetry flush is logged and does not stop the exit', async () => {
    const { lifecycle, entries, exit } = setup({
      telemetry: {
        shutdown: () => Promise.reject(new Error('collector down')),
      },
    });
    await expect(lifecycle.begin('SIGTERM')).resolves.toBe(0);
    expect(
      entries.find((e) => e.msg === 'shutdown.cleanup_failed')
    ).toMatchObject({
      fields: {
        step: 'telemetry',
        err: expect.objectContaining({ message: 'collector down' }),
      },
    });
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('VT-20 a telemetry flush that hangs ends by the limit', async () => {
    const { lifecycle, exit, exitTimes } = setup({
      telemetry: { shutdown: () => new Promise(() => {}) },
    });
    const done = lifecycle.begin('SIGTERM');
    await vi.advanceTimersByTimeAsync(10000);
    await expect(done).resolves.toBe(0);
    expect(exit).toHaveBeenCalledOnce();
    expect(exitTimes[0]).toBeLessThanOrEqual(10000);
  });

  it('VT-21 TBI-018 a second signal skips the drain, runs bounded cleanup, and exits 1', async () => {
    const { lifecycle, registry, events, entries, exit } = setup();
    openRequest(registry, 'req-open');
    const first = lifecycle.begin('SIGTERM');
    await vi.advanceTimersByTimeAsync(100);
    const second = lifecycle.begin('SIGTERM');
    await expect(second).resolves.toBe(1);
    await expect(first).resolves.toBe(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(events).toContain('database.close');
    expect(events).toContain('telemetry.shutdown');
    expect(entries.find((e) => e.msg === 'shutdown.abandoned')).toBeDefined();
    expect(entries.at(-1)).toMatchObject({
      msg: 'shutdown.complete',
      fields: { forced: true, exitCode: 1, elapsedMs: 100 },
    });
  });

  it('PBI-015 AC-3 requests that arrive while draining get Connection: close and still run', async () => {
    const { lifecycle, registry } = setup();
    const first = openRequest(registry, 'req-first');
    expect(first.headers.get('connection')).toBeUndefined();
    const done = lifecycle.begin('SIGTERM');
    const late = openRequest(registry, 'req-late');
    expect(late.headers.get('connection')).toBe('close');
    expect(registry.size()).toBe(2);
    first.finish();
    late.finish();
    await expect(done).resolves.toBe(0);
  });

  it('flushes the logger before exit', async () => {
    const order: string[] = [];
    const { logger } = fakeLogger(order);
    const flush = vi.fn((callback?: (err?: Error) => void) => {
      order.push('flush');
      callback?.();
    });
    const exit = vi.fn(() => order.push('exit'));
    const { lifecycle } = setup({ logger: { ...logger, flush }, exit });
    await lifecycle.begin('SIGTERM');
    expect(order.slice(-2)).toEqual(['flush', 'exit']);
  });

  it('flushes the logger before a watchdog exit', async () => {
    const order: string[] = [];
    const { logger } = fakeLogger(order);
    const flush = vi.fn((callback?: (err?: Error) => void) => {
      order.push('flush');
      callback?.();
    });
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const exit = vi.fn(() => {
      order.push('exit');
      resolveExit();
    });
    let watchdog: (() => void) | undefined;
    const { lifecycle } = setup({
      logger: { ...logger, flush },
      exit,
      setTimer: (callback, ms) => {
        if (ms === 10000 && watchdog === undefined) {
          watchdog = callback;
        }
        return {};
      },
      clearTimer: () => {},
    });
    void lifecycle.begin('SIGTERM');
    expect(watchdog).toBeDefined();
    watchdog?.();
    await exited;
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(order.slice(-2)).toEqual(['flush', 'exit']);
  });

  it('flushes the logger before an unexpected-error exit', async () => {
    const order: string[] = [];
    const { logger } = fakeLogger(order);
    const flush = vi.fn((callback?: (err?: Error) => void) => {
      order.push('flush');
      callback?.();
    });
    const exit = vi.fn(() => order.push('exit'));
    const { lifecycle } = setup({
      logger: { ...logger, flush },
      exit,
      server: {
        close() {
          throw new Error('close failed');
        },
        closeIdleConnections() {},
        closeAllConnections() {},
      },
    });
    await expect(lifecycle.begin('SIGTERM')).resolves.toBe(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(order.slice(-2)).toEqual(['flush', 'exit']);
  });
});

describe('in-flight registry', () => {
  it('removes a request on finish or close and reports unmatched routes', () => {
    const registry = createInFlightRegistry();
    const finished = openRequest(registry, 'a');
    const closed = openRequest(registry, 'b');
    expect(registry.size()).toBe(2);
    finished.finish();
    closed.emit('close');
    closed.emit('finish');
    expect(registry.size()).toBe(0);
    const req = { method: 'GET', url: '/nope' } as unknown as Request;
    registry.middleware(
      req,
      new FakeResponse() as unknown as Response,
      (() => {}) as NextFunction
    );
    expect(registry.snapshot()).toMatchObject([
      { requestId: 'unknown', method: 'GET', route: '(unmatched)' },
    ]);
  });
});

describe('registerSignalHandlers', () => {
  it('TBI-018 starts shutdown on SIGTERM or SIGINT and forwards a second signal', () => {
    const target = new EventEmitter();
    const lifecycle = {
      isShuttingDown: () => false,
      begin: vi.fn(() => Promise.resolve(0)),
    };
    const unregister = registerSignalHandlers(lifecycle, target);
    expect(registerSignalHandlers(lifecycle, target)).toBe(unregister);
    target.emit('SIGTERM', 'SIGTERM');
    target.emit('SIGINT', 'SIGINT');
    expect(lifecycle.begin.mock.calls).toEqual([['SIGTERM'], ['SIGINT']]);
    unregister();
    expect(target.listenerCount('SIGTERM')).toBe(0);
    expect(target.listenerCount('SIGINT')).toBe(0);
  });
});
