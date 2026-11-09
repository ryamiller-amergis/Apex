import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLOSED_PORT_URL,
  committedMigrations,
  DOCKER_SKIP_NOTE,
  isDockerAvailable,
  runCli,
  startTestDatabaseServer,
  type TestDatabaseServer,
} from '../../test/support/testDatabase.ts';

const docker = await isDockerAvailable();
const SENTINEL = 'sentinel-password-123';

describe('migrate command configuration (no database)', () => {
  it('VT-13 PBI-004 AC-3 exits 2 and names DATABASE_URL when it is unset', async () => {
    const result = await runCli('migrate', { NODE_ENV: 'production' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'Configuration error: DATABASE_URL is missing.'
    );
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('Cannot connect');
  }, 30000);

  it('VT-14 PBI-004 AC-3 exits 2 for a malformed DATABASE_URL and never prints the value', async () => {
    const result = await runCli('migrate', {
      NODE_ENV: 'production',
      DATABASE_URL: `mysql://app_user:${SENTINEL}@db.internal/project_db`,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'Configuration error: DATABASE_URL is not a valid PostgreSQL connection URL.'
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(SENTINEL);
  }, 30000);

  it('exits 1 without printing the URL when PostgreSQL is unreachable', async () => {
    const result = await runCli('migrate', {
      NODE_ENV: 'production',
      DATABASE_URL: CLOSED_PORT_URL,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot connect to the database.');
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      'local-dev-only-password'
    );
  }, 30000);
});

describe.skipIf(!docker)(
  `migrate command against PostgreSQL ${docker ? '' : DOCKER_SKIP_NOTE}`,
  () => {
    let server: TestDatabaseServer;
    const scratch: string[] = [];

    beforeAll(async () => {
      server = await startTestDatabaseServer();
    }, 120000);

    afterAll(async () => {
      for (const folder of scratch) {
        rmSync(folder, { recursive: true, force: true });
      }
      await server?.stop();
    });

    it('VT-11 PBI-004 AC-0 applies pending migrations and exits 0', async () => {
      const database = await server.createDatabase();
      try {
        const result = await runCli('migrate', {
          NODE_ENV: 'production',
          DATABASE_URL: database.url,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(
          'Applied 1 migration: 0000_init_app_users'
        );
        expect(
          await database.query(
            "select to_regclass('public.app_users') is not null as present"
          )
        ).toEqual([{ present: true }]);

        const again = await runCli('migrate', {
          NODE_ENV: 'production',
          DATABASE_URL: database.url,
        });
        expect(again.status).toBe(0);
        expect(again.stdout).toContain('No pending migrations.');
      } finally {
        await database.drop();
      }
    }, 60000);

    it('VT-12 PBI-004 AC-1 TBI-007 DoD-1 exits 1, names the failing file, and keeps earlier files applied', async () => {
      const folder = mkdtempSync(path.join(tmpdir(), 'bad-migrations-'));
      scratch.push(folder);
      cpSync(committedMigrations, folder, { recursive: true });
      const journalPath = path.join(folder, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: Record<string, unknown>[];
      };
      const first = journal.entries[0] as { when: number };
      journal.entries.push({
        idx: 1,
        version: '7',
        when: first.when + 1000,
        tag: '0001_broken',
        breakpoints: true,
      });
      writeFileSync(journalPath, JSON.stringify(journal));
      writeFileSync(
        path.join(folder, '0001_broken.sql'),
        'ALTER TABLE "app_users" ADD COLUMN "nickname" text;\n--> statement-breakpoint\nALTER TABLE "app_users" ADD COLUMN "broken" no_such_type;'
      );

      const database = await server.createDatabase();
      try {
        const result = await runCli(
          'migrate',
          { NODE_ENV: 'production', DATABASE_URL: database.url },
          ['--migrations', folder]
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(
          /Migration 0001_broken failed: 42704 type "no_such_type" does not exist/
        );
        expect(result.stdout).not.toContain('Applied');

        expect(
          await database.query<{ n: number }>(
            'select count(*)::int as n from drizzle.__drizzle_migrations'
          )
        ).toEqual([{ n: 1 }]);
        expect(
          await database.query(
            `select column_name from information_schema.columns
              where table_name = 'app_users' and column_name in ('nickname', 'broken')`
          )
        ).toEqual([]);
      } finally {
        await database.drop();
      }
    }, 60000);

    it('VT-25 two simultaneous runs both exit 0 and apply each migration once', async () => {
      const database = await server.createDatabase();
      try {
        const env = { NODE_ENV: 'production', DATABASE_URL: database.url };
        const [one, two] = await Promise.all([
          runCli('migrate', env),
          runCli('migrate', env),
        ]);
        expect(one.status, one.stderr).toBe(0);
        expect(two.status, two.stderr).toBe(0);
        expect([one.stdout.trim(), two.stdout.trim()].sort()).toEqual([
          'Applied 1 migration: 0000_init_app_users',
          'No pending migrations.',
        ]);
        expect(
          await database.query<{ n: number }>(
            'select count(*)::int as n from drizzle.__drizzle_migrations'
          )
        ).toEqual([{ n: 1 }]);
      } finally {
        await database.drop();
      }
    }, 60000);
  }
);
