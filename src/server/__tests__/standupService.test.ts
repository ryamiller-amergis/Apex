/**
 * Unit tests for standupService reminder and facilitator behavior.
 */

jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn().mockResolvedValue({ id: 'thread-1' }),
}));

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue({}),
}));

jest.mock('../services/teamsBotService', () => ({
  sendTeamsNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      standupSessions: { findFirst: jest.fn(), findMany: jest.fn() },
      standupParticipants: { findFirst: jest.fn() },
      standupConfigs: { findFirst: jest.fn(), findMany: jest.fn() },
    },
    update: jest.fn(),
    insert: jest.fn(),
    select: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((_col: unknown, val: unknown) => ({ _tag: 'eq', val })),
  and: jest.fn((...args: unknown[]) => ({ _tag: 'and', args })),
  desc: jest.fn((col: unknown) => ({ _tag: 'desc', col })),
  inArray: jest.fn((col: unknown, vals: unknown) => ({ _tag: 'inArray', col, vals })),
}));

jest.mock('../db/schema', () => ({
  standupConfigs: {},
  standupSessions: {},
  standupParticipants: {},
  standupFollowups: {},
  appGroupMembers: {},
  appUsers: {},
  projectSkillSettings: {},
  chatMessages: {},
  appGroups: {},
}));

import { sendStandupReminders, runFacilitator } from '../services/standupService';
import { createNotification } from '../services/notificationService';
import { sendTeamsNotification } from '../services/teamsBotService';
import { createThread } from '../services/chatAgentService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const mockCreateNotification = createNotification as jest.Mock;
const mockSendTeamsNotification = sendTeamsNotification as jest.Mock;
const mockCreateThread = createThread as jest.Mock;

function makeSessionFixture(overrides: Partial<Record<string, unknown>> = {}) {
  const createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return {
    id: 'session-1',
    configId: 'config-1',
    sessionDate: '2026-06-30',
    status: 'collecting',
    createdAt,
    lastRemindedAt: null,
    config: {
      project: 'AI-Pilot',
      reminderDelayMin: 30,
      reminderIntervalMin: 60,
      facilitatorDeadlineMin: 120,
      skillSettingsId: null,
    },
    participants: [
      { id: 'p-1', userId: 'user-1', status: 'notified' },
      { id: 'p-2', userId: 'user-2', status: 'submitted' },
    ],
    ...overrides,
  };
}

describe('sendStandupReminders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const setMock = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
    mockDb.update.mockReturnValue({ set: setMock });
  });

  it('does nothing when session is not found', async () => {
    mockDb.query.standupSessions.findFirst.mockResolvedValue(null);

    await sendStandupReminders('missing');

    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('does nothing when session is not collecting', async () => {
    mockDb.query.standupSessions.findFirst.mockResolvedValue(
      makeSessionFixture({ status: 'facilitating' }),
    );

    await sendStandupReminders('session-1');

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('does nothing before the configured reminder delay', async () => {
    mockDb.query.standupSessions.findFirst.mockResolvedValue(
      makeSessionFixture({
        createdAt: new Date().toISOString(),
        config: {
          project: 'AI-Pilot',
          reminderDelayMin: 30,
          reminderIntervalMin: 60,
        },
      }),
    );

    await sendStandupReminders('session-1');

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('does nothing when within the reminder interval after last reminder', async () => {
    mockDb.query.standupSessions.findFirst.mockResolvedValue(
      makeSessionFixture({
        lastRemindedAt: new Date().toISOString(),
      }),
    );

    await sendStandupReminders('session-1');

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('does nothing when all participants have submitted', async () => {
    mockDb.query.standupSessions.findFirst.mockResolvedValue(
      makeSessionFixture({
        participants: [{ id: 'p-1', userId: 'user-1', status: 'submitted' }],
      }),
    );

    await sendStandupReminders('session-1');

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('notifies pending participants and stamps lastRemindedAt', async () => {
    mockDb.query.standupSessions.findFirst.mockResolvedValue(makeSessionFixture());

    await sendStandupReminders('session-1');

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith('user-1', {
      type: 'system',
      title: 'Standup Reminder',
      body: 'Reminder: Your standup update for AI-Pilot is still pending.',
      link: '/standup',
    });
    expect(mockSendTeamsNotification).toHaveBeenCalledTimes(1);
    expect(mockDb.update).toHaveBeenCalled();
  });
});

describe('runFacilitator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const setMock = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
    mockDb.update.mockReturnValue({ set: setMock });
  });

  it('does nothing when session is not found', async () => {
    mockDb.query.standupSessions.findFirst.mockResolvedValue(null);

    await runFacilitator('missing');

    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it('does nothing when session is already completed', async () => {
    mockDb.query.standupSessions.findFirst.mockResolvedValue({
      id: 'session-1',
      status: 'completed',
      config: { project: 'AI-Pilot', skillSettingsId: null },
    });

    await runFacilitator('session-1');

    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it('starts facilitator thread for collecting sessions', async () => {
    mockDb.query.standupSessions.findFirst.mockResolvedValue({
      id: 'session-1',
      status: 'collecting',
      config: { project: 'AI-Pilot', skillSettingsId: 'skill-1' },
    });

    await runFacilitator('session-1');

    expect(mockCreateThread).toHaveBeenCalledWith(
      'system-standup-facilitator',
      expect.objectContaining({
        project: 'AI-Pilot',
        mode: 'standup-facilitator',
        standupSessionId: 'session-1',
      }),
    );
    expect(mockDb.update).toHaveBeenCalledTimes(2);
  });
});
