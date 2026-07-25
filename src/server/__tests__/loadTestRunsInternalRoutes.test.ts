/**
 * Internal ingest route tests — FEAT-007 / PBI-009 (session-free runner path)
 */
import request from 'supertest';
import express from 'express';
import loadTestRunsInternalRouter from '../routes/loadTestRunsInternal';
import * as loadTestRunService from '../services/loadTestRunService';

jest.mock('../services/loadTestRunService', () => ({
  ingest: jest.fn(),
}));

const mockIngest = loadTestRunService.ingest as jest.MockedFunction<
  typeof loadTestRunService.ingest
>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/load-test-runs', loadTestRunsInternalRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.LT_RUNNER_CALLBACK_TOKEN = 'runner-secret';
});

describe('POST /api/internal/load-test-runs/:projectId/:runId/ingest', () => {
  it('AC-1: rejects missing/invalid runner token without mutating', async () => {
    const res = await request(buildApp())
      .post('/api/internal/load-test-runs/project-a/run-1/ingest')
      .send({ dispatchMessageId: 'm1', kind: 'progress' });

    expect(res.status).toBe(401);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('accepts valid runner token (pipeline-forward contract)', async () => {
    mockIngest.mockResolvedValue({
      id: 'run-1',
      projectId: 'project-a',
      loadTestId: 'def-1',
      status: 'running',
      runSource: 'pipeline',
      queuedAt: new Date().toISOString(),
      cancelRequested: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);

    const res = await request(buildApp())
      .post('/api/internal/load-test-runs/project-a/run-1/ingest')
      .set('Authorization', 'Bearer runner-secret')
      .send({ dispatchMessageId: 'm1', kind: 'progress' });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(mockIngest).toHaveBeenCalledWith(
      'project-a',
      'run-1',
      expect.objectContaining({ kind: 'progress' }),
    );
  });
});
