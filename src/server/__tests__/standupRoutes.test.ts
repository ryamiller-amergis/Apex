/**
 * Integration-style tests for standup config routes.
 */
import request from 'supertest';
import express from 'express';

jest.mock('../middleware/rbac', () => ({
  requirePermission: (..._keys: string[]) =>
    (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn().mockReturnValue('user-test'),
}));

jest.mock('../services/adoUserToken', () => ({
  getAdoTokenForUser: jest.fn(),
}));

jest.mock('../services/standupService', () => ({
  submitParticipant: jest.fn(),
  runFacilitator: jest.fn(),
  triggerSessionForConfig: jest.fn(),
  deleteStandupSession: jest.fn(),
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
      standupSessions: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
      standupParticipants: { findMany: jest.fn().mockResolvedValue([]) },
    },
  },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((_col: unknown, val: unknown) => ({ _tag: 'eq', val })),
  desc: jest.fn((col: unknown) => ({ _tag: 'desc', col })),
  inArray: jest.fn((col: unknown, vals: unknown) => ({ _tag: 'inArray', col, vals })),
}));

jest.mock('../db/schema', () => ({
  standupConfigs: {},
  standupSessions: {},
  standupParticipants: {},
  standupFollowups: {},
  appGroups: {},
}));

import standupRouter from '../routes/standup';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

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

describe('POST /api/standup/configs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.insert.mockReturnValue(makeInsertChain());
  });

  it('returns 400 when groupIds or project are missing', async () => {
    const res = await request(buildApp())
      .post('/api/standup/configs')
      .send({ project: 'AI-Pilot' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/groupIds/i);
  });

  it('persists reminder and facilitator timing fields', async () => {
    const returningMock = jest.fn().mockResolvedValue([
      {
        id: 'config-1',
        groupIds: ['group-1'],
        project: 'AI-Pilot',
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
        reminderDelayMin: 15,
        reminderIntervalMin: 45,
        facilitatorDeadlineMin: 90,
      });

    expect(res.status).toBe(201);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reminderDelayMin: 15,
        reminderIntervalMin: 45,
        facilitatorDeadlineMin: 90,
      }),
    );
    expect(res.body).toMatchObject({
      reminderDelayMin: 15,
      reminderIntervalMin: 45,
      facilitatorDeadlineMin: 90,
    });
  });
});

describe('PUT /api/standup/configs/:id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates reminder timing fields on an existing config', async () => {
    const returningMock = jest.fn().mockResolvedValue([
      {
        id: 'config-1',
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
        reminderDelayMin: 20,
        reminderIntervalMin: 40,
        facilitatorDeadlineMin: 100,
      });

    expect(res.status).toBe(200);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reminderDelayMin: 20,
        reminderIntervalMin: 40,
        facilitatorDeadlineMin: 100,
        updatedAt: expect.any(String),
      }),
    );
  });
});
