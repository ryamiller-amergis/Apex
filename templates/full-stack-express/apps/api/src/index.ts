// The composition root. Production starts it with instrumentation first:
//   node --import ./dist/instrument.js dist/index.js
// It builds the real dependencies, starts listening, and registers graceful
// shutdown. createApp in app.ts holds the middleware order.
import type { RequestHandler } from 'express';
import { createApp } from './app.ts';
import { loadEnv } from './config/env.ts';
import { createLocalFlagEvaluator } from './feature-flags/index.ts';
import {
  createIdentityAdapter,
  IdentityConfigurationError,
  type IdentityProviderAdapter,
} from './identity/index.ts';
import { logger, telemetry } from './instrument.ts';
import { createInFlightRegistry } from './lifecycle/inFlight.ts';
import {
  createShutdown,
  registerSignalHandlers,
} from './lifecycle/shutdown.ts';
import { createRateLimit } from './middleware/rateLimit.ts';
import { createPersistence } from './persistence/index.ts';

const env = loadEnv();

// Runs before anything listens, so a bad AUTH_MODE stops the process with no
// port open.
function buildIdentityAdapter(): IdentityProviderAdapter {
  try {
    return createIdentityAdapter(env, { logger });
  } catch (error) {
    if (error instanceof IdentityConfigurationError) {
      logger.fatal(
        { event: 'auth.startup_aborted', errorName: error.name },
        error.message
      );
      process.exit(1);
    }
    throw error;
  }
}

export const identityAdapter = buildIdentityAdapter();

// The flag provider extension point: swap this adapter, not the call sites.
export const flags = createLocalFlagEvaluator({
  source: env.FEATURE_FLAGS,
  logger,
});

// The pool gives up on a connection no later than readiness does, so a
// readiness ping abandoned at its deadline frees its slot.
const persistence = createPersistence({
  databaseUrl: env.DATABASE_URL,
  connectionTimeoutMs: env.READINESS_TIMEOUT_MS,
});

const rateLimiter: RequestHandler | undefined =
  env.RATE_LIMIT_MAX === undefined
    ? undefined
    : createRateLimit({
        max: env.RATE_LIMIT_MAX,
        windowMs: env.RATE_LIMIT_WINDOW_MS,
      });

const inFlight = createInFlightRegistry();
const app = createApp({
  logger,
  identityAdapter,
  persistence,
  readinessTimeoutMs: env.READINESS_TIMEOUT_MS,
  isShuttingDown: () => lifecycle.isShuttingDown(),
  clientDistDir: env.CLIENT_DIST_DIR,
  requestTracking: inFlight.middleware,
  ...(rateLimiter ? { rateLimiter } : {}),
});

const server = app.listen(env.PORT, (error?: Error) => {
  if (error) {
    logger.fatal(
      {
        event: 'server.listen_failed',
        errorName: error.name,
        code: (error as NodeJS.ErrnoException).code,
      },
      'the API could not open its port'
    );
    process.exit(1);
  }
  logger.info({ event: 'server.listening', port: env.PORT }, 'listening');
});

const lifecycle = createShutdown({
  server,
  inFlight,
  resources: [{ name: 'database', close: () => persistence.close() }],
  telemetry,
  logger,
  exit: (code) => process.exit(code),
  timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
});
registerSignalHandlers(lifecycle);
