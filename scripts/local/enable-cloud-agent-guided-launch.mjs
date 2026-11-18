/**
 * One-time local switch for Cloud Agent dev testing.
 * Enables my-work-cloud-agent and cloud-agent-guided-launch for everyone
 * in the database this process connects to. Safe to run again.
 *
 *   npx dotenv -e .env.local -- node scripts/local/enable-cloud-agent-guided-launch.mjs
 *
 * Point this at the local database only.
 */
import pg from 'pg';

const KEYS = ['my-work-cloud-agent', 'cloud-agent-guided-launch'];

const DESCRIPTIONS = {
  'my-work-cloud-agent':
    'Gates Start Cloud Development on Azure DevOps My Work rows. Off keeps local Start Development / Resume / Close only.',
  'cloud-agent-guided-launch':
    'Gates the Cloud Agent launch chooser, skill recommendation, resume-from-snapshot, retry, and Home guided jobs.',
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required. Run with: npx dotenv -e .env.local -- node scripts/local/enable-cloud-agent-guided-launch.mjs');
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query('BEGIN');
  for (const key of KEYS) {
    await client.query(
      `INSERT INTO feature_flags (key, description, enabled, lifecycle, cleanup_ready, created_by)
       VALUES ($1, $2, true, 'active', false, NULL)
       ON CONFLICT (key) DO UPDATE
       SET enabled = true,
           lifecycle = 'active',
           updated_at = NOW()`,
      [key, DESCRIPTIONS[key]],
    );
    await client.query(
      `INSERT INTO feature_flag_rules (flag_id, type, value, created_by)
       SELECT f.id, 'everyone', NULL, NULL
       FROM feature_flags f
       WHERE f.key = $1
         AND NOT EXISTS (
           SELECT 1 FROM feature_flag_rules r
           WHERE r.flag_id = f.id AND r.type = 'everyone'
         )`,
      [key],
    );
  }
  await client.query('COMMIT');

  const { rows } = await client.query(
    `SELECT f.key, f.enabled, r.type AS rule
     FROM feature_flags f
     LEFT JOIN feature_flag_rules r ON r.flag_id = f.id AND r.type = 'everyone'
     WHERE f.key = ANY($1::text[])
     ORDER BY f.key`,
    [KEYS],
  );
  console.table(rows);
} catch (err) {
  await client.query('ROLLBACK');
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await client.end();
}
