import express from 'express';
import request from 'supertest';
import adrRouter from '../routes/adr';
import type { Adr } from '../../shared/types/adr';

jest.mock('../middleware/rbac', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: () => 'reviewer-1',
}));

jest.mock('../db/drizzle', () => ({
  db: {
    update: jest.fn(),
    select: jest.fn(),
  },
}));

jest.mock('../services/adrService', () => ({
  getAdr: jest.fn(),
  listAdrs: jest.fn(),
  createAdr: jest.fn(),
  deleteAdr: jest.fn(),
  markAdrGenerating: jest.fn(),
  startAdrWatcher: jest.fn(),
  updateAdrStatus: jest.fn(),
  updateAdrTitle: jest.fn(),
  applyAdrProposedContent: jest.fn(),
  rejectAdrProposedContent: jest.fn(),
  setAdrAssistantThread: jest.fn(),
  stageAdrReviewFix: jest.fn(),
}));

jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn(),
  getThread: jest.fn(),
  updateThreadKickoffContext: jest.fn(),
}));

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn(),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(),
}));

jest.mock('../services/groupService', () => ({
  listGroupsWithMembers: jest.fn(),
}));

jest.mock('../services/documentApprovalService', () => ({
  getAssignments: jest.fn(),
  isApprovalComplete: jest.fn(),
  isAssignedApprover: jest.fn(),
  removeApproverAssignments: jest.fn(),
  reassignApprovers: jest.fn(),
  recordApproverResponse: jest.fn(),
}));

jest.mock('../services/ownerApprovalService', () => ({
  getOwnerApproval: jest.fn(),
  recordOwnerApproval: jest.fn(),
}));

jest.mock('../services/reviewCommentService', () => ({
  getComments: jest.fn(),
  getUnresolvedCount: jest.fn(),
}));

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn(),
}));

jest.mock('../services/bedrockService', () => ({
  fixAdrContentWithBedrock: jest.fn(),
  BedrockModelTruncatedError: class BedrockModelTruncatedError extends Error {},
}));

import { getAdr, updateAdrStatus } from '../services/adrService';
import {
  getAssignments,
  isApprovalComplete,
  isAssignedApprover,
  removeApproverAssignments,
  reassignApprovers,
  recordApproverResponse,
} from '../services/documentApprovalService';
import { getUnresolvedCount } from '../services/reviewCommentService';
import { createNotification } from '../services/notificationService';
import { listGroupsWithMembers } from '../services/groupService';

const adr: Adr = {
  id: 'adr-1',
  chatThreadId: 'thread-1',
  authorId: 'owner-1',
  ownerName: 'Owner One',
  reviewerIds: ['reviewer-1'],
  reviewers: [{ id: 'reviewer-1', displayName: 'Reviewer One' }],
  title: 'Choose event transport',
  project: 'Apex',
  repo: 'Apex',
  status: 'proposed',
  content: '# Decision',
  createdAt: '2026-07-17T00:00:00Z',
  updatedAt: '2026-07-17T00:00:00Z',
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', adrRouter);
  return app;
}

describe('ADR reviewer response route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAdr as jest.Mock).mockResolvedValue(adr);
    (isAssignedApprover as jest.Mock).mockResolvedValue(true);
    (isApprovalComplete as jest.Mock).mockResolvedValue({ complete: true, mode: 'any_one' });
    (getUnresolvedCount as jest.Mock).mockResolvedValue(0);
    (createNotification as jest.Mock).mockResolvedValue(undefined);
  });

  it('records an assigned reviewer approval and notifies the owner', async () => {
    const response = await request(buildApp())
      .post('/adr-1/review')
      .send({ status: 'approved' });

    expect(response.status).toBe(200);
    expect(recordApproverResponse).toHaveBeenCalledWith('adr-1', 'adr', 'reviewer-1', 'approved', undefined);
    expect(createNotification).toHaveBeenCalledWith('owner-1', expect.objectContaining({ link: '/adr/adr-1' }));
  });

  it('blocks approval while review comments remain unresolved', async () => {
    (getUnresolvedCount as jest.Mock).mockResolvedValue(1);

    const response = await request(buildApp())
      .post('/adr-1/review')
      .send({ status: 'approved' });

    expect(response.status).toBe(409);
    expect(recordApproverResponse).not.toHaveBeenCalled();
  });
});

describe('ADR owner approval route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAdr as jest.Mock).mockResolvedValue({
      ...adr,
      authorId: 'reviewer-1',
      ownerName: 'Reviewer One',
      reviewerIds: ['dev-1'],
    });
    (updateAdrStatus as jest.Mock).mockResolvedValue(undefined);
    (createNotification as jest.Mock).mockResolvedValue(undefined);
  });

  it('accepts a proposed ADR after owner approval', async () => {
    const response = await request(buildApp())
      .post('/adr-1/owner-approve')
      .send({ status: 'approved' });

    expect(response.status).toBe(200);
    expect(updateAdrStatus).toHaveBeenCalledWith('adr-1', 'reviewer-1', 'accepted');
    expect(createNotification).toHaveBeenCalledWith('dev-1', expect.objectContaining({
      title: 'ADR accepted by owner',
      link: '/adr/adr-1',
    }));
  });
});

describe('ADR reviewer assignment route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAdr as jest.Mock).mockResolvedValue({
      ...adr,
      authorId: 'reviewer-1',
      ownerName: 'Reviewer One',
    });
    (reassignApprovers as jest.Mock).mockResolvedValue([]);
    (removeApproverAssignments as jest.Mock).mockResolvedValue(undefined);
    (getAssignments as jest.Mock).mockResolvedValue([
      { id: 'assignment-2', approverUserId: 'dev-1', status: 'pending' },
    ]);
    const where = jest.fn().mockResolvedValue(undefined);
    const set = jest.fn().mockReturnValue({ where });
    const { db } = jest.requireMock('../db/drizzle') as { db: { update: jest.Mock } };
    db.update.mockReturnValue({ set });
  });

  it('replaces proposed ADR reviewers and removes deselected assignments', async () => {
    const response = await request(buildApp())
      .put('/adr-1/assignments')
      .send({ reviewerIds: ['dev-1', 'dev-1'] });

    expect(response.status).toBe(200);
    expect(reassignApprovers).toHaveBeenCalledWith('adr-1', 'adr', ['dev-1'], 'reviewer-1');
    expect(removeApproverAssignments).toHaveBeenCalledWith('adr-1', 'adr', ['reviewer-1']);
    expect(response.body).toEqual([
      expect.objectContaining({ approverUserId: 'dev-1' }),
    ]);
  });

  it('rejects reviewer changes after the ADR leaves proposed status', async () => {
    (getAdr as jest.Mock).mockResolvedValue({
      ...adr,
      authorId: 'reviewer-1',
      status: 'accepted',
    });

    const response = await request(buildApp())
      .put('/adr-1/assignments')
      .send({ reviewerIds: ['dev-1'] });

    expect(response.status).toBe(409);
    expect(reassignApprovers).not.toHaveBeenCalled();
  });

  it('rejects assigning the ADR owner as a reviewer', async () => {
    const response = await request(buildApp())
      .put('/adr-1/assignments')
      .send({ reviewerIds: ['reviewer-1'] });

    expect(response.status).toBe(400);
    expect(reassignApprovers).not.toHaveBeenCalled();
  });
});

describe('ADR reviewer candidates route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (listGroupsWithMembers as jest.Mock).mockResolvedValue([
      {
        name: 'Developer',
        members: [
          { userId: 'reviewer-1', displayName: 'ADR Owner' },
          { userId: 'dev-1', displayName: 'Dev One' },
        ],
      },
    ]);
  });

  it('returns Developer group members without the signed-in ADR owner', async () => {
    const response = await request(buildApp())
      .get('/reviewer-candidates?project=Apex');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({ id: 'dev-1', displayName: 'Dev One' }),
    ]);
  });
});
