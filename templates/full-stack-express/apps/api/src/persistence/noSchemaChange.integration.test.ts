import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DOCKER_SKIP_NOTE,
  isDockerAvailable,
  startTestDatabaseServer,
  type TestDatabaseServer,
} from '../../test/support/testDatabase.ts';
import { createPersistence, SchemaNotMigratedError } from './index.ts';

const docker = await isDockerAvailable();

describe.skipIf(!docker)(
  `persistence module schema safety ${docker ? '' : DOCKER_SKIP_NOTE}`,
  () => {
    let server: TestDatabaseServer;

    beforeAll(async () => {
      server = await startTestDatabaseServer();
    }, 120000);

    afterAll(async () => {
      await server?.stop();
    });

    it('VT-17 PBI-003 AC-3 TBI-007 DoD-2 using the module on an unmigrated database issues no DDL', async () => {
      const database = await server.createDatabase();
      const persistence = createPersistence({ databaseUrl: database.url });
      try {
        await persistence.ping();
        await expect(
          persistence.users.findBySubject('seed-user-test-1')
        ).rejects.toBeInstanceOf(SchemaNotMigratedError);
        await expect(
          persistence.users.updateBySubject('seed-user-test-1', {
            displayName: 'Sample Person One',
          })
        ).rejects.toBeInstanceOf(SchemaNotMigratedError);
      } finally {
        await persistence.close();
      }
      try {
        expect(
          await database.query(
            "select table_schema, table_name from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')"
          )
        ).toEqual([]);
        expect(
          await database.query(
            "select schema_name from information_schema.schemata where schema_name = 'drizzle'"
          )
        ).toEqual([]);
      } finally {
        await database.drop();
      }
    }, 60000);

    it.todo(
      'VT-18 PBI-003 AC-3 booting the API composition root leaves the schema alone (activates with FEAT-006 TBI-014)'
    );
  }
);
