import type { Express } from 'express';
import { createApp, type AppDeps } from '../../src/app.ts';
import type { Principal } from '../../src/identity/principal.ts';
import { createLogger } from '../../src/observability/logger.ts';
import {
  captureLogs,
  type LogCapture,
} from '../../src/observability/testing/captureLogs.ts';
import {
  createMemoryPersistence,
  type MemoryPersistence,
} from './memoryPersistence.ts';
import { createStaticAdapter } from './staticAdapter.ts';

// Synthetic identities. The example.test domain is reserved (RFC 2606).
export const PRINCIPAL_A: Principal = Object.freeze({
  subject: 'synthetic-subject-a-7f3q',
  displayName: 'Synthetic Person Alpha',
  email: 'person.alpha@example.test',
});

export const PRINCIPAL_B: Principal = Object.freeze({
  subject: 'synthetic-subject-b-9k2w',
  displayName: 'Synthetic Person Beta',
  email: 'person.beta@example.test',
});

export type PrincipalSource = Principal | null | (() => Principal | null);

export interface TestApp {
  app: Express;
  adapter: ReturnType<typeof createStaticAdapter>;
  persistence: MemoryPersistence;
  capture: LogCapture;
}

export interface TestAppOptions {
  /** Defaults to PRINCIPAL_A. Null means every request is unauthenticated. */
  principal?: PrincipalSource;
  persistence?: AppDeps['persistence'] & Partial<MemoryPersistence>;
  deps?: Partial<AppDeps>;
}

/** createApp with an in-memory store, a static adapter, and captured logs. */
export function buildTestApp(options: TestAppOptions = {}): TestApp {
  const capture = captureLogs();
  const logger = createLogger({ LOG_LEVEL: 'debug' }, capture.stream);
  const persistence = (options.persistence ??
    createMemoryPersistence()) as MemoryPersistence;
  const source =
    options.principal === undefined ? PRINCIPAL_A : options.principal;
  const adapter = createStaticAdapter(() =>
    Promise.resolve(typeof source === 'function' ? source() : source)
  );
  const app = createApp({
    logger,
    identityAdapter: adapter,
    persistence,
    readinessTimeoutMs: 2000,
    ...options.deps,
  });
  return { app, adapter, persistence, capture };
}

/** Lets pino's asynchronous writes and response listeners finish. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
