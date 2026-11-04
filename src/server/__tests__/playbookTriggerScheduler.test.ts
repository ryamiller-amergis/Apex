jest.mock('../db', () => ({
  __esModule: true,
  default: { connect: jest.fn() },
}));

jest.mock('../db/drizzle', () => ({ db: {} }));

import pool from '../db';
import { withPlaybookTriggerSweepLock } from '../services/playbookTriggerScheduler';

const connect = pool.connect as jest.Mock;

describe('withPlaybookTriggerSweepLock', () => {
  beforeEach(() => {
    connect.mockReset();
  });

  it('locks and unlocks on the same connection', async () => {
    const queries: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [{ locked: true }] };
      }),
      release: jest.fn(),
    };
    connect.mockResolvedValue(client);
    const body = jest.fn(async () => undefined);

    await withPlaybookTriggerSweepLock(body);

    expect(body).toHaveBeenCalledTimes(1);
    expect(queries[0]).toContain('pg_try_advisory_lock');
    expect(queries[1]).toContain('pg_advisory_unlock');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('does not run the sweep when another connection holds the lock', async () => {
    const client = {
      query: jest.fn(async () => ({ rows: [{ locked: false }] })),
      release: jest.fn(),
    };
    connect.mockResolvedValue(client);
    const body = jest.fn();

    await withPlaybookTriggerSweepLock(body);

    expect(body).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
