/**
 * TBI-010 — the `playbooks-spike` flag seed, verified against a real migrated database.
 *
 * The scratch harness from the FEAT-001 verification spike builds a disposable database and applies
 * every migration to it. The original seed is checked inside a rolled-back transaction, while the
 * migrated database verifies the accepted Phase 1 archive state.
 */
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { createScratchDatabase, ScratchDatabase } from './support/scratch-db';

const REPO_ROOT = path.resolve(__dirname, '../..');
const MIGRATION = path.join(REPO_ROOT, 'migrations/20260918120000_seed-playbooks-spike-flag.sql');
const FLAG_KEY = 'playbooks-spike';

/** The Up half of the migration — everything before the Down marker. */
function upMigrationSql(): string {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const downAt = sql.indexOf('-- Down Migration');
  expect(downAt).toBeGreaterThan(-1);
  return sql.slice(0, downAt);
}

async function query<T extends pg.QueryResultRow>(
  connectionString: string,
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<T>(text, values);
    return rows;
  } finally {
    await client.end();
  }
}

interface FlagRow {
  key: string;
  description: string | null;
  enabled: boolean;
  lifecycle: string;
  cleanup_ready: boolean;
}

describe('TBI-010 — playbooks-spike flag seed', () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await createScratchDatabase('playbookflag');
  }, 600_000);

  afterAll(async () => {
    if (scratch) await scratch.drop();
  });

  // DoD-0, VT-10 — verify the seed itself, isolated from the later retirement migration.
  it('originally seeds the flag active, default-off, and not cleanup-ready', async () => {
    const client = new pg.Client({ connectionString: scratch.connectionString });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM feature_flag_rules
         WHERE flag_id = (SELECT id FROM feature_flags WHERE key = $1)`,
        [FLAG_KEY]
      );
      await client.query('DELETE FROM feature_flags WHERE key = $1', [FLAG_KEY]);
      await client.query(upMigrationSql());
      const { rows } = await client.query<FlagRow>(
        'SELECT key, description, enabled, lifecycle, cleanup_ready FROM feature_flags WHERE key = $1',
        [FLAG_KEY]
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].key).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
      expect(rows[0].enabled).toBe(false);
      expect(rows[0].lifecycle).toBe('active');
      expect(rows[0].cleanup_ready).toBe(false);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('archives the flag and marks it cleanup-ready after Phase 1 acceptance', async () => {
    const [flag] = await query<FlagRow>(
      scratch.connectionString,
      'SELECT key, description, enabled, lifecycle, cleanup_ready FROM feature_flags WHERE key = $1',
      [FLAG_KEY]
    );

    expect(flag.enabled).toBe(false);
    expect(flag.lifecycle).toBe('archived');
    expect(flag.cleanup_ready).toBe(true);
  });

  // DoD-1, VT-10 — recorded at creation, not left to be decided later
  it('records the winning branch and cleanup criterion on the flag itself', async () => {
    const [flag] = await query<FlagRow>(
      scratch.connectionString,
      'SELECT key, description, enabled, lifecycle, cleanup_ready FROM feature_flags WHERE key = $1',
      [FLAG_KEY]
    );

    expect(flag.description).toMatch(/winning branch: enabled/i);
    expect(flag.description).toMatch(/cleanup criterion:/i);
    expect(flag.description).toMatch(/phase 1 definition model/i);
  });

  // DoD-0, VT-10 — default-off means no audience, not merely a false toggle
  it('ships with no targeting rules', async () => {
    const rules = await query(
      scratch.connectionString,
      `SELECT r.id FROM feature_flag_rules r
       JOIN feature_flags f ON f.id = r.flag_id
       WHERE f.key = $1`,
      [FLAG_KEY]
    );
    expect(rules).toEqual([]);
  });

  // VT-11 — re-running the migration is a no-op rather than an error
  it('is idempotent when applied a second time', async () => {
    await expect(query(scratch.connectionString, upMigrationSql())).resolves.toBeDefined();

    const rows = await query<FlagRow>(
      scratch.connectionString,
      'SELECT key, enabled FROM feature_flags WHERE key = $1',
      [FLAG_KEY]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(false); // a second insert must not resurrect a disabled flag
  });

  /*
   * VT-12 — a project that was never targeted resolves disabled.
   *
   * Asserted against the flag record and its rules rather than by calling `isFeatureEnabled`,
   * because that service reads through Apex's own pool rather than this scratch database. The
   * service's behaviour for this shape — flag disabled, no matching rule — is covered by the
   * wrapper's unit tests; what only a real database can show is that the seeded row has that shape.
   */
  it('leaves an untargeted project with nothing that could enable the flag', async () => {
    const [flag] = await query<{ enabled: boolean; rule_count: string }>(
      scratch.connectionString,
      `SELECT f.enabled, COUNT(r.id)::text AS rule_count
       FROM feature_flags f
       LEFT JOIN feature_flag_rules r ON r.flag_id = f.id
       WHERE f.key = $1
       GROUP BY f.enabled`,
      [FLAG_KEY]
    );

    expect(flag.enabled).toBe(false);
    expect(flag.rule_count).toBe('0');
  });
});
