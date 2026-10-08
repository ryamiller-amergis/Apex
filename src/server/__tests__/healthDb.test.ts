import request from 'supertest';
import express from 'express';

// Mock Drizzle before importing the router that uses it
jest.mock('../db/drizzle', () => ({
  db: {
    execute: jest.fn(),
  },
}));

import apiRouter from '../routes/api';
import { db } from '../db/drizzle';

// ── Test app ──────────────────────────────────────────────────────────────────

let app: express.Application;

beforeEach(() => {
  jest.clearAllMocks();
  app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
});

// ── GET /api/health/ready + /api/health/db ───────────────────────────────────

describe('GET /api/health/ready', () => {
  it('returns 200 with healthy=true and timestamp when DB responds', async () => {
    const fakeNow = '2026-01-01T12:00:00.000Z';
    (db.execute as jest.Mock).mockResolvedValue({ rows: [{ now: fakeNow }] });

    const response = await request(app).get('/api/health/ready').expect(200);

    expect(response.body).toEqual({ healthy: true, timestamp: fakeNow });
  });

  it('calls db.execute with a SELECT NOW() statement', async () => {
    (db.execute as jest.Mock).mockResolvedValue({ rows: [{ now: '2026-01-01T00:00:00Z' }] });

    await request(app).get('/api/health/ready');

    expect(db.execute).toHaveBeenCalledTimes(1);
    // The sql template tag produces an object — we verify it was called, not the exact SQL shape
    const [sqlArg] = (db.execute as jest.Mock).mock.calls[0];
    expect(sqlArg).toBeDefined();
  });

  it('returns 503 with healthy=false when the database is unavailable', async () => {
    (db.execute as jest.Mock).mockRejectedValue(new Error('connection refused'));

    const response = await request(app).get('/api/health/ready').expect(503);

    expect(response.body).toEqual({ healthy: false, error: 'Database unavailable' });
  });

  it('returns 503 for any DB error regardless of message', async () => {
    (db.execute as jest.Mock).mockRejectedValue(new Error('SSL SYSCALL error: EOF detected'));

    const response = await request(app).get('/api/health/ready').expect(503);

    expect(response.body.healthy).toBe(false);
    expect(response.body.error).toBe('Database unavailable');
  });
});

describe('GET /api/health/db', () => {
  it('remains a compatibility alias with the same healthy response', async () => {
    const fakeNow = '2026-01-01T12:00:00.000Z';
    (db.execute as jest.Mock).mockResolvedValue({ rows: [{ now: fakeNow }] });

    const response = await request(app).get('/api/health/db').expect(200);

    expect(response.body).toEqual({ healthy: true, timestamp: fakeNow });
  });

  it('remains a compatibility alias with the same failure response', async () => {
    (db.execute as jest.Mock).mockRejectedValue(new Error('connection refused'));

    const response = await request(app).get('/api/health/db').expect(503);

    expect(response.body).toEqual({ healthy: false, error: 'Database unavailable' });
  });
});
