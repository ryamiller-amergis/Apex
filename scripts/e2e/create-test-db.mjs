/**
 * Create the E2E test database as a sibling of the application database.
 *
 * Reads DATABASE_URL from .env, derives the E2E database name (or uses
 * TEST_DATABASE_URL if set), connects to the same server's default
 * "postgres" maintenance database, and creates the test database if it
 * does not already exist.
 *
 * Usage:
 *   node scripts/e2e/create-test-db.mjs
 *
 * Safe to run repeatedly — it is a no-op if the database already exists.
 */
import 'dotenv/config';
import pg from 'pg';

const appUrl = process.env.DATABASE_URL;
if (!appUrl) {
  console.error('[create-test-db] DATABASE_URL is not set in .env.');
  process.exit(1);
}

// Derive the test database URL if TEST_DATABASE_URL is not explicitly set.
const testUrl =
  process.env.TEST_DATABASE_URL ??
  appUrl.replace(/\/([^/?]+)(\?.*)?$/, '/$1_e2e$2');

const parsed = new URL(testUrl);
const testDbName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));

// Connect to the "postgres" maintenance DB on the same server to run CREATE DATABASE.
const adminClient = new pg.Client({
  host: parsed.hostname,
  port: parsed.port ? Number(parsed.port) : 5432,
  user: decodeURIComponent(parsed.username),
  password: decodeURIComponent(parsed.password),
  database: 'postgres',
});

try {
  await adminClient.connect();
  const existing = await adminClient.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [testDbName],
  );

  if (existing.rowCount > 0) {
    console.log(`[create-test-db] Database "${testDbName}" already exists — nothing to do.`);
  } else {
    // CREATE DATABASE cannot be parameterized; the name is derived from our own
    // env, not user input, and is quoted defensively.
    await adminClient.query(`CREATE DATABASE "${testDbName.replace(/"/g, '""')}"`);
    console.log(`[create-test-db] Created database "${testDbName}".`);
  }
} catch (err) {
  console.error('[create-test-db] Failed:', err.message);
  process.exit(1);
} finally {
  await adminClient.end();
}
