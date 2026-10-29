import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  problemContentType,
  problemTypes,
  profileSchema,
} from '@project-scope/contracts';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { createLogger } from '../../src/observability/logger.ts';
import { captureLogs } from '../../src/observability/testing/captureLogs.ts';
import {
  ProfileConflictError,
  createPersistence,
  type Persistence,
} from '../../src/persistence/index.ts';
import { syntheticProfiles } from '../fixtures/synthetic.ts';
import {
  columnMatches,
  drizzleAppUsersExpectation,
  type InformationColumn,
} from '../support/appUsersSchema.ts';
import {
  createTestIdentityAdapter,
  TEST_SUBJECT_HEADER,
} from '../support/testIdentityAdapter.ts';
import { CLOSED_PORT_URL, querySql } from '../support/testDatabase.ts';

const dockerAvailable = inject('dockerAvailable') === true;
const databaseUrl = String(inject('databaseUrl') ?? '');
const containerId = String(inject('containerId') ?? '');
const skipNote = dockerAvailable
  ? ''
  : ' (skipped: Docker is required to run the integration tests)';

const [personA, personB] = syntheticProfiles;
const pools: Persistence[] = [];

function openPersistence(): Persistence {
  const persistence = createPersistence({
    databaseUrl,
    connectionTimeoutMs: 5000,
  });
  pools.push(persistence);
  return persistence;
}

async function truncate(): Promise<void> {
  await querySql(databaseUrl, 'truncate table app_users');
}

beforeEach(async () => {
  if (dockerAvailable) {
    await truncate();
  }
});

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.close()));
});

describe(`PostgreSQL integration${skipNote}`, () => {
  it.skipIf(!dockerAvailable)(
    'VT-19 TBI-024 DoD-0 committed migrations match the Drizzle app_users table',
    async () => {
      const columns = await querySql<InformationColumn>(
        databaseUrl,
        `select column_name, data_type, is_nullable, character_maximum_length
         from information_schema.columns
         where table_schema = 'public' and table_name = 'app_users'`
      );
      const expected = drizzleAppUsersExpectation();
      expect(columns).toHaveLength(expected.columns.length);
      for (const column of expected.columns) {
        const actual = columns.find((row) => row.column_name === column.name);
        expect(actual, column.name).toBeDefined();
        expect(columnMatches(column, actual as InformationColumn)).toBe(true);
      }
      const constraints = await querySql<{
        constraint_name: string;
        constraint_type: string;
        column_name: string;
      }>(
        databaseUrl,
        `select tc.constraint_name, tc.constraint_type, kcu.column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on tc.constraint_name = kcu.constraint_name
          and tc.table_schema = kcu.table_schema
         where tc.table_schema = 'public' and tc.table_name = 'app_users'`
      );
      expect(
        constraints.some(
          (row) =>
            row.constraint_type === 'PRIMARY KEY' && row.column_name === 'id'
        )
      ).toBe(true);
      expect(
        constraints.some(
          (row) =>
            row.constraint_name === 'app_users_external_subject_unique' &&
            row.column_name === 'external_subject'
        )
      ).toBe(true);
      const applied = await querySql<{ hash: string }>(
        databaseUrl,
        'select hash from drizzle.__drizzle_migrations'
      );
      expect(applied.length).toBeGreaterThan(0);
    }
  );

  it.skipIf(!dockerAvailable)(
    'VT-20 TBI-024 DoD-0 find, create on first access, update, and a duplicate subject',
    async () => {
      const persistence = openPersistence();
      expect(await persistence.users.findBySubject(personA.subject)).toBeNull();
      const created = await persistence.users.create({
        externalSubject: personA.subject,
        displayName: personA.displayName,
        email: personA.email,
      });
      expect(created.externalSubject).toBe(personA.subject);
      const found = await persistence.users.findBySubject(personA.subject);
      expect(found?.displayName).toBe(personA.displayName);
      const updated = await persistence.users.updateBySubject(personA.subject, {
        displayName: 'test-name-a-updated',
        email: 'test-name-a-updated@example.test',
      });
      expect(updated).toMatchObject({
        externalSubject: personA.subject,
        displayName: 'test-name-a-updated',
        email: 'test-name-a-updated@example.test',
        status: 'active',
      });
      await expect(
        persistence.users.create({
          externalSubject: personA.subject,
          displayName: personA.displayName,
        })
      ).rejects.toBeInstanceOf(ProfileConflictError);
    }
  );

  it.skipIf(!dockerAvailable)(
    'VT-21 TBI-024 DoD-2 one principal cannot read or change another profile',
    async () => {
      const persistence = openPersistence();
      await persistence.users.create({
        externalSubject: personA.subject,
        displayName: personA.displayName,
        email: personA.email,
      });
      const createdB = await persistence.users.create({
        externalSubject: personB.subject,
        displayName: personB.displayName,
        email: personB.email,
      });
      const capture = captureLogs();
      const app = createApp({
        logger: createLogger({ LOG_LEVEL: 'silent' }, capture.stream),
        identityAdapter: createTestIdentityAdapter(),
        persistence,
        readinessTimeoutMs: 2000,
      });
      const seen = await request(app)
        .get('/api/v1/me')
        .set(TEST_SUBJECT_HEADER, personA.subject);
      expect(seen.status).toBe(200);
      expect(profileSchema.parse(seen.body).displayName).toBe(
        personA.displayName
      );
      expect(seen.text).not.toContain(personB.displayName);
      expect(seen.text).not.toContain(personB.subject);

      const sneaky = await request(app)
        .put(`/api/v1/me?subject=${personB.subject}&id=${createdB.id}`)
        .set(TEST_SUBJECT_HEADER, personA.subject)
        .send({
          displayName: 'test-name-a-only',
          email: personA.email,
          subject: personB.subject,
          id: createdB.id,
        });
      expect(sneaky.status).toBe(400);
      expect(
        (await persistence.users.findBySubject(personB.subject))?.displayName
      ).toBe(personB.displayName);

      const renamed = await request(app)
        .put('/api/v1/me')
        .set(TEST_SUBJECT_HEADER, personA.subject)
        .send({ displayName: 'test-name-a-only', email: personA.email });
      expect(renamed.status).toBe(200);
      expect(renamed.text).not.toContain(personB.displayName);
      expect(
        (await persistence.users.findBySubject(personA.subject))?.displayName
      ).toBe('test-name-a-only');
      expect(
        (await persistence.users.findBySubject(personB.subject))?.email
      ).toBe(personB.email);
    }
  );

  it.skipIf(!dockerAvailable)(
    'VT-22 TBI-024 NFR the table is empty at the start of the run and the container id changes across runs',
    async () => {
      const rows = await querySql<{ count: string }>(
        databaseUrl,
        'select count(*)::text as count from app_users'
      );
      expect(rows[0]?.count).toBe('0');
      const marker = path.join(tmpdir(), 'feat-011-integration-container-id');
      let previous = '';
      try {
        previous = readFileSync(marker, 'utf8').trim();
      } catch {
        previous = '';
      }
      if (previous) {
        expect(containerId).not.toBe(previous);
      }
      expect(containerId).not.toBe('');
      writeFileSync(marker, containerId);
      await querySql(
        databaseUrl,
        `insert into app_users (external_subject, display_name, email)
         values ($1, $2, $3)`,
        [personA.subject, personA.displayName, personA.email]
      );
    }
  );

  it.skipIf(!dockerAvailable)(
    'VT-23 TBI-024 DoD-1 ready succeeds when PostgreSQL is up and live needs no credentials',
    async () => {
      const persistence = openPersistence();
      const capture = captureLogs();
      const app = createApp({
        logger: createLogger({ LOG_LEVEL: 'silent' }, capture.stream),
        identityAdapter: createTestIdentityAdapter(),
        persistence,
        readinessTimeoutMs: 2000,
      });
      const ready = await request(app).get('/health/ready');
      expect(ready.status).toBe(200);
      expect(ready.body).toEqual({ status: 'ready' });
      const live = await request(app).get('/health/live');
      expect(live.status).toBe(200);
      expect(live.body).toEqual({ status: 'ok' });
    }
  );
});

describe('readiness without a database connection string in the body', () => {
  it('VT-23 TBI-024 DoD-1 a closed port reports not-ready and live still succeeds', async () => {
    const persistence = createPersistence({
      databaseUrl: CLOSED_PORT_URL,
      connectionTimeoutMs: 300,
    });
    const capture = captureLogs();
    const app = createApp({
      logger: createLogger({ LOG_LEVEL: 'silent' }, capture.stream),
      identityAdapter: createTestIdentityAdapter(),
      persistence,
      readinessTimeoutMs: 800,
    });
    try {
      const ready = await request(app).get('/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.headers['content-type']).toContain(problemContentType);
      expect(ready.body.type).toBe(problemTypes.notReady);
      expect(ready.text).not.toContain('127.0.0.1');
      expect(ready.text).not.toContain('postgresql');
      expect(ready.text).not.toContain('local-dev-only-password');
      const live = await request(app).get('/health/live');
      expect(live.status).toBe(200);
      expect(live.body).toEqual({ status: 'ok' });
    } finally {
      await persistence.close();
    }
  });
});
