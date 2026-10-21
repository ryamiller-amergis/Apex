/**
 * Checks for the scratch-database harness used by TBI-001.
 *
 * TBI-001 must observe what DDL the engine's store issues, which means a database it can own
 * outright. These checks prove the harness produces a migrated database, exposes the inspection
 * queries the question needs, cleans up after itself, and refuses to point at a shared server.
 */
import { createScratchDatabase, listTables, grantsOutsideSchema } from './support/scratch-db';

// Applying 246 migrations takes a few seconds, well past the suite's 30s default.
jest.setTimeout(180_000);

describe('scratch-db harness', () => {
  it('creates a migrated database, exposes it for inspection, and drops it', async () => {
    const scratch = await createScratchDatabase('smoke');
    expect(scratch.databaseName).toMatch(/^apex_scratch_smoke_\d+_\d+$/);

    const tables = await listTables(scratch.connectionString);
    expect(tables).toEqual(expect.arrayContaining(['pgmigrations', 'adrs', 'app_users']));

    // The grant enumeration TBI-001 (c) depends on must return without error.
    await expect(
      grantsOutsideSchema(scratch.connectionString, 'postgres', 'public')
    ).resolves.toBeInstanceOf(Array);

    await scratch.drop();
    await scratch.drop(); // idempotent

    await expect(listTables(scratch.connectionString)).rejects.toThrow();
  });

  it('refuses to operate against a non-local host', async () => {
    // Both are overridden: TEST_DATABASE_URL takes precedence, and CI sets only that one.
    const original = { test: process.env.TEST_DATABASE_URL, db: process.env.DATABASE_URL };
    process.env.TEST_DATABASE_URL = 'postgresql://u:p@db.example.com:5432/app';
    process.env.DATABASE_URL = 'postgresql://u:p@db.example.com:5432/app';
    delete process.env.ALLOW_REMOTE_SCRATCH_DB;
    try {
      await expect(createScratchDatabase('nope')).rejects.toThrow(
        /Refusing to create a scratch database on non-local host/
      );
    } finally {
      if (original.test === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = original.test;
      process.env.DATABASE_URL = original.db;
    }
  });
});
