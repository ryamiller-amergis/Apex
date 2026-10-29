import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
} from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorLogging } from './errorLogging.ts';
import { createLogger, type Logger } from './logger.ts';
import { requestId, REQUEST_ID_HEADER } from './requestId.ts';
import { requestLogging } from './requestLogging.ts';
import { captureLogs, type LogCapture } from './testing/captureLogs.ts';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Synthetic identity markers in the shape of the seed fixtures (TBI-008).
const MARKERS = {
  displayName: 'Seed Marker Person 7Q2',
  email: 'seed.marker.7q2@example.test',
  subject: 'seed-subject-7q2-marker',
};

function createDataAccessStub(logger: Logger) {
  return {
    findProfile(subject: string) {
      logger.info({ table: 'app_users' }, 'data access query');
      return { subject, displayName: MARKERS.displayName };
    },
  };
}

function wrappedDatabaseError(): Error {
  const cause = Object.assign(
    new Error(`duplicate key ${MARKERS.email} ${MARKERS.displayName}`),
    {
      code: '23505',
      detail: `Key (email)=(${MARKERS.email}) already exists.`,
      where: `subject ${MARKERS.subject}`,
      parameters: [MARKERS.displayName, MARKERS.email],
    }
  );
  return Object.assign(new Error('profile update failed', { cause }), {
    detail: `display_name=${MARKERS.displayName}`,
  });
}

const problemDetails: ErrorRequestHandler = (_err, _req, res, _next) => {
  res.status(500).json({ title: 'Internal Server Error', status: 500 });
};

function buildApp(): { app: Express; capture: LogCapture } {
  const capture = captureLogs();
  const logger = createLogger({ LOG_LEVEL: 'debug' }, capture.stream);
  const dataAccess = createDataAccessStub(logger);
  const app = express();
  app.use(requestId());
  app.use(requestLogging(logger));
  app.use(express.json());
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/items', (_req, res) => {
    logger.info('handler start');
    dataAccess.findProfile('subject');
    res.json({ ok: true });
  });
  app.post('/fail', () => {
    throw new Error('unhandled failure');
  });
  app.put('/api/v1/me', (req: Request, res) => {
    const body = req.body as Record<string, string>;
    logger.info(
      { displayName: body.displayName, email: body.email },
      'profile update started'
    );
    dataAccess.findProfile(body.subject ?? '');
    res.json({ displayName: body.displayName, email: body.email });
  });
  app.put('/api/v1/me/fail', async () => {
    await Promise.resolve();
    throw wrappedDatabaseError();
  });
  app.use(errorLogging(logger));
  app.use(problemDetails);
  return { app, capture };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function expectNoMarkers(capture: LogCapture): void {
  const text = capture.raw().join('\n');
  for (const value of Object.values(MARKERS)) {
    expect(text).not.toContain(value);
  }
}

describe('request ID and request logging', () => {
  it('VT-03 PBI-013 AC-0 TBI-016 DoD-0 puts one generated ID on the response and on every log line', async () => {
    const { app, capture } = buildApp();
    const response = await request(app).get('/items').expect(200);
    await settle();
    const id = response.headers[REQUEST_ID_HEADER.toLowerCase()];
    expect(id).toMatch(UUID);
    const lines = capture.lines();
    expect(lines.map((line) => line.msg)).toEqual([
      'handler start',
      'data access query',
      'request completed',
    ]);
    for (const line of lines) {
      expect(line.requestId).toBe(id);
      expect(line.correlationId).toBe(id);
    }
    const completed = lines.at(-1);
    expect(completed).toMatchObject({
      level: 'info',
      req: { method: 'GET', path: '/items' },
      res: { statusCode: 200 },
      durationMs: expect.any(Number),
    });
  });

  it('VT-03 keeps each request on its own ID when requests overlap', async () => {
    const { app, capture } = buildApp();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => request(app).get('/items'))
    );
    await settle();
    const ids = new Set(
      responses.map((r) => r.headers[REQUEST_ID_HEADER.toLowerCase()])
    );
    expect(ids.size).toBe(5);
    const lines = capture.lines();
    for (const id of ids) {
      expect(lines.filter((line) => line.requestId === id)).toHaveLength(3);
    }
  });

  it('VT-03 logs probe paths at debug and drops the query string', async () => {
    const { app, capture } = buildApp();
    await request(app).get('/health/live?email=x').expect(200);
    await settle();
    expect(capture.lines().at(-1)).toMatchObject({
      level: 'debug',
      msg: 'request completed',
      req: { path: '/health/live' },
    });
    expect(capture.raw().join('')).not.toContain('email=x');
  });

  it('VT-04 PBI-013 AC-1 logs an unhandled error with the request ID and without the body', async () => {
    const { app, capture } = buildApp();
    const response = await request(app)
      .post('/fail')
      .send({ displayName: MARKERS.displayName, email: MARKERS.email })
      .expect(500);
    await settle();
    const id = response.headers[REQUEST_ID_HEADER.toLowerCase()];
    expect(id).toMatch(UUID);
    const failed = capture
      .lines()
      .find((line) => line.msg === 'request failed');
    expect(failed).toMatchObject({
      level: 'error',
      requestId: id,
      err: { type: 'Error', message: 'unhandled failure' },
    });
    expect(failed).not.toHaveProperty('body');
    expect(failed).not.toHaveProperty('req');
    const completed = capture.lines().at(-1);
    expect(completed).toMatchObject({
      level: 'error',
      msg: 'request completed',
      requestId: id,
      res: { statusCode: 500 },
    });
    expectNoMarkers(capture);
  });

  it('VT-05 PBI-013 AC-2 reuses a valid caller request ID', async () => {
    const { app, capture } = buildApp();
    const response = await request(app)
      .get('/items')
      .set(REQUEST_ID_HEADER, 'abc-123_DEF.456')
      .expect(200);
    await settle();
    expect(response.headers[REQUEST_ID_HEADER.toLowerCase()]).toBe(
      'abc-123_DEF.456'
    );
    for (const line of capture.lines()) {
      expect(line.requestId).toBe('abc-123_DEF.456');
    }
  });

  it.each(['has space', '<script>', 'naïve-ünïcode', ''])(
    'VT-06 PBI-013 AC-2 replaces a malformed request ID %j',
    async (sent) => {
      const { app, capture } = buildApp();
      const response = await request(app)
        .get('/items')
        .set(REQUEST_ID_HEADER, sent)
        .expect(200);
      await settle();
      const id = response.headers[REQUEST_ID_HEADER.toLowerCase()];
      expect(id).toMatch(UUID);
      for (const line of capture.lines()) {
        expect(line.requestId).toBe(id);
      }
      if (sent !== '') {
        expect(capture.raw().join('')).not.toContain(sent);
      }
    }
  );

  it('VT-07 PBI-013 AC-2 reuses 64 characters and replaces 65', async () => {
    const { app } = buildApp();
    const valid64 = 'a'.repeat(64);
    const invalid65 = 'b'.repeat(65);
    const reused = await request(app)
      .get('/items')
      .set(REQUEST_ID_HEADER, valid64);
    expect(reused.headers[REQUEST_ID_HEADER.toLowerCase()]).toBe(valid64);
    const replaced = await request(app)
      .get('/items')
      .set(REQUEST_ID_HEADER, invalid65);
    expect(replaced.headers[REQUEST_ID_HEADER.toLowerCase()]).toMatch(UUID);
  });

  it('VT-07 uses a valid X-Correlation-Id and falls back to the request ID', async () => {
    const { app, capture } = buildApp();
    await request(app)
      .get('/items')
      .set(REQUEST_ID_HEADER, 'req-1')
      .set('X-Correlation-Id', 'corr-1');
    await request(app)
      .get('/items')
      .set(REQUEST_ID_HEADER, 'req-2')
      .set('X-Correlation-Id', 'not valid!');
    await settle();
    const lines = capture.lines();
    for (const line of lines.filter((l) => l.requestId === 'req-1')) {
      expect(line.correlationId).toBe('corr-1');
    }
    for (const line of lines.filter((l) => l.requestId === 'req-2')) {
      expect(line.correlationId).toBe('req-2');
    }
  });

  it('VT-08 PBI-013 AC-3 TBI-016 DoD-1 DoD-2 keeps seed markers out of every log line', async () => {
    const { app, capture } = buildApp();
    const ok = await request(app)
      .put('/api/v1/me')
      .set('Cookie', `session=${MARKERS.subject}`)
      .set('Authorization', `Bearer ${MARKERS.subject}`)
      .send(MARKERS)
      .expect(200);
    expect(ok.body).toEqual({
      displayName: MARKERS.displayName,
      email: MARKERS.email,
    });
    const failed = await request(app)
      .put('/api/v1/me/fail')
      .send(MARKERS)
      .expect(500);
    await settle();
    expect(failed.headers[REQUEST_ID_HEADER.toLowerCase()]).toMatch(UUID);
    expect(capture.lines().map((line) => line.msg)).toEqual([
      'profile update started',
      'data access query',
      'request completed',
      'request failed',
      'request completed',
    ]);
    expectNoMarkers(capture);
  });
});
