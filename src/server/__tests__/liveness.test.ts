import express from 'express';
import request from 'supertest';
import { LIVENESS_PATH, sendLiveness } from '../liveness';

describe('GET /api/health/live', () => {
  it('returns 200 without touching session or downstream services', async () => {
    const app = express();
    app.get(LIVENESS_PATH, sendLiveness);

    const response = await request(app).get(LIVENESS_PATH).expect(200);

    expect(response.body).toEqual({ ok: true });
  });
});
