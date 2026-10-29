import {
  problemContentType,
  problemDetailsSchema,
} from '@project-scope/contracts';
import express, {
  Router,
  type ErrorRequestHandler,
  type Express,
} from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createStaticAdapter } from '../../test/support/staticAdapter.ts';
import { createLogger } from '../observability/logger.ts';
import { REQUEST_ID_HEADER, requestId } from '../observability/requestId.ts';
import { requestLogging } from '../observability/requestLogging.ts';
import {
  captureLogs,
  type LogCapture,
} from '../observability/testing/captureLogs.ts';
import type { AdapterRequest, IdentityProviderAdapter } from './adapter.ts';
import {
  AUTHENTICATION_REQUIRED_DETAIL,
  createAuthMiddleware,
  getPrincipal,
  PrincipalMissingError,
} from './authMiddleware.ts';
import type { Principal } from './principal.ts';

const FIXTURE = {
  subject: 'fixture-subject-a',
  displayName: 'Fixture Person A',
  email: 'fixture.person.a@example.test',
} as const;

// One router module for every adapter. VT-07 builds two apps from it.
function createProbeRouter(seen: { handlerRuns: number }): Router {
  const router = Router();
  router.get('/probe', (_req, res) => {
    seen.handlerRuns += 1;
    const principal = getPrincipal(res);
    res.json({
      subject: principal.subject,
      displayName: principal.displayName ?? null,
      email: principal.email ?? null,
      frozen: Object.isFrozen(principal),
    });
  });
  return router;
}

const genericProblem: ErrorRequestHandler = (_err, _req, res, _next) => {
  res.status(500).type(problemContentType).json({
    type: 'urn:problem-type:internal-error',
    title: 'Unexpected server error',
    status: 500,
  });
};

function buildApp(adapter: IdentityProviderAdapter): {
  app: Express;
  capture: LogCapture;
  seen: { handlerRuns: number };
} {
  const capture = captureLogs();
  const logger = createLogger({ LOG_LEVEL: 'debug' }, capture.stream);
  const seen = { handlerRuns: 0 };
  const app = express();
  app.use(requestId());
  app.use(requestLogging(logger));
  app.get('/unguarded', (_req, res) => {
    res.json({ subject: getPrincipal(res).subject });
  });
  app.use(
    '/api/v1',
    createAuthMiddleware({ adapter, logger }),
    createProbeRouter(seen)
  );
  app.use(genericProblem);
  return { app, capture, seen };
}

function expectProblem401(res: request.Response): void {
  expect(res.status).toBe(401);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemDetailsSchema.safeParse(res.body).success).toBe(true);
  expect(res.body).toMatchObject({
    type: 'urn:problem-type:authentication-required',
    title: 'Authentication is required',
    status: 401,
    detail: AUTHENTICATION_REQUIRED_DETAIL,
  });
  const header = res.headers[REQUEST_ID_HEADER.toLowerCase()];
  expect(header).toBeTruthy();
  expect(res.body.requestId).toBe(header);
}

function rejected(capture: LogCapture): Record<string, unknown>[] {
  return capture.lines().filter((line) => line.event === 'auth.rejected');
}

describe('createAuthMiddleware', () => {
  it('VT-03 TBI-012 DoD-1 PBI-008 AC-3 returns a Problem Details 401 when no adapter authenticates', async () => {
    const { app, capture, seen } = buildApp(createStaticAdapter(null));
    const res = await request(app).get('/api/v1/probe');
    expectProblem401(res);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(seen.handlerRuns).toBe(0);
    expect(rejected(capture)).toEqual([
      expect.objectContaining({ level: 'warn', reason: 'no_principal' }),
    ]);
  });

  it('VT-03 sends the adapter challenge in WWW-Authenticate', async () => {
    const { app } = buildApp(createStaticAdapter(null, 'Cookie realm="app"'));
    const res = await request(app).get('/api/v1/probe');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Cookie realm="app"');
  });

  it('VT-03 reuses the caller request id in the 401 body', async () => {
    const { app } = buildApp(createStaticAdapter(null));
    const res = await request(app)
      .get('/api/v1/probe')
      .set('X-Request-Id', 'caller-req-1');
    expectProblem401(res);
    expect(res.body.requestId).toBe('caller-req-1');
  });

  it('VT-04 TBI-012 DoD-2 handlers read the principal only from the middleware', async () => {
    const { app } = buildApp(createStaticAdapter({ subject: FIXTURE.subject }));
    const res = await request(app)
      .get('/api/v1/probe?subject=other')
      .set('x-user', 'other')
      .set('x-subject', 'other');
    expect(res.status).toBe(200);
    expect(res.body.subject).toBe(FIXTURE.subject);
    expect(res.body.frozen).toBe(true);
  });

  it('VT-04 getPrincipal outside the middleware becomes a generic 500', async () => {
    const { app } = buildApp(createStaticAdapter({ subject: FIXTURE.subject }));
    const res = await request(app).get('/unguarded');
    expect(res.status).toBe(500);
    expect(res.body.title).toBe('Unexpected server error');
    expect(JSON.stringify(res.body)).not.toContain(FIXTURE.subject);
  });

  it('VT-04 getPrincipal throws PrincipalMissingError when no principal is set', () => {
    expect(() =>
      getPrincipal({ locals: {} } as unknown as express.Response)
    ).toThrow(PrincipalMissingError);
  });

  it('VT-05 PBI-009 AC-1 an adapter error becomes a clean 401 with clean logs', async () => {
    const adapter = createStaticAdapter(() =>
      Promise.reject(new Error(`token=abc123 subject=${FIXTURE.subject}`))
    );
    const { app, capture, seen } = buildApp(adapter);
    const res = await request(app)
      .get('/api/v1/probe')
      .set('Authorization', 'Bearer abc123');
    expectProblem401(res);
    expect(seen.handlerRuns).toBe(0);
    expect(rejected(capture)).toEqual([
      expect.objectContaining({ reason: 'adapter_error', errorName: 'Error' }),
    ]);
    const output = capture.raw().join('\n') + JSON.stringify(res.body);
    for (const secret of ['abc123', FIXTURE.subject, 'Bearer abc123']) {
      expect(output).not.toContain(secret);
    }
  });

  it('VT-05 a synchronous adapter throw also becomes a 401', async () => {
    const adapter: IdentityProviderAdapter = {
      authenticate() {
        throw new TypeError('boom');
      },
    };
    const { app, capture } = buildApp(adapter);
    const res = await request(app).get('/api/v1/probe');
    expectProblem401(res);
    expect(rejected(capture)[0]).toMatchObject({
      reason: 'adapter_error',
      errorName: 'TypeError',
    });
  });

  it('VT-06 PBI-009 AC-2 a principal with only a subject reaches the handler', async () => {
    const { app } = buildApp(createStaticAdapter({ subject: FIXTURE.subject }));
    const res = await request(app).get('/api/v1/probe');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      subject: FIXTURE.subject,
      displayName: null,
      email: null,
      frozen: true,
    });
  });

  it('VT-07 PBI-009 AC-0 the same router works under two different adapters', async () => {
    class FixtureTokenAdapter implements IdentityProviderAdapter {
      async authenticate(req: AdapterRequest): Promise<Principal | null> {
        return req.headers['x-fixture-token'] === 'token-b'
          ? { subject: 'fixture-subject-b' }
          : null;
      }
    }
    const a = buildApp(createStaticAdapter({ subject: FIXTURE.subject }));
    const b = buildApp(new FixtureTokenAdapter());

    const resA = await request(a.app).get('/api/v1/probe');
    const resB = await request(b.app)
      .get('/api/v1/probe')
      .set('x-fixture-token', 'token-b');
    const resBDenied = await request(b.app).get('/api/v1/probe');

    expect(resA.body.subject).toBe(FIXTURE.subject);
    expect(resB.body.subject).toBe('fixture-subject-b');
    expect(resBDenied.status).toBe(401);
  });

  it.each([
    [{ subject: '' }],
    [{ subject: 'x'.repeat(256) }],
    [{ displayName: FIXTURE.displayName, email: FIXTURE.email }],
  ])(
    'VT-15 PBI-009 AC-1 an invalid principal %j becomes a 401',
    async (value) => {
      const adapter = createStaticAdapter(value as unknown as Principal);
      const { app, capture, seen } = buildApp(adapter);
      const res = await request(app).get('/api/v1/probe');
      expectProblem401(res);
      expect(seen.handlerRuns).toBe(0);
      expect(rejected(capture)).toEqual([
        expect.objectContaining({ reason: 'invalid_principal' }),
      ]);
      const output = capture.raw().join('\n');
      expect(output).not.toContain(FIXTURE.displayName);
      expect(output).not.toContain(FIXTURE.email);
    }
  );

  it('logs nothing about identity on success', async () => {
    const { app, capture } = buildApp(createStaticAdapter(FIXTURE));
    const res = await request(app).get('/api/v1/probe');
    expect(res.status).toBe(200);
    const output = capture.raw().join('\n');
    for (const value of Object.values(FIXTURE)) {
      expect(output).not.toContain(value);
    }
  });
});
