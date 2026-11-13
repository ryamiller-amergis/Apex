/**
 * Route tests for Standup & Delivery Pulse endpoints + rosterMode & RBAC enforcement.
 */
import request from 'supertest';
import express from 'express';

let activePermissions = new Set<string>([
  'standup:participate',
  'standup:manage',
  'workitems:write',
]);

jest.mock('../middleware/rbac', () => ({
  requirePermission: (...keys: string[]) =>
    (_req: unknown, res: any, next: () => void) => {
      const missing = keys.filter((k) => !activePermissions.has(k));
      if (missing.length > 0) {
        res.status(403).json({ error: 'Forbidden', missing });
        return;
      }
      next();
    },
  requireAnyPermission: (...keys: string[]) =>
    (_req: unknown, res: any, next: () => void) => {
      if (!keys.some((k) => activePermissions.has(k))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      next();
    },
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn().mockReturnValue('user-test'),
}));

jest.mock('../services/adoUserToken', () => ({
  getAdoTokenForUser: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/adoFactory', () => ({
  adoWriteFromToken: jest.fn(),
  isAdoUserAuthError: jest.fn().mockReturnValue(false),
}));

jest.mock('../services/standupService', () => ({
  submitParticipant: jest.fn().mockResolvedValue(undefined),
  runFacilitator: jest.fn().mockResolvedValue(undefined),
  triggerSessionForConfig: jest.fn(),
  deleteStandupSession: jest.fn(),
}));

jest.mock('../services/standupEvidenceCollectorService', () => ({
  collectAndSaveParticipantBrief: jest.fn().mockResolvedValue(null),
  resolveStandupRoster: jest.fn().mockResolvedValue([
    {
      userId: 'u-ado-1',
      displayName: 'ADO Dev',
      email: 'ado@localhost',
      source: 'ado',
    },
  ]),
}));

const makeInsertChain = () => ({
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([]),
});

jest.mock('../db/drizzle', () => ({
  db: {
    insert: jest.fn(),
    update: jest.fn(),
    select: jest.fn(),
    delete: jest.fn(),
    query: {
      standupConfigs: { findMany: jest.fn().mockResolvedValue([]) },
      standupSessions: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
      },
      standupParticipants: { findMany: jest.fn().mockResolvedValue([]) },
      standupActionProposals: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
      },
      appUsers: { findMany: jest.fn().mockResolvedValue([]) },
    },
  },
}));

jest.mock('drizzle-orm', () => ({
  and: jest.fn((...args: unknown[]) => ({ _tag: 'and', args })),
  eq: jest.fn((_col: unknown, val: unknown) => ({ _tag: 'eq', val })),
  desc: jest.fn((col: unknown) => ({ _tag: 'desc', col })),
  inArray: jest.fn((col: unknown, vals: unknown) => ({
    _tag: 'inArray',
    col,
    vals,
  })),
}));

jest.mock('../db/schema', () => ({
  standupConfigs: {},
  standupSessions: {},
  standupParticipants: {},
  standupFollowups: {},
  standupActionProposals: {},
  appGroups: {},
  appUsers: {},
}));

import standupRouter from '../routes/standup';
import { submitParticipant } from '../services/standupService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const mockSubmitParticipant = submitParticipant as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { profile: { oid: 'user-test' } };
    next();
  });
  app.use('/api/standup', standupRouter);
  return app;
}

describe('Standup Config & Roster Discovery Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activePermissions = new Set([
      'standup:participate',
      'standup:manage',
      'workitems:write',
    ]);
    mockDb.insert.mockReturnValue(makeInsertChain());
  });

  it('returns 400 when project is missing, or when groupIds is empty in groups_only mode', async () => {
    const missingProject = await request(buildApp())
      .post('/api/standup/configs')
      .send({ groupIds: ['group-1'] });
    expect(missingProject.status).toBe(400);

    const missingGroupsInGroupsOnly = await request(buildApp())
      .post('/api/standup/configs')
      .send({ project: 'AI-Pilot', rosterMode: 'groups_only', groupIds: [] });
    expect(missingGroupsInGroupsOnly.status).toBe(400);
    expect(missingGroupsInGroupsOnly.body.error).toMatch(/groupIds/i);
  });

  it('allows empty groupIds when rosterMode is ado_and_groups or ado_active', async () => {
    const returningMock = jest.fn().mockResolvedValue([
      {
        id: 'config-auto',
        groupIds: [],
        project: 'MaxView',
        rosterMode: 'ado_and_groups',
        deliveryModel: 'flow',
      },
    ]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const res = await request(buildApp())
      .post('/api/standup/configs')
      .send({
        project: 'MaxView',
        rosterMode: 'ado_and_groups',
        groupIds: [],
      });

    expect(res.status).toBe(201);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project: 'MaxView',
        rosterMode: 'ado_and_groups',
        groupIds: [],
      }),
    );
  });

  it('returns previewed participants from GET /api/standup/roster-preview (standup:manage)', async () => {
    const res = await request(buildApp()).get(
      '/api/standup/roster-preview?project=MaxView&rosterMode=ado_and_groups',
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      project: 'MaxView',
      rosterMode: 'ado_and_groups',
      participants: [
        expect.objectContaining({ userId: 'u-ado-1', source: 'ado' }),
      ],
    });
  });

  it('persists reminder timing and Delivery Pulse model/goal/rosterMode/policy fields', async () => {
    const returningMock = jest.fn().mockResolvedValue([
      {
        id: 'config-1',
        groupIds: ['group-1'],
        project: 'AI-Pilot',
        deliveryModel: 'milestone',
        goalSource: 'release_epic',
        teamGoal: 'Ship v2.5',
        rosterMode: 'ado_active',
        reminderDelayMin: 15,
        reminderIntervalMin: 45,
        facilitatorDeadlineMin: 90,
      },
    ]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const res = await request(buildApp())
      .post('/api/standup/configs')
      .send({
        groupIds: ['group-1'],
        project: 'AI-Pilot',
        deliveryModel: 'milestone',
        goalSource: 'release_epic',
        teamGoal: 'Ship v2.5',
        rosterMode: 'ado_active',
        policy: { staleDaysThreshold: 4 },
        reminderDelayMin: 15,
        reminderIntervalMin: 45,
        facilitatorDeadlineMin: 90,
      });

    expect(res.status).toBe(201);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryModel: 'milestone',
        goalSource: 'release_epic',
        teamGoal: 'Ship v2.5',
        rosterMode: 'ado_active',
        policy: expect.objectContaining({
          staleDaysThreshold: 4,
          enableTargetDateChecks: true,
        }),
        reminderDelayMin: 15,
        reminderIntervalMin: 45,
        facilitatorDeadlineMin: 90,
      }),
    );
  });

  it('updates reminder timing and delivery policy on PUT /api/standup/configs/:id', async () => {
    const returningMock = jest.fn().mockResolvedValue([
      {
        id: 'config-1',
        deliveryModel: 'flow',
        reminderDelayMin: 20,
        reminderIntervalMin: 40,
        facilitatorDeadlineMin: 100,
      },
    ]);
    const whereMock = jest.fn().mockReturnValue({ returning: returningMock });
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const res = await request(buildApp())
      .put('/api/standup/configs/config-1')
      .send({
        deliveryModel: 'flow',
        reminderDelayMin: 20,
        reminderIntervalMin: 40,
        facilitatorDeadlineMin: 100,
      });

    expect(res.status).toBe(200);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryModel: 'flow',
        reminderDelayMin: 20,
        reminderIntervalMin: 40,
        facilitatorDeadlineMin: 100,
        updatedAt: expect.any(String),
      }),
    );
  });
});

describe('Latest Session, Pre-Drafted Submit & Proposals Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activePermissions = new Set(['standup:participate', 'workitems:write']);
  });

  it('returns latest session with synthesized teamPulse including individualNarratives on GET /api/standup/sessions/latest', async () => {
    mockDb.query.standupConfigs.findMany.mockResolvedValue([
      { id: 'cfg-1', project: 'MaxView' },
    ]);
    mockDb.query.standupSessions.findMany.mockResolvedValue([
      {
        id: 'sess-latest',
        sessionDate: '2026-11-13',
        status: 'completed',
        summaryMarkdown: 'All clear',
        teamPulse: null,
        config: {
          id: 'cfg-1',
          project: 'MaxView',
          deliveryModel: 'flow',
          teamGoal: 'Ship Delivery Pulse',
        },
        participants: [
          {
            id: 'p-1',
            userId: 'user-1',
            status: 'submitted',
            structuredUpdate: {
              yesterday: 'Finished #10',
              today: 'Starting #11',
              blockers: '',
              userCorrections: 'Added schema index verification',
            },
          },
        ],
        followups: [],
        proposals: [],
      },
    ]);

    const res = await request(buildApp()).get(
      '/api/standup/sessions/latest?project=MaxView',
    );

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('sess-latest');
    expect(res.body.teamPulse).toMatchObject({
      deliveryModel: 'flow',
      teamGoal: 'Ship Delivery Pulse',
      overallHealth: 'on_track',
      individualNarratives: [
        expect.objectContaining({
          userId: 'user-1',
          status: 'confirmed',
          userCorrections: 'Added schema index verification',
        }),
      ],
    });
  });

  it('passes Approve/Reject decisions, userCorrections, and proposals to submitParticipant', async () => {
    const res = await request(buildApp())
      .post('/api/standup/participants/part-1/submit')
      .send({
        structuredUpdate: {
          yesterday: 'Merged #101',
          today: 'Working #102',
          blockers: '',
          userCorrections: 'Also reviewed PR !90',
          approvalAction: 'approved_with_edits',
          itemDecisions: { 'draft-1': 'approved', 'draft-2': 'rejected' },
        },
        proposals: [
          {
            workItemId: 101,
            workItemTitle: 'Auth PBI',
            proposalType: 'state',
            fieldName: 'state',
            currentValue: 'In PR',
            proposedValue: 'Ready for Test',
            reason: 'PR merged',
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(mockSubmitParticipant).toHaveBeenCalledWith(
      'part-1',
      expect.objectContaining({
        structuredUpdate: expect.objectContaining({
          yesterday: 'Merged #101',
          userCorrections: 'Also reviewed PR !90',
          approvalAction: 'approved_with_edits',
        }),
        proposals: [expect.objectContaining({ workItemId: 101 })],
      }),
    );
  });

  it('enforces workitems:write on POST /api/standup/proposals/:id/apply and marks proposal applied', async () => {
    activePermissions = new Set(['standup:participate']);
    const forbidden = await request(buildApp()).post(
      '/api/standup/proposals/prop-1/apply',
    );
    expect(forbidden.status).toBe(403);

    activePermissions = new Set(['standup:participate', 'workitems:write']);
    mockDb.query.standupActionProposals.findFirst.mockResolvedValue({
      id: 'prop-1',
      sessionId: 'sess-1',
      project: 'MaxView',
      workItemId: 101,
      workItemTitle: 'Auth PBI',
      proposalType: 'target_date',
      fieldName: 'dueDate',
      currentValue: null,
      proposedValue: '2026-11-20',
      status: 'pending',
    });
    const returningMock = jest.fn().mockResolvedValue([
      {
        id: 'prop-1',
        status: 'applied',
        decidedBy: 'user-test',
      },
    ]);
    const whereMock = jest.fn().mockReturnValue({ returning: returningMock });
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const applied = await request(buildApp()).post(
      '/api/standup/proposals/prop-1/apply',
    );
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      ok: true,
      proposal: { id: 'prop-1', status: 'applied', decidedBy: 'user-test' },
    });
  });
});
