/**
 * Route permission tests for FEAT-005 Load Test Target Allowlist
 *
 *   PBI-006 AC-0: POST 201 + list for admin
 *   PBI-006 AC-1: POST 400 LOAD_TEST_TARGET_PROD_REFUSED
 *   PBI-006 AC-2: GET scoped — service receives projectId (isolation)
 *   PBI-006 AC-3 / TBI-005 DoD-2: load-test:manage without admin:roles → 403
 *   TBI-005 DoD-0: PATCH/DELETE require admin:roles
 */

import request from 'supertest';
import express from 'express';
import loadTestTargetsRouter from '../routes/loadTestTargets';
import * as loadTestTargetService from '../services/loadTestTargetService';
import { LoadTestValidationError } from '../../shared/types/loadTest';

let mockPermissions: Set<string> = new Set();

jest.mock('../middleware/rbac', () => ({
  requirePermission: (...keys: string[]) =>
    (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      const missing = keys.filter((k) => !mockPermissions.has(k));
      if (missing.length > 0) {
        res.status(403).json({ error: 'Forbidden', missing });
        return;
      }
      next();
    },
}));

jest.mock('../services/loadTestTargetService', () => ({
  listTargets: jest.fn(),
  createTarget: jest.fn(),
  updateTarget: jest.fn(),
  deleteTarget: jest.fn(),
}));

const mockSvc = loadTestTargetService as jest.Mocked<typeof loadTestTargetService>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res, next) => {
    (req as express.Request & { user?: unknown }).user = {
      profile: { oid: 'user-1', upn: 'user@example.com' },
    };
    next();
  });
  app.use('/api/projects/:projectId/load-test-targets', loadTestTargetsRouter);
  return app;
}

const PROJECT = 'project-a';
const BASE = `/api/projects/${PROJECT}/load-test-targets`;
const NOW = new Date().toISOString();

const stubTarget = {
  id: 'target-1',
  projectId: PROJECT,
  baseUrl: 'https://api.staging.example.internal',
  environmentLabel: 'staging',
  isReachable: true,
  isActive: true,
  createdAt: NOW,
  updatedAt: NOW,
  createdBy: 'user-1',
  updatedBy: 'user-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPermissions = new Set();
});

describe('GET /api/projects/:projectId/load-test-targets', () => {
  it('returns 403 without load-test:view', async () => {
    const res = await request(buildApp()).get(BASE);
    expect(res.status).toBe(403);
  });

  it('AC-2: lists with projectId scope when caller has load-test:view', async () => {
    mockPermissions = new Set(['load-test:view']);
    mockSvc.listTargets.mockResolvedValue([stubTarget]);

    const res = await request(buildApp()).get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].projectId).toBe(PROJECT);
    expect(mockSvc.listTargets).toHaveBeenCalledWith(PROJECT, { includeInactive: false });
  });

  it('passes includeInactive=true for admin UI', async () => {
    mockPermissions = new Set(['load-test:view']);
    mockSvc.listTargets.mockResolvedValue([stubTarget]);

    await request(buildApp()).get(`${BASE}?includeInactive=true`);
    expect(mockSvc.listTargets).toHaveBeenCalledWith(PROJECT, { includeInactive: true });
  });
});

describe('POST /api/projects/:projectId/load-test-targets', () => {
  const payload = {
    baseUrl: 'https://api.staging.example.internal',
    environment: 'staging',
  };

  it('AC-3 / DoD-2: returns 403 when caller has load-test:manage but not admin:roles', async () => {
    mockPermissions = new Set(['load-test:manage', 'load-test:view']);
    const res = await request(buildApp()).post(BASE).send(payload);
    expect(res.status).toBe(403);
    expect(mockSvc.createTarget).not.toHaveBeenCalled();
  });

  it('AC-0: returns 201 + item when caller has admin:roles', async () => {
    mockPermissions = new Set(['admin:roles']);
    mockSvc.createTarget.mockResolvedValue(stubTarget);

    const res = await request(buildApp()).post(BASE).send(payload);
    expect(res.status).toBe(201);
    expect(res.body.item.baseUrl).toBe(stubTarget.baseUrl);
    expect(mockSvc.createTarget).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({
        baseUrl: payload.baseUrl,
        environmentLabel: 'staging',
      }),
      'user-1',
    );
  });

  it('AC-1: returns 400 LOAD_TEST_TARGET_PROD_REFUSED and does not leave a row', async () => {
    mockPermissions = new Set(['admin:roles']);
    mockSvc.createTarget.mockRejectedValue(
      new LoadTestValidationError(
        'Production refused',
        'LOAD_TEST_TARGET_PROD_REFUSED',
      ),
    );

    const res = await request(buildApp())
      .post(BASE)
      .send({ baseUrl: 'https://api.staging.example.com', environment: 'prod' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOAD_TEST_TARGET_PROD_REFUSED');
  });
});

describe('PATCH / DELETE require admin:roles (DoD-0 / DoD-2)', () => {
  it('PATCH returns 403 without admin:roles even with load-test:manage', async () => {
    mockPermissions = new Set(['load-test:manage']);
    const res = await request(buildApp()).patch(`${BASE}/target-1`).send({ reachable: false });
    expect(res.status).toBe(403);
    expect(mockSvc.updateTarget).not.toHaveBeenCalled();
  });

  it('DELETE returns 403 without admin:roles', async () => {
    mockPermissions = new Set(['load-test:view']);
    const res = await request(buildApp()).delete(`${BASE}/target-1`);
    expect(res.status).toBe(403);
    expect(mockSvc.deleteTarget).not.toHaveBeenCalled();
  });

  it('DELETE returns 204 when admin deletes', async () => {
    mockPermissions = new Set(['admin:roles']);
    mockSvc.deleteTarget.mockResolvedValue(true);
    const res = await request(buildApp()).delete(`${BASE}/target-1`);
    expect(res.status).toBe(204);
  });
});
