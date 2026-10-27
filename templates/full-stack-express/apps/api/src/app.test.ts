import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  problemContentType,
  problemDetailsSchema,
  problemTypes,
  type ProblemDetails,
} from '@project-scope/contracts';
import request, { type Response } from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  PRINCIPAL_A,
  settle,
} from '../test/support/testApp.ts';
import { createRateLimit } from './middleware/rateLimit.ts';
import { getRequestContext } from './observability/requestContext.ts';
import { PersistenceUnavailableError } from './persistence/index.ts';

const REQUEST_ID = 'x-request-id';
// A frame from application or test code, which is where the thrown error came
// from. pino-http's own "failed with status code 500" error carries frames
// from node_modules only.
const APP_STACK_FRAME = /\bat .*[\\/](?:src|test)[\\/][^\s]*\.ts:\d+:\d+/;

function expectProblem(
  response: Response,
  status: number,
  type: string
): ProblemDetails {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toContain(problemContentType);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.type).toBe(type);
  expect(body.status).toBe(status);
  expect(body.requestId).toBe(response.headers[REQUEST_ID]);
  return body;
}

const fixtureDirs: string[] = [];

function clientFixture(withIndex = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'client-dist-'));
  fixtureDirs.push(dir);
  if (withIndex) {
    writeFileSync(
      path.join(dir, 'index.html'),
      '<!doctype html><title>client fixture</title>'
    );
  }
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("asset");');
  return dir;
}

afterAll(() => {
  for (const dir of fixtureDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('not-found handling (VT-21, TBI-014 DoD-1)', () => {
  it('TBI-014 DoD-1 returns Problem Details 404 for unknown API and non-API paths', async () => {
    const { app } = buildTestApp();
    for (const target of ['/api/v1/unknown', '/unknown', '/health/unknown']) {
      const response = await request(app).get(target);
      const body = expectProblem(response, 404, problemTypes.notFound);
      expect(body.title).toBe('Not found');
    }
  });
});

describe('unhandled errors (VT-22, TBI-014 DoD-1 and NFR)', () => {
  it('TBI-014 DoD-1 NFR returns a fixed 500 body and logs no message, identity value, or stack', async () => {
    const leaked = 'leak.marker.8h1@example.test';
    const { app, persistence, capture } = buildTestApp();
    persistence.override('findBySubject', () => {
      throw new Error(`lookup failed for ${leaked}`);
    });
    const response = await request(app).get('/api/v1/me');
    await settle();
    const body = expectProblem(response, 500, problemTypes.internalError);
    expect(body).toEqual({
      type: problemTypes.internalError,
      title: 'Unexpected server error',
      status: 500,
      detail: 'The server could not complete the request.',
      requestId: response.headers[REQUEST_ID],
    });
    const text = `${JSON.stringify(response.body)}\n${capture.raw().join('\n')}`;
    expect(text).not.toContain(leaked);
    expect(text).not.toContain('lookup failed');
    expect(text).not.toMatch(APP_STACK_FRAME);
    const failed = capture
      .lines()
      .filter((line) => line.event === 'request.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      level: 'error',
      errorName: 'Error',
      requestId: response.headers[REQUEST_ID],
    });
  });
});

describe('request ID on every response (VT-23, TBI-014 DoD-0)', () => {
  it('TBI-014 DoD-0 sets X-Request-Id on 200, 400, 401, 404, 413, 500, 503, and both probes', async () => {
    const { app, persistence } = buildTestApp();
    const unauthenticated = buildTestApp({ principal: null }).app;
    const failing = buildTestApp();
    failing.persistence.override('findBySubject', () => {
      throw new Error('boom');
    });
    const unavailable = buildTestApp();
    unavailable.persistence.override('findBySubject', () => {
      throw new PersistenceUnavailableError();
    });

    const cases: [Promise<Response>, number][] = [
      [request(app).get('/api/v1/me'), 200],
      [request(app).put('/api/v1/me').send({ displayName: '' }), 400],
      [request(unauthenticated).get('/api/v1/me'), 401],
      [request(app).get('/nothing-here'), 404],
      [
        request(app)
          .put('/api/v1/me')
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ displayName: 'x'.repeat(20 * 1024) })),
        413,
      ],
      [request(failing.app).get('/api/v1/me'), 500],
      [request(unavailable.app).get('/api/v1/me'), 503],
      [request(app).get('/health/live'), 200],
      [request(app).get('/health/ready'), 200],
    ];
    for (const [pending, status] of cases) {
      const response = await pending;
      expect(response.status).toBe(status);
      const id = response.headers[REQUEST_ID];
      expect(id, `status ${status}`).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
      if (status >= 400) {
        expect(problemDetailsSchema.parse(response.body).requestId).toBe(id);
      }
    }
    expect(persistence.rowCount()).toBe(1);
  });
});

describe('middleware order (VT-24, TBI-014 DoD-4)', () => {
  it('TBI-014 DoD-4 runs request ID, then authenticate, then the handler', async () => {
    const order: string[] = [];
    let idSeenByAdapter: string | undefined;
    const { app, adapter, persistence } = buildTestApp({
      principal: () => {
        order.push('authenticate');
        idSeenByAdapter = getRequestContext()?.requestId;
        return PRINCIPAL_A;
      },
    });
    const realFind = persistence.users.findBySubject;
    persistence.users.findBySubject = (subject) => {
      order.push('handler');
      return realFind(subject);
    };
    const response = await request(app).get('/api/v1/me').expect(200);
    expect(order.slice(0, 2)).toEqual(['authenticate', 'handler']);
    expect(idSeenByAdapter).toBe(response.headers[REQUEST_ID]);

    const before = adapter.calls;
    await request(app).get('/health/ready').expect(200);
    await request(app).get('/health/live').expect(200);
    expect(adapter.calls).toBe(before);
  });

  it('TBI-014 DoD-4 a 401 carries a request ID and the handler never runs', async () => {
    const { app, persistence } = buildTestApp({ principal: null });
    const response = await request(app).get('/api/v1/me');
    expectProblem(response, 401, problemTypes.authenticationRequired);
    expect(persistence.calls).toEqual([]);
  });

  it('TBI-014 sends Cache-Control: no-store on the API and probes', async () => {
    const { app } = buildTestApp();
    for (const target of ['/api/v1/me', '/health/live', '/health/ready']) {
      const response = await request(app).get(target).expect(200);
      expect(response.headers['cache-control'], target).toBe('no-store');
    }
    const unauthenticated = buildTestApp({ principal: null }).app;
    const rejected = await request(unauthenticated).get('/api/v1/me');
    expect(rejected.headers['cache-control']).toBe('no-store');
  });
});

describe('rate-limit hook (VT-25, TBI-014 DoD-2)', () => {
  it('TBI-014 DoD-2 limits /api when configured and never limits the probes', async () => {
    const { app } = buildTestApp({
      deps: { rateLimiter: createRateLimit({ max: 2, windowMs: 60000 }) },
    });
    await request(app).get('/api/v1/me').expect(200);
    await request(app).get('/api/v1/me').expect(200);
    const limited = await request(app).get('/api/v1/me');
    const body = expectProblem(limited, 429, problemTypes.rateLimited);
    expect(body.title).toBe('Too many requests');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    for (let i = 0; i < 3; i += 1) {
      await request(app).get('/health/live').expect(200);
      await request(app).get('/health/ready').expect(200);
    }
  });

  it('TBI-014 DoD-2 limits nothing when no limiter is configured', async () => {
    const { app } = buildTestApp();
    for (let i = 0; i < 3; i += 1) {
      await request(app).get('/api/v1/me').expect(200);
    }
  });

  it('TBI-014 DoD-2 starts a new window after windowMs', async () => {
    let now = 0;
    const limiter = createRateLimit({ max: 1, windowMs: 1000, now: () => now });
    const { app } = buildTestApp({ deps: { rateLimiter: limiter } });
    await request(app).get('/api/v1/me').expect(200);
    await request(app).get('/api/v1/me').expect(429);
    now = 1000;
    await request(app).get('/api/v1/me').expect(200);
  });
});

describe('built client serving (VT-26, TBI-014 DoD-3)', () => {
  it('TBI-014 DoD-3 serves index.html for non-API paths and Problem Details for API paths', async () => {
    const { app } = buildTestApp({
      deps: { clientDistDir: clientFixture() },
    });
    for (const target of ['/', '/profile', '/profile/details/edit']) {
      const response = await request(app).get(target).expect(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.text).toContain('client fixture');
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers[REQUEST_ID]).toBeDefined();
    }
    const asset = await request(app).get('/assets/app.js').expect(200);
    expect(asset.headers['content-type']).toContain('javascript');
    expectProblem(
      await request(app).get('/api/v1/unknown'),
      404,
      problemTypes.notFound
    );
    expectProblem(
      await request(app).post('/profile'),
      404,
      problemTypes.notFound
    );
  });

  it('TBI-014 DoD-3 serves no client when the directory is unset or has no index.html', async () => {
    for (const clientDistDir of [undefined, clientFixture(false)]) {
      const { app } = buildTestApp({ deps: { clientDistDir } });
      expectProblem(await request(app).get('/'), 404, problemTypes.notFound);
    }
  });
});

describe('body errors (VT-27, TBI-014 DoD-4, PBI-011 AC-1)', () => {
  it('TBI-014 DoD-4 returns Problem Details 400 for malformed JSON', async () => {
    const { app, persistence } = buildTestApp();
    const response = await request(app)
      .put('/api/v1/me')
      .set('Content-Type', 'application/json')
      .send('{"displayName": "Ada"');
    const body = expectProblem(response, 400, problemTypes.malformedBody);
    expect(body.title).toBe('The request body is malformed');
    expect(response.text).not.toContain('<html');
    expect(persistence.calls).toEqual([]);
  });

  it('TBI-014 DoD-4 returns Problem Details 413 for a body over 16 KB', async () => {
    const { app } = buildTestApp();
    const response = await request(app)
      .put('/api/v1/me')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ displayName: 'x'.repeat(20 * 1024) }));
    expectProblem(response, 413, problemTypes.payloadTooLarge);
    expect(response.text).not.toContain('<html');
  });
});
