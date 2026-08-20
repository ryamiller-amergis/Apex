import express from 'express';
import request from 'supertest';

jest.mock('../utils/requestUser', () => ({
  getUserId: () => 'triage-1',
}));

jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: () => false,
}));

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn().mockResolvedValue(true),
}));

jest.mock('../middleware/rbac', () => ({
  requirePermission: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers['x-deny'] === '1') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  },
}));

jest.mock('../services/rfpIntakeService', () => {
  const actual = jest.requireActual('../services/rfpIntakeService');
  return {
    ...actual,
    listTriageRequests: jest.fn(),
    getTriageDetail: jest.fn(),
    transitionStatus: jest.fn(),
    reopenRequest: jest.fn(),
    retryEvaluation: jest.fn(),
    reevaluate: jest.fn(),
    addComment: jest.fn(),
    addAttachment: jest.fn(),
    getAttachment: jest.fn(),
    listMentionCandidates: jest.fn(),
    resolveRfpSubmissionRecipients: jest.fn().mockResolvedValue([]),
    setRfpEvaluationNotificationHook: jest.fn(),
    dispatchRfpNotifications: jest.fn(),
  };
});

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

import rfpIntakeRouter from '../routes/rfpIntake';
import { isFeatureEnabled } from '../services/featureFlagService';
import {
  getTriageDetail,
  listTriageRequests,
  reopenRequest,
  RfpIntakeError,
  transitionStatus,
} from '../services/rfpIntakeService';

const mockedList = listTriageRequests as jest.MockedFunction<typeof listTriageRequests>;
const mockedDetail = getTriageDetail as jest.MockedFunction<typeof getTriageDetail>;
const mockedTransition = transitionStatus as jest.MockedFunction<typeof transitionStatus>;
const mockedReopen = reopenRequest as jest.MockedFunction<typeof reopenRequest>;
const mockedFlag = isFeatureEnabled as jest.MockedFunction<typeof isFeatureEnabled>;

const DETAIL = {
  id: 'rfp-1',
  ownerId: 'owner-1',
  title: 'Internal intake tracker',
  status: 'in-review',
  comments: [],
  attachments: [],
  activity: [{ id: 'evt-1', rfpRequestId: 'rfp-1', eventType: 'status-changed', actorId: 'triage-1', payload: { to: 'accepted' }, createdAt: '2026-08-19T12:00:00.000Z' }],
  evaluations: [],
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rfp-intake', rfpIntakeRouter);
  app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' });
  });
  return app;
}

describe('RFP intake triage routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFlag.mockResolvedValue(true);
    mockedList.mockResolvedValue({ items: [], total: 0 });
    mockedDetail.mockResolvedValue(DETAIL as never);
    mockedTransition.mockResolvedValue(DETAIL as never);
    mockedReopen.mockResolvedValue(DETAIL as never);
  });

  it('VT-04 AC-3 returns 403 with no RFP data when view permission is missing', async () => {
    const response = await request(buildApp())
      .get('/api/rfp-intake/triage/requests')
      .set('x-deny', '1');

    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('items');
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('VT-02 AC-1 returns 409 and does not claim a transition when the service rejects it', async () => {
    mockedTransition.mockRejectedValue(new RfpIntakeError('Invalid status transition', 409, 'INVALID_TRANSITION'));

    const response = await request(buildApp())
      .patch('/api/rfp-intake/triage/requests/rfp-1/status')
      .send({ target: 'accepted' });

    expect(response.status).toBe(409);
    expect(response.body).not.toHaveProperty('activity');
  });

  it('PBI-005 AC-0 returns updated detail after a valid decision', async () => {
    const response = await request(buildApp())
      .patch('/api/rfp-intake/triage/requests/rfp-1/status')
      .send({ target: 'accepted', note: 'Fits Apex' });

    expect(response.status).toBe(200);
    expect(mockedTransition).toHaveBeenCalledWith('rfp-1', 'accepted', 'triage-1', expect.objectContaining({
      note: 'Fits Apex',
    }));
    expect(response.body.activity).toHaveLength(1);
  });

  it('PBI-005 AC-2 reopens through the audited endpoint', async () => {
    const response = await request(buildApp())
      .post('/api/rfp-intake/triage/requests/rfp-1/reopen')
      .send({ reason: 'Need more discussion' });

    expect(response.status).toBe(200);
    expect(mockedReopen).toHaveBeenCalledWith('rfp-1', 'triage-1', 'Need more discussion', expect.any(Object));
  });

  it('returns 404 for triage routes when the rfp-intake flag is off', async () => {
    mockedFlag.mockResolvedValue(false);
    const response = await request(buildApp()).get('/api/rfp-intake/triage/requests');
    expect(response.status).toBe(404);
    expect(mockedList).not.toHaveBeenCalled();
  });
});
