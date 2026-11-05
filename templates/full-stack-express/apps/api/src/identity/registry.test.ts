import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createStaticAdapter } from '../../test/support/staticAdapter.ts';
import { parseEnv } from '../config/env.ts';
import { createLogger } from '../observability/logger.ts';
import { requestId } from '../observability/requestId.ts';
import { captureLogs } from '../observability/testing/captureLogs.ts';
import type { IdentityProviderAdapter } from './adapter.ts';
import { createAuthMiddleware, getPrincipal } from './authMiddleware.ts';
import { DEVELOPMENT_PRINCIPAL } from './developmentAdapter.ts';
import {
  DevelopmentAdapterInProductionError,
  EXTERNAL_ADAPTER_NOT_REGISTERED_MESSAGE,
  ExternalAdapterNotRegisteredError,
  IdentityConfigurationError,
} from './errors.ts';
import { createIdentityAdapter } from './registry.ts';

const DATABASE_URL =
  'postgresql://app_user:local-dev-only-password@localhost:5432/project_db';

function quietLogger() {
  return createLogger({ LOG_LEVEL: 'silent' }, captureLogs().stream);
}

// The handler module a project writes. It never changes per adapter.
function buildApp(adapter: IdentityProviderAdapter) {
  const app = express();
  app.use(requestId());
  app.use(
    '/api/v1',
    createAuthMiddleware({ adapter, logger: quietLogger() }),
    express.Router().get('/probe', (_req, res) => {
      res.json({ subject: getPrincipal(res).subject });
    })
  );
  return app;
}

describe('createIdentityAdapter', () => {
  it('VT-12 PBI-009 AC-0 external mode without a registered adapter throws the named message', () => {
    const env = { AUTH_MODE: 'external', NODE_ENV: 'production' } as const;
    expect(() => createIdentityAdapter(env, { logger: quietLogger() })).toThrow(
      ExternalAdapterNotRegisteredError
    );
    expect(EXTERNAL_ADAPTER_NOT_REGISTERED_MESSAGE).toBe(
      'AUTH_MODE=external requires an adapter registered in apps/api/src/identity/registry.ts.'
    );
    expect(new ExternalAdapterNotRegisteredError()).toBeInstanceOf(
      IdentityConfigurationError
    );
  });

  it('VT-12 PBI-009 AC-0 a registered external adapter resolves the principal with no handler change', async () => {
    const provider = createStaticAdapter({ subject: 'provider-subject-1' });
    const adapter = createIdentityAdapter(
      { AUTH_MODE: 'external', NODE_ENV: 'production' },
      { logger: quietLogger(), external: () => provider }
    );
    expect(adapter).toBe(provider);
    const res = await request(buildApp(adapter)).get('/api/v1/probe');
    expect(res.status).toBe(200);
    expect(res.body.subject).toBe('provider-subject-1');
  });

  it('TBI-013 DoD-1 repeats the production check for development mode', () => {
    let thrown: unknown;
    try {
      createIdentityAdapter(
        { AUTH_MODE: 'development', NODE_ENV: 'production' },
        { logger: quietLogger() }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DevelopmentAdapterInProductionError);
    expect(thrown).toBeInstanceOf(IdentityConfigurationError);
  });

  it('never builds the development adapter in external mode', () => {
    const capture = captureLogs();
    const logger = createLogger({ LOG_LEVEL: 'debug' }, capture.stream);
    expect(() =>
      createIdentityAdapter(
        { AUTH_MODE: 'external', NODE_ENV: 'development' },
        { logger }
      )
    ).toThrow(ExternalAdapterNotRegisteredError);
    expect(capture.raw().join('\n')).not.toContain(
      'auth.development_adapter_active'
    );
  });
});

describe('development composition (VT-10)', () => {
  it('PBI-008 AC-0 TBI-013 DoD-2 runs every request as the synthetic principal with no other configuration', async () => {
    const env = parseEnv({
      NODE_ENV: 'development',
      AUTH_MODE: 'development',
      DATABASE_URL,
    });
    const adapter = createIdentityAdapter(env, { logger: quietLogger() });
    const app = buildApp(adapter);

    const bare = await request(app).get('/api/v1/probe');
    const spoofed = await request(app)
      .get('/api/v1/probe')
      .set('Authorization', 'Bearer x')
      .set('x-user', 'other');

    expect(bare.status).toBe(200);
    expect(bare.body.subject).toBe(DEVELOPMENT_PRINCIPAL.subject);
    expect(spoofed.body.subject).toBe(DEVELOPMENT_PRINCIPAL.subject);
  });
});
