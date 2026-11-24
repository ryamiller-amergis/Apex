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

const mockFacilitatorAcquire = jest.fn();
const mockFacilitatorRelease = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/cursorSdkAdapter', () => ({
  createCursorSdkAdapter: jest.fn(() => ({
    acquire: (...args: unknown[]) => mockFacilitatorAcquire(...args),
    release: (...args: unknown[]) => mockFacilitatorRelease(...args),
  })),
}));

const mockResolveSkillConfig = jest.fn();
jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: (...args: unknown[]) => mockResolveSkillConfig(...args),
}));

const mockGetDefaultModel = jest.fn().mockResolvedValue('claude-sonnet-4-6');
jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: (...args: unknown[]) => mockGetDefaultModel(...args),
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
  projectSkillWorkflowSettings: { workflow: 'workflow' },
  chatMessages: {},
  appGroups: {},
}));

import {
  sendStandupReminders,
  runFacilitator,
  triggerSessionForConfig,
  generateDailySessions,
} from '../services/standupService';
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

  it('runs facilitator through CursorSdkAdapter for collecting sessions', async () => {
    mockDb.query.standupSessions.findFirst.mockResolvedValue({
      id: 'session-1',
      status: 'collecting',
      config: { project: 'AI-Pilot', skillSettingsId: 'skill-1' },
    });
    mockResolveSkillConfig.mockResolvedValue({
      id: 'skill-1',
      project: 'AI-Pilot',
      standupModel: 'claude-sonnet-4-6',
    });
    const waitMock = jest.fn().mockResolvedValue({ status: 'completed' });
    const sendMock = jest.fn().mockResolvedValue({ wait: waitMock });
    const disposeMock = jest.fn().mockResolvedValue(undefined);
    mockFacilitatorAcquire.mockResolvedValue({
      agentId: 'facilitator-agent-1',
      mode: 'recreated',
      send: sendMock,
      dispose: disposeMock,
    });

    await runFacilitator('session-1');

    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockFacilitatorAcquire).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'standup-facilitator:session-1',
        model: { id: 'claude-sonnet-4-6' },
      }),
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(waitMock).toHaveBeenCalledTimes(1);
    expect(disposeMock).toHaveBeenCalledTimes(1);
    expect(mockFacilitatorRelease).toHaveBeenCalledWith('standup-facilitator:session-1');
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });
});

const standupSkillColumns = {
  columns: {
    skillRepo: true,
    skillBranch: true,
  },
  with: {
    workflowSettings: {
      columns: { skillPath: true },
      where: expect.anything(),
    },
  },
};

describe('generateDailySessions project skill settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads only the standup skill columns when generating sessions', async () => {
    mockDb.query.standupConfigs.findMany.mockResolvedValue([]);

    await generateDailySessions();

    expect(mockDb.query.standupConfigs.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        with: { group: true, skillSettings: standupSkillColumns },
      }),
    );
  });
});

describe('triggerSessionForConfig project skill settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.query.standupSessions.findFirst.mockResolvedValue(null);
    mockDb.insert.mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) });
    mockDb.select.mockReturnValue({
      from: () => ({
        innerJoin: () => ({
          where: jest.fn().mockResolvedValue([
            { userId: 'user-1', displayName: 'User One', email: 'one@example.com' },
          ]),
        }),
      }),
    });
  });

  it('loads only the standup skill columns and still passes them to the participant thread', async () => {
    mockDb.query.standupConfigs.findFirst.mockResolvedValue({
      id: 'config-1',
      project: 'AI-Pilot',
      groupIds: ['group-1'],
      skillSettingsId: 'skill-1',
      skillSettings: {
        skillRepo: 'org/skills',
        skillBranch: 'main',
        workflowSettings: [{ skillPath: '.cursor/skills/custom-standup/SKILL.md' }],
      },
    });

    await triggerSessionForConfig('config-1');

    expect(mockDb.query.standupConfigs.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ with: { group: true, skillSettings: standupSkillColumns } }),
    );
    expect(mockCreateThread).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        agentModule: 'standup',
        repo: 'org/skills',
        branch: 'main',
        standupSkillPath: '.cursor/skills/custom-standup/SKILL.md',
        skillSettingsId: 'skill-1',
      }),
      { harness: { area: 'standup-participant', version: 1 } },
    );
  });
});
