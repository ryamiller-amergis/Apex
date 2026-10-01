import express from 'express';
import request from 'supertest';

jest.mock('../utils/requestUser', () => ({
  getUserId: () => 'user-1',
}));

jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: (req: express.Request) => req.headers['x-super'] === '1',
}));

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn().mockResolvedValue(true),
}));

jest.mock('../middleware/rbac', () => ({
  requirePermission: (key: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const denied = String(req.headers['x-deny'] ?? '').split(',');
    if (denied.includes(key)) {
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
    createRequest: jest.fn(),
    resolveRfpSubmissionRecipients: jest.fn().mockResolvedValue([]),
    setRfpEvaluationNotificationHook: jest.fn(),
    dispatchRfpNotifications: jest.fn(),
  };
});

jest.mock('../services/rfpProposalService', () => ({
  submitReview: jest.fn(),
  regenerateProposal: jest.fn(),
  saveProposalDraft: jest.fn(),
  publishProposal: jest.fn(),
  approveProposal: jest.fn(),
  rejectProposal: jest.fn(),
  deleteIntakeProject: jest.fn(),
}));

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

import rfpIntakeRouter from '../routes/rfpIntake';
import { createRequest, RfpIntakeError } from '../services/rfpIntakeService';
import {
  approveProposal,
  publishProposal,
  rejectProposal,
  deleteIntakeProject,
  regenerateProposal,
  saveProposalDraft,
  submitReview,
} from '../services/rfpProposalService';

const mockedCreate = createRequest as jest.MockedFunction<typeof createRequest>;
const mockedSubmitReview = submitReview as jest.MockedFunction<typeof submitReview>;
const mockedRegenerate = regenerateProposal as jest.MockedFunction<typeof regenerateProposal>;
const mockedSaveDraft = saveProposalDraft as jest.MockedFunction<typeof saveProposalDraft>;
const mockedPublish = publishProposal as jest.MockedFunction<typeof publishProposal>;
const mockedApprove = approveProposal as jest.MockedFunction<typeof approveProposal>;
const mockedReject = rejectProposal as jest.MockedFunction<typeof rejectProposal>;
const mockedDeleteProject = deleteIntakeProject as jest.MockedFunction<typeof deleteIntakeProject>;

const REQUEST = { id: 'rfp-1', title: 'Benefits Tracker' };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rfp-intake', rfpIntakeRouter);
  return app;
}

const INTAKE = {
  title: 'Benefits Tracker',
  stakeholder: 'Benefits Administration',
  request: 'Track enrollments',
  problem: 'Spreadsheets',
  audience: 'internal',
  dataSensitivity: 'employee-pii',
  existingSolution: 'none known',
  expectedUsers: 'medium',
  aiInApp: 'yes',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedCreate.mockResolvedValue(REQUEST as never);
  mockedSubmitReview.mockResolvedValue(REQUEST as never);
  mockedRegenerate.mockResolvedValue(REQUEST as never);
  mockedSaveDraft.mockResolvedValue(REQUEST as never);
  mockedPublish.mockResolvedValue(REQUEST as never);
  mockedApprove.mockResolvedValue(REQUEST as never);
  mockedReject.mockResolvedValue(REQUEST as never);
  mockedDeleteProject.mockResolvedValue(REQUEST as never);
});

describe('POST /requests new intake fields', () => {
  it('FF-0 FF-1 returns 400 with field errors when expected users or AI intent is missing', async () => {
    const response = await request(buildApp())
      .post('/api/rfp-intake/requests')
      .send({ ...INTAKE, expectedUsers: '', aiInApp: '' });

    expect(response.status).toBe(400);
    expect(response.body.fields).toMatchObject({
      expectedUsers: 'expectedUsers is required',
      aiInApp: 'aiInApp is required',
    });
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('FF-2 passes the sponsoring team through as stakeholder with the new fields', async () => {
    const response = await request(buildApp()).post('/api/rfp-intake/requests').send(INTAKE);

    expect(response.status).toBe(201);
    expect(mockedCreate).toHaveBeenCalledWith('user-1', expect.objectContaining({
      stakeholder: 'Benefits Administration',
      expectedUsers: 'medium',
      aiInApp: 'yes',
    }), []);
  });
});

describe('POST /triage/requests/:id/submit-review', () => {
  const architecture = {
    appType: 'web',
    resources: ['rds'],
    requiresAi: true,
    domainName: 'x.amergis.com',
    sizing: {
      region: 'us-east',
      sizingProfile: 'medium',
      environmentCount: 2,
      uptimePattern: 'always-on',
      storageGb: 100,
      aiUsage: 'moderate',
    },
  };

  it('SR-1 returns 403 without rfp-intake:manage', async () => {
    const response = await request(buildApp())
      .post('/api/rfp-intake/triage/requests/rfp-1/submit-review')
      .set('x-deny', 'rfp-intake:manage')
      .send({ architecture });

    expect(response.status).toBe(403);
    expect(mockedSubmitReview).not.toHaveBeenCalled();
  });

  it('SR-0 forwards the parsed architecture with sizing and the super-admin flag', async () => {
    const response = await request(buildApp())
      .post('/api/rfp-intake/triage/requests/rfp-1/submit-review')
      .set('x-super', '1')
      .send({ architecture: { ...architecture, resources: ['rds', 42] } });

    expect(response.status).toBe(200);
    expect(mockedSubmitReview).toHaveBeenCalledWith(
      'rfp-1',
      'user-1',
      { architecture: { ...architecture, resources: ['rds'] } },
      { isSuperAdmin: true },
    );
  });

  it('SR-0 sends a null architecture for a decline decision summary', async () => {
    await request(buildApp())
      .post('/api/rfp-intake/triage/requests/rfp-1/submit-review')
      .send({ architecture: null });
    expect(mockedSubmitReview).toHaveBeenCalledWith('rfp-1', 'user-1', { architecture: null }, { isSuperAdmin: false });
  });

  it('SR-0 turns non-numeric sizing into NaN so validation rejects it', async () => {
    await request(buildApp())
      .post('/api/rfp-intake/triage/requests/rfp-1/submit-review')
      .send({ architecture: { ...architecture, sizing: { ...architecture.sizing, storageGb: '100' } } });
    const input = mockedSubmitReview.mock.calls[0][2];
    expect(input.architecture?.sizing.storageGb).toBeNaN();
  });

  it('SR-0 returns field errors from the service', async () => {
    mockedSubmitReview.mockRejectedValue(new RfpIntakeError('sizing.region is invalid', 400, 'VALIDATION'));
    const response = await request(buildApp())
      .post('/api/rfp-intake/triage/requests/rfp-1/submit-review')
      .send({ architecture });

    expect(response.status).toBe(400);
    expect(response.body.fields).toMatchObject({ 'sizing.region': 'sizing.region is invalid' });
  });

  it('SR-2 returns 409 when generation is already running', async () => {
    mockedSubmitReview.mockRejectedValue(new RfpIntakeError('Proposal generation is already running', 409, 'GENERATION_ACTIVE'));
    const response = await request(buildApp())
      .post('/api/rfp-intake/triage/requests/rfp-1/submit-review')
      .send({ architecture });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('GENERATION_ACTIVE');
  });
});

describe('POST /triage/requests/:id/proposal/regenerate', () => {
  it('RG-0 queues a new draft for managers', async () => {
    const response = await request(buildApp()).post('/api/rfp-intake/triage/requests/rfp-1/proposal/regenerate');
    expect(response.status).toBe(200);
    expect(mockedRegenerate).toHaveBeenCalledWith('rfp-1', 'user-1', { isSuperAdmin: false });
  });

  it('RG-1 returns 403 without rfp-intake:manage', async () => {
    const response = await request(buildApp())
      .post('/api/rfp-intake/triage/requests/rfp-1/proposal/regenerate')
      .set('x-deny', 'rfp-intake:manage');
    expect(response.status).toBe(403);
    expect(mockedRegenerate).not.toHaveBeenCalled();
  });
});

describe('PUT /triage/requests/:id/proposal-draft', () => {
  it('DR-0 forwards the edited draft', async () => {
    const draft = { kind: 'proposal', jobId: 'job-1' };
    const response = await request(buildApp())
      .put('/api/rfp-intake/triage/requests/rfp-1/proposal-draft')
      .send({ draft });
    expect(response.status).toBe(200);
    expect(mockedSaveDraft).toHaveBeenCalledWith('rfp-1', 'user-1', draft, { isSuperAdmin: false });
  });

  it('DR-1 returns 409 for a stale draft', async () => {
    mockedSaveDraft.mockRejectedValue(new RfpIntakeError('This draft is out of date. Reload the request.', 409, 'STALE_DRAFT'));
    const response = await request(buildApp())
      .put('/api/rfp-intake/triage/requests/rfp-1/proposal-draft')
      .send({ draft: {} });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STALE_DRAFT');
  });
});

describe('POST /triage/requests/:id/proposal-draft/publish', () => {
  it('PB-0 forwards the product owner', async () => {
    const response = await request(buildApp())
      .post('/api/rfp-intake/triage/requests/rfp-1/proposal-draft/publish')
      .send({ productOwnerId: 'po-1' });

    expect(response.status).toBe(200);
    expect(mockedPublish).toHaveBeenCalledWith('rfp-1', 'user-1', { productOwnerId: 'po-1' }, { isSuperAdmin: false });
  });

  it('PB-0 omits a missing product owner for decision summaries', async () => {
    await request(buildApp()).post('/api/rfp-intake/triage/requests/rfp-1/proposal-draft/publish').send({});
    expect(mockedPublish).toHaveBeenCalledWith('rfp-1', 'user-1', { productOwnerId: undefined }, { isSuperAdmin: false });
  });

  it('PB-1 returns 403 without rfp-intake:manage', async () => {
    const response = await request(buildApp())
      .post('/api/rfp-intake/triage/requests/rfp-1/proposal-draft/publish')
      .set('x-deny', 'rfp-intake:manage')
      .send({});
    expect(response.status).toBe(403);
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it('removes the old manual proposal and architecture endpoints', async () => {
    const app = buildApp();
    expect((await request(app).put('/api/rfp-intake/triage/requests/rfp-1/proposal').send({})).status).toBe(404);
    expect((await request(app).put('/api/rfp-intake/triage/requests/rfp-1/architecture').send({})).status).toBe(404);
  });
});

describe('POST /requests/:id/approve', () => {
  it('AR-0 approves as the signed-in requester', async () => {
    const response = await request(buildApp()).post('/api/rfp-intake/requests/rfp-1/approve');

    expect(response.status).toBe(200);
    expect(mockedApprove).toHaveBeenCalledWith('rfp-1', 'user-1');
  });

  it('AR-4 returns the Azure DevOps error so the requester can retry', async () => {
    mockedApprove.mockRejectedValue(
      new RfpIntakeError('Azure DevOps could not create the repository: denied', 502, 'REPO_CREATE_FAILED'),
    );
    const response = await request(buildApp()).post('/api/rfp-intake/requests/rfp-1/approve');

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ code: 'REPO_CREATE_FAILED', error: expect.stringContaining('denied') });
  });
});

describe('POST /requests/:id/reject', () => {
  it('RJ-0 rejects as the signed-in requester', async () => {
    const response = await request(buildApp())
      .post('/api/rfp-intake/requests/rfp-1/reject')
      .send({ reason: 'The monthly cost is too high.' });

    expect(response.status).toBe(200);
    expect(mockedReject).toHaveBeenCalledWith('rfp-1', 'user-1', 'The monthly cost is too high.');
  });

  it('RJ-0 passes an empty reason through so the service can reject it', async () => {
    mockedReject.mockRejectedValue(new RfpIntakeError('A rejection reason is required', 400, 'VALIDATION'));
    const response = await request(buildApp()).post('/api/rfp-intake/requests/rfp-1/reject').send({});
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION' });
  });
});

describe('DELETE /triage/requests/:id/project', () => {
  it('DP-0 deletes the project created from the approved request', async () => {
    const response = await request(buildApp())
      .delete('/api/rfp-intake/triage/requests/rfp-1/project')
      .set('x-super', '1');

    expect(response.status).toBe(200);
    expect(mockedDeleteProject).toHaveBeenCalledWith('rfp-1', 'user-1', { isSuperAdmin: true });
  });

  it('DP-0 returns 403 without rfp-intake:manage', async () => {
    const response = await request(buildApp())
      .delete('/api/rfp-intake/triage/requests/rfp-1/project')
      .set('x-deny', 'rfp-intake:manage');

    expect(response.status).toBe(403);
    expect(mockedDeleteProject).not.toHaveBeenCalled();
  });
});
