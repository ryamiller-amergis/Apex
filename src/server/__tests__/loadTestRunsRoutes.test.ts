/**
 * Route tests — FEAT-007 load test run lifecycle
 *
 * PBI-008 AC-3 (403), cancel negative, PBI-009 AC-1/AC-3 (ingest auth + project scope)
 */
import request from 'supertest';
import express from 'express';
import loadTestRouter from '../routes/loadTests';
import * as loadTestRunService from '../services/loadTestRunService';
import { LoadTestValidationError } from '../../shared/types/loadTest';

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
      if (keys.some((k) => mockPermissions.has(k))) next();
      else res.status(403).json({ error: 'Forbidden' });
    },
}));

jest.mock('../services/loadTestService', () => ({
  listDefinitions: jest.fn(),
  createDefinition: jest.fn(),
  getDefinition: jest.fn(),
  updateDefinition: jest.fn(),
  deleteDefinition: jest.fn(),
  getPortable: jest.fn(),
}));

jest.mock('../services/loadTestRunService', () => ({
  enqueue: jest.fn(),
  listRuns: jest.fn(),
  getRun: jest.fn(),
  cancel: jest.fn(),
  ingest: jest.fn(),
  subscribeRunProgress: jest.fn(() => () => undefined),
}));

const mockRunSvc = loadTestRunService as jest.Mocked<typeof loadTestRunService>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { profile: { oid: 'user-1' } };
    next();
  });
  app.use('/api/projects/:projectId/load-tests', loadTestRouter);
  return app;
}

const PROJECT = 'project-a';
const OTHER = 'project-b';
const BASE = `/api/projects/${PROJECT}/load-tests`;
const RUN_ID = 'run-1';
const NOW = new Date().toISOString();

const stubRun = {
  id: RUN_ID,
  projectId: PROJECT,
  loadTestId: 'def-1',
  status: 'running' as const,
  runSource: 'app' as const,
  queuedAt: NOW,
  cancelRequested: false,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPermissions = new Set();
  process.env.LT_RUNNER_CALLBACK_TOKEN = 'test-runner-token';
});

describe('POST /runs/:runId/cancel', () => {
  it('PBI-008 cancel negative: 403 without load-test:run', async () => {
    mockPermissions = new Set(['load-test:view']);
    const res = await request(buildApp()).post(`${BASE}/runs/${RUN_ID}/cancel`);
    expect(res.status).toBe(403);
    expect(mockRunSvc.cancel).not.toHaveBeenCalled();
  });

  it('PBI-008 cancel happy: sets cancel via service', async () => {
    mockPermissions = new Set(['load-test:run']);
    mockRunSvc.cancel.mockResolvedValue({ ...stubRun, cancelRequested: true } as any);

    const res = await request(buildApp()).post(`${BASE}/runs/${RUN_ID}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.run.cancelRequested).toBe(true);
  });
});

describe('GET /runs/:runId', () => {
  it('VT-13: 200 with load-test:view', async () => {
    mockPermissions = new Set(['load-test:view']);
    mockRunSvc.getRun.mockResolvedValue(stubRun as any);

    const res = await request(buildApp()).get(`${BASE}/runs/${RUN_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.run.id).toBe(RUN_ID);
  });

  it('returns 403 without load-test:view', async () => {
    const res = await request(buildApp()).get(`${BASE}/runs/${RUN_ID}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /runs/:runId/ingest', () => {
  it('PBI-009 AC-1: rejects invalid identity; does not call ingest', async () => {
    const res = await request(buildApp())
      .post(`${BASE}/runs/${RUN_ID}/ingest`)
      .set('Authorization', 'Bearer wrong-token')
      .send({
        dispatchMessageId: 'msg-1',
        kind: 'progress',
      });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('LOAD_TEST_RUNNER_UNAUTHORIZED');
    expect(mockRunSvc.ingest).not.toHaveBeenCalled();
  });

  it('PBI-009 AC-0 route: accepts valid runner token', async () => {
    mockRunSvc.ingest.mockResolvedValue({ ...stubRun, status: 'passed' } as any);

    const res = await request(buildApp())
      .post(`${BASE}/runs/${RUN_ID}/ingest`)
      .set('Authorization', 'Bearer test-runner-token')
      .send({
        dispatchMessageId: 'msg-1',
        kind: 'final',
        thresholdResults: [{ metric: 'http_req_failed', expression: 'rate<0.01', passed: true }],
      });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(mockRunSvc.ingest).toHaveBeenCalledWith(
      PROJECT,
      RUN_ID,
      expect.objectContaining({ kind: 'final' }),
    );
  });

  it('PBI-009 AC-3: cross-project miss returns 404 from service; no mutation', async () => {
    mockRunSvc.ingest.mockRejectedValue(
      new LoadTestValidationError(
        'Load test run not found in this project',
        'LOAD_TEST_NOT_FOUND',
      ),
    );

    const res = await request(buildApp())
      .post(`/api/projects/${OTHER}/load-tests/runs/${RUN_ID}/ingest`)
      .set('Authorization', 'Bearer test-runner-token')
      .send({ dispatchMessageId: 'msg-1', kind: 'progress' });

    expect(res.status).toBe(404);
    expect(mockRunSvc.ingest).toHaveBeenCalledWith(
      OTHER,
      RUN_ID,
      expect.any(Object),
    );
  });
});
