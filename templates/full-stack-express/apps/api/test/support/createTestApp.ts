import type { Express } from 'express';
import { createApp } from '../../src/app.ts';
import type { IdentityProviderAdapter } from '../../src/identity/adapter.ts';
import { createLogger } from '../../src/observability/logger.ts';
import { captureLogs } from '../../src/observability/testing/captureLogs.ts';
import type { AppUserStore } from '../../src/persistence/index.ts';
import {
  createMemoryPersistence,
  type MemoryPersistence,
} from './memoryPersistence.ts';
import { createTestIdentityAdapter } from './testIdentityAdapter.ts';

export interface TestAppHarness {
  app: Express;
  persistence: MemoryPersistence;
  adapter: ReturnType<typeof createTestIdentityAdapter>;
}

export interface CreateTestAppOptions {
  users?: AppUserStore;
  ping?: () => Promise<void>;
  adapter?: IdentityProviderAdapter;
}

/** Real Express app with an injected store and the test identity adapter. */
export function createTestApp(
  options: CreateTestAppOptions = {}
): TestAppHarness {
  const capture = captureLogs();
  const logger = createLogger({ LOG_LEVEL: 'silent' }, capture.stream);
  const memory = createMemoryPersistence();
  const users = options.users ?? memory.users;
  const ping = options.ping ?? memory.ping;
  const adapter = options.adapter ?? createTestIdentityAdapter();
  const app = createApp({
    logger,
    identityAdapter: adapter,
    persistence: { users, ping },
    readinessTimeoutMs: 500,
  });
  return {
    app,
    persistence: memory,
    adapter: adapter as ReturnType<typeof createTestIdentityAdapter>,
  };
}
