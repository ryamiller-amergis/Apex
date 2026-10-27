import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineRoute,
  paginated,
  paginationQuerySchema,
  problemDetailsSchema,
  problemTypes,
  requestIdSchema,
  routeList,
  zodIssuesToProblemErrors,
} from '../src/index.ts';

const sample = (type: string, status: number, title: string) => ({
  type,
  title,
  status,
  requestId: 'req-1',
});

describe('Problem Details (VT-09, TBI-011 DoD-0)', () => {
  it.each([
    [problemTypes.validationError, 400, 'The request failed validation'],
    [problemTypes.authenticationRequired, 401, 'Authentication is required'],
    [problemTypes.notFound, 404, 'Not found'],
    [problemTypes.internalError, 500, 'Unexpected server error'],
    [problemTypes.notReady, 503, 'Not ready'],
  ])('TBI-011 DoD-0 parses a %s body', (type, status, title) => {
    expect(
      problemDetailsSchema.safeParse(sample(type, status, title)).success
    ).toBe(true);
  });

  it('TBI-011 DoD-0 uses URN problem types', () => {
    expect(Object.values(problemTypes)).toEqual([
      'urn:problem-type:validation-error',
      'urn:problem-type:malformed-body',
      'urn:problem-type:authentication-required',
      'urn:problem-type:not-found',
      'urn:problem-type:rate-limited',
      'urn:problem-type:not-ready',
      'urn:problem-type:internal-error',
    ]);
  });

  it('TBI-011 NFR rejects a body that carries a stack trace or a subject', () => {
    const base = sample(problemTypes.internalError, 500, 'Unexpected error');
    expect(
      problemDetailsSchema.safeParse({ ...base, stack: 'Error: at x' }).success
    ).toBe(false);
    expect(
      problemDetailsSchema.safeParse({ ...base, subject: 'auth0|1' }).success
    ).toBe(false);
  });

  it('TBI-011 NFR mapped errors never echo the submitted value', () => {
    const schema = z.strictObject({
      email: z.email().max(5),
      nickname: z.number(),
    });
    const result = schema.safeParse({
      email: 'ada@example.test',
      nickname: 'ada@example.test',
      extra: 'ada@example.test',
    });
    expect(result.success).toBe(false);
    const errors = zodIssuesToProblemErrors(result.error!.issues);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(errors)).not.toContain('ada@example.test');
    for (const error of errors) {
      expect(error.pointer).toMatch(/^\//);
      expect(error.message).not.toMatch(/received|expected/i);
    }
  });

  it('TBI-011 escapes JSON pointer segments and maps array indexes', () => {
    const schema = z.strictObject({
      'a/b~c': z.array(z.string()),
    });
    const result = schema.safeParse({ 'a/b~c': ['ok', 1] });
    expect(zodIssuesToProblemErrors(result.error!.issues)).toEqual([
      expect.objectContaining({ pointer: '/a~1b~0c/1', code: 'invalid_type' }),
    ]);
  });

  it('TBI-011 request IDs are 1 to 128 safe characters', () => {
    expect(requestIdSchema.safeParse('a').success).toBe(true);
    expect(requestIdSchema.safeParse('A.b_c-1'.padEnd(128, 'x')).success).toBe(
      true
    );
    expect(requestIdSchema.safeParse('').success).toBe(false);
    expect(requestIdSchema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(requestIdSchema.safeParse('has space').success).toBe(false);
  });
});

describe('pagination (VT-10, TBI-011 DoD-2)', () => {
  it('TBI-011 DoD-2 defaults limit to 20', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 20 });
  });

  it('TBI-011 DoD-2 accepts the maximum of 100 and coerces query strings', () => {
    expect(paginationQuerySchema.parse({ limit: 100 }).limit).toBe(100);
    expect(paginationQuerySchema.parse({ limit: '7' }).limit).toBe(7);
  });

  it.each([
    [{ limit: 101 }],
    [{ limit: 0 }],
    [{ limit: 1.5 }],
    [{ cursor: 'c'.repeat(513) }],
  ])('TBI-011 DoD-2 rejects %j', (query) => {
    expect(paginationQuerySchema.safeParse(query).success).toBe(false);
  });

  it('TBI-011 DoD-2 paginated() describes items and a nullable nextCursor', () => {
    const page = paginated(z.strictObject({ id: z.string() }));
    const listThings = defineRoute({
      id: 'listThings',
      method: 'get',
      path: '/api/v1/things',
      auth: 'principal',
      summary: 'Fixture list',
      request: { query: paginationQuerySchema },
      responses: { 200: { description: 'A page', body: page } },
    });
    const body = listThings.responses[200].body;
    expect(
      body.safeParse({ items: [{ id: '1' }], nextCursor: null }).success
    ).toBe(true);
    expect(body.safeParse({ items: [], nextCursor: 'abc' }).success).toBe(true);
    expect(body.safeParse({ items: [] }).success).toBe(false);
  });
});

describe('definition guards (VT-11)', () => {
  const ok = {
    id: 'getThing',
    method: 'get',
    path: '/api/v1/things',
    auth: 'none',
    summary: 'Fixture',
    responses: { 200: { description: 'OK' } },
  } as const;

  it('TBI-011 rejects an unversioned path', () => {
    expect(() => defineRoute({ ...ok, path: '/users' })).toThrow(
      /versioning convention/
    );
  });

  it('TBI-011 rejects params keys that do not match the path', () => {
    expect(() =>
      defineRoute({
        ...ok,
        path: '/api/v1/things/:thingId',
        request: { params: z.strictObject({ id: z.string() }) },
      })
    ).toThrow(/path parameters/);
    expect(() =>
      defineRoute({ ...ok, path: '/api/v1/things/:thingId' })
    ).toThrow(/path parameters/);
  });

  it('TBI-011 rejects an error response without the Problem Details schema', () => {
    expect(() =>
      defineRoute({
        ...ok,
        responses: {
          200: { description: 'OK' },
          400: {
            description: 'Bad',
            body: z.strictObject({ msg: z.string() }),
          },
        },
      })
    ).toThrow(/Problem Details convention/);
  });

  it.each(['userId', 'subject', 'sub', 'externalSubject', 'externalId'])(
    'TBI-009 BR-001 rejects a request field named %s',
    (field) => {
      expect(() =>
        defineRoute({
          ...ok,
          method: 'put',
          request: { body: z.strictObject({ [field]: z.string() }) },
        })
      ).toThrow(/identifier guard/);
      expect(() =>
        defineRoute({
          ...ok,
          request: { query: z.strictObject({ [field]: z.string() }) },
        })
      ).toThrow(/identifier guard/);
    }
  );

  it('TBI-009 BR-001 rejects an identifier nested inside the body', () => {
    expect(() =>
      defineRoute({
        ...ok,
        method: 'put',
        request: {
          body: z.strictObject({
            owner: z.strictObject({ userId: z.string() }).optional(),
          }),
        },
      })
    ).toThrow(/identifier guard/);
  });

  it.each([
    [
      'union',
      z.union([
        z.strictObject({ name: z.string() }),
        z.strictObject({ userId: z.string() }),
      ]),
    ],
    [
      'intersection',
      z.intersection(
        z.strictObject({ name: z.string() }),
        z.strictObject({ userId: z.string() })
      ),
    ],
    [
      'pipe',
      z.strictObject({ userId: z.string() }).transform((value) => value),
    ],
    ['lazy', z.lazy(() => z.strictObject({ userId: z.string() }))],
    ['record', z.record(z.string(), z.strictObject({ userId: z.string() }))],
  ] as const)(
    'TBI-009 BR-001 rejects an identifier nested inside a %s body',
    (_kind, body) => {
      expect(() =>
        defineRoute({
          ...ok,
          method: 'put',
          request: { body },
        })
      ).toThrow(/identifier guard/);
    }
  );

  it('TBI-011 rejects an example that does not match its schema', () => {
    expect(() =>
      defineRoute({
        ...ok,
        responses: {
          200: {
            description: 'OK',
            body: z.strictObject({ id: z.string() }),
            example: { id: 1 },
          },
        },
      })
    ).toThrow(/example/);
  });

  it('TBI-011 returns a frozen definition for a valid route', () => {
    const route = defineRoute({
      ...ok,
      path: '/api/v2/things/:thingId',
      request: { params: z.strictObject({ thingId: z.string() }) },
    });
    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(route.responses)).toBe(true);
    expect(Object.keys(route.responses)).toEqual(['200', '400', '500']);
  });

  it('TBI-011 DoD-1 every registered route declares Problem errors and success', () => {
    for (const route of routeList) {
      expect(route.responses[500]?.body, route.id).toBe(problemDetailsSchema);
      if (route.auth === 'principal') {
        expect(route.responses[401]?.body, route.id).toBe(problemDetailsSchema);
        expect(route.responses[429]?.body, route.id).toBe(problemDetailsSchema);
      }
    }
  });
});
