import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  committedMigrations,
  DOCKER_SKIP_NOTE,
  isDockerAvailable,
  startTestDatabaseServer,
  type TestDatabaseServer,
} from '../../../test/support/testDatabase.ts';
import { appUsers } from '../schema.ts';
import { readMigrations, runMigrations } from './runMigrations.ts';

const docker = await isDockerAvailable();

interface ColumnRow {
  column_name: string;
  data_type: string;
  character_maximum_length: number | null;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
}

function liveType(row: ColumnRow): string {
  if (row.data_type === 'character varying') {
    return `varchar(${row.character_maximum_length})`;
  }
  return row.data_type;
}

describe.skipIf(!docker)(
  `runMigrations against PostgreSQL ${docker ? '' : DOCKER_SKIP_NOTE}`,
  () => {
    let server: TestDatabaseServer;

    beforeAll(async () => {
      server = await startTestDatabaseServer();
    }, 120000);

    afterAll(async () => {
      await server?.stop();
    });

    it('VT-09 PBI-003 AC-2 applies the committed migrations in order on an empty database and produces the schema', async () => {
      const database = await server.createDatabase();
      try {
        const result = await runMigrations({
          databaseUrl: database.url,
          migrationsFolder: committedMigrations,
        });
        const expected = readMigrations(committedMigrations);
        expect(result.applied).toEqual(expected.map((m) => m.tag));

        const history = await database.query<{
          hash: string;
          created_at: string;
        }>(
          'select hash, created_at from drizzle.__drizzle_migrations order by id'
        );
        expect(history.map((row) => row.hash)).toEqual(
          expected.map((m) => m.hash)
        );
        expect(history.map((row) => Number(row.created_at))).toEqual(
          expected.map((m) => m.folderMillis)
        );

        const live = await database.query<ColumnRow>(
          `select column_name, data_type, character_maximum_length, is_nullable, column_default
             from information_schema.columns
            where table_schema = 'public' and table_name = 'app_users'`
        );
        const config = getTableConfig(appUsers);
        const liveByName = new Map(live.map((row) => [row.column_name, row]));
        expect([...liveByName.keys()].sort()).toEqual(
          config.columns.map((column) => column.name).sort()
        );
        for (const column of config.columns) {
          const row = liveByName.get(column.name);
          expect(row, column.name).toBeDefined();
          if (!row) {
            continue;
          }
          expect(liveType(row), column.name).toBe(column.getSQLType());
          expect(row.is_nullable === 'NO', column.name).toBe(column.notNull);
          expect(row.column_default !== null, column.name).toBe(
            column.hasDefault
          );
        }

        const constraints = await database.query<{
          conname: string;
          contype: string;
        }>(
          `select conname, contype from pg_constraint
            where conrelid = 'public.app_users'::regclass order by conname`
        );
        expect(constraints).toEqual([
          { conname: 'app_users_external_subject_unique', contype: 'u' },
          { conname: 'app_users_pkey', contype: 'p' },
          { conname: 'app_users_status_check', contype: 'c' },
        ]);
      } finally {
        await database.drop();
      }
    }, 60000);

    it('VT-10 TBI-007 NFR re-running on a migrated database changes nothing', async () => {
      const database = await server.createDatabase({ migrated: true });
      try {
        await database.query(
          `insert into app_users (external_subject, display_name)
           values ('seed-user-test-1', 'Sample Person One')`
        );
        const before = await database.query(
          'select * from drizzle.__drizzle_migrations order by id'
        );

        const result = await runMigrations({
          databaseUrl: database.url,
          migrationsFolder: committedMigrations,
        });

        expect(result.applied).toEqual([]);
        expect(
          await database.query(
            'select * from drizzle.__drizzle_migrations order by id'
          )
        ).toEqual(before);
        expect(
          await database.query('select count(*)::int as n from app_users')
        ).toEqual([{ n: 1 }]);
      } finally {
        await database.drop();
      }
    }, 60000);
  }
);
