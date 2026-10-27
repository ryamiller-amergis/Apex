import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineRoute,
  getMe,
  problemDetailsSchema,
  problemTypes,
  profileSchema,
  putMe,
  requestIdHeader,
  updateProfileBodySchema,
  zodIssuesToProblemErrors,
} from '../src/index.ts';

const emailOfLength = (length: number) =>
  `${'a'.repeat(length - '@example.test'.length)}@example.test`;

function toValidationProblem(issues: z.core.$ZodIssue[]) {
  return problemDetailsSchema.parse({
    type: problemTypes.validationError,
    title: 'The request failed validation',
    status: 400,
    requestId: 'req-1',
    errors: zodIssuesToProblemErrors(issues),
  });
}

describe('profile route definitions (TBI-009 DoD-0)', () => {
  it('TBI-009 DoD-0 getMe declares GET /api/v1/me with a profile body and Problem errors', () => {
    expect(getMe.method).toBe('get');
    expect(getMe.path).toBe('/api/v1/me');
    expect(getMe.auth).toBe('principal');
    expect(getMe.responses[200].body).toBe(profileSchema);
    for (const status of [401, 429, 500] as const) {
      expect(getMe.responses[status].body).toBe(problemDetailsSchema);
    }
    expect(Object.keys(getMe.responses)).toEqual(['200', '401', '429', '500']);
  });

  it('TBI-009 DoD-0 putMe declares PUT /api/v1/me with a body, a profile response, and Problem errors', () => {
    expect(putMe.method).toBe('put');
    expect(putMe.path).toBe('/api/v1/me');
    expect(putMe.request.body).toBe(updateProfileBodySchema);
    expect(putMe.responses[200].body).toBe(profileSchema);
    expect(Object.keys(putMe.responses)).toEqual([
      '200',
      '400',
      '401',
      '429',
      '500',
    ]);
    expect(requestIdHeader).toBe('X-Request-Id');
  });
});

describe('profile payloads (VT-04, TBI-009 DoD-2)', () => {
  const valid = { displayName: 'Ada Example', email: 'ada@example.test' };

  it.each([1, 100])(
    'TBI-009 DoD-2 accepts a displayName of %i characters',
    (length) => {
      const body = { ...valid, displayName: 'a'.repeat(length) };
      expect(updateProfileBodySchema.safeParse(body).success).toBe(true);
    }
  );

  it.each([0, 101])(
    'TBI-009 DoD-2 rejects a displayName of %i characters',
    (length) => {
      const body = { ...valid, displayName: 'a'.repeat(length) };
      expect(updateProfileBodySchema.safeParse(body).success).toBe(false);
    }
  );

  it('TBI-009 DoD-2 trims displayName and rejects whitespace only', () => {
    expect(
      updateProfileBodySchema.parse({ displayName: '  Ada  ' }).displayName
    ).toBe('Ada');
    expect(updateProfileBodySchema.safeParse({ displayName: '   ' }).success).toBe(
      false
    );
  });

  it('TBI-009 DoD-2 accepts a 254-character email, null, and an omitted email', () => {
    expect(emailOfLength(254)).toHaveLength(254);
    for (const email of [emailOfLength(254), null, undefined]) {
      expect(
        updateProfileBodySchema.safeParse({ displayName: 'Ada', email })
          .success,
        String(email)
      ).toBe(true);
    }
  });

  it('TBI-009 DoD-2 rejects a 255-character email and a malformed email', () => {
    for (const email of [emailOfLength(255), 'not-an-email']) {
      expect(
        updateProfileBodySchema.safeParse({ displayName: 'Ada', email })
          .success
      ).toBe(false);
    }
  });

  it('TBI-009 DoD-2 the profile response requires status from the fixed set', () => {
    const profile = { displayName: 'Ada', email: null, status: 'active' };
    expect(profileSchema.safeParse(profile).success).toBe(true);
    expect(
      profileSchema.safeParse({ ...profile, status: 'deleted' }).success
    ).toBe(false);
    expect(
      profileSchema.safeParse({ ...profile, subject: 'x' }).success
    ).toBe(false);
  });

  it('TBI-009 DoD-2 failures map to Problem Details errors with a pointer and a code', () => {
    const result = updateProfileBodySchema.safeParse({
      displayName: '',
      email: 'not-an-email',
    });
    expect(result.success).toBe(false);
    const problem = toValidationProblem(result.error!.issues);
    expect(problem.errors).toEqual([
      expect.objectContaining({ pointer: '/displayName', code: 'too_small' }),
      expect.objectContaining({ pointer: '/email', code: 'invalid_format' }),
    ]);
  });
});

describe('optional bounded field on a fixture route (PBI-006 AC-2)', () => {
  const nicknameBody = z.strictObject({
    nickname: z.string().min(2).max(20).optional(),
  });
  const patchThing = defineRoute({
    id: 'patchThing',
    method: 'patch',
    path: '/api/v1/things',
    auth: 'principal',
    summary: 'Fixture',
    request: { body: nicknameBody },
    responses: { 204: { description: 'Updated' } },
  });

  it.each([2, 20])(
    'PBI-006 AC-2 accepts a nickname at the limit (%i characters)',
    (length) => {
      expect(
        patchThing.request.body.safeParse({ nickname: 'n'.repeat(length) })
          .success
      ).toBe(true);
    }
  );

  it.each([1, 21])(
    'PBI-006 AC-2 returns a Problem Details validation error outside the limits (%i characters)',
    (length) => {
      const result = patchThing.request.body.safeParse({
        nickname: 'n'.repeat(length),
      });
      expect(result.success).toBe(false);
      const problem = toValidationProblem(result.error!.issues);
      expect(problem.type).toBe('urn:problem-type:validation-error');
      expect(problem.errors).toEqual([
        expect.objectContaining({
          pointer: '/nickname',
          code: length < 2 ? 'too_small' : 'too_big',
        }),
      ]);
      expect(patchThing.responses[400].body).toBe(problemDetailsSchema);
    }
  );

  it('PBI-006 AC-2 accepts the omitted optional field', () => {
    expect(patchThing.request.body.safeParse({}).success).toBe(true);
  });
});

describe('unknown request fields are rejected (VT-06)', () => {
  it.each(['subject', 'id', 'status'])(
    'TBI-009 / TBI-011 rejects %s beside valid fields without echoing it',
    (key) => {
      const secret = 'auth0|1234567890abcdef';
      const result = putMe.request.body.safeParse({
        displayName: 'Ada',
        [key]: secret,
      });
      expect(result.success).toBe(false);
      const errors = zodIssuesToProblemErrors(result.error!.issues);
      expect(errors).toEqual([
        {
          pointer: `/${key}`,
          code: 'unrecognized_key',
          message: 'This field is not allowed.',
        },
      ]);
      expect(JSON.stringify(errors)).not.toContain(secret);
    }
  );
});
