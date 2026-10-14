/**
 * Scratch database harness for the playbook engine verification spike (FEAT-001, step S2).
 *
 * TBI-001's non-functional requirement forbids running DDL against a shared schema during
 * verification. The existing integration bootstrap (`tests/integration/setup.ts`) points at a
 * shared, pre-migrated database, so it cannot be used for that question. This harness creates a
 * uniquely named database per call, applies Apex's migrations to it, and drops it afterwards.
 *
 * Adapted from `scripts/e2e/create-test-db.mjs`, which uses the same approach of connecting to the
 * server's `postgres` maintenance database to issue CREATE DATABASE.
 *
 * Safety: refuses to operate against a non-local host unless ALLOW_REMOTE_SCRATCH_DB=1. The
 * verification suite must never create or drop databases on a shared or production server.
 */
import pg from 'pg';
import path from 'path';
import dotenv from 'dotenv';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations');
// node-pg-migrate@8 is ESM-only, so its programmatic runner cannot be imported under Jest's CJS
// transform. Driving its CLI in a child process sidesteps that without touching jest config.
const MIGRATE_CLI = path.join(REPO_ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');

export interface ScratchDatabase {
  /** Connection string for the freshly created, migrated database. */
  connectionString: string;
  databaseName: string;
  /** Drops the database. Safe to call twice. */
  drop(): Promise<void>;
}

/**
 * Finds the Postgres *server* to build scratch databases on.
 *
 * Precedence follows `tests/integration/setup.ts` so this behaves like every other integration
 * test: TEST_DATABASE_URL first, DATABASE_URL second. CI's integration job sets only the former,
 * while local development usually has only the latter. Only the host, port and credentials are
 * used — the database named in the URL is never opened, altered or dropped.
 *
 * The final fallback loads .env, because Jest does not read it and `npm run test:integration` has
 * no dotenv wrapper. That file does not exist in CI, which is why the env vars come first.
 */
function connectionSource(): string {
  const fromEnv = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;
  dotenv.config({ path: path.join(REPO_ROOT, '.env') });
  return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
}

function baseUrl(): URL {
  const raw = connectionSource();
  if (!raw) {
    throw new Error(
      'TEST_DATABASE_URL or DATABASE_URL must be set so the scratch harness knows which Postgres ' +
        'server to create the scratch database on. It is used for the server address and ' +
        'credentials only — the application database itself is never touched.'
    );
  }
  const url = new URL(raw);
  if (!LOCAL_HOSTS.has(url.hostname) && process.env.ALLOW_REMOTE_SCRATCH_DB !== '1') {
    throw new Error(
      `Refusing to create a scratch database on non-local host "${url.hostname}". ` +
        'The verification suite must not issue DDL against a shared or production server. ' +
        'Set ALLOW_REMOTE_SCRATCH_DB=1 only if you are certain the target is disposable.'
    );
  }
  return url;
}

function urlFor(base: URL, database: string): string {
  const next = new URL(base.toString());
  next.pathname = `/${database}`;
  return next.toString();
}

async function withMaintenanceClient<T>(base: URL, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlFor(base, 'postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates a uniquely named database, applies Apex migrations, and returns its connection string.
 * Migrating 246 files takes several seconds — give the calling hook a generous timeout.
 */
export async function createScratchDatabase(label = 'verify'): Promise<ScratchDatabase> {
  const base = baseUrl();
  const safeLabel = label.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12) || 'verify';
  const databaseName = `apex_scratch_${safeLabel}_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;

  await withMaintenanceClient(base, (c) => c.query(`CREATE DATABASE "${databaseName}"`));

  const connectionString = urlFor(base, databaseName);

  try {
    await execFileAsync(
      process.execPath,
      [MIGRATE_CLI, 'up', '--no-check-order', '--migrations-dir', MIGRATIONS_DIR],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: connectionString },
        maxBuffer: 32 * 1024 * 1024,
      }
    );
  } catch (error) {
    // Never leave an unmigrated scratch database behind.
    await dropDatabase(base, databaseName).catch(() => undefined);
    throw error;
  }

  let dropped = false;
  return {
    connectionString,
    databaseName,
    async drop() {
      if (dropped) return;
      dropped = true;
      await dropDatabase(base, databaseName);
    },
  };
}

/**
 * Rolls back the most recent `count` migrations.
 *
 * Reversibility is a stated non-functional requirement on the playbook schema, and the only honest
 * way to check it is to actually run the down path and see what is left behind. Scoped to a scratch
 * database for the obvious reason.
 */
export async function migrateDown(connectionString: string, count: number): Promise<void> {
  await execFileAsync(
    process.execPath,
    [MIGRATE_CLI, 'down', String(count), '--no-check-order', '--migrations-dir', MIGRATIONS_DIR],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: connectionString },
      maxBuffer: 32 * 1024 * 1024,
    }
  );
}

const SCRATCH_NAME = /^apex_scratch_[a-z0-9]+_\d+_\d+$/;

async function dropDatabase(base: URL, databaseName: string): Promise<void> {
  // DROP DATABASE cannot be parameterised, so the name is checked against the exact shape this
  // module generates. Nothing else is droppable, whatever a caller passes in.
  if (!SCRATCH_NAME.test(databaseName)) {
    throw new Error(
      `Refusing to drop "${databaseName}": only databases created by this harness ` +
        '(apex_scratch_<label>_<timestamp>_<random>) may be dropped.'
    );
  }
  await withMaintenanceClient(base, async (c) => {
    /*
     * Sessions left open by a failed test would otherwise block the drop, so this clears them
     * first — but only as a courtesy. `pg_terminate_backend` needs the caller to own the session
     * or hold `pg_signal_backend`, and a local role that has neither raises "permission denied to
     * terminate process". That is a cleanup step failing, not a test, and letting it throw turns a
     * suite whose every assertion passed into a red one. `WITH (FORCE)` below does the same job
     * with the server's own authority, so the drop is still the thing that has to succeed.
     */
    try {
      await c.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [databaseName]
      );
    } catch {
      // Fall through to the forced drop.
    }

    await c.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  });
}

/** Table names present in the given schema — the before/after snapshot TBI-001 needs. */
export async function listTables(connectionString: string, schema = 'public'): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [schema]
    );
    return rows.map((r) => r.table_name);
  } finally {
    await client.end();
  }
}

/**
 * Reads a Postgres server setting. TBI-003 requires the engine pool be checked against the
 * database connection budget, and `max_connections` is the only authoritative source for it —
 * a number copied into a document can drift from the server it claims to describe.
 */
export async function serverSetting(connectionString: string, name: string): Promise<string> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{ setting: string }>(
      'SELECT setting FROM pg_settings WHERE name = $1',
      [name]
    );
    if (!rows[0]) throw new Error(`No Postgres setting named "${name}".`);
    return rows[0].setting;
  } finally {
    await client.end();
  }
}

/** Grants held by `role` outside `schema` — the enumeration TBI-001 (c) requires. */
export async function grantsOutsideSchema(
  connectionString: string,
  role: string,
  schema: string
): Promise<Array<{ table_schema: string; table_name: string; privilege_type: string }>> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT table_schema, table_name, privilege_type
       FROM information_schema.role_table_grants
       WHERE grantee = $1 AND table_schema <> $2
       ORDER BY table_schema, table_name, privilege_type`,
      [role, schema]
    );
    return rows;
  } finally {
    await client.end();
  }
}
