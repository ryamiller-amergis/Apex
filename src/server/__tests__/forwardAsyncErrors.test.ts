import express from 'express';
import request from 'supertest';
import { forwardAsyncErrors } from '../utils/forwardAsyncErrors';

function buildApp() {
  const app = express();
  const router = forwardAsyncErrors(express.Router());
  router.get('/boom', async () => {
    await Promise.resolve();
    throw new Error('late failure');
  });
  router.get('/sync', () => {
    throw new Error('sync failure');
  });
  router.get('/ok', async (_req, res) => {
    res.json({ ok: true });
  });
  router.get('/chain', (_req, _res, next) => next(), async (_req, res) => {
    res.json({ chained: true });
  });
  app.use(router);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

describe('forwardAsyncErrors', () => {
  it('answers a request whose async handler throws after an await', async () => {
    const res = await request(buildApp()).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'late failure' });
  });

  it('answers a request whose handler throws at once', async () => {
    const res = await request(buildApp()).get('/sync');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'sync failure' });
  });

  it('leaves handlers that answer on their own alone', async () => {
    const ok = await request(buildApp()).get('/ok');
    expect(ok.body).toEqual({ ok: true });
    const chained = await request(buildApp()).get('/chain');
    expect(chained.body).toEqual({ chained: true });
  });
});
