/**
 * TBI-015 — the reconstruction projection, and the claim this whole Feature exists to make.
 *
 * Covers VT-14, VT-15 (the exit criterion E4 precursor) and VT-16.
 *
 * E4 is the blunt one: start a run, drop every engine-owned table, and the projection must still
 * answer correctly. It is written before the projection rather than after, because a read path
 * built first and tested second tends to acquire a convenient join into the engine's store along
 * the way, and then the test is written to match whatever it already does.
 *
 * Drizzle binds its pool at module load, so DATABASE_URL is pointed at the scratch database before
 * the service is required. Nothing above may import anything that reaches `db/drizzle`.
 */
import pg from 'pg';
import { createScratchDatabase, ScratchDatabase } from './support/scratch-db';

type ProjectionModule = typeof import('../../src/server/services/playbookRunProjectionService');

const MIGRATE_TIMEOUT = 600_000;
const ENGINE_SCHEMA = 'playbook_engine';
const USER_OID = 'feat003-projection-user';
const OTHER_USER_OID = 'feat003-other-user';

let scratch: ScratchDatabase;
let client: pg.Client;
let projection: ProjectionModule;
let pool: { end: () => Promise<void> };

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const { rows } = await client.query<T>(text, values);
  return rows;
}

interface SeededRun {
  runId: string;
  versionId: string;
  definitionName: string;
}

async function seedRun(options: {
  project?: string;
  name: string;
  status?: string;
  initiator?: string;
}): Promise<SeededRun> {
  const project = options.project ?? 'Apex';
  const [definition] = await query<{ id: string }>(
    `INSERT INTO playbook_definitions (project, name, created_by)
     VALUES ($1, $2, $3) RETURNING id`,
    [project, options.name, USER_OID]
  );
  const [version] = await query<{ id: string }>(
    `INSERT INTO playbook_definition_versions
       (definition_id, version_number, graph, status, published_by, published_at)
     VALUES ($1, 3, $2, 'published', $3, now()) RETURNING id`,
    [definition.id, JSON.stringify({ nodes: [], edges: [] }), USER_OID]
  );
  const [run] = await query<{ id: string }>(
    `INSERT INTO playbook_runs (project, definition_version_id, initiator_user_id, status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [project, version.id, options.initiator ?? USER_OID, options.status ?? 'running']
  );
  return { runId: run.id, versionId: version.id, definitionName: options.name };
}

async function addStep(
  runId: string,
  step: {
    stepId: string;
    stepType: string;
    status: string;
    expiresAt?: string | null;
    outputInline?: unknown;
  }
): Promise<void> {
  await query(
    `INSERT INTO playbook_step_runs (run_id, step_id, step_type, status, expires_at, output_inline)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      runId,
      step.stepId,
      step.stepType,
      step.status,
      step.expiresAt ?? null,
      step.outputInline === undefined ? null : JSON.stringify(step.outputInline),
    ]
  );
}

beforeAll(async () => {
  scratch = await createScratchDatabase('playbookproj');

  process.env.DATABASE_URL = scratch.connectionString;
  /* eslint-disable @typescript-eslint/no-require-imports --
     Required rather than imported so the pool is built after DATABASE_URL points at the scratch
     database. A static import is hoisted and would bind to whatever URL was set at file load. */
  projection = require('../../src/server/services/playbookRunProjectionService');
  pool = require('../../src/server/db').default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();

  await query(
    `INSERT INTO app_users (oid, display_name) VALUES ($1, 'Projection User'), ($2, 'Other User')
     ON CONFLICT (oid) DO NOTHING`,
    [USER_OID, OTHER_USER_OID]
  );
}, MIGRATE_TIMEOUT);

afterAll(async () => {
  if (client) await client.end();
  // The engine holds its own pool; an open session blocks the scratch database from being dropped.
  await require('../../src/server/services/playbookEngine/runtime').closeEngineStore();
  if (pool) await pool.end();
  if (scratch) await scratch.drop();
});

describe('VT-14 — the projection answers from Apex tables alone', () => {
  it('reports run status, pinned version and the current step for a suspended run', async () => {
    const { runId, versionId } = await seedRun({ name: 'suspended-run', status: 'suspended' });
    await addStep(runId, { stepId: 'draft', stepType: 'cursor-agent', status: 'completed' });
    await addStep(runId, {
      stepId: 'approve',
      stepType: 'approval-gate',
      status: 'suspended',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });

    const detail = await projection.getRun('Apex', runId);

    expect(detail).not.toBeNull();
    expect(detail!.status).toBe('suspended');
    expect(detail!.definitionVersionId).toBe(versionId);
    expect(detail!.versionNumber).toBe(3);
    expect(detail!.definitionName).toBe('suspended-run');
    expect(detail!.currentStepId).toBe('approve');
    expect(detail!.steps.map((s) => s.stepId)).toEqual(['draft', 'approve']);
  });

  it('names what a suspended run is waiting on, and until when', async () => {
    const { runId } = await seedRun({ name: 'gate-deadline', status: 'suspended' });
    await addStep(runId, {
      stepId: 'gate',
      stepType: 'approval-gate',
      status: 'suspended',
      expiresAt: '2026-11-15T09:30:00.000Z',
    });

    const detail = await projection.getRun('Apex', runId);

    expect(detail!.suspension).toMatchObject({ stepId: 'gate', reason: 'approval_gate' });
    // Compared as an instant, not a spelling: Drizzle's `mode: 'string'` hands back Postgres's own
    // offset form (+00:00), which is what every other Apex table returns.
    expect(Date.parse(detail!.suspension!.deadline!)).toBe(
      Date.parse('2026-11-15T09:30:00.000Z')
    );
  });

  it('distinguishes a suspended agent step from a suspended approval gate', async () => {
    const { runId } = await seedRun({ name: 'agent-wait', status: 'suspended' });
    await addStep(runId, {
      stepId: 'agent',
      stepType: 'cursor-agent',
      status: 'suspended',
      expiresAt: '2026-11-20T00:00:00.000Z',
    });

    const detail = await projection.getRun('Apex', runId);
    expect(detail!.suspension?.reason).toBe('agent_run');
  });

  it('reports no suspension for a completed run', async () => {
    const { runId } = await seedRun({ name: 'finished-run', status: 'completed' });
    await addStep(runId, {
      stepId: 'notify',
      stepType: 'notify',
      status: 'completed',
      outputInline: { delivered: true },
    });

    const detail = await projection.getRun('Apex', runId);

    expect(detail!.status).toBe('completed');
    expect(detail!.suspension).toBeNull();
    expect(detail!.currentStepId).toBeNull();
    expect(detail!.steps[0].outputInline).toEqual({ delivered: true });
  });

  it('refuses to read a run belonging to another project', async () => {
    const { runId } = await seedRun({ project: 'OtherProject', name: 'not-yours' });

    // Scoped in the service as well as at the route guard, so a misconfigured guard is not the only
    // thing standing between a caller and another project's run history.
    expect(await projection.getRun('Apex', runId)).toBeNull();
    expect(await projection.getRun('OtherProject', runId)).not.toBeNull();
  });

  it('returns null for a run that does not exist', async () => {
    const absent = '00000000-0000-0000-0000-000000000000';
    expect(await projection.getRun('Apex', absent)).toBeNull();
  });
});

describe('VT-16 — a run with no steps yet', () => {
  it('returns the run with an empty step list rather than throwing', async () => {
    const { runId, versionId } = await seedRun({ name: 'no-steps-yet' });

    const detail = await projection.getRun('Apex', runId);

    expect(detail).not.toBeNull();
    expect(detail!.steps).toEqual([]);
    expect(detail!.currentStepId).toBeNull();
    expect(detail!.suspension).toBeNull();
    expect(detail!.definitionVersionId).toBe(versionId);
  });
});

describe('listRuns — the status view list', () => {
  const LIST_PROJECT = 'ListProject';

  beforeAll(async () => {
    for (let i = 1; i <= 7; i++) {
      await seedRun({ project: LIST_PROJECT, name: `listed-${i}` });
    }
  });

  it('caps the page but reports an accurate total', async () => {
    const result = await projection.listRuns(LIST_PROJECT, 3);

    expect(result.runs).toHaveLength(3);
    // A view that shows three and claims three, when there are seven, tells the wrong story.
    expect(result.total).toBe(7);
  });

  it('returns the most recent runs first', async () => {
    const result = await projection.listRuns(LIST_PROJECT, 7);
    const started = result.runs.map((r) => Date.parse(r.startedAt));

    expect([...started].sort((a, b) => b - a)).toEqual(started);
  });

  it('lists only the requested project', async () => {
    const result = await projection.listRuns(LIST_PROJECT, 50);
    expect(result.runs.every((r) => r.project === LIST_PROJECT)).toBe(true);
    expect(result.runs.map((r) => r.definitionName).sort()).toEqual([
      'listed-1',
      'listed-2',
      'listed-3',
      'listed-4',
      'listed-5',
      'listed-6',
      'listed-7',
    ]);
  });

  it('returns an empty result for a project with no runs', async () => {
    expect(await projection.listRuns('ProjectWithNothing', 20)).toEqual({ runs: [], total: 0 });
  });
});

describe('VT-15 — exit criterion E4: the engine tables are disposable', () => {
  /*
   * The engine's store is a cache. If Apex owns run truth, then deleting the cache mid-run must
   * lose the engine's position and nothing else — the status view should still be able to say what
   * happened and what it is waiting on.
   *
   * Phase 0 has no live engine, so the engine's tables are stood up here to be destroyed. What is
   * under test is the projection's independence from that schema, and a table Mastra would have
   * created is no better a subject for that than one created here.
   */
  it('still answers correctly for an in-flight run after every engine table is dropped', async () => {
    const { runId, versionId } = await seedRun({ name: 'survives-e4', status: 'suspended' });
    await addStep(runId, {
      stepId: 'generate',
      stepType: 'cursor-agent',
      status: 'completed',
      outputInline: { summary: 'draft produced' },
    });
    await addStep(runId, {
      stepId: 'review',
      stepType: 'approval-gate',
      status: 'suspended',
      expiresAt: '2026-12-24T12:00:00.000Z',
    });

    await query(
      `CREATE TABLE ${ENGINE_SCHEMA}.mastra_workflow_snapshot (
         workflow_name text, run_id text, snapshot jsonb)`
    );
    await query(`CREATE TABLE ${ENGINE_SCHEMA}.mastra_evals (id text)`);
    await query(
      `INSERT INTO ${ENGINE_SCHEMA}.mastra_workflow_snapshot VALUES ('demo', $1, '{"step":"review"}')`,
      [runId]
    );

    const before = await projection.getRun('Apex', runId);

    // The cache, deleted mid-run.
    await query(`DROP TABLE ${ENGINE_SCHEMA}.mastra_workflow_snapshot`);
    await query(`DROP TABLE ${ENGINE_SCHEMA}.mastra_evals`);
    const remaining = await query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [ENGINE_SCHEMA]
    );
    expect(remaining).toEqual([]);

    const after = await projection.getRun('Apex', runId);

    expect(after).toEqual(before);
    expect(after!.status).toBe('suspended');
    expect(after!.definitionVersionId).toBe(versionId);
    expect(after!.versionNumber).toBe(3);
    expect(after!.currentStepId).toBe('review');
    expect(after!.suspension).toMatchObject({ stepId: 'review', reason: 'approval_gate' });
    expect(Date.parse(after!.suspension!.deadline!)).toBe(Date.parse('2026-12-24T12:00:00.000Z'));
    // Prior step output survives, which is what makes the run resumable rather than merely listed.
    expect(after!.steps[0].outputInline).toEqual({ summary: 'draft produced' });
  });

  it('still lists runs after the engine schema itself is gone', async () => {
    await query(`DROP SCHEMA IF EXISTS ${ENGINE_SCHEMA} CASCADE`);

    const result = await projection.listRuns('Apex', 50);
    expect(result.total).toBeGreaterThan(0);
  });
});
