/**
 * Detects whether migrations should run in CI.
 *
 * - pull_request: true when migrations/ changed between base and head (diff-based;
 *   PR CI only validates, never applies).
 * - push / workflow_dispatch / MIGRATION_DETECT_STRATEGY=db: true when DATABASE_URL
 *   has pending migrations (DB-truth; used for deploy jobs).
 *
 * Writes has_migration_changes=true|false to GITHUB_OUTPUT when set.
 */
import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

function gitDiffMigrations(base, head) {
  if (!base || !head) return false;
  const diff = execSync(`git diff --name-only ${base} ${head} -- migrations/`, {
    encoding: 'utf8',
  }).trim();
  return diff.length > 0;
}

async function hasPendingMigrations(databaseUrl) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  const files = readdirSync(join(process.cwd(), 'migrations')).filter((file) =>
    file.endsWith('.sql'),
  );

  try {
    const { rows } = await client.query('SELECT name FROM pgmigrations');
    const applied = new Set(rows.map((row) => row.name));
    return files.some((file) => !applied.has(file.replace(/\.sql$/, '')));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '42P01') {
      return files.length > 0;
    }
    throw error;
  } finally {
    await client.end();
  }
}

function writeGithubOutput(value) {
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, `has_migration_changes=${value}\n`);
  }
}

const eventName = process.env.GITHUB_EVENT_NAME ?? 'push';
const strategy = process.env.MIGRATION_DETECT_STRATEGY;
let hasChanges = false;

if (strategy === 'db' || eventName === 'push' || eventName === 'workflow_dispatch') {
  // Apply path: compare migration files on disk to pgmigrations in the target DB.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(`${eventName} requires DATABASE_URL to detect pending migrations`);
    process.exit(1);
  }
  hasChanges = await hasPendingMigrations(databaseUrl);
  console.log(
    hasChanges
      ? 'Pending migrations found on database'
      : 'No pending migrations on database',
  );
} else if (eventName === 'pull_request') {
  // PR path: diff-based only (PR CI validates, never applies)
  const base = process.env.GITHUB_BASE_SHA;
  const head = process.env.GITHUB_SHA ?? 'HEAD';
  hasChanges = gitDiffMigrations(base, head);
  console.log(
    hasChanges
      ? `Migration files changed between ${base} and ${head}`
      : 'No migration file changes in PR',
  );
} else {
  console.error(`Unsupported GITHUB_EVENT_NAME for migration detection: ${eventName}`);
  process.exit(1);
}

const value = hasChanges ? 'true' : 'false';
writeGithubOutput(value);
console.log(`has_migration_changes=${value}`);
process.exit(0);
