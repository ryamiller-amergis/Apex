/**
 * Real-Postgres schema & migration rollback test for Standup Delivery Pulse (AC-09).
 */
import pg from 'pg';
import {
  createScratchDatabase,
  migrateDown,
  migrateUp,
  migrationsFrom,
  type ScratchDatabase,
} from './support/scratch-db';

const MIGRATE_TIMEOUT = 600_000;
const MIGRATION_NAME = '20261113120000_standup-delivery-pulse';

let scratch: ScratchDatabase;
let client: pg.Client;

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const { rows } = await client.query<T>(text, values);
  return rows;
}

async function columnNames(table: string): Promise<string[]> {
  const rows = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY column_name`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

beforeAll(async () => {
  scratch = await createScratchDatabase('deliverypulse');
  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();
}, MIGRATE_TIMEOUT);

afterAll(async () => {
  if (client) await client.end();
  if (scratch) await scratch.drop();
});

describe('Standup Delivery Pulse migration up / down / up (AC-09)', () => {
  it('adds Delivery Pulse columns (including roster_mode) and standup_action_proposals table, rolls back cleanly, and re-applies', async () => {
    const configCols = await columnNames('standup_configs');
    expect(configCols).toEqual(
      expect.arrayContaining([
        'delivery_model',
        'goal_source',
        'team_goal',
        'roster_mode',
        'policy',
      ]),
    );

    const sessionCols = await columnNames('standup_sessions');
    expect(sessionCols).toContain('team_pulse');

    const participantCols = await columnNames('standup_participants');
    expect(participantCols).toContain('prepared_brief');

    const proposalCols = await columnNames('standup_action_proposals');
    expect(proposalCols).toEqual(
      expect.arrayContaining([
        'id',
        'session_id',
        'participant_id',
        'project',
        'work_item_id',
        'work_item_title',
        'proposal_type',
        'field_name',
        'current_value',
        'proposed_value',
        'reason',
        'confidence',
        'status',
        'decided_by',
        'decided_at',
        'created_at',
      ]),
    );

    // Insert a config, session, participant, and proposal to verify FK cascade & defaults
    await query(
      `INSERT INTO app_users (oid, display_name, email)
       VALUES ('pulse-user-1', 'Pulse Tester', 'pulse@localhost')
       ON CONFLICT (oid) DO NOTHING`,
    );
    const [cfg] = await query<{
      id: string;
      delivery_model: string;
      roster_mode: string;
    }>(
      `INSERT INTO standup_configs (project, group_ids, team_goal)
       VALUES ('MaxView', '[]'::jsonb, 'Ship Delivery Pulse')
       RETURNING id, delivery_model, roster_mode`,
    );
    expect(cfg.delivery_model).toBe('flow');
    expect(cfg.roster_mode).toBe('ado_and_groups');

    const [sess] = await query<{ id: string }>(
      `INSERT INTO standup_sessions (config_id, session_date, status, team_pulse)
       VALUES ($1, '2026-11-13', 'collecting', '{"overallHealth":"watch"}'::jsonb)
       RETURNING id`,
      [cfg.id],
    );

    const [part] = await query<{ id: string }>(
      `INSERT INTO standup_participants (session_id, user_id, status, prepared_brief)
       VALUES ($1, 'pulse-user-1', 'notified', '{"deliveryModel":"flow"}'::jsonb)
       RETURNING id`,
      [sess.id],
    );

    const [prop] = await query<{ id: string; status: string }>(
      `INSERT INTO standup_action_proposals (
         session_id, participant_id, project, work_item_id, work_item_title,
         proposal_type, field_name, proposed_value, reason
       ) VALUES ($1, $2, 'MaxView', 101, 'Test PBI', 'state', 'state', 'Ready for Test', 'PR merged')
       RETURNING id, status`,
      [sess.id, part.id],
    );
    expect(prop.status).toBe('pending');

    // Roll back through 20261113120000_standup-delivery-pulse
    const downCount = await migrationsFrom(scratch.connectionString, MIGRATION_NAME);
    await client.end();
    await migrateDown(scratch.connectionString, downCount);

    client = new pg.Client({ connectionString: scratch.connectionString });
    await client.connect();

    const tablesAfterDown = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'standup_action_proposals'`,
    );
    expect(tablesAfterDown).toEqual([]);
    expect(await columnNames('standup_configs')).not.toContain('delivery_model');
    expect(await columnNames('standup_configs')).not.toContain('roster_mode');
    expect(await columnNames('standup_sessions')).not.toContain('team_pulse');
    expect(await columnNames('standup_participants')).not.toContain('prepared_brief');

    // Re-apply up
    await client.end();
    await migrateUp(scratch.connectionString);
    client = new pg.Client({ connectionString: scratch.connectionString });
    await client.connect();

    expect(await columnNames('standup_configs')).toContain('delivery_model');
    expect(await columnNames('standup_configs')).toContain('roster_mode');
    expect(await columnNames('standup_action_proposals')).toContain('proposed_value');
  }, MIGRATE_TIMEOUT);
});
