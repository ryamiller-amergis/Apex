/**
 * FEAT-010 dispatcher, completion handler, and sweep against a scratch database.
 * Covers VT-10, VT-15, VT-16, VT-17, and the dispatcher half of VT-19.
 *
 * Drizzle binds its pool at module load, so DATABASE_URL is pointed at the scratch database before
 * the services are required. Nothing above may import anything that reaches `db/drizzle`.
 */
import pg from 'pg';
import { taskBranchName } from '../../src/shared/types/build';
import { createScratchDatabase, ScratchDatabase } from './support/scratch-db';
import type { BuildTaskLaunchRequest } from '../../src/server/services/buildOrchestrator/taskLauncher';
import type { BuildAgentRunRow, DispatchStore } from '../../src/server/services/buildOrchestrator/dispatchStore';

type StoreModule = typeof import('../../src/server/services/buildOrchestrator/dispatchStore');
type DispatchModule = typeof import('../../src/server/services/buildOrchestrator/dispatchRun');
type CompletionModule = typeof import('../../src/server/services/buildOrchestrator/applyCompletion');
type ReconcileModule = typeof import('../../src/server/services/buildOrchestrator/reconcile');
type FailureModule = typeof import('../../src/server/services/buildOrchestrator/taskFailure');

const MIGRATE_TIMEOUT = 600_000;
const USER_OID = 'feat010-dispatch-user';
const FUTURE = '2099-01-01T00:00:00.000Z';

let scratch: ScratchDatabase;
let client: pg.Client;
let pool: { end: () => Promise<void> };
let storeModule: StoreModule;
let dispatchModule: DispatchModule;
let completionModule: CompletionModule;
let reconcileModule: ReconcileModule;
let failureModule: FailureModule;

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const { rows } = await client.query<T>(text, values);
  return rows;
}

async function seedRun(options: { status?: string; parallelismCap?: number; suspendReason?: string } = {}) {
  const suspended = options.status === 'suspended';
  const [run] = await query<{ id: string }>(
    `INSERT INTO build_runs (project, repository, requested_by_user_id, client_request_id, prompt, status,
       suspend_reason, suspended_from_status, skill_snapshot, support_contacts, quality_manifest_snapshot,
       cost_cap_usd, elapsed_cap_seconds, parallelism_cap)
     VALUES ('Apex', 'apex', $1, gen_random_uuid()::text, 'Add a reports page', $2, $3, $4,
       '{}'::jsonb, $5::jsonb, '{}'::jsonb, 25, 3600, $6)
     RETURNING id`,
    [USER_OID, options.status ?? 'building', suspended ? options.suspendReason : null, suspended ? 'building' : null,
      JSON.stringify([{ userId: USER_OID, displayName: 'Dev', email: '' }]), options.parallelismCap ?? 4],
  );
  const [revision] = await query<{ id: string }>(
    `INSERT INTO build_revisions (build_run_id, revision_number) VALUES ($1, 1) RETURNING id`,
    [run.id],
  );
  return { runId: run.id, revisionId: revision.id };
}

async function seedTask(revisionId: string, key: string, status: string, blockers: string[] = [],
  options: { launched?: boolean; branch?: string; startedMsAgo?: number } = {}): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO build_tasks (build_revision_id, task_key, role, depends_on, run_mode, status, started_at, branch_name)
     VALUES ($1, $2, 'implementer', $3::jsonb, 'own_agent', $4, now() - $5::interval, $6) RETURNING id`,
    [revisionId, key, JSON.stringify(blockers), status,
      options.launched || status === 'running' || status === 'merged' ? `${options.startedMsAgo ?? 60_000} milliseconds` : null,
      options.branch ?? null],
  );
  return row.id;
}

async function seedAgentRun(taskId: string, status: string,
  options: { startedMsAgo?: number; cursorIds?: boolean } = {}): Promise<string> {
  const ids = options.cursorIds ?? true;
  const [row] = await query<{ id: string }>(
    `INSERT INTO agent_runs (thread_id, status, project_id, lane, owner_instance, build_task_id, workflow_class,
       cloud_agent_identity, dispatch_message_id, timeout_at, started_at)
     VALUES ($1, $2, 'Apex', 'cloud-agent', 'apex-build-agent', $3, 'build-task', $4, $5, $6, now() - $7::interval)
     RETURNING id`,
    [`build-task:${taskId}`, status, taskId, ids ? 'bc-1' : null, ids ? 'msg-1' : null, FUTURE,
      `${options.startedMsAgo ?? 0} milliseconds`],
  );
  return row.id;
}

async function taskRows(revisionId: string) {
  return query<{ task_key: string; status: string; attempt: number; branch_name: string | null }>(
    `SELECT task_key, status, attempt, branch_name FROM build_tasks WHERE build_revision_id = $1 ORDER BY task_key`,
    [revisionId],
  );
}

function services(overrides: {
  readFlag?: () => Promise<'on' | 'off'>;
  requestMerge?: (input: { buildRunId: string; headTaskId: string; taskIds: string[] }) => Promise<void>;
  cancelAgent?: (agentRun: BuildAgentRunRow) => Promise<void>;
} = {}) {
  const store: DispatchStore = storeModule.createDrizzleDispatchStore();
  const track = jest.fn();
  const launches: BuildTaskLaunchRequest[] = [];
  const failTask = failureModule.createTaskFailurePolicy({ store, track });
  const dispatchNext = dispatchModule.createDispatchNext({
    store,
    guard: async () => ({ outcome: 'allow' }),
    launch: async (request) => {
      launches.push(request);
      const agentRunId = await seedAgentRun(request.tasks[0].id, 'running');
      return { kind: 'launched', agentRunId, cloudAgentId: 'bc-1', cursorRunId: 'msg-1' };
    },
    failTask,
    track,
  });
  const requestMerge = jest.fn(overrides.requestMerge ?? (async () => undefined));
  const applyCompletion = completionModule.createCompletionHandler({
    store,
    observe: async () => ({ status: 'running', prUrl: null, resultText: null, settled: false }),
    markTerminal: async () => undefined,
    mayReportDone: async () => true,
    requestMerge,
    failTask,
    dispatchNext,
    track,
  });
  const cancelAgent = jest.fn(overrides.cancelAgent ?? (async (agentRun: BuildAgentRunRow) => {
    await query(`UPDATE agent_runs SET status = 'cancelled', terminal_reason = 'forced_cancel' WHERE id = $1`, [agentRun.id]);
  }));
  const reconcile = reconcileModule.createBuildReconciler({
    store,
    readFlag: overrides.readFlag ?? (async () => 'on'),
    applyCompletion,
    dispatchNext,
    cancelAgent,
    track,
    logError: jest.fn(),
  });
  return { store, launches, dispatchNext, requestMerge, cancelAgent, reconcile };
}

beforeAll(async () => {
  scratch = await createScratchDatabase('builddispatch');
  process.env.DATABASE_URL = scratch.connectionString;
  /* eslint-disable @typescript-eslint/no-require-imports --
     Required rather than imported so the pool is built after DATABASE_URL points at the scratch
     database. A static import is hoisted and would bind to whatever URL was set at file load. */
  storeModule = require('../../src/server/services/buildOrchestrator/dispatchStore');
  dispatchModule = require('../../src/server/services/buildOrchestrator/dispatchRun');
  completionModule = require('../../src/server/services/buildOrchestrator/applyCompletion');
  reconcileModule = require('../../src/server/services/buildOrchestrator/reconcile');
  failureModule = require('../../src/server/services/buildOrchestrator/taskFailure');
  pool = require('../../src/server/db').default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();
  await query(
    `INSERT INTO app_users (oid, display_name) VALUES ($1, 'FEAT-010 Dispatcher') ON CONFLICT (oid) DO NOTHING`,
    [USER_OID],
  );
}, MIGRATE_TIMEOUT);

beforeEach(async () => {
  await query(
    `UPDATE build_runs SET status = 'cancelled', ended_at = now(), suspend_reason = NULL, suspended_from_status = NULL
     WHERE status NOT IN ('accepted', 'cancelled', 'failed')`,
  );
});

afterAll(async () => {
  if (client) await client.end();
  if (pool) await pool.end();
  if (scratch) await scratch.drop();
});

describe('VT-10 two concurrent dispatches with one free slot', () => {
  it('claims and launches one unit; the other waits and no task gets two agent runs', async () => {
    const { runId, revisionId } = await seedRun({ parallelismCap: 1 });
    await seedTask(revisionId, 'a', 'ready');
    await seedTask(revisionId, 'b', 'ready');
    const first = services();
    const second = services();

    await Promise.all([first.dispatchNext(runId), second.dispatchNext(runId)]);

    expect(first.launches.length + second.launches.length).toBe(1);
    const rows = await taskRows(revisionId);
    expect(rows.filter((row) => row.status === 'running')).toHaveLength(1);
    expect(rows.filter((row) => row.status === 'ready')).toHaveLength(1);
    const [{ count }] = await query<{ count: string }>(
      `SELECT count(*) FROM agent_runs ar JOIN build_tasks bt ON bt.id = ar.build_task_id WHERE bt.build_revision_id = $1`,
      [revisionId],
    );
    expect(Number(count)).toBe(1);
    const [run] = await query<{ parallelism_used: number }>(`SELECT parallelism_used FROM build_runs WHERE id = $1`, [runId]);
    expect(run.parallelism_used).toBe(1);
  });
});

describe('VT-15 restart with a missed completion', () => {
  it('applies the completion, calls the merge step once, and launches the next task', async () => {
    const { runId, revisionId } = await seedRun();
    await seedTask(revisionId, 'a', 'merged');
    const b = await seedTask(revisionId, 'b', 'running', ['a']);
    await seedTask(revisionId, 'c', 'pending', ['b']);
    await seedAgentRun(b, 'completed');
    let dispatchAfterMerge: (id: string) => Promise<unknown> = async () => undefined;
    const svc = services({
      requestMerge: async ({ headTaskId }) => {
        await query(`UPDATE build_tasks SET status = 'merged' WHERE id = $1`, [headTaskId]);
        await dispatchAfterMerge(runId);
      },
    });
    dispatchAfterMerge = svc.dispatchNext;

    await svc.reconcile();

    expect(svc.requestMerge).toHaveBeenCalledTimes(1);
    expect((await taskRows(revisionId)).map((row) => [row.task_key, row.status])).toEqual([
      ['a', 'merged'], ['b', 'merged'], ['c', 'running'],
    ]);
    const events = await query<{ event_type: string }>(
      `SELECT event_type FROM build_events WHERE build_run_id = $1 ORDER BY ordinal`, [runId]);
    expect(events.map((row) => row.event_type)).toEqual(['task.completed', 'task.launched']);
  });
});

describe('VT-16 My Work ends a build agent row first', () => {
  it('the build sweep still applies the completion, and the My Work pump predicate never matches the row', async () => {
    const { runId, revisionId } = await seedRun();
    const a = await seedTask(revisionId, 'a', 'running');
    const agentRunId = await seedAgentRun(a, 'running');
    await query(`UPDATE agent_runs SET status = 'completed' WHERE id = $1`, [agentRunId]);
    const svc = services();

    await svc.reconcile();
    await svc.reconcile();

    expect(svc.requestMerge).toHaveBeenCalled();
    const events = await query<{ event_type: string }>(
      `SELECT event_type FROM build_events WHERE build_run_id = $1`, [runId]);
    expect(events.map((row) => row.event_type)).toEqual(['task.completed']);
    const pumpable = await query(
      `SELECT id FROM agent_runs WHERE id = $1 AND lane = 'cloud-agent' AND owner_instance IS NULL`, [agentRunId]);
    expect(pumpable).toHaveLength(0);
  });
});

describe('VT-17 flag off with two running agents', () => {
  it('one pass cancels both, resets both tasks, suspends the run, and writes run.suspended', async () => {
    const { runId, revisionId } = await seedRun();
    const a = await seedTask(revisionId, 'a', 'running');
    const b = await seedTask(revisionId, 'b', 'running');
    const agents = [await seedAgentRun(a, 'running'), await seedAgentRun(b, 'running')];
    const svc = services({ readFlag: async () => 'off' });

    const started = Date.now();
    await svc.reconcile();

    const maxSweepDelayMs = 20_000;
    expect(Date.now() - started + maxSweepDelayMs).toBeLessThan(60_000);
    expect(svc.cancelAgent.mock.calls.map(([row]) => row.id).sort()).toEqual([...agents].sort());
    expect((await taskRows(revisionId)).map((row) => row.status)).toEqual(['ready', 'ready']);
    const [run] = await query<{ status: string; suspend_reason: string; suspended_from_status: string }>(
      `SELECT status, suspend_reason, suspended_from_status FROM build_runs WHERE id = $1`, [runId]);
    expect(run).toEqual({ status: 'suspended', suspend_reason: 'flag_disabled', suspended_from_status: 'building' });
    const events = await query<{ event_type: string }>(
      `SELECT event_type FROM build_events WHERE build_run_id = $1`, [runId]);
    expect(events.map((row) => row.event_type)).toEqual(['run.suspended']);
  });
});

describe('VT-19 resume after the flag comes back (dispatcher half)', () => {
  it('relaunches unmerged tasks with attempt + 1 on new branches and leaves merged tasks alone', async () => {
    const { runId, revisionId } = await seedRun({ status: 'suspended', suspendReason: 'flag_disabled' });
    await seedTask(revisionId, 'a', 'merged');
    await seedTask(revisionId, 'b', 'ready', ['a'], { launched: true, branch: `${taskBranchName('x', 'b')}-1` });
    await seedTask(revisionId, 'c', 'ready', ['a'], { launched: true });
    await query(
      `UPDATE build_runs SET status = 'building', suspend_reason = NULL, suspended_from_status = NULL WHERE id = $1`,
      [runId],
    );
    const svc = services();

    await svc.dispatchNext(runId);

    expect((await taskRows(revisionId)).map((row) => [row.task_key, row.status, row.attempt, row.branch_name])).toEqual([
      ['a', 'merged', 1, null],
      ['b', 'running', 2, `${taskBranchName(runId, 'b')}-2`],
      ['c', 'running', 2, `${taskBranchName(runId, 'c')}-2`],
    ]);
  });
});

describe('launch lost to a crash between claim and launch', () => {
  const LONG_AGO = 10 * 60_000;

  it('resets stale claims with no usable agent run and relaunches them; a recent claim is left alone', async () => {
    const { runId, revisionId } = await seedRun();
    const a = await seedTask(revisionId, 'a', 'running', [], { startedMsAgo: LONG_AGO });
    const b = await seedTask(revisionId, 'b', 'running', [], { startedMsAgo: LONG_AGO });
    await seedTask(revisionId, 'c', 'running');
    const stuck = await seedAgentRun(b, 'queued', { cursorIds: false });
    const svc = services();

    await expect(svc.reconcile()).resolves.toMatchObject({ launchesRecovered: 2, errors: 0 });

    expect(svc.cancelAgent.mock.calls.map(([row]) => row.id)).toEqual([stuck]);
    expect(svc.launches.map((request) => request.tasks[0].id).sort()).toEqual([a, b].sort());
    expect((await taskRows(revisionId)).map((row) => [row.task_key, row.status, row.attempt])).toEqual([
      ['a', 'running', 2], ['b', 'running', 2], ['c', 'running', 1],
    ]);
    const lost = await query(
      `SELECT 1 FROM build_events WHERE build_run_id = $1 AND event_type = 'task.launch_lost'`, [runId]);
    expect(lost).toHaveLength(2);
    const [revision] = await query<{ repair_attempts: number }>(
      `SELECT repair_attempts FROM build_revisions WHERE id = $1`, [revisionId]);
    expect(revision.repair_attempts).toBe(0);
  });

  it('does not apply a finished agent run from an earlier attempt to the current one', async () => {
    const { revisionId } = await seedRun();
    const a = await seedTask(revisionId, 'a', 'running', [], { startedMsAgo: LONG_AGO });
    await seedAgentRun(a, 'completed', { startedMsAgo: 2 * LONG_AGO });
    const svc = services();

    await svc.reconcile();

    expect(svc.requestMerge).not.toHaveBeenCalled();
    expect((await taskRows(revisionId)).map((row) => [row.status, row.attempt])).toEqual([['running', 2]]);
  });
});

describe('run lock', () => {
  it('a suspend waits for a completion decision that holds the run lock', async () => {
    const { runId } = await seedRun();
    const store = storeModule.createDrizzleDispatchStore();
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lockTaken = new Promise<void>((resolve) => { acquired = resolve; });
    const decision = store.withRunLock(runId, async () => {
      acquired();
      await held;
    });
    await lockTaken;

    const suspend = store.suspend(runId, 'flag_disabled');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [during] = await query<{ status: string }>(`SELECT status FROM build_runs WHERE id = $1`, [runId]);
    release();
    await decision;

    await expect(suspend).resolves.toBe(true);
    expect(during.status).toBe('building');
  });
});

describe('repair attempt counter', () => {
  it('allows two attempts per revision, then reports none left', async () => {
    const { revisionId } = await seedRun();
    const store = storeModule.createDrizzleDispatchStore();
    const results = [
      await store.consumeRepairAttempt(revisionId),
      await store.consumeRepairAttempt(revisionId),
      await store.consumeRepairAttempt(revisionId),
    ];
    expect(results).toEqual(['attempt_left', 'attempt_left', 'none_left']);
  });
});
