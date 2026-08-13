const mockExecute = jest.fn();
const mockTxExecute = jest.fn();
const mockInsertReturning = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    execute: (...args: unknown[]) => mockExecute(...args),
    transaction: jest.fn(
      (callback: (tx: { execute: (...args: unknown[]) => unknown }) => unknown) =>
        callback({ execute: (...args: unknown[]) => mockTxExecute(...args) }),
    ),
    insert: jest.fn(() => ({
      values: jest.fn(() => ({
        returning: (...args: unknown[]) => mockInsertReturning(...args),
      })),
    })),
  },
}));

import {
  claimNextCheckoutJob,
  insertCheckoutJob,
} from '../services/repositoryCheckoutJobService';

describe('repositoryCheckoutJobService DoD — claim/lease', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('DoD-2: insertCheckoutJob writes a queued row', async () => {
    mockInsertReturning.mockResolvedValue([
      {
        id: 'job-1',
        skillSettingsId: 'cfg-1',
        refresh: true,
        status: 'queued',
        attempts: 0,
        ownerInstance: null,
        heartbeatAt: null,
        lockExpiresAt: null,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        createdAt: '2026-08-12T00:00:00Z',
        updatedAt: '2026-08-12T00:00:00Z',
      },
    ]);

    const job = await insertCheckoutJob({ skillSettingsId: 'cfg-1', refresh: true });
    expect(job.status).toBe('queued');
    expect(job.skillSettingsId).toBe('cfg-1');
    expect(job.refresh).toBe(true);
  });

  it('DoD-2: claimNextCheckoutJob uses FOR UPDATE SKIP LOCKED', async () => {
    mockTxExecute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'job-1',
            skill_settings_id: 'cfg-1',
            refresh: false,
            status: 'claimed',
            attempts: 1,
            owner_instance: 'host:1',
            heartbeat_at: '2026-08-12T00:00:00Z',
            lock_expires_at: '2026-08-12T00:02:00Z',
            error_message: null,
            started_at: '2026-08-12T00:00:00Z',
            completed_at: null,
            created_at: '2026-08-12T00:00:00Z',
            updated_at: '2026-08-12T00:00:00Z',
          },
        ],
      });

    const claimed = await claimNextCheckoutJob();
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.skillSettingsId).toBe('cfg-1');
    const sqlCalls = mockTxExecute.mock.calls.map((call) => JSON.stringify(call[0]));
    expect(sqlCalls.some((sql) => sql.includes('FOR UPDATE SKIP LOCKED'))).toBe(true);
  });
});
