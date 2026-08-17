/**
 * Route tests for apiKeys — FEAT-001 / TBI-002 / VT-08..VT-13
 */

import request from 'supertest';
import express from 'express';
import { ApiKeyValidationError } from '../../shared/types/apiKey';

let permissionGranted = true;
let projectAccessGranted = true;
let authenticated = true;

jest.mock('../middleware/rbac', () => ({
  requirePermission: (...keys: string[]) =>
    (req: any, res: any, next: any) => {
      if (!authenticated) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (!permissionGranted) {
        return res.status(403).json({ error: 'Forbidden', missing: keys });
      }
      next();
    },
  requireProjectAccess: () =>
    (req: any, res: any, next: any) => {
      if (!authenticated) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (!projectAccessGranted) {
        return res.status(403).json({ error: 'Forbidden: project parameter required' });
      }
      next();
    },
  resolveRequestProject: (req: any) => req.params?.projectId,
}));

const listKeys = jest.fn();
const createKey = jest.fn();
const updateKey = jest.fn();
const regenerateKey = jest.fn();
const deleteKey = jest.fn();

jest.mock('../services/apiKeyLifecycleService', () => ({
  listKeys: (...args: unknown[]) => listKeys(...args),
  createKey: (...args: unknown[]) => createKey(...args),
  updateKey: (...args: unknown[]) => updateKey(...args),
  regenerateKey: (...args: unknown[]) => regenerateKey(...args),
  deleteKey: (...args: unknown[]) => deleteKey(...args),
}));

import apiKeysRouter from '../routes/apiKeys';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    if (authenticated) {
      req.user = { profile: { oid: 'user-1' } };
    }
    next();
  });
  app.use('/api/projects/:projectId/api-keys', apiKeysRouter);
  return app;
}

const metadata = {
  id: 'key-1',
  shortId: 'key1short',
  name: 'CI',
  maskedPrefix: 'apex_a1b…',
  cadence: '90d',
  scopes: [] as string[],
  expiresAt: '2026-11-09T14:00:00.000Z',
  status: 'active',
  createdAt: '2026-08-11T14:00:00.000Z',
  createdBy: 'Ada',
};

beforeEach(() => {
  jest.clearAllMocks();
  permissionGranted = true;
  projectAccessGranted = true;
  authenticated = true;
});

describe('POST create (VT-08 / PBI-001 AC-0)', () => {
  it('returns 201 with key + one-time rawKey', async () => {
    createKey.mockResolvedValue({ key: metadata, rawKey: 'apex_secrettokenvalue' });
    const app = buildApp();

    const res = await request(app)
      .post('/api/projects/P1/api-keys')
      .send({ name: 'CI', cadence: '90d' });

    expect(res.status).toBe(201);
    expect(res.body.key).toEqual(metadata);
    expect(res.body.rawKey).toBe('apex_secrettokenvalue');
    expect(createKey).toHaveBeenCalledWith(
      'P1',
      { name: 'CI', cadence: '90d', scopes: [] },
      'user-1',
    );
  });
});

describe('GET list (VT-09 / PBI-001 AC-4)', () => {
  it('returns sanitized items without rawKey or hash', async () => {
    listKeys.mockResolvedValue([metadata]);
    const app = buildApp();

    const res = await request(app).get('/api/projects/P1/api-keys');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [metadata] });
    expect(JSON.stringify(res.body)).not.toMatch(/rawKey|keyHash|key_hash/);
  });
});

describe('authorization (VT-10 / VT-11 / PBI-001 AC-3)', () => {
  it('returns 403 when api-keys:manage is missing', async () => {
    permissionGranted = false;
    const app = buildApp();

    const res = await request(app).get('/api/projects/P1/api-keys');

    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty('items');
    expect(res.body).not.toHaveProperty('rawKey');
    expect(listKeys).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    authenticated = false;
    const app = buildApp();

    const res = await request(app).get('/api/projects/P1/api-keys');

    expect(res.status).toBe(401);
    expect(listKeys).not.toHaveBeenCalled();
  });
});

describe('cross-project denial (VT-12 / PBI-002 AC-4)', () => {
  it('returns 404 and no rawKey when targeting another project key', async () => {
    updateKey.mockRejectedValue(new ApiKeyValidationError('API key not found', 'NOT_FOUND'));
    regenerateKey.mockRejectedValue(new ApiKeyValidationError('API key not found', 'NOT_FOUND'));
    deleteKey.mockRejectedValue(new ApiKeyValidationError('API key not found', 'NOT_FOUND'));
    const app = buildApp();

    const patch = await request(app).patch('/api/projects/P1/api-keys/other').send({ name: 'X' });
    expect(patch.status).toBe(404);
    expect(patch.body).not.toHaveProperty('rawKey');

    const regen = await request(app).post('/api/projects/P1/api-keys/other/regenerate');
    expect(regen.status).toBe(404);
    expect(regen.body).not.toHaveProperty('rawKey');

    const del = await request(app).delete('/api/projects/P1/api-keys/other');
    expect(del.status).toBe(404);
    expect(del.body).not.toHaveProperty('rawKey');
  });

  it('returns 403 when project access denied', async () => {
    projectAccessGranted = false;
    const app = buildApp();

    const res = await request(app)
      .patch('/api/projects/P2/api-keys/key-1')
      .send({ name: 'X' });

    expect(res.status).toBe(403);
    expect(updateKey).not.toHaveBeenCalled();
  });
});

describe('validation (VT-13 / PBI-001 AC-1)', () => {
  it('returns 422 VALIDATION and does not expose secret', async () => {
    createKey.mockRejectedValue(new ApiKeyValidationError('Name is required', 'VALIDATION'));
    const app = buildApp();

    const res = await request(app)
      .post('/api/projects/P1/api-keys')
      .send({ name: '', cadence: '90d' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION');
    expect(res.body).not.toHaveProperty('rawKey');
  });

  it('returns 409 NAME_TAKEN for duplicate names', async () => {
    createKey.mockRejectedValue(
      new ApiKeyValidationError('An API key with this name already exists', 'NAME_TAKEN'),
    );
    const app = buildApp();

    const res = await request(app)
      .post('/api/projects/P1/api-keys')
      .send({ name: 'CI', cadence: '90d' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NAME_TAKEN');
    expect(res.body).not.toHaveProperty('rawKey');
  });
});

describe('PATCH / regenerate / DELETE success contracts (TBI-002 DoD-2)', () => {
  it('PATCH returns metadata without rawKey', async () => {
    updateKey.mockResolvedValue(metadata);
    const app = buildApp();

    const res = await request(app)
      .patch('/api/projects/P1/api-keys/key-1')
      .send({ name: 'CI-2', cadence: '30d' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(metadata);
    expect(res.body).not.toHaveProperty('rawKey');
  });

  it('regenerate returns one-time rawKey', async () => {
    regenerateKey.mockResolvedValue({ key: metadata, rawKey: 'apex_newsecret' });
    const app = buildApp();

    const res = await request(app).post('/api/projects/P1/api-keys/key-1/regenerate');

    expect(res.status).toBe(200);
    expect(res.body.rawKey).toBe('apex_newsecret');
  });

  it('DELETE returns 204', async () => {
    deleteKey.mockResolvedValue(undefined);
    const app = buildApp();

    const res = await request(app).delete('/api/projects/P1/api-keys/key-1');

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });
});
