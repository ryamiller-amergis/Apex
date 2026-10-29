import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CLOSED_PORT_URL,
  DOCKER_SKIP_NOTE,
  isDockerAvailable,
  startTestDatabaseServer,
  type TestDatabase,
  type TestDatabaseServer,
} from '../../test/support/testDatabase.ts';
import {
  createPersistence,
  PersistenceError,
  PersistenceUnavailableError,
  ProfileConflictError,
  SchemaNotMigratedError,
  type Persistence,
} from './index.ts';

const docker = await isDockerAvailable();

const SUBJECT = 'seed-user-test-1';
const NAME = 'Sample Person One';
const EMAIL = 'sample.one@example.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to reject');
}

function serialized(error: Error): string {
  return [error.message, error.stack ?? '', JSON.stringify(error)].join('\n');
}

describe('persistence with an unreachable database (no Docker needed)', () => {
  it('VT-08 (b) ping and findBySubject throw PersistenceUnavailableError without the URL', async () => {
    const persistence = createPersistence({ databaseUrl: CLOSED_PORT_URL });
    try {
      for (const error of [
        await caught(persistence.ping()),
        await caught(persistence.users.findBySubject(SUBJECT)),
      ]) {
        expect(error).toBeInstanceOf(PersistenceUnavailableError);
        const text = serialized(error);
        for (const value of [
          CLOSED_PORT_URL,
          '127.0.0.1',
          'local-dev-only-password',
          SUBJECT,
        ]) {
          expect(text).not.toContain(value);
        }
      }
    } finally {
      await persistence.close();
    }
  }, 30000);
});

describe.skipIf(!docker)(
  `app_users store against PostgreSQL ${docker ? '' : DOCKER_SKIP_NOTE}`,
  () => {
    let server: TestDatabaseServer;
    let database: TestDatabase;
    let persistence: Persistence;

    beforeAll(async () => {
      server = await startTestDatabaseServer();
    }, 120000);

    afterAll(async () => {
      await server?.stop();
    });

    async function open(migrated = true): Promise<Persistence> {
      database = await server.createDatabase({ migrated });
      persistence = createPersistence({ databaseUrl: database.url });
      return persistence;
    }

    afterEach(async () => {
      await persistence?.close();
      await database?.drop();
    });

    it('VT-01 TBI-006 DoD-1 DoD-2 creates and finds a user by subject', async () => {
      const { users } = await open();
      const created = await users.create({
        externalSubject: SUBJECT,
        displayName: NAME,
      });
      expect(created.id).toMatch(UUID);
      expect(created).toMatchObject({
        externalSubject: SUBJECT,
        displayName: NAME,
        email: null,
        status: 'active',
      });
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.updatedAt.getTime()).toBe(created.createdAt.getTime());

      expect(await users.findBySubject(SUBJECT)).toEqual(created);
      expect(await users.findBySubject('seed-user-unknown')).toBeNull();
    });

    it('VT-02 TBI-006 DoD-1 DoD-2 updates by subject and leaves the rest unchanged', async () => {
      const { users } = await open();
      const created = await users.create({
        externalSubject: SUBJECT,
        displayName: NAME,
      });

      const updated = await users.updateBySubject(SUBJECT, {
        displayName: 'Sample Person Renamed',
        email: EMAIL,
      });
      expect(updated).toMatchObject({
        id: created.id,
        externalSubject: SUBJECT,
        displayName: 'Sample Person Renamed',
        email: EMAIL,
        status: 'active',
        createdAt: created.createdAt,
      });
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(
        created.createdAt.getTime()
      );

      const unchanged = await users.updateBySubject(SUBJECT, {});
      expect(unchanged).toEqual(updated);

      expect(
        await users.updateBySubject('seed-user-unknown', { displayName: 'X' })
      ).toBeNull();
    });

    it('VT-03 TBI-006 DoD-2 NFR a duplicate subject throws ProfileConflictError with no values', async () => {
      const { users } = await open();
      await users.create({
        externalSubject: SUBJECT,
        displayName: NAME,
        email: EMAIL,
      });

      const error = await caught(
        users.create({
          externalSubject: SUBJECT,
          displayName: NAME,
          email: EMAIL,
        })
      );
      expect(error).toBeInstanceOf(ProfileConflictError);
      expect((error as ProfileConflictError).sqlState).toBe('23505');
      const text = serialized(error);
      for (const value of [SUBJECT, NAME, EMAIL]) {
        expect(text).not.toContain(value);
      }
      expect(
        await database.query('select count(*)::int as n from app_users')
      ).toEqual([{ n: 1 }]);
    });

    it('VT-04 two simultaneous creates for one subject leave one row', async () => {
      const { users } = await open();
      const results = await Promise.allSettled([
        users.create({ externalSubject: SUBJECT, displayName: NAME }),
        users.create({ externalSubject: SUBJECT, displayName: NAME }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        ProfileConflictError
      );
      expect(
        await database.query('select count(*)::int as n from app_users')
      ).toEqual([{ n: 1 }]);
    });

    it('VT-05 clears email, round-trips values at the limit, and rejects longer values', async () => {
      const { users } = await open();
      await users.create({
        externalSubject: SUBJECT,
        displayName: NAME,
        email: EMAIL,
      });
      expect(
        (await users.updateBySubject(SUBJECT, { email: null }))?.email
      ).toBeNull();

      const subject = `seed-user-${'s'.repeat(245)}`;
      const name = `Sample Person ${'n'.repeat(86)}`;
      const email = `${'e'.repeat(242)}@example.com`;
      expect([subject.length, name.length, email.length]).toEqual([
        255, 100, 254,
      ]);
      const atLimit = await users.create({
        externalSubject: subject,
        displayName: name,
        email,
      });
      expect(await users.findBySubject(subject)).toEqual(atLimit);

      const tooLong = [
        () =>
          users.create({ externalSubject: `${subject}x`, displayName: NAME }),
        () =>
          users.create({
            externalSubject: 'seed-user-x',
            displayName: `${name}x`,
          }),
        () =>
          users.create({
            externalSubject: 'seed-user-y',
            displayName: NAME,
            email: `e${email}`,
          }),
      ];
      for (const attempt of tooLong) {
        const error = await caught(attempt());
        expect(error).toBeInstanceOf(PersistenceError);
        expect((error as PersistenceError).sqlState).toBe('22001');
        expect(serialized(error)).not.toContain('eeeeeeeeee');
        expect(serialized(error)).not.toContain('nnnnnnnnnn');
      }
    });

    it('VT-06 TBI-006 DoD-0 DoD-3 app_users is the only table and has only the listed columns', async () => {
      await open();
      const tables = await database.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' order by table_name`
      );
      expect(tables).toEqual([{ table_name: 'app_users' }]);

      const columns = await database.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'app_users'
          order by column_name`
      );
      const names = columns.map((row) => row.column_name);
      expect(names).toEqual([
        'created_at',
        'display_name',
        'email',
        'external_subject',
        'id',
        'status',
        'updated_at',
      ]);
      for (const name of names) {
        expect(name).not.toMatch(/password|session|role|audit|flag/);
      }

      const constraints = await database.query<{
        conname: string;
        definition: string;
      }>(
        `select conname, pg_get_constraintdef(oid) as definition
           from pg_constraint
          where conrelid = 'public.app_users'::regclass and contype in ('u', 'c')
          order by conname`
      );
      expect(constraints).toEqual([
        {
          conname: 'app_users_external_subject_unique',
          definition: 'UNIQUE (external_subject)',
        },
        {
          conname: 'app_users_status_check',
          definition: expect.stringMatching(/active.*disabled/),
        },
      ]);
    });

    it('VT-08 (a) PBI-005 AC-1 an unmigrated database throws SchemaNotMigratedError', async () => {
      const { users } = await open(false);
      const error = await caught(users.findBySubject(SUBJECT));
      expect(error).toBeInstanceOf(SchemaNotMigratedError);
      expect(serialized(error)).not.toContain(SUBJECT);
      expect(serialized(error)).not.toContain(database.url);
    });
  }
);
