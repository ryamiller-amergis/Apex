import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLOSED_PORT_URL,
  DOCKER_SKIP_NOTE,
  isDockerAvailable,
  runCli,
  startTestDatabaseServer,
  type TestDatabaseServer,
} from '../../test/support/testDatabase.ts';

const docker = await isDockerAvailable();

const ROWS_QUERY =
  'select id, external_subject, created_at from app_users order by external_subject';

describe('seed command production guard (no database)', () => {
  it('VT-23 TBI-008 DoD-2 PBI-005 AC-3 refuses in production before connecting', async () => {
    const result = await runCli('seed', {
      NODE_ENV: 'production',
      DATABASE_URL: CLOSED_PORT_URL,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Refusing to seed: NODE_ENV is production. Seeding never runs in production.'
    );
    expect(result.stderr).not.toContain('Cannot connect');
    expect(result.stdout).toBe('');
  }, 30000);
});

describe.skipIf(!docker)(
  `seed command against PostgreSQL ${docker ? '' : DOCKER_SKIP_NOTE}`,
  () => {
    let server: TestDatabaseServer;

    beforeAll(async () => {
      server = await startTestDatabaseServer();
    }, 120000);

    afterAll(async () => {
      await server?.stop();
    });

    it('VT-20 VT-22 PBI-005 AC-0 AC-2 TBI-008 DoD-0 DoD-1 seeds three rows, then leaves them unchanged', async () => {
      const database = await server.createDatabase({ migrated: true });
      try {
        const env = { NODE_ENV: 'development', DATABASE_URL: database.url };
        const first = await runCli('seed', env);
        expect(first.status, first.stderr).toBe(0);
        expect(first.stdout.trim()).toBe(
          'Seeded 3 new rows; 0 already present.'
        );
        const before = await database.query(ROWS_QUERY);
        expect(before).toHaveLength(3);

        const second = await runCli('seed', env);
        expect(second.status, second.stderr).toBe(0);
        expect(second.stdout.trim()).toBe(
          'Seeded 0 new rows; 3 already present.'
        );
        expect(await database.query(ROWS_QUERY)).toEqual(before);
      } finally {
        await database.drop();
      }
    }, 60000);

    it('VT-21 PBI-005 AC-1 an unmigrated database fails and creates no table', async () => {
      const database = await server.createDatabase();
      try {
        const result = await runCli('seed', {
          NODE_ENV: 'development',
          DATABASE_URL: database.url,
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          'The app_users table does not exist. Run "pnpm migrate" first.'
        );
        expect(
          await database.query(
            "select table_name from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')"
          )
        ).toEqual([]);
      } finally {
        await database.drop();
      }
    }, 60000);

    it('VT-23 PBI-005 AC-3 production leaves a reachable migrated database unchanged', async () => {
      const database = await server.createDatabase({ migrated: true });
      try {
        const result = await runCli('seed', {
          NODE_ENV: 'production',
          DATABASE_URL: database.url,
        });
        expect(result.status).toBe(1);
        expect(
          await database.query('select count(*)::int as n from app_users')
        ).toEqual([{ n: 0 }]);
      } finally {
        await database.drop();
      }
    }, 60000);
  }
);
