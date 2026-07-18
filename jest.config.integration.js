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
  preset: 'ts-jest',
  globals: {
    'ts-jest': {
      tsconfig: '<rootDir>/tsconfig.e2e.json',
      diagnostics: false,
    },
  },
  testTimeout: 30_000,
  // Each test file gets its own database schema to avoid cross-test contamination.
  maxWorkers: 1,
};
