import express from 'express';
import request from 'supertest';
import featureRequestsRouter from '../routes/featureRequests';

jest.mock('../middleware/rbac', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: () => 'user-1',
}));

jest.mock('../services/featureRequestService', () => ({
  createFeatureRequest: jest.fn(),
  listFeatureRequests: jest.fn(),
  getFeatureRequest: jest.fn(),
  updateFeatureRequest: jest.fn(),
  linkInterview: jest.fn(),
  resolveApexReviewers: jest.fn(),
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
  resolveApexReviewers: jest.Mock;
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
    featureRequestService.resolveApexReviewers.mockResolvedValue([
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
});
