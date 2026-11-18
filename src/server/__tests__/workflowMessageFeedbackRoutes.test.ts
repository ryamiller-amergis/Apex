/**
 * Per-message feedback routes under /api/projects/:projectId/workflow-evaluations.
 */
import request from 'supertest';
import express from 'express';

let permissionGranted = true;
let flagEnabled = true;

jest.mock('../middleware/rbac', () => {
  const actual = jest.requireActual('../middleware/rbac') as {
    resolveRequestProject: (req: express.Request) => string | undefined;
  };
  return {
    requirePermission: (...keys: string[]) =>
      (_req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (!permissionGranted) {
          res.status(403).json({ error: 'Forbidden', missing: keys });
          return;
        }
        next();
      },
    requireProjectAccess: () =>
      (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    resolveRequestProject: actual.resolveRequestProject,
  };
});

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(async () => flagEnabled),
  isFeatureOperational: jest.fn(async () => flagEnabled),
}));

jest.mock('../services/workflowEvaluationService', () => ({}));
jest.mock('../services/workflowEvaluationJobOrchestrator', () => ({
  createWorkflowEvaluationJobOrchestrator: () => ({ retryJob: jest.fn() }),
  registerWorkflowEvaluationJobListener: jest.fn(),
}));
jest.mock('../services/skillRegressionCaseService', () => ({
  registerSkillRegressionCaseListener: jest.fn(),
}));

jest.mock('../services/workflowMessageFeedbackService', () => {
  const actual = jest.requireActual('../services/workflowMessageFeedbackService');
  return {
    ...actual,
    listMyMessageFeedback: jest.fn(),
    putMessageFeedback: jest.fn(),
  };
});

import workflowEvaluationsRouter from '../routes/workflowEvaluations';
import { WorkflowMessageFeedbackError } from '../services/workflowMessageFeedbackService';

const service = jest.requireMock('../services/workflowMessageFeedbackService') as Record<string, jest.Mock>;

const interviewId = '22222222-2222-4222-8222-222222222222';
const messageId = '33333333-3333-4333-8333-333333333333';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: unknown }).user = { profile: { oid: 'user-1', displayName: 'Ada' } };
    next();
  });
  app.use('/api/projects/:projectId/workflow-evaluations', workflowEvaluationsRouter);
  return app;
}

const base = '/api/projects/proj-a/workflow-evaluations/message-feedback';

beforeEach(() => {
  jest.clearAllMocks();
  permissionGranted = true;
  flagEnabled = true;
  service.listMyMessageFeedback.mockResolvedValue({ surface: 'interview', subjectId: interviewId, entries: [] });
  service.putMessageFeedback.mockResolvedValue({
    entry: { messageId, rating: 'up', comment: null, updatedAt: '2026-10-22T12:00:00.000Z' },
  });
});

describe('message feedback routes', () => {
  it('lists the caller’s ratings for an interview', async () => {
    const res = await request(buildApp()).get(base).query({ surface: 'interview', subjectId: interviewId });
    expect(res.status).toBe(200);
    expect(service.listMyMessageFeedback).toHaveBeenCalledWith('proj-a', 'user-1', 'interview', interviewId);
  });

  it('rejects an unknown surface or a bad subject id', async () => {
    const app = buildApp();
    expect((await request(app).get(base).query({ surface: 'email', subjectId: interviewId })).status).toBe(422);
    expect((await request(app).get(base).query({ surface: 'interview', subjectId: 'nope' })).status).toBe(422);
    expect(service.listMyMessageFeedback).not.toHaveBeenCalled();
  });

  it('saves a thumbs rating with the path project and session user', async () => {
    const res = await request(buildApp())
      .put(`${base}/${messageId}`)
      .send({ surface: 'interview', subjectId: interviewId, rating: 'up' });
    expect(res.status).toBe(200);
    expect(res.body.entry.rating).toBe('up');
    expect(service.putMessageFeedback).toHaveBeenCalledWith('proj-a', 'user-1', messageId, {
      surface: 'interview',
      subjectId: interviewId,
      rating: 'up',
      comment: null,
    });
  });

  it('clears a rating when rating is null', async () => {
    service.putMessageFeedback.mockResolvedValue({ entry: null });
    const res = await request(buildApp())
      .put(`${base}/${messageId}`)
      .send({ surface: 'interview', subjectId: interviewId, rating: null });
    expect(res.status).toBe(200);
    expect(res.body.entry).toBeNull();
  });

  it('rejects chat ratings on an interview, and a comment on an interview rating', async () => {
    const app = buildApp();
    const wrongRating = await request(app)
      .put(`${base}/${messageId}`)
      .send({ surface: 'interview', subjectId: interviewId, rating: 'good' });
    expect(wrongRating.status).toBe(422);
    expect(wrongRating.body.code).toBe('INVALID_RATING');
    const withComment = await request(app)
      .put(`${base}/${messageId}`)
      .send({ surface: 'interview', subjectId: interviewId, rating: 'down', comment: 'meh' });
    expect(withComment.status).toBe(422);
    expect(service.putMessageFeedback).not.toHaveBeenCalled();
  });

  it('maps service errors to their status, e.g. 409 once the interview is complete', async () => {
    service.putMessageFeedback.mockRejectedValue(
      new WorkflowMessageFeedbackError(409, 'SUBJECT_CLOSED', 'Ratings are closed for this interview.'),
    );
    const res = await request(buildApp())
      .put(`${base}/${messageId}`)
      .send({ surface: 'interview', subjectId: interviewId, rating: 'up' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Ratings are closed for this interview.', code: 'SUBJECT_CLOSED' });
  });

  it('answers 403 without the permission and 404 when the flag is off', async () => {
    permissionGranted = false;
    expect((await request(buildApp()).get(base).query({ surface: 'interview', subjectId: interviewId })).status)
      .toBe(403);
    permissionGranted = true;
    flagEnabled = false;
    expect((await request(buildApp())
      .put(`${base}/${messageId}`)
      .send({ surface: 'interview', subjectId: interviewId, rating: 'up' })).status).toBe(404);
    expect(service.putMessageFeedback).not.toHaveBeenCalled();
  });
});
