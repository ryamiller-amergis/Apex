import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  PRINCIPAL_A,
  PRINCIPAL_B,
} from '../../test/support/testApp.ts';
import {
  DOCKER_SKIP_NOTE,
  isDockerAvailable,
  startTestDatabaseServer,
  type TestDatabase,
  type TestDatabaseServer,
} from '../../test/support/testDatabase.ts';
import type { Principal } from '../identity/principal.ts';
import { createPersistence, type Persistence } from '../persistence/index.ts';

const docker = await isDockerAvailable();

interface UserRow {
  external_subject: string;
  display_name: string;
  email: string | null;
  status: string;
}

describe.skipIf(!docker)(
  `profile API against PostgreSQL ${docker ? '' : DOCKER_SKIP_NOTE}`,
  () => {
    let server: TestDatabaseServer;
    let database: TestDatabase;
    let persistence: Persistence;
    let current: Principal = PRINCIPAL_A;

    beforeAll(async () => {
      server = await startTestDatabaseServer();
    }, 120000);

    afterAll(async () => {
      await server?.stop();
    });

    async function freshApp() {
      database = await server.createDatabase({ migrated: true });
      persistence = createPersistence({ databaseUrl: database.url });
      current = PRINCIPAL_A;
      return buildTestApp({ principal: () => current, persistence }).app;
    }

    afterEach(async () => {
      await persistence?.close();
      await database?.drop();
    });

    const rows = () =>
      database.query<UserRow>(
        'select external_subject, display_name, email, status from app_users order by external_subject'
      );

    it('VT-01 VT-03 PBI-010 AC-0 AC-2 the first GET creates the row and a later GET returns it', async () => {
      const app = await freshApp();
      const first = await request(app).get('/api/v1/me').expect(200);
      expect(first.body).toEqual({
        displayName: PRINCIPAL_A.displayName,
        email: PRINCIPAL_A.email,
        status: 'active',
      });
      const second = await request(app).get('/api/v1/me').expect(200);
      expect(second.body).toEqual(first.body);
      expect(await rows()).toEqual([
        {
          external_subject: PRINCIPAL_A.subject,
          display_name: PRINCIPAL_A.displayName,
          email: PRINCIPAL_A.email,
          status: 'active',
        },
      ]);
    }, 60000);

    it('VT-04 PBI-010 AC-2 ten parallel first requests create exactly one row', async () => {
      const app = await freshApp();
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => request(app).get('/api/v1/me'))
      );
      expect(responses.map((response) => response.status)).toEqual(
        Array.from({ length: 10 }, () => 200)
      );
      expect(await rows()).toHaveLength(1);
    }, 60000);

    it('VT-06 VT-07 PBI-010 AC-3 PBI-011 AC-3 each principal changes only its own row, whatever the request names', async () => {
      const app = await freshApp();
      await request(app).get('/api/v1/me').expect(200);
      current = PRINCIPAL_B;
      await request(app)
        .put(`/api/v1/me?subject=${PRINCIPAL_A.subject}`)
        .set('X-User-Subject', PRINCIPAL_A.subject)
        .send({ displayName: 'Beta Renamed', email: null })
        .expect(200);
      expect(await rows()).toEqual([
        {
          external_subject: PRINCIPAL_A.subject,
          display_name: PRINCIPAL_A.displayName,
          email: PRINCIPAL_A.email,
          status: 'active',
        },
        {
          external_subject: PRINCIPAL_B.subject,
          display_name: 'Beta Renamed',
          email: null,
          status: 'active',
        },
      ]);
    }, 60000);

    it('VT-08 VT-11 PBI-011 AC-0 AC-2 an update persists and a blank email clears it', async () => {
      const app = await freshApp();
      await request(app)
        .put('/api/v1/me')
        .send({ displayName: '  Updated Alpha  ', email: 'new@example.test' })
        .expect(200);
      expect((await request(app).get('/api/v1/me').expect(200)).body).toEqual({
        displayName: 'Updated Alpha',
        email: 'new@example.test',
        status: 'active',
      });
      await request(app)
        .put('/api/v1/me')
        .send({ displayName: 'Updated Alpha', email: '   ' })
        .expect(200);
      expect((await rows())[0]?.email).toBeNull();
    }, 60000);

    it('VT-12 PBI-011 AC-2 stores values at the limit, including multi-byte characters', async () => {
      const app = await freshApp();
      const displayName = '\u{1F600}'.repeat(100);
      const email = `${'a'.repeat(64)}@${'b'.repeat(185)}.test`;
      expect(email).toHaveLength(254);
      await request(app)
        .put('/api/v1/me')
        .send({ displayName, email })
        .expect(200);
      expect(await rows()).toEqual([
        expect.objectContaining({ display_name: displayName, email }),
      ]);
      await request(app)
        .put('/api/v1/me')
        .send({ displayName: `${displayName}x`, email })
        .expect(400);
      expect((await rows())[0]?.display_name).toBe(displayName);
    }, 60000);

    it('VT-14 PBI-011 AC-2 a PUT before any GET creates the row with the update applied', async () => {
      const app = await freshApp();
      await request(app)
        .put('/api/v1/me')
        .send({ displayName: 'Chosen Name' })
        .expect(200);
      expect(await rows()).toEqual([
        {
          external_subject: PRINCIPAL_A.subject,
          display_name: 'Chosen Name',
          email: null,
          status: 'active',
        },
      ]);
    }, 60000);

    it('VT-16 PBI-012 AC-0 readiness answers ready against a real database', async () => {
      const app = await freshApp();
      const response = await request(app).get('/health/ready').expect(200);
      expect(response.body).toEqual({ status: 'ready' });
    }, 60000);
  }
);
