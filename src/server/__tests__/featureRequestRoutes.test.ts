import express from 'express';
import request from 'supertest';
import featureRequestsRouter from '../routes/featureRequests';

jest.mock('../middleware/rbac', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  resolveRequestProject: (req: any) => (req.query?.project as string) || (req.body?.project as string) || req.get?.('x-apex-project') || undefined,
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: () => 'user-1',
}));

jest.mock('../services/featureRequestService', () => ({
  createFeatureRequest: jest.fn(),
  listFeatureRequests: jest.fn(),
  getFeatureRequest: jest.fn(),
  listAcceptedAdrsForProject: jest.fn(),
  updateFeatureRequest: jest.fn(),
  linkInterview: jest.fn(),
  resolveFeatureRequestReviewers: jest.fn(),
}));

jest.mock('../services/featureRequestAnalysisService', () => ({
  autoStartFeatureRequestAnalysis: jest.fn().mockResolvedValue(undefined),
  reanalyzeFeatureRequest: jest.fn(),
}));

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

const featureRequestService = jest.requireMock(
  '../services/featureRequestService'
) as {
  createFeatureRequest: jest.Mock;
  listFeatureRequests: jest.Mock;
  getFeatureRequest: jest.Mock;
  resolveFeatureRequestReviewers: jest.Mock;
};
const analysisService = jest.requireMock(
  '../services/featureRequestAnalysisService'
) as {
  autoStartFeatureRequestAnalysis: jest.Mock;
};
const notificationService = jest.requireMock(
  '../services/notificationService'
) as {
  createNotification: jest.Mock;
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/feature-requests', featureRequestsRouter);
  return app;
}

describe('feature request work item submission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    featureRequestService.resolveFeatureRequestReviewers.mockResolvedValue([
      'reviewer-1',
    ]);
  });

  it('rejects an unsupported work item type', async () => {
    const response = await request(buildApp())
      .post('/api/feature-requests')
      .send({
        type: 'bug',
        title: 'Broken behavior',
        request: 'Something failed',
        project: 'Apex',
      });

    expect(response.status).toBe(400);
    expect(featureRequestService.createFeatureRequest).not.toHaveBeenCalled();
  });

  it('creates and routes an issue without requiring advantage', async () => {
    featureRequestService.createFeatureRequest.mockResolvedValue({
      id: 'issue-1',
      type: 'issue',
      title: 'Save fails',
    });

    const response = await request(buildApp())
      .post('/api/feature-requests')
      .send({
        type: 'issue',
        title: 'Save fails',
        request: 'Saving a PRD returns an error',
        project: 'Apex',
      });

    expect(response.status).toBe(201);
    expect(featureRequestService.createFeatureRequest).toHaveBeenCalledWith(
      'user-1',
      'Apex',
      {
        type: 'issue',
        title: 'Save fails',
        request: 'Saving a PRD returns an error',
        advantage: null,
        adrIds: undefined,
      }
    );
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      'reviewer-1',
      expect.objectContaining({ title: 'New issue reported' })
    );
    expect(
      analysisService.autoStartFeatureRequestAnalysis
    ).toHaveBeenCalledWith('issue-1');
  });

  it('passes ADR associations through for technical requests', async () => {
    featureRequestService.createFeatureRequest.mockResolvedValue({
      id: 'technical-1',
      type: 'technical',
      title: 'Refactor queue',
    });
    const adrId = '11111111-1111-4111-8111-111111111111';

    const response = await request(buildApp())
      .post('/api/feature-requests')
      .send({
        type: 'technical',
        title: 'Refactor queue',
        request: 'Replace direct dispatch',
        project: 'Apex',
        adrIds: [adrId],
      });

    expect(response.status).toBe(201);
    expect(featureRequestService.createFeatureRequest).toHaveBeenCalledWith(
      'user-1',
      'Apex',
      expect.objectContaining({ type: 'technical', adrIds: [adrId] }),
    );
  });
});

describe('per-project backlog listing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    featureRequestService.listFeatureRequests.mockResolvedValue([
      { id: 'request-1', title: 'Some request' },
    ]);
  });

  it('passes project to listFeatureRequests for filtering', async () => {
    const response = await request(buildApp())
      .get('/api/feature-requests?project=Amego');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { id: 'request-1', title: 'Some request' },
    ]);
    expect(featureRequestService.listFeatureRequests).toHaveBeenCalledWith('Amego');
  });

  it('passes Apex project for Apex backlog', async () => {
    const response = await request(buildApp())
      .get('/api/feature-requests?project=Apex');

    expect(response.status).toBe(200);
    expect(featureRequestService.listFeatureRequests).toHaveBeenCalledWith('Apex');
  });

  it('requires the selected project query parameter', async () => {
    const response = await request(buildApp()).get('/api/feature-requests');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/project query parameter is required/i);
    expect(featureRequestService.listFeatureRequests).not.toHaveBeenCalled();
  });
});

describe('cross-project isolation on single-item endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /:id returns 404 when sourceProject does not match active project', async () => {
    featureRequestService.getFeatureRequest = jest.fn().mockResolvedValue({
      id: 'req-1',
      sourceProject: 'Apex',
      title: 'Apex item',
    });

    const response = await request(buildApp())
      .get('/api/feature-requests/req-1?project=Amego');

    expect(response.status).toBe(404);
  });

  it('GET /:id succeeds when sourceProject matches active project', async () => {
    featureRequestService.getFeatureRequest = jest.fn().mockResolvedValue({
      id: 'req-1',
      sourceProject: 'Amego',
      title: 'Amego item',
    });

    const response = await request(buildApp())
      .get('/api/feature-requests/req-1?project=Amego');

    expect(response.status).toBe(200);
    expect(response.body.title).toBe('Amego item');
  });
});
