jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../db', () => ({ __esModule: true, default: { end: jest.fn(), on: jest.fn() } }));

jest.mock('../utils/superAdmin', () => ({
  getAppEnvironment: () => 'local',
  isSuperAdminRequest: jest.fn().mockReturnValue(false),
}));
jest.mock('../services/rbacService', () => ({
  getUserPermissions: jest.fn().mockResolvedValue(new Set()),
}));

const cancelPlaybookRun = jest.fn();
const retryPlaybookStep = jest.fn();
jest.mock('../services/playbookRunActionService', () => ({
  ...jest.requireActual('../services/playbookRunActionService'),
  cancelPlaybookRun: (...args: unknown[]) => cancelPlaybookRun(...args),
  retryPlaybookStep: (...args: unknown[]) => retryPlaybookStep(...args),
}));

import express from 'express';
import request from 'supertest';
import playbooksRouter from '../routes/playbooks';
import {
  PlaybookRunActionConflictError,
  PlaybookRunActionForbiddenError,
  PlaybookRunActionNotFoundError,
} from '../services/playbookRunActionService';

function app(authenticated = true) {
  const instance = express();
  instance.use(express.json());
  if (authenticated) {
    instance.use((req, _res, next) => {
      (req as unknown as { user: unknown }).user = { profile: { oid: 'actor' } };
      next();
    });
  }
  instance.use('/api/playbooks', playbooksRouter);
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
  cancelPlaybookRun.mockResolvedValue({
    runId: 'run-1',
    status: 'cancelled',
    outcome: 'cancelled',
  });
  retryPlaybookStep.mockResolvedValue({
    runId: 'run-1',
    stepRunId: 'step-1',
    status: 'running',
    outcome: 'retried',
  });
});

describe('S6 Playbook run action routes', () => {
  it('VT-20 forwards authenticated cancel and retry without playbooks:run middleware', async () => {
    const cancel = await request(app())
      .post('/api/playbooks/runs/run-1/cancel')
      .send({ project: 'Apex', reason: ' stop ' });
    const retry = await request(app())
      .post('/api/playbooks/runs/run-1/steps/step-1/retry')
      .send({ project: 'Apex' });

    expect(cancel.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(cancelPlaybookRun).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'actor', project: 'Apex', reason: 'stop' })
    );
    expect(retryPlaybookStep).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'actor', project: 'Apex' })
    );
  });

  it.each([
    [new PlaybookRunActionForbiddenError(), 403],
    [new PlaybookRunActionNotFoundError(), 404],
    [new PlaybookRunActionConflictError('stale'), 409],
  ])('maps service errors exactly', async (error, status) => {
    cancelPlaybookRun.mockRejectedValue(error);
    const response = await request(app())
      .post('/api/playbooks/runs/run-1/cancel')
      .send({ project: 'Apex' });
    expect(response.status).toBe(status);
  });

  it('returns 400 for malformed action bodies and 401 without an actor', async () => {
    const malformed = await request(app())
      .post('/api/playbooks/runs/run-1/cancel')
      .send({ project: 'Apex', reason: 42 });
    const anonymous = await request(app(false))
      .post('/api/playbooks/runs/run-1/cancel')
      .send({ project: 'Apex' });

    expect(malformed.status).toBe(400);
    expect(anonymous.status).toBe(401);
    expect(cancelPlaybookRun).not.toHaveBeenCalled();
  });
});
