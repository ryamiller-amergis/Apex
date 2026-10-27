import {
  problemContentType,
  problemDetailsSchema,
  problemTypes,
  profileSchema,
  type ProblemDetails,
} from '@project-scope/contracts';
import request, { type Response } from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  buildTestApp,
  PRINCIPAL_A,
  PRINCIPAL_B,
} from '../../test/support/testApp.ts';
import { PersistenceUnavailableError } from '../persistence/index.ts';

const LEAK = 'postgres://synthetic-user:synthetic-pw@db.internal:5432/app';
const emailOfLength = (length: number) =>
  `${'e'.repeat(length - '@example.test'.length)}@example.test`;

function expectProblem(
  response: Response,
  status: number,
  type: string
): ProblemDetails {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toContain(problemContentType);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.type).toBe(type);
  expect(body.requestId).toBe(response.headers['x-request-id']);
  return body;
}

function pointers(body: ProblemDetails): string[] {
  return (body.errors ?? []).map((error) => error.pointer).sort();
}

describe('GET /api/v1/me (PBI-010)', () => {
  it('VT-01 PBI-010 AC-0 returns the stored profile in the documented shape', async () => {
    const { app, persistence } = buildTestApp();
    persistence.seed({
      externalSubject: PRINCIPAL_A.subject,
      displayName: 'Stored Alpha',
      email: 'stored.alpha@example.test',
    });
    const response = await request(app).get('/api/v1/me').expect(200);
    expect(profileSchema.parse(response.body)).toEqual({
      displayName: 'Stored Alpha',
      email: 'stored.alpha@example.test',
      status: 'active',
    });
    expect(Object.keys(response.body).sort()).toEqual([
      'displayName',
      'email',
      'status',
    ]);
    expect(response.text).not.toContain(PRINCIPAL_A.subject);
    expect(response.headers['x-request-id']).toBeDefined();
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('VT-02 PBI-010 AC-1 returns 503 with a request ID and no database detail', async () => {
    const { app, persistence } = buildTestApp();
    persistence.override('findBySubject', () => {
      throw Object.assign(new PersistenceUnavailableError(), {
        stack: `Error: ${LEAK}\n    at query (pool.js:1:1)`,
      });
    });
    const response = await request(app).get('/api/v1/me');
    const body = expectProblem(response, 503, problemTypes.serviceUnavailable);
    expect(body.title).toBe('Service unavailable');
    for (const fragment of ['postgres', 'db.internal', 'synthetic-pw', 'pool.js']) {
      expect(response.text).not.toContain(fragment);
    }
  });

  it('VT-03 PBI-010 AC-2 TBI-015 DoD-1 creates the profile on first access and returns it again', async () => {
    const { app, persistence } = buildTestApp();
    const first = await request(app).get('/api/v1/me').expect(200);
    const second = await request(app).get('/api/v1/me').expect(200);
    expect(first.body).toEqual({
      displayName: PRINCIPAL_A.displayName,
      email: null,
      status: 'active',
    });
    expect(second.body).toEqual(first.body);
    expect(persistence.rowCount()).toBe(1);
  });

  it('VT-04 PBI-010 AC-2 ten parallel first requests create exactly one row', async () => {
    const { app, persistence } = buildTestApp();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => request(app).get('/api/v1/me'))
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual(responses[0]!.body);
    }
    expect(persistence.rowCount()).toBe(1);
    expect(
      persistence.calls.filter((call) => call.method === 'create').length
    ).toBeGreaterThan(1);
  });

  it('VT-05 PBI-010 AC-3 PBI-011 AC-3 an unauthenticated GET or PUT gets 401 and touches no data', async () => {
    const { app, persistence } = buildTestApp({ principal: null });
    expectProblem(
      await request(app).get('/api/v1/me'),
      401,
      problemTypes.authenticationRequired
    );
    expectProblem(
      await request(app)
        .put('/api/v1/me')
        .send({ displayName: 'Intruder', email: 'intruder@example.test' }),
      401,
      problemTypes.authenticationRequired
    );
    expect(persistence.calls).toEqual([]);
  });

  it("VT-06 PBI-010 AC-3 another person's identifier in the query, a header, or the path has no effect", async () => {
    const { app, persistence } = buildTestApp();
    const rowA = persistence.seed({
      externalSubject: PRINCIPAL_A.subject,
      displayName: 'Stored Alpha',
    });
    const rowB = persistence.seed({
      externalSubject: PRINCIPAL_B.subject,
      displayName: 'Stored Beta',
      email: 'stored.beta@example.test',
    });
    const response = await request(app)
      .get(`/api/v1/me?id=${rowB.id}&subject=${PRINCIPAL_B.subject}`)
      .set('X-User-Id', PRINCIPAL_B.subject)
      .expect(200);
    expect(response.body.displayName).toBe(rowA.displayName);
    expect(response.text).not.toContain('Beta');
    expectProblem(
      await request(app).get(`/api/v1/me/${rowB.id}`),
      404,
      problemTypes.notFound
    );
    expect(
      persistence.calls.every((call) => call.subject === PRINCIPAL_A.subject)
    ).toBe(true);
  });

  it('VT-07 PBI-010 AC-3 PBI-011 AC-3 each principal reads and updates only its own row', async () => {
    let current = PRINCIPAL_A;
    const { app, persistence } = buildTestApp({ principal: () => current });
    persistence.seed({
      externalSubject: PRINCIPAL_A.subject,
      displayName: 'Stored Alpha',
    });
    persistence.seed({
      externalSubject: PRINCIPAL_B.subject,
      displayName: 'Stored Beta',
    });
    await request(app)
      .put('/api/v1/me')
      .send({ displayName: 'Alpha Renamed' })
      .expect(200);
    current = PRINCIPAL_B;
    const asB = await request(app).get('/api/v1/me').expect(200);
    expect(asB.body.displayName).toBe('Stored Beta');
    expect(persistence.row(PRINCIPAL_B.subject)?.displayName).toBe(
      'Stored Beta'
    );
    current = PRINCIPAL_A;
    const asA = await request(app).get('/api/v1/me').expect(200);
    expect(asA.body.displayName).toBe('Alpha Renamed');
  });
});

describe('PUT /api/v1/me (PBI-011)', () => {
  function seeded() {
    const built = buildTestApp();
    built.persistence.seed({
      externalSubject: PRINCIPAL_A.subject,
      displayName: 'Stored Alpha',
      email: 'stored.alpha@example.test',
    });
    return built;
  }

  it('VT-08 PBI-011 AC-0 updates the profile and a later GET returns the same values', async () => {
    const { app, persistence } = seeded();
    const before = persistence.row(PRINCIPAL_A.subject)!.updatedAt;
    const response = await request(app)
      .put('/api/v1/me')
      .send({ displayName: 'Alpha Updated', email: 'alpha.new@example.test' })
      .expect(200);
    expect(response.body).toEqual({
      displayName: 'Alpha Updated',
      email: 'alpha.new@example.test',
      status: 'active',
    });
    const read = await request(app).get('/api/v1/me').expect(200);
    expect(read.body).toEqual(response.body);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(
      persistence.row(PRINCIPAL_A.subject)!.updatedAt.getTime()
    ).toBeGreaterThan(before.getTime());
  });

  it('VT-09 PBI-011 AC-1 names each invalid field, repeats no value, and changes nothing', async () => {
    const { app, persistence } = seeded();
    const before = persistence.row(PRINCIPAL_A.subject);
    const response = await request(app)
      .put('/api/v1/me')
      .send({ displayName: '', email: 'not-an-email' });
    const body = expectProblem(response, 400, problemTypes.validationError);
    expect(pointers(body)).toEqual(['/displayName', '/email']);
    for (const error of body.errors ?? []) {
      expect(error.message.length).toBeGreaterThan(0);
    }
    expect(response.text).not.toContain('not-an-email');
    expect(persistence.row(PRINCIPAL_A.subject)).toEqual(before);
    expect(
      persistence.calls.filter((call) => call.method === 'updateBySubject')
    ).toEqual([]);
  });

  it('VT-10 PBI-011 AC-1 returns 503 with no database detail when the update fails', async () => {
    const { app, persistence } = seeded();
    persistence.override('updateBySubject', () => {
      throw new PersistenceUnavailableError();
    });
    const response = await request(app)
      .put('/api/v1/me')
      .send({ displayName: 'Never Stored' });
    expectProblem(response, 503, problemTypes.serviceUnavailable);
    expect(persistence.row(PRINCIPAL_A.subject)?.displayName).toBe(
      'Stored Alpha'
    );
  });

  it.each([
    ['null', { email: null }],
    ['blank', { email: '   ' }],
    ['omitted', {}],
  ])(
    'VT-11 PBI-011 AC-2 a %s email clears the stored email',
    async (_label, emailPart) => {
      const { app, persistence } = seeded();
      const response = await request(app)
        .put('/api/v1/me')
        .send({ displayName: 'Stored Alpha', ...emailPart })
        .expect(200);
      expect(response.body.email).toBeNull();
      expect(persistence.row(PRINCIPAL_A.subject)?.email).toBeNull();
    }
  );

  it('VT-12 PBI-011 AC-2 saves values at the limit and rejects values over it', async () => {
    const { app, persistence } = seeded();
    const name100 = `${'n'.repeat(99)}\u{1F600}`;
    await request(app)
      .put('/api/v1/me')
      .send({ displayName: name100, email: emailOfLength(254) })
      .expect(200);
    expect(persistence.row(PRINCIPAL_A.subject)).toMatchObject({
      displayName: name100,
      email: emailOfLength(254),
    });
    const tooLongName = await request(app)
      .put('/api/v1/me')
      .send({ displayName: `${name100}x` });
    expect(
      pointers(expectProblem(tooLongName, 400, problemTypes.validationError))
    ).toEqual(['/displayName']);
    const tooLongEmail = await request(app)
      .put('/api/v1/me')
      .send({ displayName: 'Ok', email: emailOfLength(255) });
    expect(
      pointers(expectProblem(tooLongEmail, 400, problemTypes.validationError))
    ).toEqual(['/email']);
    expect(persistence.row(PRINCIPAL_A.subject)?.displayName).toBe(name100);
  });

  it.each(['subject', 'externalSubject', 'id', 'status'])(
    'VT-13 PBI-011 AC-3 TBI-015 DoD-2 rejects an extra %s field and changes nothing',
    async (key) => {
      const { app, persistence } = seeded();
      const response = await request(app)
        .put('/api/v1/me')
        .send({ displayName: 'Valid Name', [key]: 'disabled' });
      const body = expectProblem(response, 400, problemTypes.validationError);
      expect(pointers(body)).toEqual([`/${key}`]);
      expect(persistence.row(PRINCIPAL_A.subject)).toMatchObject({
        externalSubject: PRINCIPAL_A.subject,
        displayName: 'Stored Alpha',
        status: 'active',
      });
    }
  );

  it.each([
    ['an array', '[{"displayName":"Ada"}]'],
    ['a string', '"Ada"'],
    ['a number', '42'],
  ])('VT-13 PBI-011 AC-3 rejects %s as the body', async (_label, raw) => {
    const { app } = seeded();
    const response = await request(app)
      .put('/api/v1/me')
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(response.status).toBe(400);
    expect(problemDetailsSchema.parse(response.body).type).toMatch(
      /validation-error|malformed-body/
    );
  });

  it('VT-13 rejects a request with no JSON body', async () => {
    const { app } = seeded();
    const response = await request(app)
      .put('/api/v1/me')
      .set('Content-Type', 'text/plain')
      .send('displayName=Ada');
    expectProblem(response, 400, problemTypes.validationError);
  });

  it('VT-14 PBI-011 AC-2 a PUT before any GET creates the row and applies the update', async () => {
    const { app, persistence } = buildTestApp();
    const response = await request(app)
      .put('/api/v1/me')
      .send({ displayName: 'First Write', email: 'first@example.test' })
      .expect(200);
    expect(response.body).toEqual({
      displayName: 'First Write',
      email: 'first@example.test',
      status: 'active',
    });
    expect(persistence.rowCount()).toBe(1);
  });
});
