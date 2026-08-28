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
jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: jest.fn().mockReturnValue(false),
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

jest.mock('../services/reviewerAvailabilityService', () => ({
  resolveReviewerAvailability: jest.fn(),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(),
}));

jest.mock('../services/documentApprovalService', () => ({
  getAvailableApproverPool: jest.fn(),
  getAssignments: jest.fn(),
  isApprovalComplete: jest.fn(),
  isAssignedApprover: jest.fn(),
  removeApproverAssignments: jest.fn(),
  reassignApprovers: jest.fn(),
  recordApproverResponse: jest.fn(),
}));

jest.mock('../services/ownerApprovalService', () => ({
  getOwnerApproval: jest.fn(),
  isDocumentOwner: jest.fn().mockResolvedValue(true),
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

jest.mock('../services/featureFlagService', () => ({
  isProjectRepositoryCheckoutReadinessEnabled: jest.fn().mockResolvedValue(false),
}));

jest.mock('../services/projectRepositoryReadinessService', () => ({
  assertResolvedProjectRepositoryReady: jest.fn().mockResolvedValue(undefined),
  ProjectRepositoryNotReady: class ProjectRepositoryNotReady extends Error {
    toJSON() {
      return {
        code: 'PROJECT_REPOSITORY_NOT_READY',
        message: this.message,
        status: 'not_cloned',
      };
    }
  },
}));

jest.mock('../services/runGroundingService', () => ({
  propagatePipelineGrounding: jest.fn().mockResolvedValue({
    grounding: { groundedSha: 'a'.repeat(40) },
    materialization: 'deferred',
  }),
}));

import { deleteAdr, getAdr, updateAdrStatus } from '../services/adrService';
import {
  getAvailableApproverPool,
  getAssignments,
  isApprovalComplete,
  isAssignedApprover,
  removeApproverAssignments,
  reassignApprovers,
  recordApproverResponse,
} from '../services/documentApprovalService';
import { getUnresolvedCount } from '../services/reviewCommentService';
import { createNotification } from '../services/notificationService';
import { resolveReviewerAvailability } from '../services/reviewerAvailabilityService';

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

describe('GET ADR reviewer availability', () => {
  beforeEach(() => jest.clearAllMocks());

  it('TBI-003 DoD-2 / PBI-004 AC-2 returns the shared all-unavailable signal unchanged', async () => {
    const payload = {
      project: 'Apex',
      modules: [{ documentType: 'adr', available: false, candidateCount: 0 }],
    };
    (resolveReviewerAvailability as jest.Mock).mockResolvedValue(payload);

    const response = await request(buildApp()).get('/reviewer-availability?project=Apex');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(payload);
    expect(resolveReviewerAvailability).toHaveBeenCalledWith('Apex', ['adr']);
  });

  it('PBI-004 AC-1 forwards resolver failure to error middleware', async () => {
    (resolveReviewerAvailability as jest.Mock).mockRejectedValue(new Error('directory unavailable'));

    const app = buildApp();
    app.use((err: Error, _req: unknown, res: express.Response, _next: unknown) => {
      res.status(503).json({ error: err.message });
    });
    const response = await request(app).get('/reviewer-availability?project=Apex');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'directory unavailable' });
  });

  it('TBI-003 DoD-2 rejects a missing project', async () => {
    const response = await request(buildApp()).get('/reviewer-availability');

    expect(response.status).toBe(400);
    expect(resolveReviewerAvailability).not.toHaveBeenCalled();
  });
});

describe('ADR reviewer response route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAdr as jest.Mock).mockResolvedValue(adr);
    (isAssignedApprover as jest.Mock).mockResolvedValue(true);
    (isApprovalComplete as jest.Mock).mockResolvedValue({ complete: true, mode: 'any_one' });
    (getUnresolvedCount as jest.Mock).mockResolvedValue(0);
    (createNotification as jest.Mock).mockResolvedValue(undefined);
    (getAssignments as jest.Mock).mockResolvedValue([{ id: 'assignment-1' }]);
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

  it('PBI-007 AC-3 rejects reviewer action on an owner-only ADR before mutation', async () => {
    (getAssignments as jest.Mock).mockResolvedValue([]);

    const response = await request(buildApp())
      .post('/adr-1/review')
      .send({ status: 'revision_requested' });

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
    (getAssignments as jest.Mock).mockResolvedValue([{ id: 'assignment-1' }]);
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
    (getAssignments as jest.Mock)
      .mockResolvedValueOnce([{ id: 'assignment-1', approverUserId: 'reviewer-1', status: 'pending' }])
      .mockResolvedValueOnce([{ id: 'assignment-2', approverUserId: 'dev-1', status: 'pending' }]);
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

  it('TBI-004 DoD-1 rejects reassignment when the ADR started owner-only', async () => {
    (getAssignments as jest.Mock).mockResolvedValue([]);

    const response = await request(buildApp())
      .put('/adr-1/assignments')
      .send({ reviewerIds: ['dev-1'] });

    expect(response.status).toBe(409);
    expect(reassignApprovers).not.toHaveBeenCalled();
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

  it('BR-009 allows assigning the ADR owner as a reviewer when they are already assigned', async () => {
    const response = await request(buildApp())
      .put('/adr-1/assignments')
      .send({ reviewerIds: ['reviewer-1'] });

    expect(response.status).toBe(200);
    expect(reassignApprovers).toHaveBeenCalledWith('adr-1', 'adr', ['reviewer-1'], 'reviewer-1');
  });

  it('TBI-002 DoD-1 surfaces the pool rejection when a reviewer is outside the ADR pool', async () => {
    (reassignApprovers as jest.Mock).mockRejectedValue(
      new Error('Users not in the adr approver pool for project "Apex": outsider-1'),
    );
    const { db } = jest.requireMock('../db/drizzle') as { db: { update: jest.Mock } };

    const response = await request(buildApp())
      .put('/adr-1/assignments')
      .send({ reviewerIds: ['outsider-1'] });

    expect(response.status).toBe(500);
    expect(reassignApprovers).toHaveBeenCalledWith('adr-1', 'adr', ['outsider-1'], 'reviewer-1');
    expect(removeApproverAssignments).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe('ADR reviewer candidates route', () => {
  function poolGroup(name: string, members: Array<{
    userId: string;
    displayName: string | null;
    email: string | null;
  }>) {
    return {
      id: `group-${name}`,
      name,
      description: null,
      project: 'Apex',
      isDefault: false,
      createdBy: 'admin-1',
      createdAt: '2026-07-17T00:00:00Z',
      documentType: 'adr',
      members: members.map((member) => ({
        ...member,
        groupId: `group-${name}`,
        addedBy: 'admin-1',
        addedAt: '2026-07-17T00:00:00Z',
      })),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('VT-14 returns the expanded configured ADR pool without Developer-group dependency', async () => {
    (getAvailableApproverPool as jest.Mock).mockResolvedValue({
      individuals: [
        { userId: 'individual-1', displayName: 'Individual One', email: 'individual@example.com' },
      ],
      groups: [
        poolGroup('Architects', [
          { userId: 'group-member-1', displayName: 'Group Member One', email: 'group@example.com' },
        ]),
      ],
    });

    const response = await request(buildApp())
      .get('/reviewer-candidates?project=Apex');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { id: 'individual-1', displayName: 'Individual One', email: 'individual@example.com' },
      { id: 'group-member-1', displayName: 'Group Member One', email: 'group@example.com' },
    ]);
    expect(getAvailableApproverPool).toHaveBeenCalledWith('Apex', 'adr');
  });

  it('TBI-002 DoD-1 returns expanded group members when the ADR pool has no individuals', async () => {
    (getAvailableApproverPool as jest.Mock).mockResolvedValue({
      individuals: [],
      groups: [
        poolGroup('Architects', [
          { userId: 'group-member-1', displayName: 'Group Member One', email: 'one@example.com' },
          { userId: 'group-member-2', displayName: null, email: 'two@example.com' },
        ]),
      ],
    });

    const response = await request(buildApp())
      .get('/reviewer-candidates?project=Apex');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { id: 'group-member-1', displayName: 'Group Member One', email: 'one@example.com' },
      { id: 'group-member-2', displayName: 'two@example.com', email: 'two@example.com' },
    ]);
  });

  it('TBI-002 DoD-1 dedupes a user configured both individually and through a group', async () => {
    (getAvailableApproverPool as jest.Mock).mockResolvedValue({
      individuals: [
        { userId: 'dev-1', displayName: 'Dev One', email: 'dev@example.com' },
      ],
      groups: [
        poolGroup('Architects', [
          { userId: 'dev-1', displayName: 'Dev One', email: 'dev@example.com' },
          { userId: 'dev-2', displayName: 'Dev Two', email: 'dev2@example.com' },
        ]),
        poolGroup('Platform', [
          { userId: 'dev-2', displayName: 'Dev Two', email: 'dev2@example.com' },
        ]),
      ],
    });

    const response = await request(buildApp())
      .get('/reviewer-candidates?project=Apex');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { id: 'dev-1', displayName: 'Dev One', email: 'dev@example.com' },
      { id: 'dev-2', displayName: 'Dev Two', email: 'dev2@example.com' },
    ]);
  });

  it('BR-009 includes the starter/owner when they are in the configured ADR pool', async () => {
    (getAvailableApproverPool as jest.Mock).mockResolvedValue({
      individuals: [
        { userId: 'reviewer-1', displayName: 'Owner', email: 'owner@example.com' },
        { userId: 'dev-1', displayName: 'Dev One', email: 'dev@example.com' },
      ],
      groups: [
        poolGroup('Architects', [
          { userId: 'reviewer-1', displayName: 'Owner', email: 'owner@example.com' },
        ]),
      ],
    });

    const response = await request(buildApp())
      .get('/reviewer-candidates?project=Apex');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { id: 'reviewer-1', displayName: 'Owner', email: 'owner@example.com' },
      { id: 'dev-1', displayName: 'Dev One', email: 'dev@example.com' },
    ]);
    expect(getAvailableApproverPool).toHaveBeenCalledWith('Apex', 'adr');
  });
});

describe('ADR delete route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (deleteAdr as jest.Mock).mockResolvedValue(undefined);
  });

  it('DELETEs an ADR and returns 204', async () => {
    const response = await request(buildApp()).delete('/adr-1');

    expect(response.status).toBe(204);
    expect(deleteAdr).toHaveBeenCalledWith('adr-1', 'reviewer-1');
  });
});

describe('VT-15 — ADR finalize inherits interview grounding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAdr as jest.Mock).mockResolvedValue({
      ...adr,
      authorId: 'reviewer-1',
      skillSettingsId: 'adr-skill-settings',
      status: 'interviewing',
    });
    const { getThread, createThread } = jest.requireMock('../services/chatAgentService') as {
      getThread: jest.Mock;
      createThread: jest.Mock;
    };
    const { resolveSkillConfig } = jest.requireMock('../services/projectSettingsService') as {
      resolveSkillConfig: jest.Mock;
    };
    const { getDefaultModel } = jest.requireMock('../services/appSettingsService') as {
      getDefaultModel: jest.Mock;
    };
    const { markAdrGenerating, startAdrWatcher } = jest.requireMock('../services/adrService') as {
      markAdrGenerating: jest.Mock;
      startAdrWatcher: jest.Mock;
    };
    getThread.mockResolvedValue({
      id: 'thread-1',
      messages: [
        { role: 'user', text: 'We need durable events' },
        { role: 'agent', text: 'Service Bus fits that constraint' },
      ],
    });
    createThread.mockResolvedValue({ id: 'thread-finalize' });
    resolveSkillConfig.mockResolvedValue({
      id: 'adr-skill-settings',
      skillRepo: 'Apex',
      skillBranch: 'main',
      adrFinalizeSkillPath: '.cursor/skills/adr-finalize/SKILL.md',
      adrModel: 'claude-opus-4-6',
    });
    getDefaultModel.mockResolvedValue('claude-opus-4-6');
    markAdrGenerating.mockResolvedValue(undefined);
    startAdrWatcher.mockReturnValue(undefined);
  });

  it('copies ADR interview grounding onto the finalize thread', async () => {
    const { createThread } = jest.requireMock('../services/chatAgentService') as {
      createThread: jest.Mock;
    };
    const { propagatePipelineGrounding } = jest.requireMock('../services/runGroundingService') as {
      propagatePipelineGrounding: jest.Mock;
    };

    const response = await request(buildApp()).post('/adr-1/generate');

    expect(response.status).toBe(201);
    expect(createThread).toHaveBeenCalledWith(
      'reviewer-1',
      expect.objectContaining({
        skillSettingsId: 'adr-skill-settings',
      }),
      expect.any(Object),
    );
    expect(propagatePipelineGrounding).toHaveBeenCalledWith(
      { runType: 'chat', runId: 'thread-1', project: 'Apex' },
      { runType: 'chat', runId: 'thread-finalize', project: 'Apex' },
      'reviewer-1',
      { deferMaterialization: true },
    );
  });
});
