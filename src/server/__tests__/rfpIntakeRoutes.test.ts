import express from 'express';
import request from 'supertest';

jest.mock('../utils/requestUser', () => ({
  getUserId: () => 'user-1',
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

jest.mock('../services/rfpSubmitAccessRequestService', () => ({
  createRfpSubmitAccessRequest: jest.fn(),
  listCurrentUserSubmitAccessRequests: jest.fn(),
}));

jest.mock('../services/rfpIntakeService', () => {
  const actual = jest.requireActual('../services/rfpIntakeService');
  return {
    ...actual,
    createRequest: jest.fn(),
    listOwnerRequests: jest.fn(),
    getOwnerRequestDetail: jest.fn(),
    answerClarification: jest.fn(),
    listOwnerComments: jest.fn(),
    addOwnerComment: jest.fn(),
    addComment: jest.fn(),
    addOwnerAttachment: jest.fn(),
    addAttachment: jest.fn(),
    getOwnerAttachment: jest.fn(),
    getAttachment: jest.fn(),
    listComments: jest.fn(),
    resolveRfpSubmissionRecipients: jest.fn(),
    setRfpEvaluationNotificationHook: jest.fn(),
  };
});

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/rfpEvaluationChatService', () => ({
  listEvaluationChat: jest.fn(),
  askEvaluationChat: jest.fn(),
}));

import {
  createRequest,
  listOwnerRequests,
  getOwnerRequestDetail,
  answerClarification,
  addComment,
  addAttachment,
  resolveRfpSubmissionRecipients,
  RfpIntakeError,
} from '../services/rfpIntakeService';
import { createNotification } from '../services/notificationService';
import { askEvaluationChat, listEvaluationChat } from '../services/rfpEvaluationChatService';
import {
  createRfpSubmitAccessRequest,
  listCurrentUserSubmitAccessRequests,
} from '../services/rfpSubmitAccessRequestService';
import rfpIntakeRouter from '../routes/rfpIntake';

const mockedCreate = createRequest as jest.MockedFunction<typeof createRequest>;
const mockedList = listOwnerRequests as jest.MockedFunction<typeof listOwnerRequests>;
const mockedDetail = getOwnerRequestDetail as jest.MockedFunction<typeof getOwnerRequestDetail>;
const mockedClarify = answerClarification as jest.MockedFunction<typeof answerClarification>;
const mockedAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockedAddAttachment = addAttachment as jest.MockedFunction<typeof addAttachment>;
const mockedRecipients = resolveRfpSubmissionRecipients as jest.MockedFunction<
  typeof resolveRfpSubmissionRecipients
>;
const mockedNotify = createNotification as jest.MockedFunction<typeof createNotification>;
const mockedListChat = listEvaluationChat as jest.MockedFunction<typeof listEvaluationChat>;
const mockedAskChat = askEvaluationChat as jest.MockedFunction<typeof askEvaluationChat>;
const mockedCreateSubmitAccess = createRfpSubmitAccessRequest as jest.MockedFunction<typeof createRfpSubmitAccessRequest>;
const mockedListSubmitAccess = listCurrentUserSubmitAccessRequests as jest.MockedFunction<
  typeof listCurrentUserSubmitAccessRequests
>;

const VALID_INTAKE = {
  title: 'Internal intake tracker',
  stakeholder: 'BA team',
  request: 'Track RFPs in Apex',
  problem: 'Intake is fragmented',
  audience: 'internal',
  dataSensitivity: 'internal-only',
  existingSolution: 'none known',
};

const CREATED = {
  id: 'rfp-1',
  ownerId: 'user-1',
  ...VALID_INTAKE,
  advantage: null,
  constraints: null,
  requestType: null,
  existingSystemStack: null,
  status: 'evaluating',
  aiStatus: 'evaluating',
  aiThreadId: null,
  sourceProject: 'Apex',
  currentEvaluationId: null,
  clarificationUsed: false,
  createdAt: '2026-08-19T12:00:00.000Z',
  updatedAt: '2026-08-19T12:00:00.000Z',
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

describe('RFP intake self-scoped routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedRecipients.mockResolvedValue(['triage-1', 'admin-1']);
    mockedCreate.mockResolvedValue(CREATED as never);
  });

  describe('POST /api/rfp-intake/requests', () => {
    it('VT-01 AC-0 creates an Evaluating RFP from the session owner and notifies triage', async () => {
      const response = await request(buildApp())
        .post('/api/rfp-intake/requests')
        .send({
          ...VALID_INTAKE,
          ownerId: 'spoofed-owner',
          sourceProject: 'OtherProject',
        });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('evaluating');
      expect(response.body.ownerId).toBe('user-1');
      expect(mockedCreate).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          title: VALID_INTAKE.title,
          audience: 'internal',
        }),
      );
      const createArg = mockedCreate.mock.calls[0][1] as unknown as Record<string, unknown>;
      expect(createArg.ownerId).toBeUndefined();
      expect(createArg.sourceProject).toBeUndefined();
      expect(mockedNotify).toHaveBeenCalledTimes(2);
      expect(mockedNotify).toHaveBeenCalledWith(
        'triage-1',
        expect.objectContaining({
          type: 'user-action',
          title: 'New request for product',
          link: '/rfp-intake/rfp-1',
        }),
      );
    });

    it('VT-04 AC-3 rejects a blank required field without creating an RFP', async () => {
      const response = await request(buildApp())
        .post('/api/rfp-intake/requests')
        .send({ ...VALID_INTAKE, title: '' });

      expect(response.status).toBe(400);
      expect(response.body.fields.title).toMatch(/title is required/i);
      expect(mockedCreate).not.toHaveBeenCalled();
      expect(mockedNotify).not.toHaveBeenCalled();
    });

    it('VT-04 AC-3 rejects an invalid enum without creating an RFP', async () => {
      const response = await request(buildApp())
        .post('/api/rfp-intake/requests')
        .send({ ...VALID_INTAKE, dataSensitivity: 'secret-clearance' });

      expect(response.status).toBe(400);
      expect(response.body.fields.dataSensitivity).toMatch(/invalid/i);
      expect(mockedCreate).not.toHaveBeenCalled();
    });

    it('VT-04 AC-3 rejects an unsupported attachment without creating an RFP', async () => {
      const response = await request(buildApp())
        .post('/api/rfp-intake/requests')
        .field('title', VALID_INTAKE.title)
        .field('stakeholder', VALID_INTAKE.stakeholder)
        .field('request', VALID_INTAKE.request)
        .field('problem', VALID_INTAKE.problem)
        .field('audience', VALID_INTAKE.audience)
        .field('dataSensitivity', VALID_INTAKE.dataSensitivity)
        .field('existingSolution', VALID_INTAKE.existingSolution)
        .attach('attachments', Buffer.from('MZ'), { filename: 'malware.exe', contentType: 'application/x-msdownload' });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/unsupported type/i);
      expect(mockedCreate).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/rfp-intake/requests/mine', () => {
    it('VT-07 AC-2 paginates owner rows with total', async () => {
      mockedList.mockResolvedValue({
        items: [{ id: 'rfp-51', title: 'Page two', status: 'evaluating', aiStatus: 'evaluating', currentVerdict: null, clarificationUsed: false, createdAt: '2026-08-19T12:00:00.000Z', updatedAt: '2026-08-19T12:00:00.000Z' }],
        total: 51,
      });

      const response = await request(buildApp())
        .get('/api/rfp-intake/requests/mine?limit=50&offset=50');

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(51);
      expect(response.body.items).toHaveLength(1);
      expect(mockedList).toHaveBeenCalledWith('user-1', { limit: 50, offset: 50 });
    });
  });

  describe('GET /api/rfp-intake/requests/:id', () => {
    it('VT-08 AC-3 returns 404 with no payload for a non-owned id', async () => {
      mockedDetail.mockRejectedValue(new RfpIntakeError('RFP not found', 404, 'NOT_FOUND'));

      const response = await request(buildApp()).get('/api/rfp-intake/requests/other-owner-id');

      expect(response.status).toBe(404);
      expect(response.body.error).toMatch(/not found/i);
      expect(response.body).not.toHaveProperty('comments');
      expect(response.body).not.toHaveProperty('activity');
      expect(response.body).not.toHaveProperty('attachments');
      expect(response.body).not.toHaveProperty('currentEvaluation');
      expect(mockedDetail).toHaveBeenCalledWith('other-owner-id', 'user-1');
    });

    it('returns owner-scoped detail for an owned request', async () => {
      mockedDetail.mockResolvedValue({
        ...CREATED,
        comments: [],
        attachments: [],
        activity: [{ id: 'evt-1', rfpRequestId: 'rfp-1', eventType: 'submitted', actorId: 'user-1', payload: null, createdAt: CREATED.createdAt }],
      } as never);

      const response = await request(buildApp()).get('/api/rfp-intake/requests/rfp-1');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('rfp-1');
      expect(response.body.activity).toHaveLength(1);
    });
  });

  describe('POST /api/rfp-intake/requests/:id/clarify', () => {
    it('VT-09 BR-005 rejects a second self-service clarification', async () => {
      mockedClarify.mockRejectedValue(
        new RfpIntakeError('Clarification resubmission is not available', 403, 'CLARIFICATION_USED'),
      );

      const response = await request(buildApp())
        .post('/api/rfp-intake/requests/rfp-1/clarify')
        .send(VALID_INTAKE);

      expect(response.status).toBe(403);
      expect(mockedClarify).toHaveBeenCalledWith('rfp-1', 'user-1', expect.objectContaining({ title: VALID_INTAKE.title }));
      expect(response.body.error).toMatch(/not available/i);
    });
  });

  describe('POST /api/rfp-intake/requests/:id/comments', () => {
    it('creates an owner comment', async () => {
      mockedAddComment.mockResolvedValue({
        id: 'c-1',
        rfpRequestId: 'rfp-1',
        authorId: 'user-1',
        body: 'Thanks',
        mentionedUserIds: [],
        createdAt: CREATED.createdAt,
      });

      const response = await request(buildApp())
        .post('/api/rfp-intake/requests/rfp-1/comments')
        .send({ body: 'Thanks' });

      expect(response.status).toBe(201);
      expect(mockedAddComment).toHaveBeenCalledWith('rfp-1', 'user-1', { body: 'Thanks', mentionedUserIds: [], attachmentIds: [] });
    });
  });

  describe('POST /api/rfp-intake/requests/:id/evaluation-chat', () => {
    it('asks the evaluator about a completed evaluation', async () => {
      mockedAskChat.mockResolvedValue([
        { id: 'm-1', rfpRequestId: 'rfp-1', evaluationId: 'ev-1', authorId: 'user-1', role: 'user', body: 'Why buy?', createdAt: CREATED.createdAt },
        { id: 'm-2', rfpRequestId: 'rfp-1', evaluationId: 'ev-1', authorId: null, role: 'assistant', body: 'Cornerstone already exists.', createdAt: CREATED.createdAt },
      ]);

      const response = await request(buildApp())
        .post('/api/rfp-intake/requests/rfp-1/evaluation-chat')
        .send({ message: 'Why buy?' });

      expect(response.status).toBe(201);
      expect(response.body).toHaveLength(2);
      expect(mockedAskChat).toHaveBeenCalledWith('rfp-1', 'user-1', 'Why buy?');
      expect(mockedListChat).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/rfp-intake/requests/:id/attachments', () => {
    it('stores a valid owner attachment', async () => {
      mockedAddAttachment.mockResolvedValue({
        id: 'att-1',
        rfpRequestId: 'rfp-1',
        commentId: null,
        filename: 'shot.png',
        contentType: 'image/png',
        sizeBytes: 4,
        storageKey: 'key',
        createdAt: CREATED.createdAt,
      });

      const response = await request(buildApp())
        .post('/api/rfp-intake/requests/rfp-1/attachments')
        .attach('attachments', Buffer.from([137, 80, 78, 71]), { filename: 'shot.png', contentType: 'image/png' });

      expect(response.status).toBe(201);
      expect(mockedAddAttachment).toHaveBeenCalled();
    });
  });

  describe('submit access request routes', () => {
    it('creates a pending Request for Product access request', async () => {
      mockedCreateSubmitAccess.mockResolvedValue({
        id: 'access-1',
        userId: 'user-1',
        status: 'pending',
        requestedAt: CREATED.createdAt,
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
      });

      const response = await request(buildApp()).post('/api/rfp-intake/submit-access-requests');

      expect(response.status).toBe(201);
      expect(response.body.request.status).toBe('pending');
      expect(mockedCreateSubmitAccess).toHaveBeenCalledWith('user-1');
    });

    it('returns alreadyGranted when the user already has submit access', async () => {
      mockedCreateSubmitAccess.mockResolvedValue(null);

      const response = await request(buildApp()).post('/api/rfp-intake/submit-access-requests');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ request: null, alreadyGranted: true });
    });

    it('lists the current user submit-access requests', async () => {
      mockedListSubmitAccess.mockResolvedValue([
        {
          id: 'access-1',
          userId: 'user-1',
          status: 'pending',
          requestedAt: CREATED.createdAt,
        },
      ]);

      const response = await request(buildApp()).get('/api/rfp-intake/submit-access-requests/me');

      expect(response.status).toBe(200);
      expect(response.body.requests).toHaveLength(1);
    });
  });

  it('returns 403 when the owner lacks rfp-intake:submit', async () => {
    const response = await request(buildApp())
      .post('/api/rfp-intake/requests')
      .set('x-deny', '1')
      .send(VALID_INTAKE);

    expect(response.status).toBe(403);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});
