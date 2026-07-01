/**
 * Integration-style tests for the /api/ask-apex routes.
 *
 * Service dependencies are fully mocked — no real SDK or sessions.
 */
import request from 'supertest';
import express from 'express';

jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn().mockReturnValue('user-1'),
}));

jest.mock('../services/askApexService', () => ({
  createSession: jest.fn(),
  subscribeToSession: jest.fn(),
  sendMessage: jest.fn(),
  getSessionMessages: jest.fn(),
  closeSession: jest.fn(),
}));

import askApexRouter from '../routes/askApex';
import * as askApexService from '../services/askApexService';

const mockService = askApexService as jest.Mocked<typeof askApexService>;

// ── App factory ─────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { profile: { oid: 'user-1' } };
    next();
  });
  app.use('/api/ask-apex', askApexRouter);
  return app;
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('POST /api/ask-apex/sessions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 201 with a sessionId', async () => {
    mockService.createSession.mockReturnValue('sess-abc');
    const app = buildApp();

    const res = await request(app).post('/api/ask-apex/sessions').send();

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ sessionId: 'sess-abc' });
    expect(mockService.createSession).toHaveBeenCalledWith('user-1');
  });

  it('returns 500 when createSession throws', async () => {
    mockService.createSession.mockImplementation(() => {
      throw new Error('out of memory');
    });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp();

    const res = await request(app).post('/api/ask-apex/sessions').send();

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'out of memory' });
    consoleSpy.mockRestore();
  });
});

describe('POST /api/ask-apex/sessions/:id/messages', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 202 and invokes sendMessage', async () => {
    mockService.sendMessage.mockResolvedValue(undefined);
    const app = buildApp();

    const res = await request(app)
      .post('/api/ask-apex/sessions/sess-1/messages')
      .send({ text: 'Hello' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    // sendMessage is fire-and-forget from the route perspective
  });

  it('returns 400 when text is missing', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/api/ask-apex/sessions/sess-1/messages')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'text is required' });
  });

  it('returns 400 when text is empty whitespace', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/api/ask-apex/sessions/sess-1/messages')
      .send({ text: '   ' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'text is required' });
  });
});

describe('DELETE /api/ask-apex/sessions/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns { ok: true } when session is closed', async () => {
    mockService.closeSession.mockReturnValue(true);
    const app = buildApp();

    const res = await request(app).delete('/api/ask-apex/sessions/sess-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockService.closeSession).toHaveBeenCalledWith('sess-1', 'user-1');
  });

  it('returns { ok: false } for non-existent session (acts as 404)', async () => {
    mockService.closeSession.mockReturnValue(false);
    const app = buildApp();

    const res = await request(app).delete('/api/ask-apex/sessions/nonexistent');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false });
  });
});

describe('GET /api/ask-apex/sessions/:id/stream (SSE)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends error event and ends when session not found', async () => {
    mockService.getSessionMessages.mockReturnValue(null);
    mockService.subscribeToSession.mockReturnValue(null);
    const app = buildApp();

    const res = await request(app)
      .get('/api/ask-apex/sessions/bad-id/stream')
      .set('Accept', 'text/event-stream');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Session not found');
  });

  it('calls getSessionMessages and subscribeToSession for a valid session', async () => {
    mockService.getSessionMessages.mockReturnValue([]);
    const unsubFn = jest.fn();
    mockService.subscribeToSession.mockReturnValue(unsubFn);
    const app = buildApp();

    const server = app.listen(0);
    const port = (server.address() as any).port;

    const controller = new AbortController();
    const fetchPromise = fetch(`http://127.0.0.1:${port}/api/ask-apex/sessions/sess-1/stream`, {
      signal: controller.signal,
    });

    const res = await fetchPromise;
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    controller.abort();
    server.close();

    await new Promise((r) => setTimeout(r, 50));

    expect(mockService.getSessionMessages).toHaveBeenCalledWith('sess-1', 'user-1');
    expect(mockService.subscribeToSession).toHaveBeenCalledWith(
      'sess-1',
      'user-1',
      expect.any(Function),
    );
  });
});
