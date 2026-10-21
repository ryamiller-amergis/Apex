/**
 * TBI-005 runner callback authentication — DoD-0 security contract.
 */
import { generateKeyPairSync, sign } from 'crypto';
import express from 'express';
import request from 'supertest';
import {
  requireAiRunnerAuth,
  __resetAiRunnerAuthJwksCacheForTests,
} from '../middleware/aiRunnerAuth';

function buildApp() {
  const app = express();
  app.get('/secure', requireAiRunnerAuth, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createManagedIdentityFixture(roles?: string[]) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const kid = 'runner-test-key';
  const header = encode({ alg: 'RS256', kid, typ: 'JWT' });
  const payload = encode({
    aud: 'api://apex',
    tid: 'tenant-1',
    appid: 'runner-client-1',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...(roles ? { roles } : {}),
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey)
    .toString('base64url');
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    token: `${signingInput}.${signature}`,
    jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] },
  };
}

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  __resetAiRunnerAuthJwksCacheForTests();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.AI_RUNS_RUNNER_CALLBACK_TOKEN;
  delete process.env.AI_RUNS_ALLOW_STATIC_CALLBACK_TOKEN;
  delete process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE;
  delete process.env.AI_RUNS_RUNNER_ALLOWED_CLIENT_IDS;
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('requireAiRunnerAuth', () => {
  it('TBI-005 DoD-0: accepts explicit static callback token for local/tests', async () => {
    process.env.AI_RUNS_RUNNER_CALLBACK_TOKEN = 'local-runner-secret';

    const res = await request(buildApp())
      .get('/secure')
      .set('Authorization', 'Bearer local-runner-secret');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('TBI-005 security NFR: never accepts the static token in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AI_RUNS_RUNNER_CALLBACK_TOKEN = 'local-runner-secret';

    const res = await request(buildApp())
      .get('/secure')
      .set('Authorization', 'Bearer local-runner-secret');

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_RUNNER_AUTH_UNCONFIGURED');
  });

  it('accepts the static token in production only with explicit operator opt-in', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AI_RUNS_RUNNER_CALLBACK_TOKEN = 'dev-runner-secret';
    process.env.AI_RUNS_ALLOW_STATIC_CALLBACK_TOKEN = 'true';

    const res = await request(buildApp())
      .get('/secure')
      .set('Authorization', 'Bearer dev-runner-secret');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('TBI-005 DoD-0: rejects a valid managed-identity JWT without AiRun.Runner', async () => {
    process.env.AZURE_TENANT_ID = 'tenant-1';
    process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE = 'api://apex';
    process.env.AI_RUNS_RUNNER_ALLOWED_CLIENT_IDS = 'runner-client-1';
    const fixture = createManagedIdentityFixture();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => fixture.jwks,
    }) as unknown as typeof fetch;

    const res = await request(buildApp())
      .get('/secure')
      .set('Authorization', `Bearer ${fixture.token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AI_RUNNER_FORBIDDEN');
  });

  it('TBI-005 DoD-0: accepts allowed managed identity with AiRun.Runner role', async () => {
    process.env.AZURE_TENANT_ID = 'tenant-1';
    process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE = 'api://apex';
    process.env.AI_RUNS_RUNNER_ALLOWED_CLIENT_IDS = 'runner-client-1';
    const fixture = createManagedIdentityFixture(['AiRun.Runner']);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => fixture.jwks,
    }) as unknown as typeof fetch;

    const res = await request(buildApp())
      .get('/secure')
      .set('Authorization', `Bearer ${fixture.token}`);

    expect(res.status).toBe(200);
  });

  it('retries once when JWKS fetch fails transiently', async () => {
    process.env.AZURE_TENANT_ID = 'tenant-1';
    process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE = 'api://apex';
    process.env.AI_RUNS_RUNNER_ALLOWED_CLIENT_IDS = 'runner-client-1';
    const fixture = createManagedIdentityFixture(['AiRun.Runner']);
    global.fetch = jest.fn()
      .mockRejectedValueOnce(new TypeError('network timeout'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => fixture.jwks,
      }) as unknown as typeof fetch;

    const res = await request(buildApp())
      .get('/secure')
      .set('Authorization', `Bearer ${fixture.token}`);

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('refreshes JWKS when key is missing from cache response', async () => {
    process.env.AZURE_TENANT_ID = 'tenant-1';
    process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE = 'api://apex';
    process.env.AI_RUNS_RUNNER_ALLOWED_CLIENT_IDS = 'runner-client-1';
    const fixture = createManagedIdentityFixture(['AiRun.Runner']);
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ keys: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => fixture.jwks,
      }) as unknown as typeof fetch;

    const res = await request(buildApp())
      .get('/secure')
      .set('Authorization', `Bearer ${fixture.token}`);

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
