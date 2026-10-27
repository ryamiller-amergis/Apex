import express, { type Express, type RequestHandler } from 'express';
import type { IdentityProviderAdapter } from './identity/adapter.ts';
import { createAuthMiddleware } from './identity/index.ts';
import { createClientStatic } from './middleware/clientStatic.ts';
import { errorHandler } from './middleware/errorHandler.ts';
import { noStore } from './middleware/noStore.ts';
import { notFound } from './middleware/notFound.ts';
import type { Logger } from './observability/logger.ts';
import { requestId } from './observability/requestId.ts';
import { requestLogging } from './observability/requestLogging.ts';
import type { Persistence } from './persistence/index.ts';
import { createHealthRouter } from './routes/health.ts';
import { mountedAt } from './routes/inventory.ts';
import { API_V1_PREFIX, createMeRouter } from './routes/me.ts';
import { createProfileService } from './services/profileService.ts';
import { createReadinessService } from './services/readinessService.ts';

export const JSON_BODY_LIMIT = '16kb';

export interface AppDeps {
  logger: Logger;
  identityAdapter: IdentityProviderAdapter;
  persistence: Pick<Persistence, 'users' | 'ping'>;
  /** READINESS_TIMEOUT_MS. */
  readinessTimeoutMs: number;
  /** Readiness reports not ready once this returns true. */
  isShuttingDown?: () => boolean;
  /**
   * The rate-limit hook for /api. Omit for no limit. Health probes never pass
   * through it. createRateLimit() builds the default from RATE_LIMIT_*.
   */
  rateLimiter?: RequestHandler;
  /** CLIENT_DIST_DIR. Served only when it holds an index.html. */
  clientDistDir?: string | undefined;
  /** Mounted right after request logging, such as the in-flight tracker. */
  requestTracking?: RequestHandler;
}

/**
 * Builds the HTTP app without listening, so tests pass fakes. Order matters:
 * the request ID comes first so every response, a 401 included, carries one;
 * probes come before authentication and the rate-limit hook; unknown /api and
 * /health paths get a Problem Details 404 before the web client fallback can
 * answer with index.html.
 */
export function createApp(deps: AppDeps): Express {
  const { logger } = deps;
  const app = express();
  app.disable('x-powered-by');

  app.use(requestId());
  app.use(requestLogging(logger));
  if (deps.requestTracking) {
    app.use(deps.requestTracking);
  }

  const readiness = createReadinessService({
    ping: () => deps.persistence.ping(),
    timeoutMs: deps.readinessTimeoutMs,
    ...(deps.isShuttingDown ? { isShuttingDown: deps.isShuttingDown } : {}),
  });
  app.use('/health', noStore());
  app.use(createHealthRouter({ readiness }));

  if (deps.rateLimiter) {
    app.use('/api', deps.rateLimiter);
  }

  const profiles = createProfileService({
    users: deps.persistence.users,
    onProfileCreated: () => logger.info({ event: 'profile.created' }, 'profile created'),
  });
  app.use(
    API_V1_PREFIX,
    noStore(),
    express.json({ limit: JSON_BODY_LIMIT }),
    createAuthMiddleware({ adapter: deps.identityAdapter, logger }),
    createMeRouter({ profiles })
  );

  app.use(['/api', '/health'], notFound());

  const client = createClientStatic(deps.clientDistDir);
  if (client) {
    app.use(mountedAt(client, null));
  }

  app.use(notFound());
  app.use(errorHandler(logger));
  return app;
}
