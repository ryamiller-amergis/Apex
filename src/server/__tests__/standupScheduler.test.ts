/**
 * Unit tests for StandupSchedulerService deadline and reminder orchestration.
 */

jest.mock('../services/standupService', () => ({
  generateDailySessions: jest.fn().mockResolvedValue(0),
  sendStandupReminders: jest.fn().mockResolvedValue(undefined),
  runFacilitator: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    query: {
      standupSessions: { findMany: jest.fn() },
    },
  },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((_col: unknown, val: unknown) => ({ _tag: 'eq', val })),
}));

jest.mock('../db/schema', () => ({
  standupSessions: {},
}));

import { StandupSchedulerService } from '../services/standupScheduler';
import {
  generateDailySessions,
  sendStandupReminders,
  runFacilitator,
} from '../services/standupService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const mockGenerateDailySessions = generateDailySessions as jest.Mock;
const mockSendStandupReminders = sendStandupReminders as jest.Mock;
const mockRunFacilitator = runFacilitator as jest.Mock;

describe('StandupSchedulerService', () => {
  let scheduler: StandupSchedulerService;

  beforeEach(() => {
    jest.clearAllMocks();
    scheduler = new StandupSchedulerService();
    jest.useFakeTimers();
  });

  afterEach(() => {
    scheduler.stop();
    jest.useRealTimers();
  });

  it('runs session generation, reminders, and deadline checks in order', async () => {
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ id: 'session-1' }]),
      }),
    });
    mockDb.query.standupSessions.findMany.mockResolvedValue([]);

    await (scheduler as any).run();

    const generateOrder = mockGenerateDailySessions.mock.invocationCallOrder[0];
    const remindOrder = mockSendStandupReminders.mock.invocationCallOrder[0];
    const deadlineOrder = mockDb.query.standupSessions.findMany.mock.invocationCallOrder[0];

    expect(generateOrder).toBeLessThan(remindOrder);
    expect(remindOrder).toBeLessThan(deadlineOrder);
    expect(mockSendStandupReminders).toHaveBeenCalledWith('session-1');
  });

  it('triggers facilitator when session is past configured deadline', async () => {
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    });
    mockDb.query.standupSessions.findMany.mockResolvedValue([
      {
        id: 'session-late',
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        config: { facilitatorDeadlineMin: 120 },
      },
    ]);

    await (scheduler as any).run();

    expect(mockRunFacilitator).toHaveBeenCalledWith('session-late');
  });

  it('does not trigger facilitator before configured deadline', async () => {
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    });
    mockDb.query.standupSessions.findMany.mockResolvedValue([
      {
        id: 'session-early',
        createdAt: new Date().toISOString(),
        config: { facilitatorDeadlineMin: 120 },
      },
    ]);

    await (scheduler as any).run();

    expect(mockRunFacilitator).not.toHaveBeenCalled();
  });
});
