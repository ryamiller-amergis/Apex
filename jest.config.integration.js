/**
 * Jest configuration for PostgreSQL integration tests.
 *
 * Unlike the main jest.config.js (which mocks all database calls), these tests
 * use a real PostgreSQL instance to verify schema correctness, Drizzle query
 * behaviour, and migration-level data contracts.
 *
 * Run with:
 *   npm run test:integration
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL) pointing to a migrated
 * PostgreSQL 16 test database. In CI, this is provisioned by the GitHub
 * Actions postgres service in the integration test job.
 */

module.exports = {
  displayName: 'integration',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.e2e.json',
        diagnostics: false,
      },
    ],
  },
  testTimeout: 30_000,
  // Each test file gets its own database schema to avoid cross-test contamination.
  maxWorkers: 1,
  /*
   * Recycles the worker once it grows past this, and — the reason it is here — forces the suites
   * into a worker process at all. Jest runs in band when `maxWorkers` is 1, meaning every file
   * shares the main process, and specifying a memory limit is what turns that off (see
   * `shouldRunInBand`). One worker keeps the files sequential, so nothing contends for the
   * database; recycling it gives the Playbook engine a fresh module context partway through.
   *
   * The engine is loaded through a real dynamic `import()`, and Mastra's ESM graph accumulates
   * state across files in a way that eventually wedges a run with no error and no failing
   * assertion. A worker that restarts never reaches that point. Roughly 800MB was where the full
   * Playbook run stopped making progress, so the limit sits comfortably below it.
   */
  workerIdleMemoryLimit: '512MB',
};
