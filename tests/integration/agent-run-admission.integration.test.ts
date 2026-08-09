import './setup';
import pool from '../../src/server/db';
import { runAdmissionCycle } from '../../src/server/services/admissionGovernorService';

const RUN_PREFIX = 'feat002-admission-int-';
const ORIGINAL_LIMIT = process.env.AI_RUNS_BACKGROUND_INFLIGHT_LIMIT;

type SeedRun = {
  id: string;
  projectId: string;
  status?: 'queued' | 'dispatched' | 'running';
  queuedAt?: string;
};

async function seedRuns(runs: SeedRun[]): Promise<void> {
  const timeoutAt = new Date(Date.now() + 60 * 60_000).toISOString();
  for (const run of runs) {
    const now = run.queuedAt ?? new Date().toISOString();
    await pool.query(
      `INSERT INTO agent_runs (
         id, thread_id, status, project_id, lane, queued_at, dispatched_at,
         dispatch_message_id, cancel_requested, heartbeat_at, started_at,
         timeout_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'background', $5,
         CASE WHEN $3 = 'dispatched' THEN $5::timestamptz ELSE NULL END,
         CASE WHEN $3 = 'dispatched' THEN $1 || '-fence' ELSE NULL END,
         FALSE, $5, $5, $6, $5, $5
       )`,
      [
        run.id,
        `${run.id}-thread`,
        run.status ?? 'queued',
        run.projectId,
        now,
        timeoutAt,
      ],
    );
  }
}

async function cleanup(): Promise<void> {
  await pool.query('DELETE FROM agent_runs WHERE id LIKE $1', [`${RUN_PREFIX}%`]);
}

describe('FEAT-002 PostgreSQL admission integration', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  afterAll(async () => {
    if (ORIGINAL_LIMIT === undefined) {
      delete process.env.AI_RUNS_BACKGROUND_INFLIGHT_LIMIT;
    } else {
      process.env.AI_RUNS_BACKGROUND_INFLIGHT_LIMIT = ORIGINAL_LIMIT;
    }
    await pool.end();
  });

  it('AC-1/VT-02/DoD-2 keeps concurrent governors within the global cap', async () => {
    process.env.AI_RUNS_BACKGROUND_INFLIGHT_LIMIT = '4';
    await seedRuns(
      Array.from({ length: 8 }, (_, index) => ({
        id: `${RUN_PREFIX}concurrent-${index}`,
        projectId: `project-${index % 3}`,
        queuedAt: `2026-08-06T00:0${index}:00.000Z`,
      })),
    );

    await Promise.all([
      runAdmissionCycle('enqueue'),
      runAdmissionCycle('enqueue'),
      runAdmissionCycle('slot-release'),
      runAdmissionCycle('sweep'),
    ]);

    const result = await pool.query<{
      in_flight: number;
      fenced: number;
      distinct_fences: number;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('dispatched', 'running'))::int AS in_flight,
         COUNT(dispatch_message_id)::int AS fenced,
         COUNT(DISTINCT dispatch_message_id)::int AS distinct_fences
       FROM agent_runs
       WHERE id LIKE $1`,
      [`${RUN_PREFIX}concurrent-%`],
    );

    expect(result.rows[0]).toEqual({
      in_flight: 4,
      fenced: 4,
      distinct_fences: 4,
    });
  });

  it('AC-0/VT-01/BR-004 admits the project with fewer live runs first', async () => {
    process.env.AI_RUNS_BACKGROUND_INFLIGHT_LIMIT = '2';
    await seedRuns([
      {
        id: `${RUN_PREFIX}fair-live-b`,
        projectId: 'project-b',
        status: 'running',
        queuedAt: '2026-08-06T00:00:00.000Z',
      },
      {
        id: `${RUN_PREFIX}fair-queued-b`,
        projectId: 'project-b',
        queuedAt: '2026-08-06T00:01:00.000Z',
      },
      {
        id: `${RUN_PREFIX}fair-queued-a`,
        projectId: 'project-a',
        queuedAt: '2026-08-06T00:02:00.000Z',
      },
    ]);

    await runAdmissionCycle('enqueue');

    const result = await pool.query<{ id: string }>(
      `SELECT id
       FROM agent_runs
       WHERE id LIKE $1 AND status = 'dispatched'
       ORDER BY id`,
      [`${RUN_PREFIX}fair-queued-%`],
    );
    expect(result.rows.map((row) => row.id)).toEqual([
      `${RUN_PREFIX}fair-queued-a`,
    ]);
  });

  it('AC-2/VT-03 lets one project consume otherwise idle slots', async () => {
    process.env.AI_RUNS_BACKGROUND_INFLIGHT_LIMIT = '3';
    await seedRuns(
      Array.from({ length: 4 }, (_, index) => ({
        id: `${RUN_PREFIX}idle-${index}`,
        projectId: 'project-only',
        queuedAt: `2026-08-06T00:0${index}:00.000Z`,
      })),
    );

    await runAdmissionCycle('enqueue');

    const result = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM agent_runs
       WHERE id LIKE $1 AND status = 'dispatched'`,
      [`${RUN_PREFIX}idle-%`],
    );
    expect(result.rows[0].count).toBe(3);
  });

  it('DoD-3/BR-004 uses FIFO then stable run identity for ties', async () => {
    process.env.AI_RUNS_BACKGROUND_INFLIGHT_LIMIT = '1';
    const queuedAt = '2026-08-06T00:00:00.000Z';
    await seedRuns([
      { id: `${RUN_PREFIX}tie-b`, projectId: 'project-a', queuedAt },
      { id: `${RUN_PREFIX}tie-a`, projectId: 'project-a', queuedAt },
    ]);

    await runAdmissionCycle('enqueue');

    const result = await pool.query<{ id: string }>(
      `SELECT id
       FROM agent_runs
       WHERE id LIKE $1 AND status = 'dispatched'`,
      [`${RUN_PREFIX}tie-%`],
    );
    expect(result.rows[0].id).toBe(`${RUN_PREFIX}tie-a`);
  });
});
