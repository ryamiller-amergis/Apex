/**
 * Bootstrap for AI-run V2 persistence integration tests.
 * Must be imported before any server db module.
 *
 * Aborts unless the resolved database name ends with `_e2e`.
 */
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const worktreeEnv = resolve(__dirname, '../../.env');
const siblingMainEnv = resolve(__dirname, '../../../Apex/.env');
if (existsSync(worktreeEnv)) {
  loadEnv({ path: worktreeEnv });
} else if (existsSync(siblingMainEnv)) {
  // Isolated worktrees often omit .env; fall back to the primary checkout.
  loadEnv({ path: siblingMainEnv });
}

const APPROVED_TEST_DB_SUFFIX = '_e2e';

function resolveTestDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL?.trim();
  if (explicit) return explicit;
  const base = process.env.DATABASE_URL?.trim();
  if (!base) {
    throw new Error(
      '[ai-run-v2-persistence] TEST_DATABASE_URL or DATABASE_URL must be set'
    );
  }
  return base.replace(/\/([^/?]+)(\?.*)?$/, '/$1_e2e$2');
}

function assertApprovedTestDatabase(url: string): void {
  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error('[ai-run-v2-persistence] Invalid TEST_DATABASE_URL');
  }
  if (!dbName.endsWith(APPROVED_TEST_DB_SUFFIX)) {
    throw new Error(
      `[ai-run-v2-persistence] Refusing to run: database "${dbName}" is not an approved *_e2e test database`
    );
  }
}

const testDbUrl = resolveTestDatabaseUrl();
assertApprovedTestDatabase(testDbUrl);
process.env.DATABASE_URL = testDbUrl;
process.env.TEST_DATABASE_URL = testDbUrl;
