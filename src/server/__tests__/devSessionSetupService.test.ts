const mockReturning = jest.fn();
const mockWhere = jest.fn(() => ({ returning: mockReturning }));
const mockSet = jest.fn(() => ({ where: mockWhere }));
const mockUpdate = jest.fn((_table?: unknown) => ({ set: mockSet }));

jest.mock('../db/drizzle', () => ({
  db: {
    update: (table: unknown) => mockUpdate(table),
  },
}));

import {
  activateDevSession,
  touchDevSessionSetup,
} from '../services/devSessionSetupService';

describe('devSessionSetupService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReturning.mockResolvedValue([{ id: 'session-1' }]);
  });

  it('touches only a session that is still setting up', async () => {
    await expect(touchDevSessionSetup('session-1')).resolves.toBe(true);

    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      updatedAt: expect.any(String),
    }));
    expect(mockWhere).toHaveBeenCalled();
  });

  it('activates only a session that is still setting up', async () => {
    await expect(activateDevSession('session-1', {
      chatThreadId: 'thread-1',
      branchName: 'feature/apex-42-work',
      setupPhase: 'dependencies_ready',
      setupDetail: 'Dependencies are ready',
      setupProgressAt: '2026-07-14T12:00:00.000Z',
    })).resolves.toBe(true);

    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      chatThreadId: 'thread-1',
      branchName: 'feature/apex-42-work',
      status: 'in_progress',
      setupPhase: 'dependencies_ready',
      setupDetail: 'Dependencies are ready',
      setupProgressAt: '2026-07-14T12:00:00.000Z',
    }));
  });

  it('returns false when stale cleanup already changed the session status', async () => {
    mockReturning.mockResolvedValue([]);

    await expect(touchDevSessionSetup('session-1')).resolves.toBe(false);
    await expect(activateDevSession('session-1', {
      chatThreadId: 'thread-1',
      branchName: 'feature/apex-42-work',
    })).resolves.toBe(false);
  });
});
