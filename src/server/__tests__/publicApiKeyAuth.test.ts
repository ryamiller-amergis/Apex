/**
 * Unit + integration tests for public API-key auth and ping — FEAT-002
 * Covers VT-01..VT-10, TBI-003 DoD-0..3, PBI-003 AC-0..4
 */
import express from 'express';
import request from 'supertest';
import {
  requirePublicApiKey,
  requireApiKeyScope,
  __publicApiKeyUnauthorizedBodyForTests,
  PUBLIC_API_KEY_UNAUTHORIZED_CODE,
  PUBLIC_API_KEY_RATE_LIMITED_CODE,
} from '../middleware/publicApiKeyAuth';
import { PUBLIC_API_KEY_RATE_LIMIT } from '../services/publicRateLimitService';
import { __resetPublicRateLimitForTests } from '../services/publicRateLimitService';
import publicRoutes from '../routes/public';

jest.mock('../services/apiKeyLifecycleService', () => ({
  verifyRawKey: jest.fn(),
}));

import { verifyRawKey } from '../services/apiKeyLifecycleService';

const mockVerifyRawKey = verifyRawKey as jest.MockedFunction<typeof verifyRawKey>;

function buildMiddlewareApp() {
  const app = express();
  app.get('/secure', requirePublicApiKey, (req, res) => {
    res.status(200).json({
      apiKeyId: req._publicApiKey?.apiKeyId,
      projectId: req._publicApiKey?.projectId,
      scopes: req._publicApiKey?.scopes,
    });
  });
  return app;
}

function buildScopedApp() {
  const app = express();
  app.get(
    '/flags',
    requirePublicApiKey,
    requireApiKeyScope('flags:evaluate'),
    (_req, res) => {
      res.status(200).json({ ok: true });
    },
  );
  return app;
}

function buildPublicApp() {
  const app = express();
  app.use('/api/public', publicRoutes);
  return app;
}

beforeEach(() => {
  __resetPublicRateLimitForTests();
  mockVerifyRawKey.mockReset();
});

describe('requirePublicApiKey (TBI-003 / PBI-003)', () => {
  const unauthorized = __publicApiKeyUnauthorizedBodyForTests();

  it('DoD-0 / AC-0: attaches apiKeyId, projectId, and scopes on success', async () => {
    mockVerifyRawKey.mockResolvedValue({
      apiKeyId: 'key-1',
      projectId: 'ProjectA',
      scopes: ['flags:evaluate'],
    });
    const res = await request(buildMiddlewareApp())
      .get('/secure')
      .set('Authorization', 'Bearer apex_valid');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      apiKeyId: 'key-1',
      projectId: 'ProjectA',
      scopes: ['flags:evaluate'],
    });
    expect(mockVerifyRawKey).toHaveBeenCalledWith('apex_valid');
  });

  it('AC-1 / VT-02: returns generic 401 when Authorization is missing', async () => {
    const res = await request(buildMiddlewareApp()).get('/secure');
    expect(res.status).toBe(401);
    expect(res.body).toEqual(unauthorized);
    expect(mockVerifyRawKey).not.toHaveBeenCalled();
  });

  it('AC-1 / VT-03: returns identical generic 401 for malformed Bearer', async () => {
    const basic = await request(buildMiddlewareApp())
      .get('/secure')
      .set('Authorization', 'Basic xyz');
    const emptyBearer = await request(buildMiddlewareApp())
      .get('/secure')
      .set('Authorization', 'Bearer');
    expect(basic.status).toBe(401);
    expect(emptyBearer.status).toBe(401);
    expect(basic.body).toEqual(unauthorized);
    expect(emptyBearer.body).toEqual(unauthorized);
    expect(JSON.stringify(basic.body)).toBe(JSON.stringify(emptyBearer.body));
  });

  it('AC-1 / VT-04: returns generic 401 for unknown key (verify null)', async () => {
    mockVerifyRawKey.mockResolvedValue(null);
    const res = await request(buildMiddlewareApp())
      .get('/secure')
      .set('Authorization', 'Bearer apex_unknown');
    expect(res.status).toBe(401);
    expect(res.body).toEqual(unauthorized);
    expect(res.body).not.toHaveProperty('projectId');
  });

  it('AC-2 / VT-05: expired and deleted keys both return identical 401 with no project context', async () => {
    mockVerifyRawKey.mockResolvedValue(null);
    const expired = await request(buildMiddlewareApp())
      .get('/secure')
      .set('Authorization', 'Bearer apex_expired');
    const deleted = await request(buildMiddlewareApp())
      .get('/secure')
      .set('Authorization', 'Bearer apex_deleted');
    expect(expired.status).toBe(401);
    expect(deleted.status).toBe(401);
    expect(expired.body).toEqual(unauthorized);
    expect(deleted.body).toEqual(unauthorized);
    expect(JSON.stringify(expired.body)).toBe(JSON.stringify(deleted.body));
  });

  it('DoD-1 / AC-4: does not derive project from query, header, or body overrides', async () => {
    mockVerifyRawKey.mockResolvedValue({
      apiKeyId: 'key-1',
      projectId: 'ProjectA',
      scopes: [],
    });
    const res = await request(buildMiddlewareApp())
      .get('/secure')
      .query({ project: 'ProjectB' })
      .set('Authorization', 'Bearer apex_valid')
      .set('x-apex-project', 'ProjectB');
    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe('ProjectA');
  });

  it('AC-3 / VT-07: 101st request in the window returns 429', async () => {
    mockVerifyRawKey.mockResolvedValue({
      apiKeyId: 'key-rl',
      projectId: 'ProjectA',
      scopes: [],
    });
    const app = buildMiddlewareApp();
    for (let i = 0; i < PUBLIC_API_KEY_RATE_LIMIT; i += 1) {
      const ok = await request(app)
        .get('/secure')
        .set('Authorization', 'Bearer apex_rl');
      expect(ok.status).toBe(200);
    }
    const throttled = await request(app)
      .get('/secure')
      .set('Authorization', 'Bearer apex_rl');
    expect(throttled.status).toBe(429);
    expect(throttled.body.code).toBe(PUBLIC_API_KEY_RATE_LIMITED_CODE);
  });

  it('VT-10: success/401/429 bodies never echo the raw credential or a hash', async () => {
    const raw = 'apex_super_secret_raw_key_value';
    mockVerifyRawKey.mockResolvedValueOnce({
      apiKeyId: 'key-1',
      projectId: 'ProjectA',
      scopes: [],
    });
    const ok = await request(buildMiddlewareApp())
      .get('/secure')
      .set('Authorization', `Bearer ${raw}`);
    expect(JSON.stringify(ok.body)).not.toContain(raw);

    mockVerifyRawKey.mockResolvedValueOnce(null);
    const unauthorizedRes = await request(buildMiddlewareApp())
      .get('/secure')
      .set('Authorization', `Bearer ${raw}`);
    expect(JSON.stringify(unauthorizedRes.body)).not.toContain(raw);
    expect(unauthorizedRes.body.code).toBe(PUBLIC_API_KEY_UNAUTHORIZED_CODE);

    mockVerifyRawKey.mockResolvedValue({
      apiKeyId: 'key-flood',
      projectId: 'ProjectA',
      scopes: [],
    });
    const app = buildMiddlewareApp();
    for (let i = 0; i < PUBLIC_API_KEY_RATE_LIMIT; i += 1) {
      await request(app).get('/secure').set('Authorization', `Bearer ${raw}`);
    }
    const limited = await request(app).get('/secure').set('Authorization', `Bearer ${raw}`);
    expect(limited.status).toBe(429);
    expect(JSON.stringify(limited.body)).not.toContain(raw);
  });
});

describe('requireApiKeyScope', () => {
  it('allows the request when the key grants the required scope', async () => {
    mockVerifyRawKey.mockResolvedValue({
      apiKeyId: 'key-1',
      projectId: 'ProjectA',
      scopes: ['flags:evaluate'],
    });
    const res = await request(buildScopedApp())
      .get('/flags')
      .set('Authorization', 'Bearer apex_valid');
    expect(res.status).toBe(200);
  });

  it('returns 403 when the key is missing the required scope', async () => {
    mockVerifyRawKey.mockResolvedValue({
      apiKeyId: 'key-1',
      projectId: 'ProjectA',
      scopes: ['backlog:export'],
    });
    const res = await request(buildScopedApp())
      .get('/flags')
      .set('Authorization', 'Bearer apex_valid');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PUBLIC_API_KEY_FORBIDDEN');
  });
});

describe('GET /api/public/ping (PBI-003 integration)', () => {
  it('AC-0 / VT-01: returns 200 with only status, projectId, and ISO timestamp', async () => {
    mockVerifyRawKey.mockResolvedValue({
      apiKeyId: 'key-1',
      projectId: 'ProjectA',
      scopes: [],
    });
    const res = await request(buildPublicApp())
      .get('/api/public/ping')
      .set('Authorization', 'Bearer apex_valid');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['projectId', 'status', 'timestamp']);
    expect(res.body.status).toBe('ok');
    expect(res.body.projectId).toBe('ProjectA');
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('VT-09: succeeds without a session cookie (session-free mount)', async () => {
    mockVerifyRawKey.mockResolvedValue({
      apiKeyId: 'key-1',
      projectId: 'ProjectA',
      scopes: [],
    });
    const res = await request(buildPublicApp())
      .get('/api/public/ping')
      .set('Authorization', 'Bearer apex_valid');
    expect(res.status).toBe(200);
  });

  it('AC-4 / VT-08: ignores ?project= and x-apex-project overrides', async () => {
    mockVerifyRawKey.mockResolvedValue({
      apiKeyId: 'key-1',
      projectId: 'ProjectA',
      scopes: [],
    });
    const withQuery = await request(buildPublicApp())
      .get('/api/public/ping')
      .query({ project: 'ProjectB' })
      .set('Authorization', 'Bearer apex_valid');
    const withHeader = await request(buildPublicApp())
      .get('/api/public/ping')
      .set('Authorization', 'Bearer apex_valid')
      .set('x-apex-project', 'ProjectB');
    expect(withQuery.body.projectId).toBe('ProjectA');
    expect(withHeader.body.projectId).toBe('ProjectA');
  });

  it('AC-3 / VT-06: throttled key gets 429 while another key retains allowance', async () => {
    mockVerifyRawKey.mockImplementation(async (raw) => {
      if (raw === 'apex_k1') return { apiKeyId: 'k1', projectId: 'ProjectA', scopes: [] };
      if (raw === 'apex_k2') return { apiKeyId: 'k2', projectId: 'ProjectA', scopes: [] };
      return null;
    });
    const app = buildPublicApp();
    for (let i = 0; i < PUBLIC_API_KEY_RATE_LIMIT; i += 1) {
      const ok = await request(app)
        .get('/api/public/ping')
        .set('Authorization', 'Bearer apex_k1');
      expect(ok.status).toBe(200);
    }
    const throttled = await request(app)
      .get('/api/public/ping')
      .set('Authorization', 'Bearer apex_k1');
    const other = await request(app)
      .get('/api/public/ping')
      .set('Authorization', 'Bearer apex_k2');
    expect(throttled.status).toBe(429);
    expect(other.status).toBe(200);
    expect(other.body.projectId).toBe('ProjectA');
  });
});
