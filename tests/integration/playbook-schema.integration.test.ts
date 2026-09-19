/**
 * FEAT-003 — the Apex-owned playbook schema, checked against a real migrated database.
 *
 * Everything here runs on a scratch database built by the FEAT-001 harness, so the assertions are
 * about what an operator would actually find after a deploy rather than about how the SQL reads.
 * That distinction matters most for the constraint tests: a `CHECK` that was written but never
 * applied looks identical in a diff to one that works.
 *
 * Covers VT-01, VT-02, VT-05, VT-06, VT-07, VT-09, VT-10, VT-11, VT-12, VT-13 and VT-18.
 */
import pg from 'pg';
import {
  createScratchDatabase,
  grantsOutsideSchema,
  migrateDown,
  ScratchDatabase,
} from './support/scratch-db';

const MIGRATE_TIMEOUT = 600_000;

const APEX_TABLES = [
  'playbook_definitions',
  'playbook_definition_versions',
  'playbook_runs',
  'playbook_step_runs',
] as const;

const ENGINE_SCHEMA = 'playbook_engine';
const ENGINE_ROLE = 'playbook_engine';

let scratch: ScratchDatabase;
let client: pg.Client;

/** A user row, because every playbook table roots its authorship in app_users. */
const USER_OID = 'feat003-test-user';

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const { rows } = await client.query<T>(text, values);
  return rows;
}

/** Inserts a definition, a published version and returns the version id. */
async function seedPublishedVersion(name: string): Promise<string> {
  const [definition] = await query<{ id: string }>(
    `INSERT INTO playbook_definitions (project, name, created_by)
     VALUES ('Apex', $1, $2) RETURNING id`,
    [name, USER_OID]
  );
  const [version] = await query<{ id: string }>(
    `INSERT INTO playbook_definition_versions (definition_id, version_number, graph, status, published_by, published_at)
     VALUES ($1, 1, $2, 'published', $3, now()) RETURNING id`,
    [definition.id, JSON.stringify({ nodes: [], edges: [] }), USER_OID]
  );
  return version.id;
}

async function seedRun(versionId: string): Promise<string> {
  const [run] = await query<{ id: string }>(
    `INSERT INTO playbook_runs (project, definition_version_id, initiator_user_id)
     VALUES ('Apex', $1, $2) RETURNING id`,
    [versionId, USER_OID]
  );
  return run.id;
}

beforeAll(async () => {
  scratch = await createScratchDatabase('playbookschema');
  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();
  await query(
    `INSERT INTO app_users (oid, display_name) VALUES ($1, 'FEAT-003 Test User')
     ON CONFLICT (oid) DO NOTHING`,
    [USER_OID]
  );
}, MIGRATE_TIMEOUT);

afterAll(async () => {
  if (client) await client.end();
  if (scratch) await scratch.drop();
});

describe('VT-01 — migrations create the documented shape', () => {
  it('creates all four Apex-owned tables in the public schema', async () => {
    const rows = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name`,
      [[...APEX_TABLES]]
    );
    expect(rows.map((r) => r.table_name)).toEqual([...APEX_TABLES].sort());
  });

  it('gives playbook_definition_versions its documented columns', async () => {
    const columns = await query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'playbook_definition_versions' ORDER BY column_name`
    );
    const byName = Object.fromEntries(columns.map((c) => [c.column_name, c]));

    expect(Object.keys(byName).sort()).toEqual([
      'created_at',
      'definition_id',
      'graph',
      'id',
      'published_at',
      'published_by',
      'status',
      'version_number',
    ]);
    expect(byName.graph.data_type).toBe('jsonb');
    expect(byName.graph.is_nullable).toBe('NO');
    // Publication metadata is absent on a draft, so it has to be nullable.
    expect(byName.published_by.is_nullable).toBe('YES');
    expect(byName.published_at.is_nullable).toBe('YES');
  });

  it('gives playbook_runs its documented columns, including the step-budget counters', async () => {
    const columns = await query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns
       WHERE table_name = 'playbook_runs' ORDER BY column_name`
    );
    const names = columns.map((c) => c.column_name);

    expect(names).toEqual([
      'agent_step_count',
      'completed_at',
      'created_at',
      'definition_version_id',
      'id',
      'initiator_user_id',
      'project',
      'started_at',
      'status',
      'step_count',
      'updated_at',
    ]);

    // Counters start at zero and are incremented by the runtime; a null default would make the
    // first increment a special case.
    for (const counter of ['step_count', 'agent_step_count']) {
      expect(columns.find((c) => c.column_name === counter)?.column_default).toBe('0');
    }
  });

  it('gives playbook_step_runs its documented columns, both output shapes included', async () => {
    const columns = await query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'playbook_step_runs' ORDER BY column_name`
    );
    const byName = Object.fromEntries(columns.map((c) => [c.column_name, c]));

    expect(Object.keys(byName).sort()).toEqual([
      'agent_run_id',
      'completed_at',
      'created_at',
      'expires_at',
      'id',
      'output_blob_ref',
      'output_inline',
      'resume_token',
      'run_id',
      'started_at',
      'status',
      'step_id',
      'step_type',
      'updated_at',
    ]);

    // Shaped now so fixing the Phase 1 size threshold costs no migration.
    expect(byName.output_inline.data_type).toBe('jsonb');
    expect(byName.output_blob_ref.data_type).toBe('jsonb');
    // Approval-gate and notify steps correlate to no agent run.
    expect(byName.agent_run_id.is_nullable).toBe('YES');
  });

  it('creates the documented indexes', async () => {
    const rows = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY indexname`,
      [[...APEX_TABLES]]
    );
    const names = rows.map((r) => r.indexname);

    for (const expected of [
      'idx_playbook_definitions_project_created',
      'uq_playbook_definitions_project_name',
      'idx_playbook_definition_versions_definition',
      'idx_playbook_definition_versions_status',
      'idx_playbook_runs_project_started',
      'idx_playbook_runs_project_status',
      'idx_playbook_runs_definition_version',
      'idx_playbook_step_runs_run',
      'idx_playbook_step_runs_expires_at',
      'idx_playbook_step_runs_agent_run',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('pins a run to its version with a restrict-mode foreign key', async () => {
    const [fk] = await query<{ delete_rule: string }>(
      `SELECT rc.delete_rule
       FROM information_schema.referential_constraints rc
       JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name
       WHERE tc.table_name = 'playbook_runs'
         AND rc.unique_constraint_name IN (
           SELECT constraint_name FROM information_schema.table_constraints
           WHERE table_name = 'playbook_definition_versions' AND constraint_type = 'PRIMARY KEY'
         )`
    );
    // NO ACTION and RESTRICT both refuse the delete; what matters is that neither cascades.
    expect(['RESTRICT', 'NO ACTION']).toContain(fk.delete_rule);
  });

  it('cascades step runs from their run, so deleting a run leaves no orphans', async () => {
    const versionId = await seedPublishedVersion('cascade-check');
    const runId = await seedRun(versionId);
    await query(
      `INSERT INTO playbook_step_runs (run_id, step_id, step_type) VALUES ($1, 'step-1', 'notify')`,
      [runId]
    );

    await query('DELETE FROM playbook_runs WHERE id = $1', [runId]);

    const orphans = await query('SELECT id FROM playbook_step_runs WHERE run_id = $1', [runId]);
    expect(orphans).toEqual([]);
  });
});

describe('VT-06 — status vocabularies are enforced by the database', () => {
  /*
   * Inserted through raw SQL on purpose. Every application path goes through TypeScript, where the
   * union type already refuses a bad value — so a test that writes through the service proves the
   * type-checker works, not the database. The NFR is about the column.
   */
  it('rejects a run status outside the six-value vocabulary', async () => {
    const versionId = await seedPublishedVersion('bad-run-status');

    await expect(
      query(
        `INSERT INTO playbook_runs (project, definition_version_id, initiator_user_id, status)
         VALUES ('Apex', $1, $2, 'succeeded')`,
        [versionId, USER_OID]
      )
    ).rejects.toThrow(/playbook_runs_status_check/);
  });

  it('accepts every status in the run vocabulary', async () => {
    const versionId = await seedPublishedVersion('all-run-statuses');

    for (const status of ['running', 'suspended', 'completed', 'cancelled', 'failed', 'expired']) {
      await expect(
        query(
          `INSERT INTO playbook_runs (project, definition_version_id, initiator_user_id, status)
           VALUES ('Apex', $1, $2, $3)`,
          [versionId, USER_OID, status]
        )
      ).resolves.toBeDefined();
    }
  });

  it('keeps expired as a distinct terminal state rather than a flavour of failed', async () => {
    const versionId = await seedPublishedVersion('expired-distinct');
    await query(
      `INSERT INTO playbook_runs (project, definition_version_id, initiator_user_id, status)
       VALUES ('Apex', $1, $2, 'expired')`,
      [versionId, USER_OID]
    );

    const [row] = await query<{ status: string }>(
      `SELECT status FROM playbook_runs WHERE definition_version_id = $1`,
      [versionId]
    );
    expect(row.status).toBe('expired');
    expect(row.status).not.toBe('failed');
  });

  it('rejects a step-run status outside its vocabulary but accepts failed_retryable', async () => {
    const versionId = await seedPublishedVersion('step-status');
    const runId = await seedRun(versionId);

    await expect(
      query(
        `INSERT INTO playbook_step_runs (run_id, step_id, step_type, status)
         VALUES ($1, 'bad', 'notify', 'halfway')`,
        [runId]
      )
    ).rejects.toThrow(/playbook_step_runs_status_check/);

    // The state a live agent step lands in when the process dies mid-turn.
    await expect(
      query(
        `INSERT INTO playbook_step_runs (run_id, step_id, step_type, status)
         VALUES ($1, 'retryable', 'cursor-agent', 'failed_retryable')`,
        [runId]
      )
    ).resolves.toBeDefined();
  });

  it('rejects a version lifecycle status outside its vocabulary', async () => {
    const [definition] = await query<{ id: string }>(
      `INSERT INTO playbook_definitions (project, name, created_by)
       VALUES ('Apex', 'bad-lifecycle', $1) RETURNING id`,
      [USER_OID]
    );

    await expect(
      query(
        `INSERT INTO playbook_definition_versions (definition_id, version_number, status)
         VALUES ($1, 1, 'retired')`,
        [definition.id]
      )
    ).rejects.toThrow(/playbook_definition_versions_status_check/);
  });
});

describe('VT-05 — a version a run pinned cannot be hard-deleted', () => {
  it('refuses to delete a referenced version', async () => {
    const versionId = await seedPublishedVersion('referenced-version');
    await seedRun(versionId);

    await expect(
      query('DELETE FROM playbook_definition_versions WHERE id = $1', [versionId])
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it('allows deleting a version no run ever started on', async () => {
    const versionId = await seedPublishedVersion('unreferenced-version');

    await expect(
      query('DELETE FROM playbook_definition_versions WHERE id = $1', [versionId])
    ).resolves.toBeDefined();
  });
});

describe('VT-07 — a new run carries its authorship and zeroed counters', () => {
  it('records initiator, pinned version, running status and zero counters', async () => {
    const versionId = await seedPublishedVersion('fresh-run');
    const runId = await seedRun(versionId);

    const [run] = await query<{
      initiator_user_id: string;
      definition_version_id: string;
      status: string;
      step_count: number;
      agent_step_count: number;
      started_at: string;
      completed_at: string | null;
    }>('SELECT * FROM playbook_runs WHERE id = $1', [runId]);

    expect(run.initiator_user_id).toBe(USER_OID);
    expect(run.definition_version_id).toBe(versionId);
    expect(run.status).toBe('running');
    expect(run.step_count).toBe(0);
    expect(run.agent_step_count).toBe(0);
    expect(run.started_at).toBeTruthy();
    expect(run.completed_at).toBeNull();
  });

  it('refuses a negative counter, so an over-decrement cannot go unnoticed', async () => {
    const versionId = await seedPublishedVersion('negative-counter');
    const runId = await seedRun(versionId);

    await expect(
      query('UPDATE playbook_runs SET step_count = -1 WHERE id = $1', [runId])
    ).rejects.toThrow(/playbook_runs_step_count_check/);
  });
});

describe('VT-09 / VT-11 — step rows carry correlation and inline output', () => {
  it('stores an approval-gate step with no correlated agent run', async () => {
    const versionId = await seedPublishedVersion('gate-step');
    const runId = await seedRun(versionId);

    await query(
      `INSERT INTO playbook_step_runs (run_id, step_id, step_type, status, expires_at)
       VALUES ($1, 'gate', 'approval-gate', 'suspended', now() + interval '7 days')`,
      [runId]
    );

    const [step] = await query<{ agent_run_id: string | null; expires_at: string }>(
      `SELECT agent_run_id, expires_at FROM playbook_step_runs WHERE run_id = $1`,
      [runId]
    );
    expect(step.agent_run_id).toBeNull();
    expect(step.expires_at).toBeTruthy(); // every suspension has a deadline
  });

  it('writes a small output inline and leaves the Blob reference null', async () => {
    const versionId = await seedPublishedVersion('inline-output');
    const runId = await seedRun(versionId);

    await query(
      `INSERT INTO playbook_step_runs (run_id, step_id, step_type, status, output_inline)
       VALUES ($1, 'notify', 'notify', 'completed', $2)`,
      [runId, JSON.stringify({ delivered: true })]
    );

    const [step] = await query<{
      output_inline: Record<string, unknown>;
      output_blob_ref: unknown;
    }>(`SELECT output_inline, output_blob_ref FROM playbook_step_runs WHERE run_id = $1`, [runId]);

    expect(step.output_inline).toEqual({ delivered: true });
    expect(step.output_blob_ref).toBeNull();
  });

  it('accepts a Blob reference in the { container, key } shape used elsewhere in Apex', async () => {
    const versionId = await seedPublishedVersion('blob-output');
    const runId = await seedRun(versionId);
    const ref = { container: 'playbook-step-outputs', key: 'run/abc/step-1.json' };

    await query(
      `INSERT INTO playbook_step_runs (run_id, step_id, step_type, status, output_blob_ref)
       VALUES ($1, 'big', 'cursor-agent', 'completed', $2)`,
      [runId, JSON.stringify(ref)]
    );

    const [step] = await query<{ output_blob_ref: { container: string; key: string } }>(
      `SELECT output_blob_ref FROM playbook_step_runs WHERE run_id = $1`,
      [runId]
    );
    expect(step.output_blob_ref).toEqual(ref);
  });
});

describe('VT-10 — the reconciliation sweep uses the expires_at partial index', () => {
  /*
   * The point of the partial index is that a sweep costs time proportional to outstanding
   * suspensions rather than to all run history, so the table is loaded the way history actually
   * accumulates: overwhelmingly terminal rows, a handful still waiting. On a near-empty table the
   * planner would sequentially scan whatever indexes exist and the assertion would prove nothing.
   */
  const TERMINAL_ROWS = 5000;

  beforeAll(async () => {
    const versionId = await seedPublishedVersion('sweep-plan');
    const runId = await seedRun(versionId);

    await query(
      `INSERT INTO playbook_step_runs (run_id, step_id, step_type, status, expires_at)
       SELECT $1, 'done-' || g, 'notify', 'completed', now() - interval '1 day'
       FROM generate_series(1, $2) AS g`,
      [runId, TERMINAL_ROWS]
    );
    await query(
      `INSERT INTO playbook_step_runs (run_id, step_id, step_type, status, expires_at)
       SELECT $1, 'waiting-' || g, 'approval-gate', 'suspended', now() - interval '1 hour'
       FROM generate_series(1, 5) AS g`,
      [runId]
    );
    await query('ANALYZE playbook_step_runs');
  }, 120_000);

  it('plans an index scan rather than a sequential scan for overdue suspensions', async () => {
    const plan = await query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id, run_id, step_id FROM playbook_step_runs
       WHERE status = 'suspended' AND expires_at IS NOT NULL AND expires_at <= now()`
    );
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');

    expect(text).toContain('idx_playbook_step_runs_expires_at');
    expect(text).not.toMatch(/Seq Scan on playbook_step_runs/);
  });

  it('returns only the overdue suspended rows', async () => {
    const overdue = await query(
      `SELECT id FROM playbook_step_runs
       WHERE status = 'suspended' AND expires_at IS NOT NULL AND expires_at <= now()`
    );
    expect(overdue).toHaveLength(5);
  });
});

describe('VT-18 — the playbooks permission seed', () => {
  it('seeds both keys under the playbooks category', async () => {
    const rows = await query<{ key: string; category: string; description: string }>(
      `SELECT key, category, description FROM app_permissions
       WHERE key IN ('playbooks:view', 'playbooks:run') ORDER BY key`
    );

    expect(rows.map((r) => r.key)).toEqual(['playbooks:run', 'playbooks:view']);
    for (const row of rows) expect(row.category).toBe('playbooks');
  });

  it('grants both keys to admin and to no other role', async () => {
    const rows = await query<{ name: string; key: string }>(
      `SELECT r.name, p.key
       FROM app_role_permissions rp
       JOIN app_roles r ON r.id = rp.role_id
       JOIN app_permissions p ON p.id = rp.permission_id
       WHERE p.key IN ('playbooks:view', 'playbooks:run')
       ORDER BY r.name, p.key`
    );

    expect(rows).toEqual([
      { name: 'admin', key: 'playbooks:run' },
      { name: 'admin', key: 'playbooks:view' },
    ]);
  });

  it('leaves the Epic 2 keys alone', async () => {
    const rows = await query(
      `SELECT key FROM app_permissions WHERE key IN ('playbooks:author', 'playbooks:admin')`
    );
    expect(rows).toEqual([]);
  });

  it('is idempotent — re-inserting adds no duplicate', async () => {
    await query(
      `INSERT INTO app_permissions (key, description, category)
       VALUES ('playbooks:view', 'duplicate attempt', 'playbooks')
       ON CONFLICT (key) DO NOTHING`
    );

    const rows = await query<{ description: string }>(
      `SELECT description FROM app_permissions WHERE key = 'playbooks:view'`
    );
    expect(rows).toHaveLength(1);
    // The original description survived; the conflicting insert did not overwrite it.
    expect(rows[0].description).not.toBe('duplicate attempt');
  });
});

describe('VT-12 / VT-13 — the engine schema is confined and disposable', () => {
  it('creates the confined schema and the restricted role', async () => {
    const [schema] = await query<{ schema_name: string; schema_owner: string }>(
      `SELECT schema_name, schema_owner FROM information_schema.schemata WHERE schema_name = $1`,
      [ENGINE_SCHEMA]
    );
    expect(schema).toBeDefined();
    // Deliberately NOT owned by the engine role: it may create tables inside, but cannot drop the
    // schema Apex made for it.
    expect(schema.schema_owner).not.toBe(ENGINE_ROLE);

    const [role] = await query<{ rolcanlogin: boolean; rolsuper: boolean }>(
      `SELECT rolcanlogin, rolsuper FROM pg_roles WHERE rolname = $1`,
      [ENGINE_ROLE]
    );
    expect(role).toBeDefined();
    // NOLOGIN until something actually needs to connect as it, which is FEAT-004's problem.
    expect(role.rolcanlogin).toBe(false);
    expect(role.rolsuper).toBe(false);
  });

  it('lets the engine role create inside its schema and nowhere else', async () => {
    const [inside] = await query<{ allowed: boolean }>(
      `SELECT has_schema_privilege($1, $2, 'CREATE') AS allowed`,
      [ENGINE_ROLE, ENGINE_SCHEMA]
    );
    expect(inside.allowed).toBe(true);

    const [outside] = await query<{ allowed: boolean }>(
      `SELECT has_schema_privilege($1, 'public', 'CREATE') AS allowed`,
      [ENGINE_ROLE]
    );
    expect(outside.allowed).toBe(false);
  });

  // The invariant FEAT-002 deferred here, now that a restricted role exists to assert it about.
  it('gives the engine role no grant on any Apex-owned table', async () => {
    const grants = await grantsOutsideSchema(scratch.connectionString, ENGINE_ROLE, ENGINE_SCHEMA);
    expect(grants).toEqual([]);
  });

  it('keeps the public schema off the engine role search path', async () => {
    const [role] = await query<{ rolconfig: string[] | null }>(
      `SELECT rolconfig FROM pg_roles WHERE rolname = $1`,
      [ENGINE_ROLE]
    );
    expect(role.rolconfig).toContain(`search_path=${ENGINE_SCHEMA}`);
  });

  /*
   * The ADR's sixth exit criterion, stated bluntly: dropping engine-owned tables must lose only the
   * engine's in-flight position, never Apex history. Phase 0 has no engine tables yet because
   * nothing connects the engine, so the test creates stand-ins — what is being proved is that
   * nothing in Apex's schema depends on that schema's contents, and a real table is as good a
   * subject for that as a Mastra one.
   */
  it('leaves Apex tables and their data untouched when every engine table is dropped', async () => {
    await query(`CREATE TABLE ${ENGINE_SCHEMA}.mastra_workflow_snapshot (id text PRIMARY KEY)`);
    await query(`CREATE TABLE ${ENGINE_SCHEMA}.mastra_evals (id text PRIMARY KEY)`);
    await query(`INSERT INTO ${ENGINE_SCHEMA}.mastra_workflow_snapshot VALUES ('run-position')`);

    const versionId = await seedPublishedVersion('survives-engine-drop');
    const runId = await seedRun(versionId);
    await query(
      `INSERT INTO playbook_step_runs (run_id, step_id, step_type, status)
       VALUES ($1, 'step-1', 'notify', 'completed')`,
      [runId]
    );

    const countsBefore = await apexRowCounts();

    await query(`DROP TABLE ${ENGINE_SCHEMA}.mastra_workflow_snapshot`);
    await query(`DROP TABLE ${ENGINE_SCHEMA}.mastra_evals`);

    const remaining = await query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [ENGINE_SCHEMA]
    );
    expect(remaining).toEqual([]);
    expect(await apexRowCounts()).toEqual(countsBefore);

    // The run is still fully readable from Apex tables alone.
    const [run] = await query<{ status: string; definition_version_id: string }>(
      'SELECT status, definition_version_id FROM playbook_runs WHERE id = $1',
      [runId]
    );
    expect(run.status).toBe('running');
    expect(run.definition_version_id).toBe(versionId);
  });
});

async function apexRowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of APEX_TABLES) {
    const [row] = await query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
    counts[table] = Number(row.count);
  }
  return counts;
}

describe('VT-02 — the playbook migrations roll back cleanly', () => {
  /*
   * Its own scratch database: rolling back is destructive, and sharing the suite's database would
   * make every test above depend on running before this one.
   */
  let rollbackScratch: ScratchDatabase;
  let rollbackClient: pg.Client;

  beforeAll(async () => {
    rollbackScratch = await createScratchDatabase('playbookdown');
    rollbackClient = new pg.Client({ connectionString: rollbackScratch.connectionString });
    await rollbackClient.connect();
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    if (rollbackClient) await rollbackClient.end();
    if (rollbackScratch) await rollbackScratch.drop();
  });

  it('reverses all five migrations, leaving no table, index or permission behind', async () => {
    // The five this Feature adds: definitions+versions, runs, step runs, permissions, engine schema.
    await migrateDown(rollbackScratch.connectionString, 5);

    const { rows: tables } = await rollbackClient.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [[...APEX_TABLES]]
    );
    expect(tables).toEqual([]);

    const { rows: indexes } = await rollbackClient.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%playbook%'`
    );
    expect(indexes).toEqual([]);

    const { rows: permissions } = await rollbackClient.query(
      `SELECT key FROM app_permissions WHERE key IN ('playbooks:view', 'playbooks:run')`
    );
    expect(permissions).toEqual([]);

    const { rows: schemas } = await rollbackClient.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
      [ENGINE_SCHEMA]
    );
    expect(schemas).toEqual([]);
  }, MIGRATE_TIMEOUT);

  it('leaves the rest of the Apex schema intact', async () => {
    // A rollback that took unrelated tables with it would be worse than one that failed loudly.
    const { rows } = await rollbackClient.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('app_users', 'app_roles', 'agent_runs', 'feature_flags')
       ORDER BY table_name`
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'agent_runs',
      'app_roles',
      'app_users',
      'feature_flags',
    ]);
  });
});
