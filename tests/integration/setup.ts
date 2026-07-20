/**
 * Integration test bootstrap.
 *
 * Resolves the test database URL and configures the Drizzle pool for
 * integration tests. Import this at the top of every integration test file.
 *
 * The test database is assumed to have all migrations applied (done by CI's
 * integration-test job or by running `npm run migrate:up` locally with
 * TEST_DATABASE_URL pointing to a fresh DB).
 */

const testDbUrl =
  process.env.TEST_DATABASE_URL ??
  (process.env.DATABASE_URL
    ? process.env.DATABASE_URL.replace(/\/([^/?]+)(\?.*)?$/, '/$1_e2e$2')
    : '');

if (!testDbUrl) {
  throw new Error('[integration tests] TEST_DATABASE_URL or DATABASE_URL must be set.');
}

// Override DATABASE_URL so the Drizzle pool created by src/server/db.ts
// connects to the integration test database rather than the application DB.
process.env.DATABASE_URL = testDbUrl;

// Re-export the configured db instance for tests to use directly.
export { db } from '../../src/server/db/drizzle';
