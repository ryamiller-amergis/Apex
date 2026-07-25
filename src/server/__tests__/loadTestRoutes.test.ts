/**
 * Route permission tests for FEAT-004 Load Test Definition API
 *
 * Coverage:
 *   TBI-004 DoD-3: view vs manage permission matrix (VT-08, VT-09)
 *   PBI-005 AC-3: GET /:id/portable returns 403 without load-test:view
 *   PBI-005 AC-2: GET /:id/portable returns 404 when definition not in project
 *   PBI-004 AC-0 (route): POST 201 + body for authorized caller
 *   PBI-004 AC-1 (route): POST 422 for cap-exceeded
 *   VT-07:  GET /:id returns 404 for missing id
 *   A-009:  DELETE 409 for active run
 *   FEAT-003: existing stub for /:definitionId/runs returns 403 without load-test:run
 */

import request from 'supertest';
import express from 'express';
import loadTestRouter from '../routes/loadTests';
import * as loadTestService from '../services/loadTestService';
import { LoadTestValidationError } from '../../shared/types/loadTest';

// ── Permission mock state ──────────────────────────────────────────────────────

let mockPermissions: Set<string> = new Set();

jest.mock('../middleware/rbac', () => ({
  requirePermission: (...keys: string[]) =>
    (req: any, res: any, next: any) => {
      const missing = keys.filter((k) => !mockPermissions.has(k));
      if (missing.length > 0) {
        res.status(403).json({ error: 'Forbidden', missing });
        return;
      }
      next();
    },
  requireAnyPermission: (...keys: string[]) =>
    (_req: any, res: any, next: any) => {
      if (keys.some((k) => mockPermissions.has(k))) {
        next();
      } else {
        res.status(403).json({ error: 'Forbidden' });
      }
    },
}));

// ── Service mock ───────────────────────────────────────────────────────────────

jest.mock('../services/loadTestService', () => ({
  listDefinitions: jest.fn(),
  createDefinition: jest.fn(),
  getDefinition: jest.fn(),
  updateDefinition: jest.fn(),
  deleteDefinition: jest.fn(),
  getPortable: jest.fn(),
}));

const mockSvc = loadTestService as jest.Mocked<typeof loadTestService>;

// ── App builder ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { profile: { oid: 'user-1', upn: 'user@example.com' } };
    next();
  });
  app.use('/api/projects/:projectId/load-tests', loadTestRouter);
  return app;
}

const PROJECT = 'project-a';
const BASE = `/api/projects/${PROJECT}/load-tests`;
const DEF_ID = 'def-uuid-1';
const NOW = new Date().toISOString();

const stubDefinition = {
  id: DEF_ID,
  projectId: PROJECT,
  name: 'My Test',
  description: null,
  requirementRef: null,
  targetUrl: 'https://staging.example.com',
  environment: 'staging',
  engine: 'k6',
  flowType: 'single',
  scriptSource: 'form_builder',
  script: 'export default function() {}',
  loadProfile: { vus: 10, durationMinutes: 5 },
  clientThresholds: [],
  runSource: null,
  secretRefs: null,
  createdAt: NOW,
  updatedAt: NOW,
  createdBy: 'user-1',
  updatedBy: 'user-1',
};

const stubPortable = {
  id: DEF_ID,
  name: 'My Test',
  engine: 'k6',
  flowType: 'single',
  script: 'export default function() {}',
  loadProfile: { vus: 10, durationMinutes: 5 },
  clientThresholds: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPermissions = new Set();
});

// ── GET / — list ───────────────────────────────────────────────────────────────

describe('GET /api/projects/:projectId/load-tests', () => {
  it('returns 403 when caller lacks load-test:view (TBI-004 DoD-3, VT-08)', async () => {
    mockPermissions = new Set(); // no permissions

    const res = await request(buildApp()).get(BASE);
    expect(res.status).toBe(403);
  });

  it('returns 200 with items when caller has load-test:view', async () => {
    mockPermissions = new Set(['load-test:view']);
    mockSvc.listDefinitions.mockResolvedValue([stubDefinition as any]);

    const res = await request(buildApp()).get(BASE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [stubDefinition] });
  });
});

// ── POST / — create ───────────────────────────────────────────────────────────

describe('POST /api/projects/:projectId/load-tests', () => {
  const createBody = {
    name: 'My Test',
    script: 'export default function() {}',
    targetUrl: 'https://staging.example.com',
    environment: 'staging',
    loadProfile: { vus: 10, durationMinutes: 5 },
    clientThresholds: [],
  };

  // VT-09 / TBI-004 DoD-3: manage required
  it('returns 403 when caller only has load-test:view (VT-09, TBI-004 DoD-3)', async () => {
    mockPermissions = new Set(['load-test:view']);

    const res = await request(buildApp()).post(BASE).send(createBody);
    expect(res.status).toBe(403);
    expect(mockSvc.createDefinition).not.toHaveBeenCalled();
  });

  // PBI-004 AC-0 (route): 201 + body for authorized caller
  it('returns 201 + definition body when caller has load-test:manage (AC-0)', async () => {
    mockPermissions = new Set(['load-test:manage']);
    mockSvc.createDefinition.mockResolvedValue(stubDefinition as any);

    const res = await request(buildApp()).post(BASE).send(createBody);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(DEF_ID);
    expect(res.body.projectId).toBe(PROJECT);
  });

  // PBI-004 AC-1 (route): 422 for cap exceeded
  it('returns 422 LOAD_TEST_PROFILE_CAP_EXCEEDED for over-cap profile (AC-1)', async () => {
    mockPermissions = new Set(['load-test:manage']);
    mockSvc.createDefinition.mockRejectedValue(
      new LoadTestValidationError('VU count exceeds cap', 'LOAD_TEST_PROFILE_CAP_EXCEEDED'),
    );

    const res = await request(buildApp()).post(BASE).send({ ...createBody, loadProfile: { vus: 999999, durationMinutes: 5 } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LOAD_TEST_PROFILE_CAP_EXCEEDED');
  });

  // PBI-004 AC-3 (route): 422 for plaintext secret
  it('returns 422 LOAD_TEST_PLAINTEXT_SECRET for plaintext credentials (AC-3)', async () => {
    mockPermissions = new Set(['load-test:manage']);
    mockSvc.createDefinition.mockRejectedValue(
      new LoadTestValidationError('Plaintext secret detected', 'LOAD_TEST_PLAINTEXT_SECRET'),
    );

    const res = await request(buildApp()).post(BASE).send({ ...createBody, secretRefs: { Authorization: 'Bearer secret' } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LOAD_TEST_PLAINTEXT_SECRET');
  });

  // Target not allowlisted
  it('returns 422 LOAD_TEST_TARGET_NOT_ALLOWLISTED for non-allowlisted target', async () => {
    mockPermissions = new Set(['load-test:manage']);
    mockSvc.createDefinition.mockRejectedValue(
      new LoadTestValidationError('Target not allowlisted', 'LOAD_TEST_TARGET_NOT_ALLOWLISTED'),
    );

    const res = await request(buildApp()).post(BASE).send(createBody);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LOAD_TEST_TARGET_NOT_ALLOWLISTED');
  });
});

// ── GET /:id — get by id ──────────────────────────────────────────────────────

describe('GET /api/projects/:projectId/load-tests/:id', () => {
  it('returns 403 without load-test:view', async () => {
    mockPermissions = new Set();

    const res = await request(buildApp()).get(`${BASE}/${DEF_ID}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 + definition when found (TBI-004 DoD-0)', async () => {
    mockPermissions = new Set(['load-test:view']);
    mockSvc.getDefinition.mockResolvedValue(stubDefinition as any);

    const res = await request(buildApp()).get(`${BASE}/${DEF_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(DEF_ID);
  });

  // VT-07: missing id → 404
  it('returns 404 when definition not found (VT-07)', async () => {
    mockPermissions = new Set(['load-test:view']);
    mockSvc.getDefinition.mockResolvedValue(null);

    const res = await request(buildApp()).get(`${BASE}/missing-id`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('LOAD_TEST_NOT_FOUND');
  });
});

// ── PATCH /:id — update ───────────────────────────────────────────────────────

describe('PATCH /api/projects/:projectId/load-tests/:id', () => {
  it('returns 403 when caller only has view permission', async () => {
    mockPermissions = new Set(['load-test:view']);

    const res = await request(buildApp()).patch(`${BASE}/${DEF_ID}`).send({ name: 'Updated' });
    expect(res.status).toBe(403);
    expect(mockSvc.updateDefinition).not.toHaveBeenCalled();
  });

  it('returns 200 + updated definition for manage-permission caller', async () => {
    mockPermissions = new Set(['load-test:manage']);
    mockSvc.updateDefinition.mockResolvedValue({ ...stubDefinition, name: 'Updated' } as any);

    const res = await request(buildApp()).patch(`${BASE}/${DEF_ID}`).send({ name: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated');
  });
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────

describe('DELETE /api/projects/:projectId/load-tests/:id', () => {
  it('returns 403 without load-test:manage', async () => {
    mockPermissions = new Set(['load-test:view']);

    const res = await request(buildApp()).delete(`${BASE}/${DEF_ID}`);
    expect(res.status).toBe(403);
  });

  it('returns 204 on successful delete (TBI-004 DoD-0)', async () => {
    mockPermissions = new Set(['load-test:manage']);
    mockSvc.deleteDefinition.mockResolvedValue(true);

    const res = await request(buildApp()).delete(`${BASE}/${DEF_ID}`);
    expect(res.status).toBe(204);
  });

  it('returns 404 when definition not found', async () => {
    mockPermissions = new Set(['load-test:manage']);
    mockSvc.deleteDefinition.mockResolvedValue(false);

    const res = await request(buildApp()).delete(`${BASE}/missing-id`);
    expect(res.status).toBe(404);
  });

  // A-009: active run blocks delete
  it('returns 409 LOAD_TEST_ACTIVE_RUN when active run exists (A-009)', async () => {
    mockPermissions = new Set(['load-test:manage']);
    mockSvc.deleteDefinition.mockRejectedValue(
      new LoadTestValidationError('Active run exists', 'LOAD_TEST_ACTIVE_RUN'),
    );

    const res = await request(buildApp()).delete(`${BASE}/${DEF_ID}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOAD_TEST_ACTIVE_RUN');
  });
});

// ── GET /:id/portable ────────────────────────────────────────────────────────

describe('GET /api/projects/:projectId/load-tests/:id/portable', () => {
  // PBI-005 AC-3: 403 without load-test:view
  it('returns 403 when caller lacks load-test:view (AC-3)', async () => {
    mockPermissions = new Set();

    const res = await request(buildApp()).get(`${BASE}/${DEF_ID}/portable`);
    expect(res.status).toBe(403);
    expect(mockSvc.getPortable).not.toHaveBeenCalled();
  });

  // PBI-005 AC-0: returns script + thresholds
  it('returns 200 + portable body with script and thresholds (AC-0)', async () => {
    mockPermissions = new Set(['load-test:view']);
    mockSvc.getPortable.mockResolvedValue(stubPortable as any);

    const res = await request(buildApp()).get(`${BASE}/${DEF_ID}/portable`);
    expect(res.status).toBe(200);
    expect(res.body.script).toBeDefined();
    expect(res.body.clientThresholds).toBeDefined();
    // Secrets must not be present (PBI-005 AC-1)
    expect(res.body.secretRefs).toBeUndefined();
  });

  // PBI-005 AC-2: missing / cross-project id → 404 (no script body)
  it('returns 404 with no script body when definition not in project (AC-2)', async () => {
    mockPermissions = new Set(['load-test:view']);
    mockSvc.getPortable.mockResolvedValue(null);

    const res = await request(buildApp()).get(`${BASE}/missing-id/portable`);
    expect(res.status).toBe(404);
    expect(res.body.script).toBeUndefined();
  });
});

// ── POST /:definitionId/runs — FEAT-003 stub still enforces load-test:run ─────

describe('POST /api/projects/:projectId/load-tests/:definitionId/runs', () => {
  it('returns 403 when caller lacks load-test:run (FEAT-003 AC-d)', async () => {
    mockPermissions = new Set(['load-test:view']);

    const res = await request(buildApp()).post(`${BASE}/${DEF_ID}/runs`).send({});
    expect(res.status).toBe(403);
  });

  it('returns 501 when caller has load-test:run (stub pending FEAT-007)', async () => {
    mockPermissions = new Set(['load-test:run']);

    const res = await request(buildApp()).post(`${BASE}/${DEF_ID}/runs`).send({});
    expect(res.status).toBe(501);
  });
});
