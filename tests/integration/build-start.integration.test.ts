/**
 * FEAT-004 start-a-build schema on a scratch database.
 * VT-07 unique client request. VT-12 a queued row holds no Playbook run until it is promoted once.
 */
import pg from 'pg';
import {
  createScratchDatabase,
  migrateDown,
  migrateUp,
  migrationsFrom,
  ScratchDatabase,
} from './support/scratch-db';

const MIGRATE_TIMEOUT = 600_000;
const QUEUE_MIGRATION = '20261026210000_f4b1_build-start-queue';
const USER_OID = 'feat004-build-user';
const SNAPSHOT = JSON.stringify({ intake: { model: 'm', skillPath: 's', contentHash: 'h' } });
const CONTACTS = JSON.stringify([{ userId: 'u', displayName: 'Dev', email: 'dev@example.com' }]);
const MANIFEST = JSON.stringify({ typeCheck: 'tsc', lint: 'eslint', relatedTests: 'jest', unitSuite: 'jest' });

let scratch: ScratchDatabase;
let client: pg.Client;

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<T[]> {
  const result = await client.query<T>(text, values);
  return result.rows;
}

beforeAll(async () => {
  scratch = await createScratchDatabase('buildstart');
  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();
  await query(
    `INSERT INTO app_users (oid, display_name) VALUES ($1, 'FEAT-004 Build') ON CONFLICT (oid) DO NOTHING`,
    [USER_OID],
  );
}, MIGRATE_TIMEOUT);

afterAll(async () => {
  if (client) await client.end();
  if (scratch) await scratch.drop();
});

async function insertQueued(clientRequestId: string): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO build_runs (
       project, repository, requested_by_user_id, client_request_id, prompt, status, queued_at,
       skill_snapshot, support_contacts, quality_manifest_snapshot,
       cost_cap_usd, elapsed_cap_seconds, parallelism_cap
     ) VALUES (
       'Apex', 'apex', $1, $2, 'Build the widget', 'queued', now(),
       $3::jsonb, $4::jsonb, $5::jsonb,
       25, 14400, 2
     ) RETURNING id`,
    [USER_OID, clientRequestId, SNAPSHOT, CONTACTS, MANIFEST],
  );
  return row.id;
}

describe('FEAT-004 queued builds', () => {
  it('VT-12 a queued build has no Playbook run, and the run can be linked once', async () => {
    const id = await insertQueued(`req-${Date.now()}`);
    const [row] = await query<{ playbook_run_id: string | null; status: string }>(
      `SELECT playbook_run_id, status FROM build_runs WHERE id = $1`,
      [id],
    );
    expect(row.status).toBe('queued');
    expect(row.playbook_run_id).toBeNull();

    const first = await seedPlaybookRun('one');
    const second = await seedPlaybookRun('two');
    await query(`UPDATE build_runs SET playbook_run_id = $2, status = 'intake' WHERE id = $1`, [id, first]);
    await expect(
      query(`UPDATE build_runs SET playbook_run_id = $2 WHERE id = $1`, [id, second]),
    ).rejects.toThrow(/frozen columns cannot change/);
  });

async function seedPlaybookRun(label: string): Promise<string> {
  const [definition] = await query<{ id: string }>(
    `INSERT INTO playbook_definitions (project, name, created_by)
     VALUES ('Apex', $1, $2) RETURNING id`,
    [`build-${label}-${Date.now()}`, USER_OID],
  );
  const [version] = await query<{ id: string }>(
    `INSERT INTO playbook_definition_versions (definition_id, version_number, graph, status, published_by, published_at)
     VALUES ($1, 1, '{"nodes":[],"edges":[]}'::jsonb, 'published', $2, now()) RETURNING id`,
    [definition.id, USER_OID],
  );
  const [run] = await query<{ id: string }>(
    `INSERT INTO playbook_runs (project, definition_version_id, initiator_user_id)
     VALUES ('Apex', $1, $2) RETURNING id`,
    [version.id, USER_OID],
  );
  return run.id;
}

  it('VT-07 the same client request cannot be inserted twice', async () => {
    await insertQueued('same-request');
    await expect(insertQueued('same-request')).rejects.toThrow(/duplicate key|unique/i);
  });
});

describe('FEAT-004 queue migration rolls back', () => {
  it('removes the queue columns on down and restores them on up', async () => {
    const downScratch = await createScratchDatabase('buildqueuedown');
    const downClient = new pg.Client({ connectionString: downScratch.connectionString });
    await downClient.connect();
    const columns = async () => {
      const { rows } = await downClient.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'build_runs' AND column_name IN ('queued_at', 'skill_settings_id', 'playbook_run_id')
         ORDER BY column_name`,
      );
      return rows;
    };
    try {
      await migrateDown(
        downScratch.connectionString,
        await migrationsFrom(downScratch.connectionString, QUEUE_MIGRATION),
      );
      expect(await columns()).toEqual([{ column_name: 'playbook_run_id', is_nullable: 'NO' }]);

      await migrateUp(downScratch.connectionString);
      expect(await columns()).toEqual([
        { column_name: 'playbook_run_id', is_nullable: 'YES' },
        { column_name: 'queued_at', is_nullable: 'YES' },
        { column_name: 'skill_settings_id', is_nullable: 'YES' },
      ]);
    } finally {
      await downClient.end();
      await downScratch.drop();
    }
  }, MIGRATE_TIMEOUT);
});
