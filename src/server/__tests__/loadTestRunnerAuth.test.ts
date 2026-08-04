/**
 * Unit tests for load-test runner callback auth (MI JWT preferred, static optional).
 */
import express from 'express';
import request from 'supertest';
import {
  requireLoadTestRunnerAuth,
  __resetLoadTestRunnerAuthJwksCacheForTests,
} from '../middleware/loadTestRunnerAuth';

function buildApp() {
  const app = express();
  app.get('/secure', requireLoadTestRunnerAuth, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  __resetLoadTestRunnerAuthJwksCacheForTests();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.LT_RUNNER_CALLBACK_TOKEN;
  delete process.env.LT_CALLBACK_TOKEN_AUDIENCE;
  delete process.env.LT_RUNNER_ALLOWED_CLIENT_IDS;
  delete process.env.APEX_API_APP_ID_URI;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('requireLoadTestRunnerAuth', () => {
  it('returns 503 when neither MI nor static auth is configured', async () => {
    const res = await request(buildApp()).get('/secure');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('LOAD_TEST_RUNNER_AUTH_UNCONFIGURED');
  });

  it('accepts static LT_RUNNER_CALLBACK_TOKEN for local/tests', async () => {
    process.env.LT_RUNNER_CALLBACK_TOKEN = 'local-secret';
    const res = await request(buildApp())
      .get('/secure')
      .set('Authorization', 'Bearer local-secret');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects wrong static token', async () => {
    process.env.LT_RUNNER_CALLBACK_TOKEN = 'local-secret';
    const res = await request(buildApp())
      .get('/secure')
      .set('Authorization', 'Bearer wrong');
    expect(res.status).toBe(401);
  });

  it('returns 401 for missing bearer when MI auth is configured', async () => {
    process.env.AZURE_TENANT_ID = '11111111-1111-1111-1111-111111111111';
    process.env.AZURE_CLIENT_ID = '22222222-2222-2222-2222-222222222222';
    process.env.LT_CALLBACK_TOKEN_AUDIENCE = 'api://22222222-2222-2222-2222-222222222222';
    process.env.LT_RUNNER_ALLOWED_CLIENT_IDS = '33333333-3333-3333-3333-333333333333';

    const res = await request(buildApp()).get('/secure');
    expect(res.status).toBe(401);
  });

  it('returns 401 for non-JWT garbage when MI auth is configured', async () => {
    process.env.AZURE_TENANT_ID = '11111111-1111-1111-1111-111111111111';
    process.env.LT_CALLBACK_TOKEN_AUDIENCE = 'api://apex';
    process.env.LT_RUNNER_ALLOWED_CLIENT_IDS = '33333333-3333-3333-3333-333333333333';

    const res = await request(buildApp())
      .get('/secure')
      .set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });
});
