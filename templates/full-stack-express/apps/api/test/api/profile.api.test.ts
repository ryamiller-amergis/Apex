import {
  displayNameMaxLength,
  problemContentType,
  problemDetailsSchema,
  problemTypes,
  profileSchema,
  routeList,
  type ProblemDetails,
} from '@project-scope/contracts';
import request, { type Response } from 'supertest';
import { describe, expect, it } from 'vitest';
import { syntheticProfiles } from '../fixtures/synthetic.ts';
import { createTestApp } from '../support/createTestApp.ts';
import { TEST_SUBJECT_HEADER } from '../support/testIdentityAdapter.ts';

const [personA, personB] = syntheticProfiles;
const LEAK = 'select * from app_users where host = db.internal';

function expectProblem(
  response: Response,
  status: number,
  type: string
): ProblemDetails {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toContain(problemContentType);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.type).toBe(type);
  expect(body.status).toBe(status);
  expect(body.requestId).toBe(response.headers['x-request-id']);
  return body;
}

function authed(subject: string) {
  return { [TEST_SUBJECT_HEADER]: subject };
}

describe('profile API (TBI-024 VT-15)', () => {
  it('VT-15 TBI-024 DoD-1 GET then PUT /api/v1/me returns the documented profile and stores the new values', async () => {
    const { app, persistence } = createTestApp();
    const created = await request(app)
      .get('/api/v1/me')
      .set(authed(personA.subject));
    expect(created.status).toBe(200);
    expect(profileSchema.parse(created.body)).toEqual({
      displayName: `test-name-${personA.subject}`,
      email: null,
      status: 'active',
    });
    expect(created.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]+$/);

    const updated = await request(app)
      .put('/api/v1/me')
      .set(authed(personA.subject))
      .send({
        displayName: personA.displayName,
        email: personA.email,
      });
    expect(updated.status).toBe(200);
    expect(profileSchema.parse(updated.body)).toEqual({
      displayName: personA.displayName,
      email: personA.email,
      status: 'active',
    });
    expect(persistence.row(personA.subject)).toMatchObject({
      displayName: personA.displayName,
      email: personA.email,
    });
    expect(persistence.row(personB.subject)).toBeUndefined();
  });
});

describe('profile validation (TBI-024 VT-16)', () => {
  it('VT-16 TBI-024 DoD-1 rejects an empty name, a malformed email, and an over-long name, and saves a name at the limit', async () => {
    const { app, persistence } = createTestApp();
    persistence.seed({
      externalSubject: personA.subject,
      displayName: personA.displayName,
      email: personA.email,
    });

    const empty = await request(app)
      .put('/api/v1/me')
      .set(authed(personA.subject))
      .send({ displayName: '   ', email: personA.email });
    const emptyBody = expectProblem(empty, 400, problemTypes.validationError);
    expect(
      emptyBody.errors?.some((error) => error.pointer === '/displayName')
    ).toBe(true);

    const email = await request(app)
      .put('/api/v1/me')
      .set(authed(personA.subject))
      .send({ displayName: personA.displayName, email: 'not-an-email' });
    const emailBody = expectProblem(email, 400, problemTypes.validationError);
    expect(emailBody.errors?.some((error) => error.pointer === '/email')).toBe(
      true
    );

    const over = await request(app)
      .put('/api/v1/me')
      .set(authed(personA.subject))
      .send({
        displayName: 'a'.repeat(displayNameMaxLength + 1),
        email: personA.email,
      });
    const overBody = expectProblem(over, 400, problemTypes.validationError);
    expect(
      overBody.errors?.some((error) => error.pointer === '/displayName')
    ).toBe(true);

    expect(persistence.row(personA.subject)).toMatchObject({
      displayName: personA.displayName,
      email: personA.email,
    });

    const atLimit = 'a'.repeat(displayNameMaxLength);
    const saved = await request(app)
      .put('/api/v1/me')
      .set(authed(personA.subject))
      .send({ displayName: atLimit, email: personA.email });
    expect(saved.status).toBe(200);
    expect(profileSchema.parse(saved.body).displayName).toBe(atLimit);
    expect(persistence.row(personA.subject)?.displayName).toBe(atLimit);
  });
});

describe('unauthenticated routes (TBI-024 VT-17 PBI-022 AC-3)', () => {
  it('VT-17 PBI-022 AC-3 TBI-024 DoD-2 every protected route returns Problem Details 401 with a request ID', async () => {
    const { app } = createTestApp();
    const protectedRoutes = routeList.filter(
      (route) => route.auth === 'principal'
    );
    expect(protectedRoutes.length).toBeGreaterThan(0);
    for (const route of protectedRoutes) {
      const agent =
        route.method === 'put'
          ? request(app).put(route.path).send({
              displayName: personA.displayName,
            })
          : request(app).get(route.path);
      const response = await agent;
      const body = expectProblem(
        response,
        401,
        problemTypes.authenticationRequired
      );
      expect(body.detail).toBeTruthy();
      expect(response.headers['x-request-id']).toBeTruthy();
    }
  });
});

describe('database failure (TBI-024 VT-18)', () => {
  it('VT-18 TBI-024 DoD-1 a driver-style store error becomes Problem Details 500 with no database text', async () => {
    const { app, persistence } = createTestApp();
    persistence.override('findBySubject', () => {
      throw new Error(LEAK);
    });
    const response = await request(app)
      .get('/api/v1/me')
      .set(authed(personA.subject));
    expectProblem(response, 500, problemTypes.internalError);
    expect(response.text).not.toContain('select');
    expect(response.text).not.toContain('db.internal');
    expect(response.text).not.toContain('app_users');
    expect(response.text).not.toContain('pg-pool');
  });
});

describe('principal isolation without Docker (VT-21 lower tier)', () => {
  it('VT-21 TBI-024 DoD-2 a caller cannot read or change another principal through body, query, or path', async () => {
    const { app, persistence } = createTestApp();
    persistence.seed({
      externalSubject: personA.subject,
      displayName: personA.displayName,
      email: personA.email,
    });
    const seededB = persistence.seed({
      externalSubject: personB.subject,
      displayName: personB.displayName,
      email: personB.email,
    });

    const seen = await request(app)
      .get('/api/v1/me')
      .set(authed(personA.subject));
    expect(seen.status).toBe(200);
    expect(seen.text).not.toContain(personB.displayName);
    expect(seen.text).not.toContain(personB.email);
    expect(seen.text).not.toContain(personB.subject);

    const sneaky = await request(app)
      .put(`/api/v1/me?subject=${personB.subject}&id=${seededB.id}`)
      .set(authed(personA.subject))
      .send({
        displayName: personA.displayName,
        email: personA.email,
        subject: personB.subject,
        id: seededB.id,
      });
    expect(sneaky.status).toBe(400);
    expect(persistence.row(personB.subject)).toMatchObject({
      displayName: personB.displayName,
      email: personB.email,
    });

    const renamed = await request(app)
      .put('/api/v1/me')
      .set(authed(personA.subject))
      .send({ displayName: 'test-name-a-renamed', email: personA.email });
    expect(renamed.status).toBe(200);
    expect(renamed.text).not.toContain(personB.displayName);
    expect(persistence.row(personA.subject)?.displayName).toBe(
      'test-name-a-renamed'
    );
    expect(persistence.row(personB.subject)?.displayName).toBe(
      personB.displayName
    );

    const missed = await request(app)
      .put(`/api/v1/me/${seededB.id}`)
      .set(authed(personA.subject))
      .send({ displayName: personB.displayName, email: personB.email });
    expect(missed.status).toBe(404);
    expect(persistence.row(personB.subject)?.displayName).toBe(
      personB.displayName
    );
  });
});

describe('health probes (TBI-024 VT-23 lower tier)', () => {
  it('VT-23 TBI-024 DoD-1 live stays up and ready reports not-ready with no connection text when the store ping fails', async () => {
    const { app } = createTestApp({
      ping: () => Promise.reject(new Error(LEAK)),
    });
    const live = await request(app).get('/health/live');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'ok' });
    const ready = await request(app).get('/health/ready');
    expectProblem(ready, 503, problemTypes.notReady);
    expect(ready.text).not.toContain('db.internal');
    expect(ready.text).not.toContain('select');
    expect(ready.text).not.toContain('password');
  });
});
