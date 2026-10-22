jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../db', () => ({ __esModule: true, default: { end: jest.fn(), on: jest.fn() } }));

const mockGetUserPermissions = jest.fn();
jest.mock('../services/rbacService', () => ({
  getUserPermissions: (...args: unknown[]) => mockGetUserPermissions(...args),
}));

jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: () => false,
  getAppEnvironment: () => 'local',
}));

const mockIsFeatureEnabled = jest.fn();
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

const mockGetStepOutput = jest.fn();
jest.mock('../services/playbookStepOutputService', () => {
  class PlaybookStepOutputNotFoundError extends Error {}
  return {
    PlaybookStepOutputNotFoundError,
    getPlaybookStepOutput: (...args: unknown[]) => mockGetStepOutput(...args),
  };
});

import express from 'express';
import request from 'supertest';
import playbooksRouter from '../routes/playbooks';
import { PlaybookStepOutputNotFoundError } from '../services/playbookStepOutputService';

const PROJECT = 'Apex';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { profile: { oid: 'viewer-1' } };
    next();
  });
  app.use('/api/playbooks', playbooksRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserPermissions.mockResolvedValue(new Set(['playbooks:view']));
  mockIsFeatureEnabled.mockResolvedValue(true);
  mockGetStepOutput.mockResolvedValue({
    value: { reportMd: '# Ready', verdict: 'ready' },
    blobRef: null,
  });
});

describe('Playbook step output route', () => {
  it('passes project, run, step, and part to the scoped output service', async () => {
    const response = await request(buildApp())
      .get('/api/playbooks/runs/run-1/steps/step-run-1/output')
      .query({ project: PROJECT, part: 'scorecard' });

    expect(response.status).toBe(200);
    expect(mockGetStepOutput).toHaveBeenCalledWith({
      project: PROJECT,
      runId: 'run-1',
      stepRunId: 'step-run-1',
      part: 'scorecard',
    });
  });

  it('returns no output metadata while the rollout flag is disabled', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);

    const response = await request(buildApp())
      .get('/api/playbooks/runs/run-1/steps/step-run-1/output')
      .query({ project: PROJECT });

    expect(response.status).toBe(404);
    expect(mockGetStepOutput).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain('step-run-1');
  });

  it('rejects unsupported output parts before reading storage', async () => {
    const response = await request(buildApp())
      .get('/api/playbooks/runs/run-1/steps/step-run-1/output')
      .query({ project: PROJECT, part: 'transcript' });

    expect(response.status).toBe(400);
    expect(mockGetStepOutput).not.toHaveBeenCalled();
  });

  it('does not distinguish a missing output from a cross-project output', async () => {
    mockGetStepOutput.mockRejectedValue(new PlaybookStepOutputNotFoundError());

    const response = await request(buildApp())
      .get('/api/playbooks/runs/run-1/steps/step-run-1/output')
      .query({ project: PROJECT });

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('run-1');
  });

  it('requires playbooks:view in the requested project', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set());

    const response = await request(buildApp())
      .get('/api/playbooks/runs/run-1/steps/step-run-1/output')
      .query({ project: PROJECT });

    expect(response.status).toBe(403);
    expect(mockGetStepOutput).not.toHaveBeenCalled();
  });
});
