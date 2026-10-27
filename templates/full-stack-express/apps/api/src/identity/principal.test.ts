import { describe, expect, expectTypeOf, it } from 'vitest';
import { PRINCIPAL_SUBJECT_MAX_LENGTH, principalSchema } from './principal.ts';
import type { Principal } from './principal.ts';

describe('principalSchema (VT-01)', () => {
  it('PBI-009 AC-2 accepts a principal with only a subject', () => {
    const result = principalSchema.safeParse({ subject: 's-1' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ subject: 's-1' });
  });

  it('accepts a subject at the maximum length', () => {
    const subject = 'x'.repeat(PRINCIPAL_SUBJECT_MAX_LENGTH);
    expect(principalSchema.safeParse({ subject }).success).toBe(true);
    expect(PRINCIPAL_SUBJECT_MAX_LENGTH).toBe(255);
  });

  it.each([
    [{ subject: '' }, 'subject'],
    [{ subject: 'x'.repeat(256) }, 'subject'],
    [{}, 'subject'],
    [{ subject: 's-1', email: 42 }, 'email'],
    [{ subject: 's-1', displayName: 7 }, 'displayName'],
  ])('rejects %j with a path naming %s', (value, field) => {
    const result = principalSchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toContain(field);
  });

  it('TBI-012 DoD-3 drops role and permission fields an adapter adds', () => {
    const result = principalSchema.safeParse({
      subject: 's-1',
      roles: ['admin'],
      permissions: ['all'],
    });
    expect(result.success).toBe(true);
    expect(Object.keys(result.data ?? {})).toEqual(['subject']);
  });
});

describe('Principal type (VT-02)', () => {
  it('TBI-012 DoD-3 has only subject, displayName, and email', () => {
    expectTypeOf<keyof Principal>().toEqualTypeOf<
      'subject' | 'displayName' | 'email'
    >();
    expectTypeOf<Principal['subject']>().toEqualTypeOf<string>();
  });
});
