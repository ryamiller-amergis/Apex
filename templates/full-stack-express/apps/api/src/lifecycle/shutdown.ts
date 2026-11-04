import type { InFlightTracker } from './inFlight.ts';

export interface ClosableServer {
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections(): void;
  closeAllConnections(): void;
}

/**
 * Something that must close after the server stops taking requests, such as
 * the database pool. `name` becomes the `step` field of shutdown.cleanup_failed.
 */
export interface ClosableResource {
  name: string;
  close(): Promise<void>;
}

export interface ShutdownLogger {
  info(fields: object, msg: string): void;
  warn(fields: object, msg: string): void;
  error(fields: object, msg: string): void;
  flush?(callback?: (err?: Error) => void): void;
}

export interface ShutdownDeps {
  server: ClosableServer;
  inFlight: InFlightTracker;
  /** Closed in order, after the server and before telemetry. */
  resources?: readonly ClosableResource[];
  telemetry: { shutdown(): Promise<void> };
  logger: ShutdownLogger;
  exit: (code: number) => void;
  /** SHUTDOWN_TIMEOUT_MS: the whole sequence ends within this limit. */
  timeoutMs: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

export interface Lifecycle {
  /** Readiness reports not ready while this is true. */
  isShuttingDown(): boolean;
  /** First call starts the shutdown; a second call ends the drain at once. */
  begin(signal: string): Promise<number>;
}

const MAX_CLEANUP_MS = 5000;
const MAX_FLUSH_RESERVE_MS = 250;
const MAX_ABANDONED_LISTED = 20;

export function shutdownBudget(timeoutMs: number): {
  drainMs: number;
  cleanupMs: number;
  flushReserveMs: number;
} {
  const cleanupMs = Math.min(MAX_CLEANUP_MS, Math.floor(timeoutMs * 0.2));
  return {
    drainMs: timeoutMs - cleanupMs,
    cleanupMs,
    flushReserveMs: Math.min(
      MAX_FLUSH_RESERVE_MS,
      Math.floor(timeoutMs * 0.05)
    ),
  };
}

class ShutdownStepTimeoutError extends Error {
  constructor(step: string) {
    super(`${step} did not finish before the shutdown deadline`);
    this.name = 'ShutdownStepTimeoutError';
  }
}

type RaceResult<T> = { done: true; value: T } | { done: false };

export function createShutdown(deps: ShutdownDeps): Lifecycle {
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer =
    deps.clearTimer ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = deps.now ?? Date.now;
  const { logger, server, inFlight, telemetry } = deps;
  const resources = deps.resources ?? [];
  const budget = shutdownBudget(deps.timeoutMs);

  let running: Promise<number> | undefined;
  let secondSignal = false;
  let endDrainNow: (() => void) | undefined;
  let exited = false;

  const exitOnce = (code: number) => {
    if (!exited) {
      exited = true;
      deps.exit(code);
    }
  };

  function raceUntil<T>(
    work: Promise<T>,
    deadline: number
  ): Promise<RaceResult<T>> {
    return new Promise((resolve, reject) => {
      const timer = setTimer(
        () => resolve({ done: false }),
        Math.max(0, deadline - now())
      );
      work.then(
        (value) => {
          clearTimer(timer);
          resolve({ done: true, value });
        },
        (error: unknown) => {
          clearTimer(timer);
          reject(error);
        }
      );
    });
  }

  async function runStep(
    step: string,
    action: () => Promise<void>,
    deadline: number
  ): Promise<void> {
    try {
      const result = await raceUntil(Promise.resolve().then(action), deadline);
      if (!result.done) {
        throw new ShutdownStepTimeoutError(step);
      }
    } catch (err) {
      logger.error({ step, err }, 'shutdown.cleanup_failed');
    }
  }

  async function flushLogger(): Promise<void> {
    const flush = logger.flush?.bind(logger);
    if (!flush) {
      return;
    }
    await raceUntil(
      new Promise<void>((resolve) => flush(() => resolve())),
      now() + budget.flushReserveMs
    ).catch(() => undefined);
  }

  async function run(signal: string): Promise<number> {
    const startedAt = now();
    const hardDeadline = startedAt + deps.timeoutMs;
    const watchdog = setTimer(() => {
      logger.error(
        { forced: true, elapsedMs: now() - startedAt, exitCode: 1 },
        'shutdown.complete'
      );
      exitOnce(1);
    }, deps.timeoutMs);

    logger.info(
      { signal, inFlight: inFlight.size(), timeoutMs: deps.timeoutMs },
      'shutdown.begin'
    );
    inFlight.markDraining();
    const serverClosed = new Promise<boolean>((resolve) => {
      server.close(() => resolve(true));
    });
    server.closeIdleConnections();
    const stopIdleWatch = inFlight.onIdle(() => server.closeIdleConnections());
    const drainEnded = new Promise<boolean>((resolve) => {
      endDrainNow = () => resolve(false);
    });

    const drain = await raceUntil(
      Promise.race([serverClosed, drainEnded]),
      startedAt + budget.drainMs
    );
    stopIdleWatch();

    let abandoned = false;
    if (!drain.done || !drain.value) {
      const open = inFlight.snapshot();
      if (open.length > 0) {
        abandoned = true;
        logger.warn(
          {
            abandonedCount: open.length,
            abandoned: open.slice(0, MAX_ABANDONED_LISTED),
          },
          'shutdown.abandoned'
        );
      }
      server.closeAllConnections();
    }

    const telemetryDeadline = hardDeadline - budget.flushReserveMs;
    const resourceDeadline =
      telemetryDeadline - Math.floor(budget.cleanupMs / 2);
    for (const resource of resources) {
      await runStep(resource.name, () => resource.close(), resourceDeadline);
    }
    await runStep('telemetry', () => telemetry.shutdown(), telemetryDeadline);

    const forced = abandoned || secondSignal;
    const exitCode = forced ? 1 : 0;
    logger.info(
      { forced, elapsedMs: now() - startedAt, exitCode },
      'shutdown.complete'
    );
    await flushLogger();
    clearTimer(watchdog);
    exitOnce(exitCode);
    return exitCode;
  }

  return {
    isShuttingDown: () => running !== undefined,
    begin(signal) {
      if (running) {
        secondSignal = true;
        endDrainNow?.();
        return running;
      }
      running = run(signal).catch((err: unknown) => {
        logger.error({ step: 'shutdown', err }, 'shutdown.cleanup_failed');
        exitOnce(1);
        return 1;
      });
      return running;
    },
  };
}

export interface SignalTarget {
  on(event: 'SIGTERM' | 'SIGINT', listener: (signal: string) => void): unknown;
  off(event: 'SIGTERM' | 'SIGINT', listener: (signal: string) => void): unknown;
}

const registered = new WeakMap<SignalTarget, () => void>();

/**
 * Registers SIGTERM and SIGINT once per process. Every signal goes to
 * lifecycle.begin, so a second signal during shutdown ends the drain.
 * Returns a function that removes the handlers.
 */
export function registerSignalHandlers(
  lifecycle: Lifecycle,
  target: SignalTarget = process
): () => void {
  const existing = registered.get(target);
  if (existing) {
    return existing;
  }
  const onSignal = (signal: string) => {
    void lifecycle.begin(signal);
  };
  target.on('SIGTERM', onSignal);
  target.on('SIGINT', onSignal);
  const unregister = () => {
    target.off('SIGTERM', onSignal);
    target.off('SIGINT', onSignal);
    registered.delete(target);
  };
  registered.set(target, unregister);
  return unregister;
}
